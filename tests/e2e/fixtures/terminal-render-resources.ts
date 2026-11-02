import type {} from "../../../public/types-globals.d.ts";
import { GhosttyPrewarmPool } from "../../../public/ghostty-prewarm-pool.ts";
import { DEFAULT_GHOSTTY_PREWARM_POOL_SIZE } from "../../../src/ghostty-prewarm-policy.ts";
import { createPtyTerminalController } from "../../../public/pty-terminal-controller.ts";

interface WasmBuffer { readonly memory: WebAssembly.Memory; getCursor(): unknown; }
interface RealTerminal extends GhosttyTerminal {
  onCursorMove(listener: () => void): { dispose(): void };
  readonly element: HTMLElement;
  readonly renderer: { readonly ctx: CanvasRenderingContext2D; render(...args: unknown[]): void };
  readonly wasmTerm?: WasmBuffer;
}
interface GhosttyInstance { readonly memory: WebAssembly.Memory; }
interface Runtime {
  readonly ghosttyReady: Promise<void>;
  readonly createIsolatedGhostty: () => Promise<GhosttyInstance>;
  readonly Terminal: new (options: object) => RealTerminal;
}
export interface RenderWork { renders: number; forcedRenders: number; cursors: number; fills: number; callbacks: number; replies: number; bytes: number; }
const blankWork = (): RenderWork => ({ renders: 0, forcedRenders: 0, cursors: 0, fills: 0, callbacks: 0, replies: 0, bytes: 0 });
const nextFrames = (count: number): Promise<void> => new Promise(resolve => {
  const next = () => { if (--count === 0) resolve(); else requestAnimationFrame(next); };
  requestAnimationFrame(next);
});
function observe(term: RealTerminal) {
  let work = blankWork();
  const renderer = term.renderer, wasm = term.wasmTerm;
  if (!wasm) throw new Error("actual WASM terminal not open");
  const render = renderer.render.bind(renderer), cursor = wasm.getCursor.bind(wasm);
  const ctx = renderer.ctx, fillText = ctx.fillText.bind(ctx), fillRect = ctx.fillRect.bind(ctx);
  renderer.render = (...args) => { work.renders++; if (args[1] === true) work.forcedRenders++; render(...args); };
  wasm.getCursor = () => { work.cursors++; return cursor(); };
  ctx.fillText = (...args: Parameters<CanvasRenderingContext2D["fillText"]>) => { work.fills++; fillText(...args); };
  ctx.fillRect = (...args: Parameters<CanvasRenderingContext2D["fillRect"]>) => { work.fills++; fillRect(...args); };
  term.onData(data => { if (/\x1b\[\d+;\d+R/.test(data)) work.replies++; });
  return {
    reset() { work = blankWork(); },
    read() { return { ...work }; },
    write(data: string) { work.bytes += new TextEncoder().encode(data).length; term.write(data, () => { work.callbacks++; }); },
    restore() { renderer.render = render; wasm.getCursor = cursor; ctx.fillText = fillText; ctx.fillRect = fillRect; },
  };
}
async function makeTerminal(blink = true) {
  const runtime = window as unknown as Runtime;
  await runtime.ghosttyReady;
  const ghostty = await runtime.createIsolatedGhostty();
  const term = new runtime.Terminal({ ghostty, cols: 80, rows: 24, scrollback: 1000, cursorBlink: blink, fontFamily: "monospace" });
  const host = document.createElement("div");
  host.style.cssText = "width:800px;height:400px;position:relative";
  document.body.append(host);
  term.open(host);
  return { term, host, ghostty, canvas: host.querySelector("canvas")! };
}

/** Raw 1/4/16 isolated canvases, not an increase to the production grid/pool cap.
 * The real production prewarm pool/policy is used for its one idle WASM slot. */
export async function createResourceFixture(count: number) {
  const runtime = window as unknown as Runtime;
  await runtime.ghosttyReady;
  const warmInstances = new Set<GhosttyInstance>();
  const prewarm = new GhosttyPrewarmPool({ maxSize: DEFAULT_GHOSTTY_PREWARM_POOL_SIZE,
    create: () => runtime.createIsolatedGhostty(), onReady: instance => { warmInstances.add(instance); } });
  await prewarm.prewarm();
  const entries: Array<Awaited<ReturnType<typeof makeTerminal>> & { probe: ReturnType<typeof observe> }> = [];
  const coldStart = performance.now();
  for (let index = 0; index < count; index++) {
    const entry = await makeTerminal();
    entry.term.write("\x1b[?25lRESOURCE_INITIAL");
    entries.push({ ...entry, probe: observe(entry.term) });
  }
  const createAndOpenMs = performance.now() - coldStart;
  await nextFrames(3);
  let parked = false;
  const resources = () => ({
    active: parked ? 0 : entries.length, parked: parked ? entries.length : 0,
    prewarmIdle: warmInstances.size, prewarmCapacity: DEFAULT_GHOSTTY_PREWARM_POOL_SIZE,
    parserHandles: entries.filter(entry => !!entry.term.wasmTerm).length,
    canvases: entries.length,
    isolatedMemories: new Set([...entries.map(entry => entry.ghostty.memory), ...[...warmInstances].map(instance => instance.memory)]).size,
    ownedWasmLinearBytes: entries.reduce((n, entry) => n + entry.ghostty.memory.buffer.byteLength, 0)
      + [...warmInstances].reduce((n, instance) => n + instance.memory.buffer.byteLength, 0),
  });
  return {
    createAndOpenMs,
    supportedApi: entries.every(entry => typeof entry.term.suspendRendering === "function"),
    resources,
    park() {
      parked = true;
      for (const { term, host } of entries) { term.suspendRendering?.(); host.remove(); }
    },
    resume() {
      const start = performance.now();
      parked = false;
      for (const { term, host } of entries) { document.body.append(host); term.resumeRendering?.(); }
      return performance.now() - start;
    },
    async sample(traffic: boolean, durationMs = 750) {
      for (const entry of entries) entry.probe.reset();
      const start = performance.now();
      if (traffic) {
        // Fixed byte/callback/query workload in every before/after sample.
        for (let batch = 0; batch < 30; batch++) {
          for (const entry of entries) entry.probe.write("\r\nPARKED_RESOURCE_OUTPUT_\u754c\x1b[6n");
          await new Promise(resolve => setTimeout(resolve, durationMs / 30));
        }
      } else await new Promise(resolve => setTimeout(resolve, durationMs));
      await nextFrames(2); // settle write callbacks; these are harness, not terminal RAFs
      const work = entries.reduce((sum, entry) => {
        const current = entry.probe.read();
        for (const key of Object.keys(sum) as Array<keyof RenderWork>) sum[key] += current[key];
        return sum;
      }, blankWork());
      return { elapsedMs: performance.now() - start, work, resources: resources() };
    },
    async dispose() {
      for (const { term, host, probe } of entries) { probe.restore(); term.dispose(); host.remove(); }
      entries.splice(0);
      await nextFrames(3);
      return resources(); // ownership, not proof of GC or resident-memory release
    },
  };
}

export async function exerciseSuspension() {
  const parked = await makeTerminal(), reference = await makeTerminal();
  const seed = "\x1b[?25l\x1b[31mBEFORE_SUSPEND";
  parked.term.write(seed); reference.term.write(seed);
  await nextFrames(2);
  const probe = observe(parked.term);
  const originalPixels = parked.canvas.toDataURL();
  try {
    for (let repeat = 0; repeat < 4; repeat++) parked.term.suspendRendering();
    parked.host.remove(); probe.reset();
    parked.term.resize(100, 14); reference.term.resize(100, 14);
    const data = "\x1b[H\x1b[2J\x1b[32mAFTER_SUSPEND_\u754c_e\u0301\x1b[6n";
    probe.write(data); reference.term.write(data);
    await nextFrames(10);
    const hidden = { ...probe.read(), samePixels: parked.canvas.toDataURL() === originalPixels, suspended: parked.term.renderingSuspended };
    reference.term.renderer.render(reference.term.wasmTerm, true, reference.term.viewportY, reference.term);
    document.body.append(parked.host);
    parked.term.resumeRendering();
    const firstFrameCorrect = parked.canvas.toDataURL() === reference.canvas.toDataURL();
    for (let repeat = 0; repeat < 10; repeat++) parked.term.resumeRendering();
    probe.reset(); await nextFrames(10);
    const resumed = probe.read();
    await new Promise<void>(resolve => {
      const subscription = parked.term.onCursorMove(() => {
        subscription.dispose();
        parked.term.suspendRendering(); parked.term.resumeRendering();
        resolve();
      });
      parked.term.write("\r\n");
    });
    await nextFrames(2); probe.reset(); await nextFrames(10);
    const reentrantResumeRenders = probe.read().renders;
    parked.term.suspendRendering(); parked.term.dispose(); parked.term.dispose(); parked.term.resumeRendering();
    const before = probe.read(); await nextFrames(10);
    return { hidden, firstFrameCorrect, resumed, reentrantResumeRenders, disposedWork: probe.read().renders - before.renders, parserReleased: !parked.term.wasmTerm };
  } finally { probe.restore(); parked.term.dispose(); reference.term.dispose(); parked.host.remove(); reference.host.remove(); }
}

/** Exercise the real controller's asynchronous mount; only the unused network
 * boundary is stubbed. The terminal/renderer/WASM and lifecycle are production. */
export async function exerciseMountRace(kind: "park" | "dispose" | "open-failure") {
  const runtime = window as unknown as Runtime;
  await runtime.ghosttyReady;
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const creating = new Promise<void>(resolve => { started = resolve; });
  const term = new runtime.Terminal({ ghostty: await runtime.createIsolatedGhostty(), cols: 80, rows: 24, scrollback: 1000, cursorBlink: true });
  const host = document.createElement("div"); document.body.append(host);
  const controller = createPtyTerminalController({ session: "render-mount-race", scrollback: 1000 }, {
    createTerminalInstance: async () => { started(); await gate; return { term, fitAddon: { fit() {} } }; },
    shouldSuppressContainerResize: () => false, getDebugStorage: () => null,
    socket: { resolveReadyMachineOrigin: () => undefined, requestWebSocketTicket: async () => { throw new Error("mount must not connect"); }, getBrowserAuthToken: () => null, getDebugStorage: () => null },
  });
  const mount = controller.mount(host);
  await creating;
  controller.suspendLayout(); host.remove();
  if (kind === "dispose") controller.dispose();
  const getContext = HTMLCanvasElement.prototype.getContext;
  if (kind === "open-failure") HTMLCanvasElement.prototype.getContext = (() => null) as typeof getContext;
  release();
  let failed = false;
  try {
    try { await mount; } catch (error) {
      if (kind !== "open-failure" || !(error instanceof Error) || error.message !== "Failed to open terminal: Error: Failed to get 2D rendering context") throw error;
      failed = true;
    } finally { HTMLCanvasElement.prototype.getContext = getContext; }
    if (kind !== "park") {
      controller.dispose(); controller.dispose(); term.resumeRendering();
      await nextFrames(3);
      return { failed, parserReleased: !term.wasmTerm, canvases: host.querySelectorAll("canvas").length };
    }
    const probe = observe(term);
    await nextFrames(10);
    const suspended = term.renderingSuspended, hidden = probe.read();
    document.body.append(host); controller.resumeLayout();
    probe.reset(); await nextFrames(10);
    const resumed = probe.read(); probe.restore();
    return { failed, suspended, hidden, resumed };
  } finally { controller.dispose(); host.remove(); }
}
