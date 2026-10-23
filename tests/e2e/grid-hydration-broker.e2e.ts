import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BROKER_BIN, start, skipIfNoBroker, type BrokerTestOwnership, type BrokerTestServer } from "./broker-helpers.ts";
import { createOwnedTestServerHome, removeOwnedTestServerHome, type OwnedTestServerHome } from "./test-server-home.ts";
import { TERMINAL_SLOW_LOAD_THRESHOLD_MS } from "../../public/terminal-loading-ui.ts";
import { ASSET_VERSIONS } from "../../src/public-assets.ts";
import { terminalTail } from "./helpers.ts";

test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
let server: BrokerTestServer;
let owner: BrokerTestOwnership | undefined;
let home: OwnedTestServerHome;
const names = ["hydration-parent", "hydration-child"];
let sessionIds: Record<string, string>;
let childProcesses: { pid: number; command: string }[] = [];
const markerFor = (name: string) => `ROUND14_${name}`;
const cells = (page: Page) => page.locator("#delegation-grid-container .grid-cell");

async function readSessions(): Promise<{ name: string; identity: { wolfpackSessionId: string; parentSession?: { wolfpackSessionId: string } } }[]> {
  return (await (await fetch(`${server.baseUrl}/api/sessions`)).json()).sessions;
}

async function expectSameSessions(): Promise<void> {
  const sessions = await readSessions();
  expect(Object.fromEntries(sessions.map(session => [session.name, session.identity.wolfpackSessionId]))).toEqual(sessionIds);
  expect(sessions.find(session => session.name === names[1])?.identity.parentSession?.wolfpackSessionId).toBe(sessionIds[names[0]]);
}

test.beforeAll(async () => {
  home = createOwnedTestServerHome();
  const dev = join(home.path, "dev");
  mkdirSync(join(dev, "hydration"), { recursive: true });
  server = await start({
    onOwnership: value => { owner = value; },
    envOverrides: { HOME: home.path, ZDOTDIR: home.path, SHELL: "/bin/sh", WOLFPACK_DEV_DIR: dev,
      WOLFPACK_MACHINE_ID_PATH: join(home.path, "machine-id"), WOLFPACK_TAILSCALE_STATUS_JSON: "{}" },
    brokerEnvOverrides: { HOME: home.path, ZDOTDIR: home.path, SHELL: "/bin/sh" },
  });
  for (const [sessionName, parentSession] of [[names[0], undefined], [names[1], names[0]], ["hydration-away", undefined]]) {
    const response = await fetch(`${server.baseUrl}/api/create`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "hydration", cmd: "shell", sessionName, parentSession }) });
    expect(response.ok, await response.text()).toBeTruthy();
  }
  const sessions = await readSessions();
  sessionIds = Object.fromEntries(sessions.map(session => [session.name, session.identity.wolfpackSessionId]));
  await expectSameSessions();
  for (const name of names) {
    const response = await fetch(`${server.baseUrl}/api/session-control/prompt`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionIds[name], prompt: `printf 'ROUND14_%s\\n' '${name}'`, outputContains: markerFor(name), timeoutMs: 5000 }),
    });
    const result = await response.json();
    expect(response.ok, JSON.stringify(result)).toBeTruthy();
    expect(result.outcome, JSON.stringify(result)).toBe("matched");
  }
  if (process.platform === "linux") {
    childProcesses = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n").flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match && Number(match[2]) === process.pid && (match[3].includes(BROKER_BIN!) || match[3].includes("test-server-broker.ts"))
        ? [{ pid: Number(match[1]), command: match[3] }] : [];
    });
    expect(childProcesses).toHaveLength(2);
  }
  const servedApp = await (await fetch(`${server.baseUrl}/app.bundle.js`)).arrayBuffer();
  const servedAppSha256 = createHash("sha256").update(Buffer.from(servedApp)).digest("hex");
  expect(servedAppSha256.slice(0, 16)).toBe(ASSET_VERSIONS["app.bundle.js"]);
  console.log(JSON.stringify({ socket: server.socketPath, home: home.path, childProcesses, servedAppSha256,
    brokerSha256: createHash("sha256").update(readFileSync(BROKER_BIN!)).digest("hex"),
    sessions }));
});

test.beforeEach(async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "delegation grid and its sidebar navigation are desktop-only");
  console.log(JSON.stringify({ browser: browser.version(), project: testInfo.project.name, executableOverride: process.env.WOLFPACK_PLAYWRIGHT_EXECUTABLE ?? null }));
});

test.afterAll(async () => {
  await owner?.teardown();
  expect(owner?.childrenExited()).toBe(true);
  expect(existsSync(server.socketPath)).toBe(false);
  for (const child of childProcesses) expect(existsSync(`/proc/${child.pid}`)).toBe(false);
  removeOwnedTestServerHome(home);
  console.log(JSON.stringify({ cleanup: "owned children exited; socket and home absent", socket: server.socketPath, home: home.path, childProcesses }));
});

test.afterEach(async ({ page }, testInfo) => {
  const path = testInfo.outputPath("lifecycle.json");
  writeFileSync(path, JSON.stringify(await lifecycleSnapshot(page)), { mode: 0o600 });
  await testInfo.attach("lifecycle", { path, contentType: "application/json" });
});

async function lifecycleSnapshot(page: Page) {
  return page.evaluate(() => ({
    events: (window as any).__gridHydrationEvents,
    cells: Array.from(document.querySelectorAll<HTMLElement>("#delegation-grid-container .grid-cell"), cell => ({
      session: cell.dataset.session, state: cell.dataset.terminalLoadState, classes: cell.className, slowLabel: cell.dataset.terminalSlowLabel,
    })),
  }));
}

interface AttachGate {
  readonly socket: WebSocketRoute;
  readonly upstream: WebSocketRoute;
  readonly completion: (string | Buffer)[];
  ready: string | Buffer | null;
  closed: boolean;
  upstreamClosed: boolean;
}

async function observeLifecycle(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("wolfpackDebug", "1");
    (window as any).__gridHydrationEvents = [];
    (window as any).__wfTraceObserver = (trace: any, event: any) => {
      if (event.kind === "raf") return;
      (window as any).__gridHydrationEvents.push({ session: trace._meta.session, ...event });
    };
  });
}

async function observeAndGate(page: Page, holdCompletion = false): Promise<AttachGate[]> {
  await page.clock.install();
  await observeLifecycle(page);
  const gates: AttachGate[] = [];
  // Only hold the real native server's completion/ready frames. All attach,
  // prefill bytes, resize acknowledgements and input use the production path.
  await page.routeWebSocket(/\/ws\/pty/, socket => {
    const upstream = socket.connectToServer();
    const gate: AttachGate = { socket, upstream, completion: [], ready: null, closed: false, upstreamClosed: false };
    gates.push(gate);
    upstream.onMessage(message => {
      const type = typeof message === "string" ? JSON.parse(message).type : null;
      if (type === "pty_ready") gate.ready = message;
      else if (type === "prefill_done" && holdCompletion) gate.completion.push(message);
      else socket.send(message);
    });
    socket.onClose((code, reason) => { gate.closed = true; void upstream.close({ code, reason }); });
    upstream.onClose((code, reason) => { gate.upstreamClosed = true; void socket.close({ code, reason }); });
  });
  return gates;
}

async function eventCount(page: Page, kind: string): Promise<number> {
  return page.evaluate(kind => (window as any).__gridHydrationEvents.filter((event: any) => event.kind === kind && event.session !== "hydration-away").length, kind);
}

async function openParent(page: Page): Promise<void> {
  await page.goto(server.baseUrl);
  await page.locator('.card [data-session="hydration-parent"]').first().click();
  await expect(cells(page)).toHaveCount(2);
}

async function release(gates: AttachGate[]): Promise<void> {
  for (const gate of gates) {
    for (const message of gate.completion) gate.socket.send(message);
    expect(gate.ready).not.toBeNull();
    gate.socket.send(gate.ready!);
  }
}

async function expectRenderedCells(page: Page): Promise<void> {
  await expect(cells(page).filter({ has: page.locator("canvas") })).toHaveCount(2);
  await expect(page.locator('#delegation-grid-container .grid-cell[data-terminal-load-state="live"].hydrated')).toHaveCount(2);
  for (const name of names) {
    await expect.poll(() => terminalTail(page.locator(`#delegation-grid-container .grid-cell[data-session="${name}"]`), 100)).toContain(markerFor(name));
  }
}

async function expectLive(page: Page): Promise<void> {
  await expectRenderedCells(page);
  // Exercise the actual diagnostic deadline, not an arbitrary stuck-state sleep.
  await page.clock.fastForward(TERMINAL_SLOW_LOAD_THRESHOLD_MS + 1);
  await expect(page.locator("#delegation-grid-container .terminal-load-slow")).toHaveCount(0);
}

test("grid ready after hydration reveal stays live on initial attach and reconnect", async ({ page }) => {
  const gates = await observeAndGate(page);
  await openParent(page);
  await expect.poll(() => gates.filter(gate => gate.ready !== null).length).toBe(2);
  await expect.poll(() => eventCount(page, "hydration.reveal")).toBe(2);
  await expectLive(page);
  await release(gates);
  await expect.poll(() => eventCount(page, "pty_ready")).toBe(2);
  await expectLive(page);
  expect(await eventCount(page, "hydration.reveal")).toBe(2); // no next cycle rescues the state

  for (const gate of gates) {
    // Close the real upstream first and forward its close to the page. Browser
    // WebSocket.close requires 1000 or an application code in 3000..4999.
    await gate.upstream.close({ code: 4000, reason: "isolated transport reconnect" });
  }
  await expect.poll(() => gates.slice(0, 2).every(gate => gate.upstreamClosed)).toBe(true);
  await expect.poll(() => gates.length).toBe(4);
  await expect.poll(() => gates.slice(2).filter(gate => gate.ready !== null).length).toBe(2);
  await expect.poll(() => eventCount(page, "hydration.reveal")).toBe(4);
  await release(gates.slice(2));
  await expect.poll(() => eventCount(page, "pty_ready")).toBe(4);
  await expectLive(page);
  expect(await eventCount(page, "hydration.reveal")).toBe(4);
  await expectSameSessions();
});

test("grid ready while hydration pending preserves the gate then becomes live", async ({ page }) => {
  const gates = await observeAndGate(page, true);
  await openParent(page);
  await expect.poll(() => gates.filter(gate => gate.ready !== null).length).toBe(2);
  expect(await eventCount(page, "hydration.reveal")).toBe(0);
  await page.clock.runFor(TERMINAL_SLOW_LOAD_THRESHOLD_MS + 1);
  await expect(page.locator('#delegation-grid-container .terminal-load-slow[data-terminal-slow-label="waiting for grid cell prefill"]')).toHaveCount(2);
  // Freeze only browser scheduling at the real transport boundary: native
  // prefill is already received, but its authoritative completion is held.
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 100));
  await release(gates);
  await expect.poll(() => eventCount(page, "pty_ready")).toBe(2);
  expect(await eventCount(page, "hydration.finish")).toBe(0);
  await expect(page.locator('#delegation-grid-container .grid-cell[data-terminal-load-state="hydrating"]')).toHaveCount(2);
  await expect(page.locator("#delegation-grid-container .terminal-load-slow")).toHaveCount(0);
  await page.clock.runFor(TERMINAL_SLOW_LOAD_THRESHOLD_MS + 1);
  await expect.poll(() => eventCount(page, "hydration.reveal")).toBe(2);
  await expectLive(page);
});

test("leaving a revealed grid with ready in flight disposes its old viewers", async ({ page }) => {
  const gates = await observeAndGate(page);
  await openParent(page);
  await expect.poll(() => gates.filter(gate => gate.ready !== null).length).toBe(2);
  await expect.poll(() => eventCount(page, "hydration.reveal")).toBe(2);
  await page.locator('[data-action="open-session"][data-session="hydration-away"]:visible').first().click();
  await expect.poll(() => gates.slice(0, 2).every(gate => gate.closed)).toBe(true);
  await page.locator('[data-action="open-session"][data-session="hydration-parent"]:visible').first().click();
  await expect.poll(() => gates.length).toBe(5); // old grid, away, new grid
  await expect.poll(() => gates.slice(3).filter(gate => gate.ready !== null).length).toBe(2);
  await expect.poll(() => eventCount(page, "hydration.reveal")).toBe(4);
  await release(gates.slice(3));
  await expect.poll(() => eventCount(page, "pty_ready")).toBe(2);
  await expectLive(page);
  await expectSameSessions();
});

test("native parent grid repeated opens stay live across twenty real attaches", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  // No clock, wire routing or source interception: each navigation tears down
  // the preceding viewers and attaches the same actual parent/child afresh.
  await observeLifecycle(page);
  const outcomes = [];
  for (let iteration = 1; iteration <= 20; iteration++) {
    await openParent(page);
    await expect.poll(() => eventCount(page, "pty_ready")).toBe(2);
    await expect.poll(() => eventCount(page, "hydration.reveal")).toBe(2);
    await expectRenderedCells(page);
    await expectSameSessions();
    outcomes.push({ iteration, ...await lifecycleSnapshot(page) });
  }
  const path = testInfo.outputPath("twenty-native-attaches.json");
  writeFileSync(path, JSON.stringify(outcomes), { mode: 0o600 });
  await testInfo.attach("twenty-native-attaches", { path, contentType: "application/json" });
  console.log(JSON.stringify({ naturalOpens: outcomes.length, bothCellsLive: outcomes.length, stuck: 0, sessionIds }));

  await page.locator('[data-action="open-session"][data-session="hydration-away"]:visible').first().click();
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
  await page.locator('[data-action="open-session"][data-session="hydration-parent"]:visible').first().click();
  await expect.poll(() => eventCount(page, "pty_ready")).toBe(4);
  await expect.poll(() => eventCount(page, "hydration.reveal")).toBe(4);
  await expectRenderedCells(page);
  await expectSameSessions();
});
