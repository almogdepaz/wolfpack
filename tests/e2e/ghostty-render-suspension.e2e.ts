import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type * as ResourceApi from "./fixtures/terminal-render-resources.ts";
import { openSessionFromUi, startTestServer, type TestServer } from "./helpers.ts";

interface RenderingTerm {
  readonly element: HTMLElement;
  readonly renderer: { render(...args: unknown[]): void };
  readonly wasmTerm?: { getCursor(): unknown };
  write(data: string, done?: () => void): void;
  onData(callback: (data: string) => void): unknown;
  open(element: HTMLElement): void;
}
interface RenderProbeWindow {
  Terminal: { prototype: RenderingTerm };
  parkedRenderProbe: {
    terminals: RenderingTerm[];
    renders: number;
    cursors: number;
    replies: string[];
  };
}

declare global {
  interface Window {
    __r5Resources?: Awaited<ReturnType<typeof ResourceApi.createResourceFixture>>;
    __r5WasmCounts: { compile: number; instantiate: number };
  }
}
let server: TestServer;
let fixtureDirectory: string;
let fixtureScript: Buffer;
test.beforeAll(async () => {
  fixtureDirectory = mkdtempSync("/tmp/wp-render-resource-fixture-");
  const output = join(fixtureDirectory, "fixture.js");
  execFileSync("bun", ["build", join(import.meta.dirname, "fixtures/terminal-render-resources.ts"), "--target=browser", `--outfile=${output}`], { stdio: "pipe" });
  fixtureScript = readFileSync(output);
  server = await startTestServer();
});
test.afterAll(async () => { await server?.close(); if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true }); });

async function loadResourceFixture(page: Page): Promise<void> {
  const baseline = process.env.WOLFPACK_RENDER_BASELINE_BUNDLE;
  const bundle = readFileSync(baseline ?? new URL("../../public/ghostty-web.bundle.js", import.meta.url));
  if (baseline) await page.route("**/ghostty-web.bundle.js*", route => route.fulfill({ body: bundle, contentType: "application/javascript" }));
  await page.route("**/__r5_resource_fixture__.js", route => route.fulfill({ body: fixtureScript, contentType: "application/javascript" }));
  await page.addInitScript(() => {
    localStorage.setItem("wolfpackDebug", "1");
    localStorage.setItem("wolfpackGhosttyPrewarmPoolSize", "0"); // fixture owns the real policy-sized prewarm pool
    const counts = window.__r5WasmCounts = { compile: 0, instantiate: 0 };
    WebAssembly.compile = new Proxy(WebAssembly.compile, { apply(target, receiver, args) { counts.compile++; return Reflect.apply(target, receiver, args); } });
    WebAssembly.instantiate = new Proxy(WebAssembly.instantiate, { apply(target, receiver, args) { counts.instantiate++; return Reflect.apply(target, receiver, args); } });
  });
  const served = page.waitForResponse(response => new URL(response.url()).pathname === "/ghostty-web.bundle.js");
  await page.goto(server.baseUrl);
  expect(createHash("sha256").update(await (await served).body()).digest("hex")).toBe(createHash("sha256").update(bundle).digest("hex"));
  await page.waitForFunction(() => typeof window.Terminal === "function");
}

test("parked application terminal stops renderer work while its parser and query replies remain live", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop production pool retains parked terminals; mobile cap remains one");
  await page.goto(server.baseUrl);
  await page.waitForFunction(() => typeof (window as unknown as RenderProbeWindow).Terminal === "function");
  await page.evaluate(() => {
    const runtime = window as unknown as RenderProbeWindow;
    const probe: RenderProbeWindow["parkedRenderProbe"] = { terminals: [], renders: 0, cursors: 0, replies: [] };
    runtime.parkedRenderProbe = probe;
    const open = runtime.Terminal.prototype.open;
    runtime.Terminal.prototype.open = function (element) {
      open.call(this, element);
      probe.terminals.push(this);
      if (probe.terminals.length !== 1) return;
      const renderer = this.renderer;
      const render = renderer.render.bind(renderer);
      renderer.render = (...args) => { probe.renders++; render(...args); };
      if (!this.wasmTerm) throw new Error("mounted real WASM terminal missing");
      const getCursor = this.wasmTerm.getCursor.bind(this.wasmTerm);
      this.wasmTerm.getCursor = () => { probe.cursors++; return getCursor(); };
      this.onData(data => probe.replies.push(data));
    };
  });
  await openSessionFromUi(page, "test-project");
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
  await openSessionFromUi(page, "another-project");
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
  const observation = await page.evaluate(async () => {
    const probe = (window as unknown as RenderProbeWindow).parkedRenderProbe;
    const parked = probe.terminals[0]!;
    if (parked.element.isConnected || !parked.wasmTerm) throw new Error("test did not park a retained terminal");
    probe.renders = 0; probe.cursors = 0; probe.replies.length = 0;
    parked.write("\r\nPARKED_PARSER_STAYS_LIVE\x1b[6n");
    // Observe ten actual visible-page animation frames, not an arbitrary sleep.
    await new Promise<void>(resolve => {
      let frames = 0;
      const next = () => { if (++frames === 10) resolve(); else requestAnimationFrame(next); };
      requestAnimationFrame(next);
    });
    return { renders: probe.renders, cursors: probe.cursors, replies: [...probe.replies] };
  });
  expect(observation.replies.some(data => /\x1b\[\d+;\d+R/.test(data))).toBe(true);
  expect(observation.renders).toBe(0);
  expect(observation.cursors).toBe(0);
  await openSessionFromUi(page, "test-project");
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
  expect(await page.evaluate(() => {
    const probe = (window as unknown as RenderProbeWindow).parkedRenderProbe;
    return { reused: probe.terminals.length === 2, connected: probe.terminals[0]!.element.isConnected, renders: probe.renders };
  })).toMatchObject({ reused: true, connected: true });
});

test("parked application socket keeps parser replies and cumulative output credit live", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop parked pool; mobile intentionally retains one terminal");
  const peers = new Map<string, { socket: WebSocketRoute; acks: number[]; stdin: string[]; outputBytes: number }>();
  await page.routeWebSocket(/\/ws\/pty/, socket => {
    const session = new URL(socket.url()).searchParams.get("session") ?? "";
    const peer = { socket, acks: [] as number[], stdin: [] as string[], outputBytes: 0 };
    peers.set(session, peer);
    socket.onMessage(message => {
      if (typeof message !== "string") { peer.stdin.push(message.toString("utf8")); return; }
      let frame: { type?: string; bytes?: number };
      try { frame = JSON.parse(message); } catch { peer.stdin.push(message); return; } // non-JSON terminal input
      if (frame.type === "ack" && typeof frame.bytes === "number") peer.acks.push(frame.bytes);
      if (frame.type !== "attach") return;
      socket.send(JSON.stringify({ type: "attach_ack", capabilities: ["output-ack"] }));
      const initial = Buffer.from("\x1b[?25lINITIAL_FRAME\r\n");
      peer.outputBytes += initial.byteLength; socket.send(initial);
      socket.send(JSON.stringify({ type: "prefill_done" }));
      socket.send(JSON.stringify({ type: "pty_ready" }));
    });
  });
  await page.goto(server.baseUrl);
  await openSessionFromUi(page, "test-project", "");
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
  await openSessionFromUi(page, "another-project", "");
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
  const parked = peers.get("test-project");
  if (!parked) throw new Error("missing parked production socket");
  const payload = Buffer.from(`${"x".repeat(70 * 1024)}\r\nPARKED_SOCKET_PARSER_\u754c\x1b[6n`);
  parked.outputBytes += payload.byteLength;
  parked.socket.send(payload);
  await expect.poll(() => parked.acks.at(-1)).toBe(parked.outputBytes);
  await expect.poll(() => parked.stdin.some(data => /\x1b\[\d+;\d+R/.test(data))).toBe(true);
  await openSessionFromUi(page, "test-project", "");
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
  expect(peers.size).toBe(2);
  expect(peers.get("test-project")).toBe(parked); // no replacement attach/reconnect to consume parked output
});

test("supported suspend/resume preserves parser replies, resize and the first visible frame with one resumed RAF loop", async ({ page }) => {
  await loadResourceFixture(page);
  const result = await page.evaluate(async () => {
    const url = "/__r5_resource_fixture__.js";
    const api = await import(url) as typeof ResourceApi;
    return api.exerciseSuspension();
  });
  expect(result.hidden.fills).toBe(0);
  expect(result.hidden.cursors).toBe(0);
  expect(result.hidden.callbacks).toBe(1);
  expect(result.hidden.replies).toBe(1);
  expect(result.hidden.samePixels).toBe(true);
  expect(result.hidden.suspended).toBe(true);
  expect(result.firstFrameCorrect).toBe(true);
  expect(result.resumed.renders).toBe(10);
  expect(result.reentrantResumeRenders).toBe(10);
  expect(result.disposedWork).toBe(0);
  expect(result.parserReleased).toBe(true);
});

for (const kind of ["park", "dispose", "open-failure"] as const) test(`asynchronous controller mount handles ${kind} without a hidden render loop or leaked parser`, async ({ page }) => {
  await loadResourceFixture(page);
  const result = await page.evaluate(async kind => {
    const url = "/__r5_resource_fixture__.js";
    const api = await import(url) as typeof ResourceApi;
    return api.exerciseMountRace(kind);
  }, kind);
  if (kind === "park") {
    expect(result).toMatchObject({ failed: false, suspended: true, hidden: { renders: 0, cursors: 0, fills: 0 } });
    // The real ResizeObserver may additionally force the existing same-size
    // layout repaint after reattachment; only non-forced calls are the RAF loop.
    if (!result.resumed) throw new Error("missing successful mount sample");
    expect(result.resumed.renders - result.resumed.forcedRenders).toBe(10);
  } else expect(result).toEqual({ failed: kind === "open-failure", parserReleased: true, canvases: 0 });
});

for (const count of [1, 4, 16]) test(`resource profile ${count} isolated terminal instances`, async ({ page, context, browser }, testInfo) => {
  test.skip(process.env.WOLFPACK_RENDER_RESOURCE_PROFILE !== "1" || testInfo.project.name !== "desktop", "explicit desktop render-resource profiling mode");
  await loadResourceFixture(page);
  const setup = await page.evaluate(async count => {
    const url = "/__r5_resource_fixture__.js";
    const api = await import(url) as typeof ResourceApi;
    const fixture = window.__r5Resources = await api.createResourceFixture(count);
    return { createAndOpenMs: fixture.createAndOpenMs, supportedApi: fixture.supportedApi, resources: fixture.resources(), wasm: { ...window.__r5WasmCounts } };
  }, count);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () => {
    const report = await cdp.send("Performance.getMetrics") as { metrics: Array<{ name: string; value: number }> };
    return { taskSeconds: report.metrics.find(item => item.name === "TaskDuration")?.value ?? null,
      jsHeapUsedBytes: report.metrics.find(item => item.name === "JSHeapUsedSize")?.value ?? null };
  };
  const sample = async (traffic: boolean) => {
    const before = await metrics();
    const result = await page.evaluate(traffic => window.__r5Resources!.sample(traffic), traffic);
    const after = await metrics();
    return { ...result, taskDurationMs: before.taskSeconds !== null && after.taskSeconds !== null ? (after.taskSeconds - before.taskSeconds) * 1000 : null,
      jsHeapUsedBytes: after.jsHeapUsedBytes };
  };
  try {
    const activeIdle = await sample(false);
    await page.evaluate(() => window.__r5Resources!.park());
    const parkedIdle = await sample(false), parkedOutput = await sample(true);
    const resumeSyncMs = await page.evaluate(() => window.__r5Resources!.resume());
    const resumedIdle = await sample(false);
    const disposed = await page.evaluate(() => window.__r5Resources!.dispose());
    expect(setup.resources.isolatedMemories).toBe(count + setup.resources.prewarmIdle);
    expect(parkedOutput.work.callbacks).toBe(count * 30);
    expect(parkedOutput.work.replies).toBe(count * 30);
    expect(disposed.parserHandles).toBe(0);
    expect(disposed.canvases).toBe(0);
    if (setup.supportedApi) {
      expect(parkedIdle.work.renders).toBe(0);
      expect(parkedIdle.work.cursors).toBe(0);
      expect(parkedOutput.work.fills).toBe(0);
      expect(parkedOutput.work.renders).toBe(0);
    }
    const report = { count, runIndex: testInfo.repeatEachIndex, browser: browser.version(), viewport: page.viewportSize(), productionCapsChanged: false,
      workload: "raw isolated instances; real one-slot prewarm policy; no PTY/grid cap increase",
      memoryScope: "owned WASM linear bytes = fixture terminals + idle prewarm, excludes loader singleton and native/RSS overhead; JS heap is separate and is not WASM or resident memory",
      setup, activeIdle, parkedIdle, parkedOutput, resumeSyncMs, resumedIdle, disposed };
    console.log(`render-resource-json:${JSON.stringify(report)}`);
    await testInfo.attach(`render-resources-${count}.json`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  } finally {
    await page.evaluate(() => window.__r5Resources?.dispose());
    await cdp.detach();
  }
});
