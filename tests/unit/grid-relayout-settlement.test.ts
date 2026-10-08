import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import type { OrderedResizeSettlement } from "../../public/ordered-resize";

const saved = new Map<string, PropertyDescriptor | undefined>();
let grid: {
  scheduleGridStabilizedFit(onSettled?: (acknowledged: boolean) => void): void;
  suspendGridMode(): void;
};
let state: {
  gridSessions: ReturnType<typeof cell>[];
  activeDelegationRoot: string | null;
  sidebarLayoutTransitioning: boolean;
};
let originalState: typeof state;
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

function frame(): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}
async function microtasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function deferred(): { promise: Promise<OrderedResizeSettlement>; resolve: (outcome: OrderedResizeSettlement) => void } {
  let resolve!: (outcome: OrderedResizeSettlement) => void;
  const promise = new Promise<OrderedResizeSettlement>(done => { resolve = done; });
  return { promise, resolve };
}

beforeAll(async () => {
  const globals = {
    window: { innerWidth: 1280, addEventListener() {}, removeEventListener() {} },
    document: { getElementById() { return { style: {}, className: "", innerHTML: "", offsetWidth: 100 }; }, addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem() { return null; } },
    navigator: {},
    requestAnimationFrame(callback: FrameRequestCallback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  };
  for (const [name, value] of Object.entries(globals)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  // URL imports keep the legacy browser orchestrator in its own TS project.
  grid = await import(new URL("../../public/app-grid.ts", import.meta.url).href);
  ({ state } = await import(new URL("../../public/app-state.ts", import.meta.url).href));
  originalState = { ...state };
});
afterEach(() => {
  grid.suspendGridMode();
  frames.clear();
  Object.assign(state, originalState);
});
afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
beforeEach(() => {
  frames.clear();
  state.activeDelegationRoot = null;
  state.gridSessions = [];
  state.sidebarLayoutTransitioning = false;
});

function cell(resize: () => Promise<OrderedResizeSettlement>) {
  const classes = new Set<string>();
  let repaints = 0;
  const element = { remove() {}, classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } } as unknown as HTMLElement;
  const controller = {
    isConnected: true, supportsOrderedResize: true,
    mount: async () => {}, connect() {}, reconnect() {}, scheduleReconnect() {}, sendTakeControl() {},
    forceRepaint() { repaints++; }, focus() {}, resize, dispose() {},
  };
  return { session: "alpha", machine: "", controller, _cellElement: element, _retainedSingle: true, classes, repaints: () => repaints };
}

for (const phase of ["queued", "awaiting acknowledgement", "repaint"] as const) {
  test(`replacement grid fit retains sidebar settlement while ${phase}`, async () => {
    const first = deferred();
    const second = deferred();
    let calls = 0;
    const gs = cell(() => (++calls === 1 ? first : second).promise);
    state.gridSessions = [gs];
    state.sidebarLayoutTransitioning = true;
    const outcomes: boolean[] = [];
    grid.scheduleGridStabilizedFit(acknowledged => {
      outcomes.push(acknowledged);
      state.sidebarLayoutTransitioning = false;
    });
    if (phase !== "queued") frame();
    if (phase === "repaint") {
      first.resolve("acknowledged");
      await microtasks();
      frame();
    }
    grid.scheduleGridStabilizedFit();
    frame();
    expect(gs.classes.has("transitioning")).toBe(true);
    expect(outcomes).toEqual([]);
    first.resolve("acknowledged");
    await microtasks();
    if (phase !== "queued") {
      expect(outcomes).toEqual([]);
      second.resolve("acknowledged");
      await microtasks();
    }
    frame();
    frame();
    expect(gs.classes.has("transitioning")).toBe(false);
    expect(gs.repaints()).toBeGreaterThan(0);
    expect(outcomes).toEqual([true]);
    expect(state.sidebarLayoutTransitioning).toBe(false);
  });
}

test("cancelled replacement releases settlement without repaint or early reveal and can recover", async () => {
  const first = deferred();
  const replacement = deferred();
  const recovery = deferred();
  const settlements = [first, replacement, recovery];
  let calls = 0;
  const gs = cell(() => settlements[calls++]!.promise);
  state.gridSessions = [gs];
  const outcomes: boolean[] = [];
  grid.scheduleGridStabilizedFit(outcome => outcomes.push(outcome));
  frame();
  grid.scheduleGridStabilizedFit();
  frame();
  first.resolve("acknowledged");
  replacement.resolve("cancelled");
  await microtasks();
  frame();
  frame();
  expect(outcomes).toEqual([false]);
  expect(gs.classes.has("transitioning")).toBe(true);
  expect(gs.repaints()).toBe(0);
  grid.scheduleGridStabilizedFit();
  frame();
  recovery.resolve("acknowledged");
  await microtasks();
  frame();
  frame();
  expect(gs.classes.has("transitioning")).toBe(false);
  expect(outcomes).toEqual([false]);
});

test("suspending grid cancels settlement ownership and fences old acknowledgements", async () => {
  const pending = deferred();
  const gs = cell(() => pending.promise);
  state.gridSessions = [gs];
  const outcomes: boolean[] = [];
  grid.scheduleGridStabilizedFit(outcome => outcomes.push(outcome));
  frame();
  grid.suspendGridMode();
  expect(outcomes).toEqual([false]);
  expect(state.gridSessions).toEqual([]);
  pending.resolve("acknowledged");
  await microtasks();
  frame();
  frame();
  expect(outcomes).toEqual([false]);
  expect(gs.repaints()).toBe(0);
});

test("settlement notifies all callers once despite a throwing and reentrant caller", async () => {
  const gs = cell(() => Promise.resolve("acknowledged"));
  state.gridSessions = [gs];
  const outcomes: string[] = [];
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    grid.scheduleGridStabilizedFit(() => { throw new Error("caller failed"); });
    grid.scheduleGridStabilizedFit(() => {
      outcomes.push("first");
      grid.scheduleGridStabilizedFit(() => outcomes.push("reentrant"));
    });
    grid.scheduleGridStabilizedFit(() => outcomes.push("second"));
    frame();
    await microtasks();
    frame();
    frame();
    expect(outcomes).toEqual(["first", "second"]);
    expect(warning).toHaveBeenCalledTimes(1);
    frame();
    await microtasks();
    frame();
    frame();
    expect(outcomes).toEqual(["first", "second", "reentrant"]);
  } finally {
    warning.mockRestore();
  }
});
