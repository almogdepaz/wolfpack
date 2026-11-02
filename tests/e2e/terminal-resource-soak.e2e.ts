import { expect, test, type WebSocketRoute } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parsePerfSoakSeconds } from "../../scripts/terminal-load-perf.ts";
import { TERMINAL_POOL_SIZE } from "../../public/terminal-pool.ts";
import { DEFAULT_GHOSTTY_PREWARM_POOL_SIZE } from "../../src/ghostty-prewarm-policy.ts";
import { openSessionFromUi, startTestServer, type TestServer } from "./helpers.ts";

interface SoakTerminal {
  readonly element: HTMLElement;
  readonly renderer: { render(...args: unknown[]): void };
  readonly wasmTerm?: { readonly memory: WebAssembly.Memory };
  readonly renderingSuspended: boolean;
  open(host: HTMLElement): void;
  dispose(): void;
}
interface SoakProbe {
  readonly records: Map<SoakTerminal, { id: number; renders: number }>;
  readonly memories: WeakRef<WebAssembly.Memory>[];
  readonly frames: Set<number>;
  created: number; disposed: number; compiled: number; instantiated: number; missingMemories: number;
}
declare global { interface Window { __terminalResourceSoak: SoakProbe; } }
const limits = {
  terminals: TERMINAL_POOL_SIZE, wasmMemories: TERMINAL_POOL_SIZE + DEFAULT_GHOSTTY_PREWARM_POOL_SIZE + 3,
  wasmLinearBytes: 64 * 1024 * 1024, heapBytes: 64 * 1024 * 1024, heapGrowthBytes: 16 * 1024 * 1024,
  listenerGrowth: 64, nodeGrowth: 512, pendingRaf: 16, browserProcessRssSumBytes: 1024 * 1024 * 1024,
};
let server: TestServer;
test.use({ trace: "off" }); // Long-run tracing would itself retain large protocol/DOM histories.
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });
function rss(pid: number): number | null {
  if (process.platform !== "linux") return null;
  try { const value = /^VmRSS:\s+(\d+)\s+kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8")); return value ? Number(value[1]) * 1024 : null; }
  catch { return null; } // Owned process may exit between CDP enumeration and procfs; never report zero.
}

test("bounded application terminal lifecycle and reconnect soak", async ({ page, context, browser }, testInfo) => {
  test.skip(process.env.WOLFPACK_PERF_SOAK !== "1" || testInfo.project.name !== "desktop", "explicit isolated desktop soak mode");
  const seconds = parsePerfSoakSeconds(process.env.WOLFPACK_PERF_SOAK_SECONDS);
  test.setTimeout((seconds + 120) * 1000);
  const sessions = ["test-project", "another-project", "prompt-project", "error-project"];
  const peers = new Map<string, { socket: WebSocketRoute; bytes: number; ack: number; replies: number }>();
  const histories = new Map(sessions.map(session => [session, [`SOAK_INITIAL_${session}\r\n`]]));
  let connections = 0, queryReplies = 0;
  await page.routeWebSocket(/\/ws\/pty/, socket => {
    const session = new URL(socket.url()).searchParams.get("session") ?? "";
    const peer = { socket, bytes: 0, ack: 0, replies: 0 }; peers.set(session, peer); connections++;
    socket.onClose(() => { if (peers.get(session) === peer) peers.delete(session); });
    socket.onMessage(message => {
      if (typeof message !== "string") {
        if (/\x1b\[\d+;\d+R/.test(message.toString("utf8"))) { peer.replies++; queryReplies++; }
        return;
      }
      let frame: { type?: string; bytes?: number };
      try { frame = JSON.parse(message); } catch { return; } // Application protocol replies are binary.
      if (frame.type === "ack" && typeof frame.bytes === "number") peer.ack = frame.bytes;
      if (frame.type !== "attach") return;
      socket.send(JSON.stringify({ type: "attach_ack", capabilities: ["output-ack"] }));
      const snapshot = Buffer.from(`\x1b[?25l\x1b[3J\x1b[2J\x1b[H${(histories.get(session) ?? []).join("")}`);
      peer.bytes += snapshot.length; socket.send(snapshot);
      socket.send(JSON.stringify({ type: "prefill_done" })); socket.send(JSON.stringify({ type: "pty_ready" }));
    });
  });
  await page.addInitScript(() => {
    const probe = window.__terminalResourceSoak = { records: new Map(), memories: [], frames: new Set(), created: 0, disposed: 0, compiled: 0, instantiated: 0, missingMemories: 0 } as SoakProbe;
    const raf = requestAnimationFrame.bind(window), cancel = cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => { const id = raf(time => { probe.frames.delete(id); callback(time); }); probe.frames.add(id); return id; };
    window.cancelAnimationFrame = id => { probe.frames.delete(id); cancel(id); };
    WebAssembly.compile = new Proxy(WebAssembly.compile, { apply(target, receiver, args) { probe.compiled++; return Reflect.apply(target, receiver, args); } });
    WebAssembly.instantiate = new Proxy(WebAssembly.instantiate, { apply(target, receiver, args) {
      return Promise.resolve(Reflect.apply(target, receiver, args)).then(result => {
        probe.instantiated++;
        const instance = result instanceof WebAssembly.Instance ? result : result.instance;
        const memory = instance.exports.memory;
        if (memory instanceof WebAssembly.Memory) probe.memories.push(new WeakRef(memory)); else probe.missingMemories++;
        return result;
      });
    } });
  });
  const fingerprints: Record<string, string> = {};
  const assetChecks = ["app.bundle.js", "styles.css", "ghostty-web.bundle.js"].map(async file => {
    const source = readFileSync(new URL(`../../public/${file}`, import.meta.url));
    fingerprints[file] = createHash("sha256").update(source).digest("hex");
    const response = await page.waitForResponse(response => new URL(response.url()).pathname === `/${file}`);
    expect(createHash("sha256").update(await response.body()).digest("hex")).toBe(fingerprints[file]);
  });
  const errors: string[] = [];
  page.on("pageerror", error => { if (errors.length < 20) errors.push(error.message); });
  await page.goto(server.baseUrl);
  await Promise.all(assetChecks);
  await page.waitForFunction(() => typeof window.Terminal === "function");
  await page.evaluate(() => {
    const probe = window.__terminalResourceSoak;
    const prototype = (window as unknown as { Terminal: { prototype: SoakTerminal } }).Terminal.prototype;
    const open = prototype.open, dispose = prototype.dispose;
    prototype.open = function (host) {
      open.call(this, host);
      const record = { id: ++probe.created, renders: 0 }; probe.records.set(this, record);
      const render = this.renderer.render.bind(this.renderer);
      this.renderer.render = (...args) => { record.renders++; render(...args); };
    };
    prototype.dispose = function () { try { dispose.call(this); } finally { if (probe.records.delete(this)) probe.disposed++; } };
  });
  const live = page.locator("#desktop-terminal-container");
  for (const session of sessions) { await openSessionFromUi(page, session); await expect(live).toHaveAttribute("data-terminal-load-state", "live"); }
  // Let the normal one-slot prewarm refill settle; no debug capacity/TTL overrides.
  await page.waitForTimeout(2000);
  const cdp = await context.newCDPSession(page), browserCdp = await browser.newBrowserCDPSession();
  await cdp.send("Performance.enable");
  const samples: unknown[] = [];
  let baseline: { heap: number; listeners: number; nodes: number } | undefined;
  const sample = async (cycles: number, elapsedMs: number) => {
    await cdp.send("HeapProfiler.collectGarbage"); // Explicit post-GC live-object probe, not a natural-GC plateau claim.
    const observation = await page.evaluate(() => {
      const probe = window.__terminalResourceSoak, records = [...probe.records.entries()];
      const memories = probe.memories.map(ref => ref.deref()).filter((memory): memory is WebAssembly.Memory => !!memory);
      return { live: records.length, active: records.filter(([term]) => !term.renderingSuspended).length,
        parked: records.filter(([term]) => term.renderingSuspended).length, parsers: records.filter(([term]) => !!term.wasmTerm).length,
        distinctParserMemories: new Set(records.map(([term]) => term.wasmTerm?.memory)).size,
        created: probe.created, disposed: probe.disposed, pendingRaf: probe.frames.size,
        compiled: probe.compiled, instantiated: probe.instantiated, missingMemories: probe.missingMemories,
        observedLiveMemoriesAfterGc: memories.length, observedWasmLinearBytes: memories.reduce((sum, memory) => sum + memory.buffer.byteLength, 0) };
    });
    const metrics = await cdp.send("Performance.getMetrics") as { metrics: Array<{ name: string; value: number }> };
    const value = (name: string) => { const found = metrics.metrics.find(metric => metric.name === name); if (!found) throw new Error(`missing soak metric ${name}`); return found.value; };
    const heap = value("JSHeapUsedSize"), listeners = value("JSEventListeners"), nodes = value("Nodes");
    baseline ??= { heap, listeners, nodes };
    const processes = await browserCdp.send("SystemInfo.getProcessInfo") as { processInfo: Array<{ id: number; type: string }> };
    const processRss = processes.processInfo.map(process => ({ ...process, rssBytes: rss(process.id) }));
    const browserProcessRssSumBytes = processRss.length > 0 && processRss.every(process => process.rssBytes !== null) ? processRss.reduce((sum, process) => sum + process.rssBytes!, 0) : null;
    const row = { cycles, elapsedMs, connections, queryReplies, peerCount: peers.size, observation, heapAfterGcBytes: heap, listenersAfterGc: listeners, nodesAfterGc: nodes,
      browserProcessRssSumBytes, processRss, fixtureServerRssBytes: rss(server.processId), driverRssBytes: process.memoryUsage().rss };
    samples.push(row); console.log(`terminal-soak-sample:${JSON.stringify(row)}`);
    expect(observation.live).toBeLessThanOrEqual(limits.terminals);
    expect(observation.active).toBe(1); expect(observation.parked).toBe(observation.live - 1);
    expect(observation.parsers).toBe(observation.live); expect(observation.distinctParserMemories).toBe(observation.live);
    expect(observation.created - observation.disposed).toBe(observation.live);
    expect(observation.compiled).toBe(1); expect(observation.missingMemories).toBe(0);
    expect(observation.observedLiveMemoriesAfterGc).toBeLessThanOrEqual(limits.wasmMemories);
    expect(observation.observedWasmLinearBytes).toBeLessThanOrEqual(limits.wasmLinearBytes);
    expect(observation.pendingRaf).toBeLessThanOrEqual(limits.pendingRaf);
    expect(heap).toBeLessThanOrEqual(limits.heapBytes); expect(heap - baseline.heap).toBeLessThanOrEqual(limits.heapGrowthBytes);
    expect(listeners - baseline.listeners).toBeLessThanOrEqual(limits.listenerGrowth); expect(nodes - baseline.nodes).toBeLessThanOrEqual(limits.nodeGrowth);
    expect(peers.size).toBeLessThanOrEqual(limits.terminals);
    if (browserProcessRssSumBytes !== null) expect(browserProcessRssSumBytes).toBeLessThanOrEqual(limits.browserProcessRssSumBytes);
    expect(errors).toEqual([]);
  };
  const started = Date.now();
  let cycles = 0;
  try {
    await sample(0, 0);
    while (Date.now() - started < seconds * 1000) {
      const cycleStarted = Date.now(), session = sessions[cycles % sessions.length]!;
      await openSessionFromUi(page, session); await expect(live).toHaveAttribute("data-terminal-load-state", "live");
      await expect.poll(() => peers.size).toBeLessThanOrEqual(limits.terminals);
      for (const [target, peer] of peers) {
        const lines = Array.from({ length: 50 }, (_, line) => `SOAK_${cycles}_${target}_${line}\r\n`);
        const history = histories.get(target)!; history.push(...lines); if (history.length > 2000) history.splice(0, history.length - 2000);
        const priorReplies = peer.replies, payload = Buffer.from(`${lines.join("")}\x1b[6n`);
        peer.bytes += payload.length; peer.socket.send(payload);
        await expect.poll(() => peer.ack).toBe(peer.bytes);
        await expect.poll(() => peer.replies).toBeGreaterThan(priorReplies);
      }
      const reconnect = peers.get(session); if (!reconnect) throw new Error("missing active soak socket");
      const beforeConnections = connections; reconnect.socket.close({ code: 1012, reason: "isolated soak reconnect" });
      await expect.poll(() => connections).toBeGreaterThan(beforeConnections);
      await expect(live).toHaveAttribute("data-terminal-load-state", "live");
      await page.evaluate(async () => {
        const parked = [...window.__terminalResourceSoak.records].filter(([term]) => term.renderingSuspended);
        const counts = parked.map(([, record]) => record.renders);
        await new Promise<void>(resolve => { let remaining = 3; const tick = () => { if (--remaining === 0) resolve(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
        if (parked.some(([, record], index) => record.renders !== counts[index])) throw new Error("parked renderer work drifted during soak");
      });
      const tail = await live.evaluate(node => {
        if (!(node instanceof HTMLElement)) throw new Error("soak terminal host is not HTML");
        return window.__wolfpackTest.serializeTerminalTail(node, 8);
      });
      expect(tail).toContain(`SOAK_${cycles}_${session}_`);
      cycles++;
      if (cycles % 6 === 0) await sample(cycles, Date.now() - started);
      await page.waitForTimeout(Math.max(0, 5000 - (Date.now() - cycleStarted)));
    }
    await sample(cycles, Date.now() - started);
    expect(cycles).toBeGreaterThan(0);
  } finally {
    const report = { seconds, actualElapsedMs: Date.now() - started, cycles, limits, fingerprints, browser: browser.version(), viewport: page.viewportSize(), errors, samples,
      scope: "real browser/application/WASM; isolated mock transport, NOT native PTY/Tailnet/device coverage",
      memoryScope: "post-explicit-GC JS/live WeakRef observations + WASM linear bytes; process RSS sums double-count shared pages, not unique/PSS; no natural-GC/RSS plateau claim" };
    await testInfo.attach("terminal-resource-soak.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    console.log(`terminal-soak-result:${JSON.stringify(report)}`);
    await cdp.detach(); await browserCdp.detach();
  }
});
