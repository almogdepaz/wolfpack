import { expect, test, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gridSessionNames, openProjectPickerFromUi, openSessionFromUi, startTestServer, toggleSessionGridFromUi, type TestServer } from "./helpers.ts";

const PUBLIC_DIRECTORY = join(import.meta.dirname, "..", "..", "public");

const installationId = "2af8af29-c4fe-44f9-9a99-9a0e35952d74";
const localInstallationId = "e2e00000-0000-4000-8000-000000000001";
const peerIdentity = `n-peer:${installationId}`;
const poisonTailnetHostname = "poison.tailnet.ts.net";
const poisonSiblingOrigin = `https://sibling.${poisonTailnetHostname}`;

let server: TestServer;
let poisonedHome: string;
let temporaryActionCounter = 0;

interface ReplacementSocketWindow extends Window {
  __replacementSurvivorController?: unknown;
  __replacementSockets?: Array<{
    readonly url: string;
    readonly sent: unknown[];
    closeCount: number;
    open(): void;
    forceClose(): void;
    serverText(data: string): void;
  }>;
}

interface ReplacementFocusedDelegationWindow extends ReplacementSocketWindow {
  readonly state: {
    readonly activeDelegationRoot: string | null;
    readonly focusedDelegationSession: string | null;
    readonly currentSession: string | null;
    readonly currentMachine: string;
    readonly currentView: string;
    readonly terminalController: unknown;
    readonly delegationGridSessions: Array<{ readonly session: string }>;
    readonly preservedGridSessions: Array<{ readonly session: string }>;
    readonly preservedGridFocusIndex: number;
  };
}

function visibleSessionList(page: Page) {
  return page.locator([
    "#session-list:not([hidden])",
    "body:has(#session-list[hidden]) #sidebar-session-list",
  ].join(", "));
}

function visibleSessionGroups(page: Page) {
  return page.locator([
    "#session-list:not([hidden]) > .machine-group",
    "body:has(#session-list[hidden]) #sidebar-session-list > .machine-group",
    "body:has(#session-list[hidden]) #sidebar-session-list:has(> .card)",
  ].join(", "));
}

function visibleMachineGroup(page: Page, machine: string) {
  return visibleSessionList(page).locator(`.machine-group[data-machine="${machine}"]`);
}

async function clickTemporaryDelegatedAction(
  page: Page,
  name: string,
  action: string,
  data: Record<string, string>,
): Promise<void> {
  const id = `temporary-action-${temporaryActionCounter++}`;
  await page.evaluate(({ id: buttonId, name: label, action: actionName, data: dataset }) => {
    const button = document.createElement("button");
    button.id = buttonId;
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-label", label);
    button.dataset.action = actionName;
    for (const [key, value] of Object.entries(dataset)) button.dataset[key] = value;
    document.body.appendChild(button);
  }, { id, name, action, data });
  try {
    await page.locator(`#${id}`).click();
  } finally {
    await page.locator(`#${id}`).evaluate((button) => button.remove()).catch(() => undefined);
  }
}

async function clickRetryMachine(page: Page, machine: string): Promise<void> {
  const retries = page.locator('[data-action="retry-machine"]').filter({ visible: true });
  const count = await retries.count();
  for (let index = 0; index < count; index += 1) {
    const retry = retries.nth(index);
    const retryMachine = await retry.evaluate((button) => (button as HTMLElement).dataset.machine ?? "");
    if (retryMachine === machine) {
      await retry.click();
      return;
    }
  }
  await clickTemporaryDelegatedAction(page, "Retry Tailnet discovery", "retry-machine", { machine });
}

async function clickKillSession(page: Page, session: string, machine: string): Promise<void> {
  await clickTemporaryDelegatedAction(page, `Stop ${session}`, "kill-session", { session, machine });
}

async function terminalSnapshot(page: Page): Promise<{ readonly session: string; readonly terminalVisible: boolean }> {
  return page.evaluate(() => ({
    session: document.getElementById("chip-label")?.textContent?.trim() ?? "",
    terminalVisible: document.getElementById("terminal-view")?.classList.contains("visible") ?? false,
  }));
}

async function installReplacementSocketHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly sent: unknown[] = [];
      readyState = FakeWebSocket.CONNECTING;
      binaryType = "blob";
      closeCount = 0;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(readonly url: string) {
        const testWindow = window as unknown as ReplacementSocketWindow;
        testWindow.__replacementSockets ??= [];
        testWindow.__replacementSockets.push(this);
      }

      send(data: unknown): void {
        this.sent.push(data);
      }

      close(): void {
        this.closeCount++;
        this.readyState = FakeWebSocket.CLOSED;
      }

      open(): void {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }

      forceClose(): void {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new Event("close") as CloseEvent);
      }

      serverText(data: string): void {
        this.onmessage?.(new MessageEvent("message", { data }));
      }
    }

    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    });
  });
}

test.beforeAll(async () => {
  poisonedHome = mkdtempSync(join(tmpdir(), "wolfpack-e2e-poison-"));
  const configDirectory = join(poisonedHome, ".wolfpack");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(join(configDirectory, "config.json"), JSON.stringify({
    devDir: join(poisonedHome, "dev"),
    port: 18790,
    tailscaleHostname: poisonTailnetHostname,
  }));
  server = await startTestServer({ home: poisonedHome });
});

test.afterAll(() => {
  server?.close();
  rmSync(poisonedHome, { recursive: true, force: true });
});

test("does not delete a directly supplied inner test home", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "process ownership is browser-independent");
  const sentinelHome = mkdtempSync(join(tmpdir(), "wolfpack-e2e-sentinel-"));
  const child = spawn("bun", [
    join(import.meta.dirname, "test-server.ts"),
    "--isolated-e2e-home",
    sentinelHome,
  ], {
    cwd: join(import.meta.dirname, "..", ".."),
    env: { ...process.env, HOME: sentinelHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk;
        if (stdout.includes("READY:")) resolve();
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`inner test server exited before ready: ${code}`)));
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;
    expect(existsSync(sentinelHome)).toBe(true);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(sentinelHome, { recursive: true, force: true });
  }
});

test("isolates inherited config from the shared Tailnet test server", async ({ page }) => {
  const localOrigin = server.baseUrl;
  const [candidatesResponse, machineResponse, poisonResponse, localResponse] = await Promise.all([
    fetch(`${server.baseUrl}/api/tailnet/v1/candidates`),
    fetch(`${server.baseUrl}/api/machine`),
    fetch(`${server.baseUrl}/api/info`, { headers: { Origin: poisonSiblingOrigin } }),
    fetch(`${server.baseUrl}/api/info`, { headers: { Origin: localOrigin } }),
  ]);

  expect(poisonResponse.status).toBe(403);
  expect(poisonResponse.headers.get("access-control-allow-origin")).toBeNull();
  expect(localResponse.ok).toBe(true);
  expect(localResponse.headers.get("access-control-allow-origin")).toBe(localOrigin);

  expect(candidatesResponse.ok).toBe(true);
  expect(await candidatesResponse.json()).toEqual({ candidates: [] });
  expect(machineResponse.ok).toBe(true);
  const machine = await machineResponse.json();
  expect(machine).toMatchObject({
    machine: {
      tailnetNodeId: "n-e2e-test-server",
      displayName: "e2e-test-server",
      origin: "https://e2e-test-server.example.ts.net",
    },
  });
  expect((machine as { readonly machine: Record<string, unknown> }).machine).toEqual({
    tailnetNodeId: "n-e2e-test-server",
    installationId: localInstallationId,
    displayName: "e2e-test-server",
    origin: "https://e2e-test-server.example.ts.net",
  });

  await page.goto(server.baseUrl);

  await expect(page.getByRole("button", { name: "Open test-project" })).toBeVisible();
  await expect(visibleSessionGroups(page)).toHaveCount(1);
});

test("loads a verified peer before an unrelated candidate machine request times out", async ({ page }) => {
  let healthySessionsRequested = false;
  await page.route("**/api/tailnet/v1/candidates", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        candidates: [
          { hostname: "peer.example.ts.net", tailnetNodeId: "n-peer", origin: "https://peer.example.ts.net", online: true },
          { hostname: "stalled.example.ts.net", tailnetNodeId: "n-stalled", origin: "https://stalled.example.ts.net", online: true },
        ],
      }),
    });
  });
  await page.route("https://peer.example.ts.net/api/machine", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: {
          tailnetNodeId: "n-peer",
          installationId,
          displayName: "verified peer",
          origin: "https://peer.example.ts.net",
        },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    });
  });
  await page.route("https://peer.example.ts.net/api/sessions", async (route) => {
    healthySessionsRequested = true;
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ sessions: [] }),
    });
  });
  await page.route("https://stalled.example.ts.net/api/machine", async (route) => {
    await new Promise(resolve => setTimeout(resolve, 4_000));
    await route.fulfill({ status: 503 });
  });

  await page.goto(server.baseUrl);

  await expect.poll(() => healthySessionsRequested, { timeout: 2_000 }).toBe(true);
  await expect(visibleMachineGroup(page, peerIdentity)).toBeVisible();
});

test("does not route REST or WebSocket traffic to a former origin while its replacement probe is pending", async ({ page }) => {
  const formerOrigin = "https://peer.example.ts.net";
  const replacementOrigin = "https://renamed.example.ts.net";
  let candidateOrigin = formerOrigin;
  let replacementProbeStarted = false;
  let releaseReplacementProbe: () => void = () => {};
  const replacementProbeReleased = new Promise<void>((resolve) => {
    releaseReplacementProbe = resolve;
  });
  const formerOriginRequests: string[] = [];

  await installReplacementSocketHarness(page);
  page.on("request", (request) => {
    if (new URL(request.url()).origin === formerOrigin) formerOriginRequests.push(request.url());
  });
  await page.route("**/api/tailnet/v1/candidates", async (route) => {
    const isReplacement = candidateOrigin === replacementOrigin;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ candidates: [{
        hostname: isReplacement ? "renamed.example.ts.net" : "peer.example.ts.net",
        tailnetNodeId: "n-peer",
        origin: candidateOrigin,
        online: true,
      }] }),
    });
  });
  await page.route(`${formerOrigin}/api/machine`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: { tailnetNodeId: "n-peer", installationId, displayName: "verified peer", origin: formerOrigin },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    });
  });
  await page.route(`${replacementOrigin}/api/machine`, async (route) => {
    replacementProbeStarted = true;
    await replacementProbeReleased;
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: { tailnetNodeId: "n-peer", installationId, displayName: "renamed peer", origin: replacementOrigin },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    });
  });
  await page.route(`${formerOrigin}/api/sessions`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ sessions: [{ name: "peer-session", triage: "idle" }] }),
    });
  });
  await page.route(`${formerOrigin}/api/info`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ name: "former peer" }),
    });
  });

  await page.goto(server.baseUrl);
  await expect(visibleMachineGroup(page, peerIdentity)).toBeVisible();
  await openSessionFromUi(page, "peer-session", peerIdentity);
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as ReplacementSocketWindow).__replacementSockets?.length ?? 0
  ))).toBe(1);
  await page.evaluate(() => {
    const socket = (window as unknown as ReplacementSocketWindow).__replacementSockets?.[0];
    if (!socket) throw new Error("missing initial peer socket");
    socket.open();
    socket.serverText(JSON.stringify({ type: "attach_ack" }));
    socket.serverText(JSON.stringify({ type: "prefill_done" }));
    socket.serverText(JSON.stringify({ type: "pty_ready" }));
  });

  candidateOrigin = replacementOrigin;
  await clickRetryMachine(page, peerIdentity);
  await expect.poll(() => replacementProbeStarted).toBe(true);

  formerOriginRequests.length = 0;
  try {
    await clickTemporaryDelegatedAction(page, "Open pending peer session", "open-session", {
      session: "peer-session",
      machine: peerIdentity,
    });
    const unavailableDialog = page.getByRole("dialog", { name: "Machine unavailable" });
    if (await unavailableDialog.isVisible().catch(() => false)) {
      await unavailableDialog.getByRole("button", { name: "Close" }).click();
    }
    await page.evaluate(() => {
      const socket = (window as unknown as ReplacementSocketWindow).__replacementSockets?.[0];
      if (!socket) throw new Error("missing established peer socket");
      socket.forceClose();
    });

    await expect(page.locator("#conn-status")).toHaveText("machine unavailable — refresh Tailnet discovery before reconnecting");
    expect(formerOriginRequests).toEqual([]);
    expect(await page.evaluate(() => (
      (window as unknown as ReplacementSocketWindow).__replacementSockets?.map((socket) => socket.url) ?? []
    ))).toEqual(["wss://peer.example.ts.net/ws/pty?session=peer-session"]);
  } finally {
    releaseReplacementProbe();
  }
});

test("removes a ready peer from workspace navigation when its sessions request fails", async ({ page }, testInfo) => {
  await page.route("**/api/tailnet/v1/candidates", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ candidates: [
        { hostname: "peer.example.ts.net", tailnetNodeId: "n-peer", origin: "https://peer.example.ts.net", online: true },
      ] }),
    });
  });
  await page.route("https://peer.example.ts.net/api/machine", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: {
          tailnetNodeId: "n-peer",
          installationId,
          displayName: "verified peer",
          origin: "https://peer.example.ts.net",
        },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    });
  });
  await page.route("https://peer.example.ts.net/api/sessions", async (route) => {
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) });
  });

  await page.goto(server.baseUrl);

  await expect(visibleMachineGroup(page, peerIdentity)).toHaveCount(0);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("#machines-list .machine-item")).toHaveCount(1);
  await expect(page.locator("#machines-list .machine-item .dot")).toHaveAttribute("title", "online");
  await page.locator(testInfo.project.name === "desktop" ? "#settings-back-btn" : "#back-btn").click();
  await expect(visibleSessionGroups(page)).toHaveCount(1);
  const localSession = page.getByRole("button", { name: "Open test-project" });
  await expect(localSession).toBeVisible();
  await localSession.click();
  await expect(page.locator("#terminal-view")).toBeVisible();
});

test("revokes a stale peer after candidate enumeration failures and recovers its stable identity", async ({ page }, testInfo) => {
  let candidateMode: "valid" | "transport-failure" | "malformed-envelope" | "error-envelope" = "valid";
  let peerSessionRequests = 0;
  await page.route("**/api/tailnet/v1/candidates", async (route) => {
    if (candidateMode === "transport-failure") {
      await route.abort("failed");
      return;
    }
    if (candidateMode === "malformed-envelope") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ candidates: [{}] }) });
      return;
    }
    if (candidateMode === "error-envelope") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ candidates: [], error: "failed to query tailscale" }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ candidates: [
        { hostname: "peer.example.ts.net", tailnetNodeId: "n-peer", origin: "https://peer.example.ts.net", online: true },
      ] }),
    });
  });
  await page.route("https://peer.example.ts.net/api/machine", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: {
          tailnetNodeId: "n-peer",
          installationId,
          displayName: "verified peer",
          origin: "https://peer.example.ts.net",
        },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    });
  });
  await page.route("https://peer.example.ts.net/api/sessions", async (route) => {
    peerSessionRequests++;
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ sessions: [] }),
    });
  });

  await page.goto(server.baseUrl);
  const peerGroup = visibleMachineGroup(page, peerIdentity);
  await expect(peerGroup).toBeVisible();
  await expect(peerGroup).not.toHaveClass(/offline/);
  await expect.poll(() => peerSessionRequests).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Settings" }).click();
  const enumerationFailures = [
    { mode: "transport-failure", status: /failed/i },
    { mode: "malformed-envelope", status: "tailnet candidate enumeration response is malformed" },
    { mode: "error-envelope", status: "failed to query tailscale" },
  ] as const;
  for (const failure of enumerationFailures) {
    candidateMode = failure.mode;
    const requestsBeforeFailure = peerSessionRequests;
    await page.getByRole("button", { name: "Discover Tailnet" }).click();
    await expect(page.locator("#discover-status")).toContainText(failure.status);
    await expect(page.locator("#machines-list .dot")).toHaveAttribute("title", "tailnet candidate enumeration unavailable");
    await expect(peerGroup).toHaveCount(0);
    await page.waitForTimeout(100);
    // The generation-start replacement may capture the formerly-ready peer
    // before the failed enumeration revokes its route; its stale result cannot apply.
    expect(peerSessionRequests).toBe(requestsBeforeFailure + 1);

    candidateMode = "valid";
    await page.getByRole("button", { name: "Discover Tailnet" }).click();
    await expect(peerGroup).toHaveCount(1);
    await expect.poll(() => peerSessionRequests).toBeGreaterThan(requestsBeforeFailure);
  }
});

test("does not let an older delayed probe restore authority after a newer enumeration failure", async ({ page }) => {
  let candidateMode: "valid" | "error" = "valid";
  let holdNextHandshake = false;
  let olderHandshakeStarted = false;
  let releaseOlderHandshake: () => void = () => {};
  const olderHandshakeReleased = new Promise<void>((resolve) => {
    releaseOlderHandshake = resolve;
  });
  let peerSessionRequests = 0;
  let peerPtyRequests = 0;

  await page.route("**/api/tailnet/v1/candidates", async (route) => {
    if (candidateMode === "error") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ candidates: [], error: "newer enumeration failed" }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ candidates: [
        { hostname: "peer.example.ts.net", tailnetNodeId: "n-peer", origin: "https://peer.example.ts.net", online: true },
      ] }),
    });
  });
  await page.route("https://peer.example.ts.net/api/machine", async (route) => {
    if (holdNextHandshake) {
      holdNextHandshake = false;
      olderHandshakeStarted = true;
      await olderHandshakeReleased;
    }
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: {
          tailnetNodeId: "n-peer",
          installationId,
          displayName: "verified peer",
          origin: "https://peer.example.ts.net",
        },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    });
  });
  await page.route("https://peer.example.ts.net/api/sessions", async (route) => {
    peerSessionRequests++;
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ sessions: [] }),
    });
  });
  page.on("request", (request) => {
    if (request.url().includes("https://peer.example.ts.net/ws/pty")) peerPtyRequests++;
  });

  await page.goto(server.baseUrl);
  const peerGroup = visibleMachineGroup(page, peerIdentity);
  await expect(peerGroup).toBeVisible();
  await expect(peerGroup).not.toHaveClass(/offline/);
  await expect.poll(() => peerSessionRequests).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Settings" }).click();
  holdNextHandshake = true;
  await page.getByRole("button", { name: "Discover Tailnet" }).click();
  await expect.poll(() => olderHandshakeStarted).toBe(true);

  candidateMode = "error";
  await page.getByRole("button", { name: "Discover Tailnet" }).click();
  await expect(page.locator("#discover-status")).toContainText("newer enumeration failed");
  await expect(peerGroup).toHaveCount(0);
  const sessionRequestsAfterRevocation = peerSessionRequests;

  releaseOlderHandshake();
  await page.waitForTimeout(150);

  await expect(peerGroup).toHaveCount(0);
  await expect(page.locator("#machines-list .dot")).toHaveAttribute("title", "tailnet candidate enumeration unavailable");
  expect(peerSessionRequests).toBe(sessionRequestsAfterRevocation);
  expect(peerPtyRequests).toBe(0);
});

test("does not let a stale session response restore a peer revoked by a newer refresh", async ({ page }) => {
  let candidateMode: "valid" | "error" = "valid";
  let holdSessionResponse = false;
  let staleSessionRequestStarted = false;
  let releaseStaleSessionResponse: () => void = () => {};
  const staleSessionResponseReleased = new Promise<void>((resolve) => {
    releaseStaleSessionResponse = resolve;
  });

  await page.route("**/api/tailnet/v1/candidates", async (route) => {
    if (candidateMode === "error") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ candidates: [], error: "newer enumeration failed" }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ candidates: [
        { hostname: "peer.example.ts.net", tailnetNodeId: "n-peer", origin: "https://peer.example.ts.net", online: true },
      ] }),
    });
  });
  await page.route("https://peer.example.ts.net/api/machine", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: {
          tailnetNodeId: "n-peer",
          installationId,
          displayName: "verified peer",
          origin: "https://peer.example.ts.net",
        },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    });
  });
  await page.route("https://peer.example.ts.net/api/sessions", async (route) => {
    if (holdSessionResponse) {
      holdSessionResponse = false;
      staleSessionRequestStarted = true;
      await staleSessionResponseReleased;
      await route.fulfill({
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ sessions: [{ name: "stale peer session", lastLine: "stale", triage: "idle" }] }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ sessions: [] }),
    });
  });

  await page.goto(server.baseUrl);
  const peerGroup = visibleMachineGroup(page, peerIdentity);
  await expect(peerGroup).toBeVisible();
  await expect(peerGroup).not.toHaveClass(/offline/);

  await page.getByRole("button", { name: "Settings" }).click();
  holdSessionResponse = true;
  await page.getByRole("button", { name: "Discover Tailnet" }).click();
  await expect.poll(() => staleSessionRequestStarted).toBe(true);

  candidateMode = "error";
  await page.getByRole("button", { name: "Discover Tailnet" }).click();
  await expect(page.locator("#discover-status")).toContainText("newer enumeration failed");
  releaseStaleSessionResponse();
  await expect(peerGroup).toHaveCount(0);
  await expect(visibleSessionList(page)).not.toContainText("stale peer session");
  await expect(visibleSessionList(page).locator(`[data-machine="${peerIdentity}"] [aria-label="Open stale peer session"]`)).toHaveCount(0);
});

test("does not let an older probe failure overwrite a newer ready peer", async ({ page }) => {
  let holdOlderProbe = false;
  let olderProbeStarted = false;
  let olderFailureSettled = false;
  let releaseOlderProbe: () => void = () => {};
  const olderProbeReleased = new Promise<void>((resolve) => {
    releaseOlderProbe = resolve;
  });

  await page.route("**/api/tailnet/v1/candidates", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ candidates: [
        { hostname: "peer.example.ts.net", tailnetNodeId: "n-peer", origin: "https://peer.example.ts.net", online: true },
      ] }),
    });
  });
  await page.route("https://peer.example.ts.net/api/machine", async (route) => {
    if (holdOlderProbe) {
      holdOlderProbe = false;
      olderProbeStarted = true;
      await olderProbeReleased;
      await route.fulfill({ status: 503 });
      olderFailureSettled = true;
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: {
          tailnetNodeId: "n-peer",
          installationId,
          displayName: "verified peer",
          origin: "https://peer.example.ts.net",
        },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    });
  });
  await page.route("https://peer.example.ts.net/api/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ sessions: [] }),
    });
  });

  await page.goto(server.baseUrl);
  const peerGroup = visibleMachineGroup(page, peerIdentity);
  await expect(peerGroup).toBeVisible();
  await expect(peerGroup).not.toHaveClass(/offline/);

  await page.getByRole("button", { name: "Settings" }).click();
  holdOlderProbe = true;
  await page.getByRole("button", { name: "Discover Tailnet" }).click();
  await expect.poll(() => olderProbeStarted).toBe(true);

  await page.getByRole("button", { name: "Discover Tailnet" }).click();
  await expect(peerGroup).not.toHaveClass(/offline/);
  await expect(page.locator("#machines-list .dot")).toHaveAttribute("title", "online");
  await expect(page.locator("#discover-status")).toHaveText("Found 1 ready Tailnet machine");

  releaseOlderProbe();
  await expect.poll(() => olderFailureSettled).toBe(true);

  await expect(peerGroup).not.toHaveClass(/offline/);
  await expect(page.locator("#machines-list .dot")).toHaveAttribute("title", "online");
  await expect(page.locator("#discover-status")).toHaveText("Found 1 ready Tailnet machine");
  await expect(peerGroup).not.toHaveClass(/offline/);
});

test("renders local and a verified peer while a malformed candidate stays non-routable", async ({ page }) => {
  let malformedSessionsRequested = false;
  let legacyUrlFetched = false;
  let candidateRequests = 0;
  let peerHandshakeRequests = 0;
  await page.addInitScript(() => {
    localStorage.setItem("wolfpack-machines", JSON.stringify([
      { name: "stored attacker", url: "https://evil.example" },
    ]));
  });
  await page.route("https://evil.example/**", async (route) => {
    legacyUrlFetched = true;
    await route.abort();
  });
  await page.route("**/api/tailnet/v1/candidates", async (route) => {
    candidateRequests++;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        candidates: [
          { hostname: "peer.example.ts.net", tailnetNodeId: "n-peer", origin: "https://peer.example.ts.net", online: true },
          { hostname: "bad.example.ts.net", tailnetNodeId: "n-bad", origin: "https://bad.example.ts.net", online: true },
        ],
      }),
    });
  });
  await page.route("https://peer.example.ts.net/api/machine", async (route) => {
    peerHandshakeRequests++;
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: {
          tailnetNodeId: "n-peer",
          installationId,
          displayName: "verified peer",
          origin: "https://peer.example.ts.net",
        },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    });
  });
  await page.route("https://peer.example.ts.net/api/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ sessions: [] }),
    });
  });
  await page.route("https://bad.example.ts.net/api/machine", async (route) => {
    await route.fulfill({ contentType: "text/plain", headers: { "Access-Control-Allow-Origin": "*" }, body: "not JSON" });
  });
  await page.route("https://bad.example.ts.net/api/sessions", async (route) => {
    malformedSessionsRequested = true;
    await route.abort();
  });

  await page.goto(server.baseUrl);

  await expect.poll(() => candidateRequests).toBeGreaterThan(0);
  await expect.poll(() => peerHandshakeRequests).toBeGreaterThan(0);
  await expect(visibleMachineGroup(page, peerIdentity)).toBeVisible();
  await expect(visibleSessionList(page)).toContainText("test-project");
  await expect(visibleMachineGroup(page, "candidate:n-bad")).toHaveCount(0);
  expect(malformedSessionsRequested).toBe(false);
  expect(legacyUrlFetched).toBe(false);
});

test("enrolls notifications only after navigating to a currently ready verified peer", async ({ page }) => {
  const peerOrigin = "https://peer.example.ts.net";
  const badOrigin = "https://bad.example.ts.net";
  let candidateMode: "valid" | "error" = "valid";
  const peerPushRequests: string[] = [];

  await page.addInitScript(() => {
    const testWindow = window as unknown as { serviceWorkerRegistrationUrls: string[] };
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      get: () => "granted",
    });
    Object.defineProperty(window, "PushManager", {
      configurable: true,
      value: class PushManager {},
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve(),
        getRegistration: async () => undefined,
        register: async (url: string) => {
          testWindow.serviceWorkerRegistrationUrls ??= [];
          testWindow.serviceWorkerRegistrationUrls.push(url);
          return {
            pushManager: {
              subscribe: async () => ({
                toJSON: () => ({
                  endpoint: "https://push.example.test/subscription",
                  keys: { p256dh: "key", auth: "auth" },
                }),
              }),
            },
          };
        },
      },
    });
  });

  await page.route("**/api/tailnet/v1/candidates", async (route) => {
    if (new URL(route.request().url()).origin === peerOrigin) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ candidates: [] }) });
      return;
    }
    if (candidateMode === "error") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ candidates: [], error: "authority revoked" }) });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ candidates: [
        { hostname: "peer.example.ts.net", tailnetNodeId: "n-peer", origin: peerOrigin, online: true },
        { hostname: "bad.example.ts.net", tailnetNodeId: "n-bad", origin: badOrigin, online: true },
      ] }),
    });
  });
  await page.route(`${peerOrigin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/machine") {
      await route.fulfill({
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
          machine: { tailnetNodeId: "n-peer", installationId, displayName: "verified peer", origin: peerOrigin },
          wolfpack: { version: "1.7.0" },
          capabilities: ["sessions", "terminal-websocket", "push-subscription"],
        }),
      });
      return;
    }
    if (url.pathname === "/api/sessions") {
      await route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ sessions: [] }) });
      return;
    }
    if (url.pathname === "/api/push/vapid-key") {
      peerPushRequests.push(`${route.request().method()} ${url.href}`);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ publicKey: "AQID" }) });
      return;
    }
    if (url.pathname === "/api/push/subscribe") {
      peerPushRequests.push(`${route.request().method()} ${url.href}`);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
      return;
    }
    const asset = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    try {
      await route.fulfill({ path: join(PUBLIC_DIRECTORY, asset) });
    } catch {
      await route.abort();
    }
  });
  await page.route(`${badOrigin}/api/machine`, async (route) => {
    await route.fulfill({ contentType: "text/plain", headers: { "Access-Control-Allow-Origin": "*" }, body: "not JSON" });
  });

  await page.goto(server.baseUrl);
  await expect(visibleMachineGroup(page, peerIdentity)).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();

  const readyAction = page.getByRole("button", { name: "Set up notifications on verified peer" });
  await expect(readyAction).toBeVisible();
  await expect(page.getByRole("button", { name: /Set up notifications on/ })).toHaveCount(1);
  const staleAction = await readyAction.elementHandle();

  candidateMode = "error";
  await page.getByRole("button", { name: "Discover Tailnet" }).click();
  await expect(page.locator("#discover-status")).toContainText("authority revoked");
  await expect(readyAction).toHaveCount(0);
  await staleAction?.evaluate((button) => {
    if (button instanceof HTMLButtonElement) button.click();
  });
  await expect(page).toHaveURL(server.baseUrl + "/");
  await expect(page.locator("#discover-status")).toContainText("no longer ready");

  candidateMode = "valid";
  await page.getByRole("button", { name: "Discover Tailnet" }).click();
  await expect(readyAction).toBeVisible();
  await readyAction.click();
  await expect(page).toHaveURL(`${peerOrigin}/#settings-effects`);
  expect(peerPushRequests).toEqual([]);

  const notificationToggle = page.locator("#setting-notifications");
  await expect(notificationToggle).toBeVisible();
  await notificationToggle.check();
  await expect(page.locator("#notification-setting-status")).toContainText("Notifications are enabled");
  expect(peerPushRequests).toEqual([
    `GET ${peerOrigin}/api/push/vapid-key`,
    `POST ${peerOrigin}/api/push/subscribe`,
  ]);
  expect(await page.evaluate(() => (
    (window as unknown as { serviceWorkerRegistrationUrls: string[] }).serviceWorkerRegistrationUrls
  ))).toEqual([`${peerOrigin}/sw.js`]);
  expect(peerPushRequests.every((request) => request.includes(peerOrigin))).toBe(true);
  expect(peerPushRequests.some((request) => request.includes(badOrigin) || request.includes(server.baseUrl))).toBe(false);
});

test("replacement filters a mixed suspended grid without disrupting an unrelated focused delegation workspace", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "manual and delegation grids are desktop-only");
  const replacementInstallationId = "3bf9bf3a-d5fe-45fa-8a88-8a1e24963e75";
  const replacementIdentity = `n-peer:${replacementInstallationId}`;
  const otherInstallationId = "ea8838c7-6721-465e-af64-6378be6a9501";
  const otherIdentity = `n-other:${otherInstallationId}`;
  let activeInstallationId = installationId;

  await installReplacementSocketHarness(page);
  await page.route("**/api/tailnet/v1/candidates", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ candidates: [
        { hostname: "peer.example.ts.net", tailnetNodeId: "n-peer", origin: "https://peer.example.ts.net", online: true },
        { hostname: "other.example.ts.net", tailnetNodeId: "n-other", origin: "https://other.example.ts.net", online: true },
      ] }),
    });
  });
  await page.route("https://peer.example.ts.net/api/machine", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: {
          tailnetNodeId: "n-peer",
          installationId: activeInstallationId,
          displayName: "verified peer",
          origin: "https://peer.example.ts.net",
        },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    });
  });
  await page.route("https://other.example.ts.net/api/machine", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: { tailnetNodeId: "n-other", installationId: otherInstallationId, displayName: "other peer", origin: "https://other.example.ts.net" },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    });
  });
  await page.route("**/api/sessions", async (route) => {
    const origin = new URL(route.request().url()).origin;
    const sessions = origin === "https://peer.example.ts.net"
      ? [{ name: "old-manual-one", triage: "idle" }]
      : origin === "https://other.example.ts.net"
        ? [{ name: "other-manual", triage: "idle" }]
        : [
          { name: "local-standalone", triage: "idle" },
          { name: "local-parent", triage: "running", identity: { wolfpackSessionId: "local-parent-id", wolfpackSessionName: "local-parent" } },
          {
            name: "local-child",
            triage: "idle",
            identity: {
              wolfpackSessionId: "local-child-id",
              wolfpackSessionName: "local-child",
              parentSession: { wolfpackSessionId: "local-parent-id", wolfpackSessionName: "local-parent" },
            },
          },
        ];
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ sessions }),
    });
  });

  await page.goto(server.baseUrl);
  await expect(visibleMachineGroup(page, peerIdentity)).toBeVisible();
  await expect(visibleMachineGroup(page, otherIdentity)).toBeVisible();
  await visibleSessionList(page).getByRole("button", { name: "Expand 1 child agent" }).click();
  await expect(visibleSessionList(page).getByRole("button", { name: "Open local-child" })).toBeVisible();
  await openSessionFromUi(page, "old-manual-one", peerIdentity);
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as ReplacementSocketWindow).__replacementSockets?.length ?? 0
  ))).toBe(1);
  await page.evaluate(() => {
    const socket = (window as unknown as ReplacementSocketWindow).__replacementSockets?.[0];
    if (!socket) throw new Error("missing initial peer socket");
    socket.open();
    socket.serverText(JSON.stringify({ type: "attach_ack" }));
    socket.serverText(JSON.stringify({ type: "prefill_done" }));
    socket.serverText(JSON.stringify({ type: "pty_ready" }));
  });
  await toggleSessionGridFromUi(page, "local-standalone", "");
  await toggleSessionGridFromUi(page, "other-manual", otherIdentity);
  await expect.poll(() => gridSessionNames(page)).toEqual(["old-manual-one", "local-standalone", "other-manual"]);
  await openSessionFromUi(page, "local-child");
  await expect(page.locator("#delegation-focus-toolbar")).toBeVisible();
  await expect(page.locator("#delegation-grid-container .grid-cell-label")).toHaveText(["local-parent", "local-child"]);
  await expect.poll(() => gridSessionNames(page)).toEqual([]);
  const socketsBeforeReplacement = await page.evaluate(() => {
    const sockets = (window as unknown as ReplacementSocketWindow).__replacementSockets ?? [];
    return { count: sockets.length, closeCounts: sockets.map(socket => socket.closeCount) };
  });

  activeInstallationId = replacementInstallationId;
  await clickRetryMachine(page, peerIdentity);

  await expect.poll(() => page.evaluate(() => {
    const sockets = (window as unknown as ReplacementSocketWindow).__replacementSockets ?? [];
    return { socketCount: sockets.length, closeCounts: sockets.map(socket => socket.closeCount) };
  })).toEqual({
    socketCount: socketsBeforeReplacement.count,
    closeCounts: socketsBeforeReplacement.closeCounts,
  });
  await expect(page.locator("#delegation-focus-toolbar")).toBeVisible();
  await expect(visibleMachineGroup(page, peerIdentity)).toHaveCount(0);
  await expect(visibleMachineGroup(page, replacementIdentity)).toHaveCount(1);
});

test("replacement retires only old-peer members from a mixed active manual grid", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "manual grids are desktop-only");
  const replacementInstallationId = "3bf9bf3a-d5fe-45fa-8a88-8a1e24963e75";
  const replacementIdentity = `n-peer:${replacementInstallationId}`;
  const otherInstallationId = "ea8838c7-6721-465e-af64-6378be6a9501";
  const otherIdentity = `n-other:${otherInstallationId}`;
  let activeInstallationId = installationId;

  await installReplacementSocketHarness(page);
  await page.route("**/api/tailnet/v1/candidates", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ candidates: [
        { hostname: "peer.example.ts.net", tailnetNodeId: "n-peer", origin: "https://peer.example.ts.net", online: true },
        { hostname: "other.example.ts.net", tailnetNodeId: "n-other", origin: "https://other.example.ts.net", online: true },
      ] }),
    });
  });
  await page.route("https://peer.example.ts.net/api/machine", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: { tailnetNodeId: "n-peer", installationId: activeInstallationId, displayName: "replaced peer", origin: "https://peer.example.ts.net" },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    });
  });
  await page.route("https://other.example.ts.net/api/machine", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: { tailnetNodeId: "n-other", installationId: otherInstallationId, displayName: "other peer", origin: "https://other.example.ts.net" },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    });
  });
  await page.route("**/api/sessions", async (route) => {
    const origin = new URL(route.request().url()).origin;
    const sessions = origin === "https://peer.example.ts.net"
      ? [{ name: "old-peer-session", triage: "idle" }]
      : origin === "https://other.example.ts.net"
        ? [{ name: "other-peer-session", triage: "idle" }]
        : [{ name: "local-session", triage: "idle" }];
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ sessions }),
    });
  });

  await page.goto(server.baseUrl);
  await expect(page.getByRole("button", { name: "Open local-session" })).toBeVisible();
  await expect(visibleMachineGroup(page, peerIdentity)).toBeVisible();
  await expect(visibleMachineGroup(page, otherIdentity)).toBeVisible();
  await openSessionFromUi(page, "local-session");
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as ReplacementSocketWindow).__replacementSockets?.length ?? 0
  ))).toBe(1);
  await page.evaluate(() => {
    const socket = (window as unknown as ReplacementSocketWindow).__replacementSockets?.[0];
    if (!socket) throw new Error("missing local socket");
    socket.open();
    socket.serverText(JSON.stringify({ type: "attach_ack" }));
    socket.serverText(JSON.stringify({ type: "prefill_done" }));
    socket.serverText(JSON.stringify({ type: "pty_ready" }));
  });
  await toggleSessionGridFromUi(page, "old-peer-session", peerIdentity);
  await toggleSessionGridFromUi(page, "other-peer-session", otherIdentity);
  await expect.poll(() => gridSessionNames(page)).toEqual(["local-session", "old-peer-session", "other-peer-session"]);
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as ReplacementSocketWindow).__replacementSockets?.length ?? 0
  ))).toBe(4);
  await page.evaluate(() => {
    for (const socket of (window as unknown as ReplacementSocketWindow).__replacementSockets?.slice(1) ?? []) {
      socket.open();
      socket.serverText(JSON.stringify({ type: "attach_ack" }));
      socket.serverText(JSON.stringify({ type: "prefill_done" }));
      socket.serverText(JSON.stringify({ type: "pty_ready" }));
    }
  });
  const socketsBeforeReplacement = await page.evaluate(() => (
    (window as unknown as ReplacementSocketWindow).__replacementSockets?.map(socket => ({ url: socket.url, closeCount: socket.closeCount })) ?? []
  ));

  activeInstallationId = replacementInstallationId;
  await clickRetryMachine(page, peerIdentity);

  await expect.poll(() => page.locator("#desktop-grid-container .grid-cell").evaluateAll((cells) => cells.map((cell) => ({
    session: (cell as HTMLElement).dataset.session ?? "",
    machine: (cell as HTMLElement).dataset.machine ?? "",
  })))).toEqual([
    { session: "local-session", machine: "" },
    { session: "other-peer-session", machine: otherIdentity },
  ]);
  expect(await page.evaluate(() => (
    (window as unknown as ReplacementSocketWindow).__replacementSockets?.map(socket => ({ url: socket.url, closeCount: socket.closeCount })) ?? []
  ))).toEqual(socketsBeforeReplacement.map(socket => ({
    url: socket.url,
    closeCount: socket.closeCount + (socket.url.includes("old-peer-session") ? 1 : 0),
  })));
  await expect(visibleMachineGroup(page, peerIdentity)).toHaveCount(0);
  await expect(visibleMachineGroup(page, replacementIdentity)).toHaveCount(1);
});

test("replacement keeps a sole healthy grid survivor connected and focused", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "manual grids are desktop-only");
  const replacementInstallationId = "3bf9bf3a-d5fe-45fa-8a88-8a1e24963e75";
  const replacementIdentity = `n-peer:${replacementInstallationId}`;
  let activeInstallationId = installationId;

  await installReplacementSocketHarness(page);
  await page.route("**/api/tailnet/v1/candidates", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ candidates: [
      { hostname: "peer.example.ts.net", tailnetNodeId: "n-peer", origin: "https://peer.example.ts.net", online: true },
    ] }) });
  });
  await page.route("https://peer.example.ts.net/api/machine", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: { tailnetNodeId: "n-peer", installationId: activeInstallationId, displayName: "replaced peer", origin: "https://peer.example.ts.net" },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    });
  });
  await page.route("**/api/sessions", async (route) => {
    const sessions = new URL(route.request().url()).origin === "https://peer.example.ts.net"
      ? [{ name: "old-peer-session", triage: "idle" }]
      : [{ name: "local-session", triage: "idle" }];
    await route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ sessions }) });
  });

  await page.goto(server.baseUrl);
  await expect(page.getByRole("button", { name: "Open local-session" })).toBeVisible();
  await expect(visibleMachineGroup(page, peerIdentity)).toBeVisible();
  await openSessionFromUi(page, "local-session");
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as ReplacementSocketWindow).__replacementSockets?.length ?? 0
  ))).toBe(1);
  await page.evaluate(() => {
    const socket = (window as unknown as ReplacementSocketWindow).__replacementSockets?.[0];
    if (!socket) throw new Error("missing local socket");
    socket.open();
    socket.serverText(JSON.stringify({ type: "attach_ack" }));
    socket.serverText(JSON.stringify({ type: "prefill_done" }));
    socket.serverText(JSON.stringify({ type: "pty_ready" }));
  });
  await toggleSessionGridFromUi(page, "old-peer-session", peerIdentity);
  await expect.poll(() => gridSessionNames(page)).toEqual(["local-session", "old-peer-session"]);
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as ReplacementSocketWindow).__replacementSockets?.length ?? 0
  ))).toBe(3);
  await page.evaluate(() => {
    for (const socket of (window as unknown as ReplacementSocketWindow).__replacementSockets?.slice(1) ?? []) {
      socket.open();
      socket.serverText(JSON.stringify({ type: "attach_ack" }));
      socket.serverText(JSON.stringify({ type: "prefill_done" }));
      socket.serverText(JSON.stringify({ type: "pty_ready" }));
    }
  });
  const beforeReplacement = await page.evaluate(() => (
    (window as unknown as ReplacementSocketWindow).__replacementSockets?.map(socket => ({ url: socket.url, closeCount: socket.closeCount })) ?? []
  ));

  activeInstallationId = replacementInstallationId;
  await clickRetryMachine(page, peerIdentity);

  await expect.poll(() => page.locator("#desktop-grid-container .grid-cell").evaluateAll((cells) => cells.map((cell) => ({
    session: (cell as HTMLElement).dataset.session ?? "",
    machine: (cell as HTMLElement).dataset.machine ?? "",
  })))).toEqual([{ session: "local-session", machine: "" }]);
  expect(await page.evaluate(() => (
    (window as unknown as ReplacementSocketWindow).__replacementSockets?.map(socket => ({ url: socket.url, closeCount: socket.closeCount })) ?? []
  ))).toEqual(beforeReplacement.map(socket => ({
    url: socket.url,
    closeCount: socket.closeCount + (socket.url.includes("old-peer-session") ? 1 : 0),
  })));
  const sentBeforeInput = await page.evaluate(() => {
    const socket = (window as unknown as ReplacementSocketWindow).__replacementSockets
      ?.find(candidate => candidate.url.includes("local-session&reset=1"));
    if (!socket) throw new Error("missing surviving local socket");
    return socket.sent.length;
  });
  await page.keyboard.type("x");
  await expect.poll(() => page.evaluate(() => {
    const socket = (window as unknown as ReplacementSocketWindow).__replacementSockets
      ?.find(candidate => candidate.url.includes("local-session&reset=1"));
    return socket?.sent.length ?? 0;
  })).toBeGreaterThan(sentBeforeInput);
  await expect(visibleMachineGroup(page, peerIdentity)).toHaveCount(0);
  await expect(visibleMachineGroup(page, replacementIdentity)).toHaveCount(1);
});

test("replacement clears an all-old active grid and returns to sessions", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "manual grids are desktop-only");
  const replacementInstallationId = "3bf9bf3a-d5fe-45fa-8a88-8a1e24963e75";
  const replacementIdentity = `n-peer:${replacementInstallationId}`;
  let activeInstallationId = installationId;

  await installReplacementSocketHarness(page);
  await page.route("**/api/tailnet/v1/candidates", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ candidates: [
      { hostname: "peer.example.ts.net", tailnetNodeId: "n-peer", origin: "https://peer.example.ts.net", online: true },
    ] }) });
  });
  await page.route("https://peer.example.ts.net/api/machine", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: { tailnetNodeId: "n-peer", installationId: activeInstallationId, displayName: "replaced peer", origin: "https://peer.example.ts.net" },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    });
  });
  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ sessions: [
        { name: "old-peer-one", triage: "idle" },
        { name: "old-peer-two", triage: "idle" },
      ] }),
    });
  });

  await page.goto(server.baseUrl);
  await expect(visibleMachineGroup(page, peerIdentity)).toBeVisible();
  await openSessionFromUi(page, "old-peer-one", peerIdentity);
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as ReplacementSocketWindow).__replacementSockets?.length ?? 0
  ))).toBe(1);
  await page.evaluate(() => {
    const socket = (window as unknown as ReplacementSocketWindow).__replacementSockets?.[0];
    if (!socket) throw new Error("missing first old-peer socket");
    socket.open();
    socket.serverText(JSON.stringify({ type: "attach_ack" }));
    socket.serverText(JSON.stringify({ type: "prefill_done" }));
    socket.serverText(JSON.stringify({ type: "pty_ready" }));
  });
  await toggleSessionGridFromUi(page, "old-peer-two", peerIdentity);
  await expect.poll(() => gridSessionNames(page)).toEqual(["old-peer-one", "old-peer-two"]);
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as ReplacementSocketWindow).__replacementSockets?.length ?? 0
  ))).toBe(3);
  const beforeReplacement = await page.evaluate(() => (
    (window as unknown as ReplacementSocketWindow).__replacementSockets?.map(socket => ({ url: socket.url, closeCount: socket.closeCount })) ?? []
  ));

  activeInstallationId = replacementInstallationId;
  await clickRetryMachine(page, peerIdentity);

  await expect.poll(() => gridSessionNames(page)).toEqual([]);
  await expect(page.locator("#terminal-view")).not.toHaveClass(/visible/);
  expect(await page.evaluate(() => (
    (window as unknown as ReplacementSocketWindow).__replacementSockets?.map(socket => ({ url: socket.url, closeCount: socket.closeCount })) ?? []
  ))).toEqual(beforeReplacement.map(socket => ({
    url: socket.url,
    closeCount: socket.closeCount + (socket.url.includes("reset=1") || socket.url.includes("old-peer-two") ? 1 : 0),
  })));
  await expect(visibleMachineGroup(page, peerIdentity)).toHaveCount(0);
  await expect(visibleMachineGroup(page, replacementIdentity)).toHaveCount(1);
});

test("retires an active terminal when a verified peer installation is replaced", async ({ page }) => {
  const replacementInstallationId = "3bf9bf3a-d5fe-45fa-8a88-8a1e24963e75";
  const replacementIdentity = `n-peer:${replacementInstallationId}`;
  let activeInstallationId = installationId;
  const pageErrors: Error[] = [];

  await installReplacementSocketHarness(page);
  page.on("pageerror", error => pageErrors.push(error));
  await page.route("**/api/tailnet/v1/candidates", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ candidates: [
        { hostname: "peer.example.ts.net", tailnetNodeId: "n-peer", origin: "https://peer.example.ts.net", online: true },
      ] }),
    });
  });
  await page.route("https://peer.example.ts.net/api/machine", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: {
          tailnetNodeId: "n-peer",
          installationId: activeInstallationId,
          displayName: "verified peer",
          origin: "https://peer.example.ts.net",
        },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    });
  });
  await page.route("https://peer.example.ts.net/api/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ sessions: [{ name: "peer-session", triage: "idle" }] }),
    });
  });

  await page.goto(server.baseUrl);
  await expect(visibleMachineGroup(page, peerIdentity)).toBeVisible();
  await openSessionFromUi(page, "peer-session", peerIdentity);
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as { __replacementSockets?: unknown[] }).__replacementSockets?.length ?? 0
  ))).toBe(1);
  await page.evaluate(() => {
    const socket = (window as unknown as {
      __replacementSockets: Array<{ open(): void; serverText(data: string): void }>;
    }).__replacementSockets[0];
    if (!socket) throw new Error("missing initial peer socket");
    socket.open();
    socket.serverText(JSON.stringify({ type: "attach_ack" }));
    socket.serverText(JSON.stringify({ type: "prefill_done" }));
    socket.serverText(JSON.stringify({ type: "pty_ready" }));
  });

  activeInstallationId = replacementInstallationId;
  await clickRetryMachine(page, peerIdentity);

  await expect(page.locator("#terminal-view")).not.toHaveClass(/visible/);
  await expect(page.locator("#desktop-terminal-container canvas")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as { __replacementSockets: Array<{ closeCount: number }> }).__replacementSockets[0]?.closeCount ?? 0
  ))).toBe(1);
  await expect(visibleMachineGroup(page, peerIdentity)).toHaveCount(0);
  await expect(visibleMachineGroup(page, replacementIdentity)).toHaveCount(1);
  await expect(visibleMachineGroup(page, replacementIdentity)).toBeVisible();

  await page.evaluate(() => {
    const socket = (window as unknown as {
      __replacementSockets: Array<{ forceClose(): void }>;
    }).__replacementSockets[0];
    if (!socket) throw new Error("missing retired peer socket");
    socket.forceClose();
  });
  await page.waitForTimeout(650);
  expect(await page.evaluate(() => (
    (window as unknown as { __replacementSockets: unknown[] }).__replacementSockets.length
  ))).toBe(1);
  expect(pageErrors).toEqual([]);
});

test("replaces an invalidated initial local session load after empty Tailnet enumeration", async ({ page }) => {
  let sessionRequests = 0;
  let firstSessionRequestStarted = false;
  let releaseFirstSessionRequest: () => void = () => {};
  const firstSessionRequestReleased = new Promise<void>((resolve) => {
    releaseFirstSessionRequest = resolve;
  });

  await page.route("**/api/tailnet/v1/candidates", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ candidates: [] }),
    });
  });
  await page.route("**/api/sessions", async (route) => {
    sessionRequests++;
    if (sessionRequests === 1) {
      firstSessionRequestStarted = true;
      await firstSessionRequestReleased;
    }
    await route.continue();
  });

  await page.goto(server.baseUrl);
  await expect.poll(() => firstSessionRequestStarted).toBe(true);
  releaseFirstSessionRequest();

  await expect.poll(() => sessionRequests, { timeout: 1_000 }).toBe(2);
  await expect(page.getByRole("button", { name: "Open test-project" })).toBeVisible();

});

test("creates a remote session through a ready stable identity and fails closed after revocation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "remote creation routing is browser-layout independent");
  const peerOrigin = "https://peer.example.ts.net";
  let candidateMode: "ready" | "revoked" = "ready";
  let sessionCreated = false;
  const remoteCreateRequests: unknown[] = [];
  const remoteDirectoryRequests: string[] = [];
  const localCreateRequests: string[] = [];
  const localDirectoryRequests: string[] = [];
  const pageErrors: Error[] = [];

  await installReplacementSocketHarness(page);
  page.on("pageerror", (error) => pageErrors.push(error));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== server.baseUrl) return;
    if (url.pathname === "/api/create") localCreateRequests.push(request.url());
    if (url.pathname === "/api/directories") localDirectoryRequests.push(request.url());
  });
  await page.route("**/api/tailnet/v1/candidates", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(candidateMode === "ready"
        ? { candidates: [{ hostname: "peer.example.ts.net", tailnetNodeId: "n-peer", origin: peerOrigin, online: true }] }
        : { candidates: [], error: "peer authority revoked" }),
    });
  });
  await page.route(`${peerOrigin}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "content-type",
          "Access-Control-Allow-Methods": "GET, POST",
        },
      });
      return;
    }

    let body: unknown;
    switch (url.pathname) {
      case "/api/machine":
        body = {
          protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
          machine: { tailnetNodeId: "n-peer", installationId, displayName: "verified peer", origin: peerOrigin },
          wolfpack: { version: "1.7.0" },
          capabilities: ["sessions", "terminal-websocket", "push-subscription"],
        };
        break;
      case "/api/sessions":
        body = { sessions: sessionCreated ? [{ name: "remote-created", triage: "idle" }] : [] };
        break;
      case "/api/projects":
        body = { projects: ["remote-project"] };
        break;
      case "/api/settings":
        body = { settings: { cmds: [{ cmd: "shell", enabled: true }] }, effective: { cmds: ["shell"], agentCmd: "shell" } };
        break;
      case "/api/directories":
        remoteDirectoryRequests.push(request.url());
        body = { current: "/remote/worktree", parent: "/remote", directories: [] };
        break;
      case "/api/next-session-name":
        body = { name: "remote-created" };
        break;
      case "/api/create":
        remoteCreateRequests.push(request.postDataJSON());
        sessionCreated = true;
        body = { session: "remote-created" };
        break;
      default:
        await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "unexpected peer API" }) });
        return;
    }
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(body),
    });
  });

  await page.goto(server.baseUrl);
  const peerGroup = visibleMachineGroup(page, peerIdentity);
  await expect(peerGroup).toBeVisible();
  await peerGroup.getByRole("button", { name: "Start a session on verified peer" }).click();
  await page.getByRole("button", { name: "Browse server directories" }).click();
  const directoryDialog = page.getByRole("dialog", { name: "Browse server directories" });
  await expect(directoryDialog.getByText("/remote/worktree", { exact: true })).toBeVisible();
  await directoryDialog.getByRole("button", { name: "Open folder" }).click();
  await expect(page.locator("#session-name-input")).toHaveValue("remote-created");
  await page.getByRole("button", { name: "Start shell" }).click();

  await expect.poll(() => remoteCreateRequests).toEqual([{
    projectDir: "/remote/worktree",
    cmd: "shell",
    sessionName: "remote-created",
  }]);
  expect(remoteDirectoryRequests).toEqual(["https://peer.example.ts.net/api/directories"]);
  await expect.poll(() => terminalSnapshot(page)).toEqual({ session: "remote-created", terminalVisible: true });
  const ptyDestinations = (): Promise<string[]> => page.evaluate(() => (
    (window as unknown as ReplacementSocketWindow).__replacementSockets?.map((socket) => socket.url) ?? []
  ));
  await expect.poll(ptyDestinations).toEqual(["wss://peer.example.ts.net/ws/pty?session=remote-created"]);
  expect(localCreateRequests).toEqual([]);
  expect(localDirectoryRequests).toEqual([]);

  await openProjectPickerFromUi(page, peerIdentity);
  await page.getByRole("button", { name: "Open project remote-project" }).click();
  await expect(page.getByRole("button", { name: "Start shell" })).toBeVisible();
  const socketsBeforeRevokedCreate = await ptyDestinations();

  candidateMode = "revoked";
  await clickRetryMachine(page, peerIdentity);
  await expect(peerGroup).toHaveCount(0);
  await page.getByRole("button", { name: "Start shell" }).click();
  await expect(page.locator("#agent-create-error")).toContainText("selected peer is not ready");

  expect(remoteCreateRequests).toHaveLength(1);
  expect(localCreateRequests).toEqual([]);
  expect(await ptyDestinations()).toEqual(socketsBeforeRevokedCreate);
  expect(pageErrors).toEqual([]);
});

test("routes peer mutation and PTY construction through a ready stable identity", async ({ page }) => {
  const peerOrigin = "https://peer.example.ts.net";
  const undiscoveredIdentity = "n-undiscovered:3bf9bf3a-d5fe-45fa-8a88-8a1e24963e75";
  const evilOrigin = "https://evil.example";
  let candidateMode: "ready" | "revoked" = "ready";
  const remoteKills: Array<{ readonly method: string; readonly url: string; readonly body: unknown }> = [];
  const apiDestinations: string[] = [];
  const unexpectedDestinations: string[] = [];
  const sourceKills: string[] = [];
  const pageErrors: Error[] = [];

  await installReplacementSocketHarness(page);
  page.on("pageerror", (error) => pageErrors.push(error));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) apiDestinations.push(`${request.method()} ${request.url()}`);
    if (url.origin === server.baseUrl && url.pathname === "/api/kill") sourceKills.push(request.url());
  });
  await page.route(`${evilOrigin}/**`, async (route) => {
    unexpectedDestinations.push(route.request().url());
    await route.abort();
  });
  await page.route("**/api/tailnet/v1/candidates", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(candidateMode === "ready"
        ? { candidates: [{ hostname: "peer.example.ts.net", tailnetNodeId: "n-peer", origin: peerOrigin, online: true }] }
        : { candidates: [], error: "peer authority revoked" }),
    });
  });
  await page.route(`${peerOrigin}/api/machine`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
        machine: { tailnetNodeId: "n-peer", installationId, displayName: "verified peer", origin: peerOrigin },
        wolfpack: { version: "1.7.0" },
        capabilities: ["sessions", "terminal-websocket", "push-subscription"],
      }),
    });
  });
  await page.route(`${peerOrigin}/api/sessions`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ sessions: [{ name: "peer-session", triage: "idle" }] }),
    });
  });
  await page.route(`${peerOrigin}/api/kill`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "content-type",
          "Access-Control-Allow-Methods": "POST",
        },
      });
      return;
    }
    remoteKills.push({
      method: route.request().method(),
      url: route.request().url(),
      body: route.request().postDataJSON(),
    });
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.goto(server.baseUrl);
  const peerGroup = visibleMachineGroup(page, peerIdentity);
  await expect(peerGroup).toBeVisible();

  await peerGroup.getByRole("button", { name: "Stop peer-session" }).click();
  await page.getByRole("dialog", { name: "Stop session" }).getByRole("button", { name: "Stop session" }).click();
  await expect.poll(() => remoteKills).toEqual([{
    method: "POST",
    url: `${peerOrigin}/api/kill`,
    body: { session: "peer-session" },
  }]);

  await peerGroup.getByRole("button", { name: "Open peer-session" }).click();
  const ptyDestinations = (): Promise<string[]> => page.evaluate(() => (
    (window as unknown as ReplacementSocketWindow).__replacementSockets?.map((socket) => socket.url) ?? []
  ));
  await expect.poll(ptyDestinations).toEqual(["wss://peer.example.ts.net/ws/pty?session=peer-session"]);
  await page.evaluate(() => {
    const socket = (window as unknown as ReplacementSocketWindow).__replacementSockets?.[0];
    if (!socket) throw new Error("missing initial peer socket");
    socket.open();
    socket.serverText(JSON.stringify({ type: "attach_ack" }));
    socket.serverText(JSON.stringify({ type: "prefill_done" }));
    socket.serverText(JSON.stringify({ type: "pty_ready" }));
  });
  await expect(page.locator("#conn-status")).toBeHidden();

  async function confirmRejectedOpen(machine: string): Promise<void> {
    const selectionBefore = await terminalSnapshot(page);
    const socketsBefore = await ptyDestinations();
    await openSessionFromUi(page, "blocked-session", machine);
    const dialog = page.getByRole("dialog", { name: "Machine unavailable" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect.poll(() => terminalSnapshot(page)).toEqual(selectionBefore);
    expect(await ptyDestinations()).toEqual(socketsBefore);
  }

  await confirmRejectedOpen(undiscoveredIdentity);
  await confirmRejectedOpen(evilOrigin);

  async function confirmRejectedStop(machine: string): Promise<void> {
    await clickKillSession(page, "blocked-session", machine);
    const dialog = page.getByRole("dialog", { name: "Stop session" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Stop session" }).click();
    const errorDialog = page.getByRole("dialog", { name: "Could not stop session" });
    await expect(errorDialog).toBeVisible();
    await errorDialog.getByRole("button", { name: "Close" }).click();
  }

  await confirmRejectedStop(undiscoveredIdentity);
  await confirmRejectedStop(evilOrigin);
  expect(remoteKills).toHaveLength(1);
  expect(sourceKills).toEqual([]);
  expect(unexpectedDestinations).toEqual([]);
  expect(apiDestinations.some((destination) => destination.includes(evilOrigin))).toBe(false);
  expect(apiDestinations.filter((destination) => destination.includes("/api/kill"))).toEqual([
    `POST ${peerOrigin}/api/kill`,
  ]);
  expect(await ptyDestinations()).toEqual(["wss://peer.example.ts.net/ws/pty?session=peer-session"]);

  candidateMode = "revoked";
  await clickRetryMachine(page, peerIdentity);
  await expect(peerGroup).toHaveCount(0);
  const intendedTerminal = await terminalSnapshot(page);
  const apiDestinationsAfterRevocation = [...apiDestinations];
  await page.evaluate(() => {
    const socket = (window as unknown as ReplacementSocketWindow).__replacementSockets?.[0];
    if (!socket) throw new Error("missing attached peer socket");
    socket.forceClose();
  });
  await page.waitForTimeout(800);
  expect(await ptyDestinations()).toEqual(["wss://peer.example.ts.net/ws/pty?session=peer-session"]);
  expect(apiDestinations).toEqual(apiDestinationsAfterRevocation);
  await expect(page.locator("#conn-status")).toContainText(/machine unavailable.*refresh tailnet discovery/i);
  await expect.poll(() => terminalSnapshot(page)).toEqual(intendedTerminal);
  await confirmRejectedStop(peerIdentity);
  await confirmRejectedOpen(peerIdentity);
  expect(remoteKills).toHaveLength(1);
  expect(sourceKills).toEqual([]);
  expect(unexpectedDestinations).toEqual([]);
  expect(apiDestinations.some((destination) => destination.includes(evilOrigin))).toBe(false);
  expect(pageErrors).toEqual([]);
});
