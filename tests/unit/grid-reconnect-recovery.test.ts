import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { OrderedResizeSettlement } from "../../public/ordered-resize";

class CellElement {
  readonly classList = new class extends Set<string> {
    remove(name: string): void { this.delete(name); }
    contains(name: string): boolean { return this.has(name); }
    toggle(name: string, enabled: boolean): void { if (enabled) this.add(name); else this.delete(name); }
  }();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: CellElement[] = [];
  parentNode: CellElement | null = null;
  innerHTML = "";
  offsetWidth = 100;
  constructor(readonly id = "") {}
  set className(value: string) { this.classList.clear(); for (const name of value.split(" ").filter(Boolean)) this.classList.add(name); }
  querySelector(): null { return null; }
  querySelectorAll(selector: string): CellElement[] { return selector === ".grid-cell" ? this.children : []; }
  addEventListener(): void {}
  setAttribute(): void {}
  appendChild(cell: CellElement): void { cell.remove(); cell.parentNode = this; this.children.push(cell); }
  remove(): void {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
}
function deferred() {
  let resolve!: (outcome: OrderedResizeSettlement) => void;
  const promise = new Promise<OrderedResizeSettlement>(done => { resolve = done; });
  return { promise, resolve };
}
interface Session {
  session: string;
  machine: string;
  _delegation?: boolean;
  _collapsed?: boolean;
  _cellElement?: CellElement | null;
  controller?: ReturnType<typeof controller> | null;
}
function controller() {
  const pending: ReturnType<typeof deferred>[] = [];
  let repaints = 0;
  return {
    isConnected: true, supportsOrderedResize: true, pending,
    mount: async () => {}, connect() {}, reconnect() {}, scheduleReconnect() {}, sendTakeControl() {}, focus() {},
    forceRepaint() { repaints++; }, repaints: () => repaints,
    resize() { const settlement = deferred(); pending.push(settlement); return settlement.promise; },
    dispose() { for (const settlement of pending) settlement.resolve("cancelled"); },
  };
}
let grid: {
  initGridDeps(deps: Record<string, unknown>): void;
  renderGridCells(): void;
  renderDelegationGridCells(): void;
  scheduleGridStabilizedFit(onSettled?: (outcome: boolean) => void): void;
  suspendGridMode(): void;
  suspendDelegationGridTerminals(): void;
};
let state: {
  gridSessions: Session[];
  delegationGridSessions: Session[];
  activeDelegationRoot: string | null;
  focusedDelegationSession: string | null;
  currentView: string;
};
let originalState: typeof state;
const saved = new Map<string, PropertyDescriptor | undefined>();
const containers = new Map<string, CellElement>();
const frames = new Map<number, FrameRequestCallback>();
const hydrated = new Map<string, () => void>();
let nextFrame = 0;
function frame(): void { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0); }
async function microtasks(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }

beforeAll(async () => {
  const globals = {
    window: { innerWidth: 1280, addEventListener() {}, removeEventListener() {} },
    document: {
      createElement: () => new CellElement(),
      getElementById(id: string) { if (!containers.has(id)) containers.set(id, new CellElement(id)); return containers.get(id)!; },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    },
    navigator: {}, localStorage: { getItem() { return null; } },
    requestAnimationFrame(callback: FrameRequestCallback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  };
  for (const [name, value] of Object.entries(globals)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  grid = await import(new URL("../../public/app-grid.ts", import.meta.url).href);
  ({ state } = await import(new URL("../../public/app-state.ts", import.meta.url).href));
  originalState = { ...state };
  grid.initGridDeps({
    createPtyTerminalController(opts: { session: string; onHydrated: () => void }) {
      hydrated.set(opts.session, opts.onHydrated);
      return controller();
    },
    renderSidebar() {}, showNotice() {},
  });
});
afterEach(async () => {
  grid.suspendGridMode();
  grid.suspendDelegationGridTerminals();
  await microtasks();
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
  containers.clear(); frames.clear(); hydrated.clear();
  state.gridSessions = []; state.delegationGridSessions = [];
  state.activeDelegationRoot = null; state.focusedDelegationSession = null; state.currentView = "terminal";
});

async function mounted(delegation: boolean): Promise<Session[]> {
  const sessions = [{ session: "alpha", machine: "", _delegation: delegation }, { session: "beta", machine: "", _delegation: delegation }];
  if (delegation) { state.activeDelegationRoot = "alpha"; state.delegationGridSessions = sessions; grid.renderDelegationGridCells(); }
  else { state.gridSessions = sessions; grid.renderGridCells(); }
  await microtasks();
  frame(); await microtasks(); frame(); frame();
  return sessions;
}
for (const delegation of [false, true]) {
  for (const hydrationFirst of [false, true]) {
    test(`hydration resumes cancelled ${delegation ? "delegation" : "manual"} grid relayout (hydrate before cancellation: ${hydrationFirst})`, async () => {
      const sessions = await mounted(delegation);
      const outcomes: boolean[] = [];
      grid.scheduleGridStabilizedFit(outcome => outcomes.push(outcome));
      frame();
      const [first, sibling] = sessions.map(session => session.controller!);
      if (hydrationFirst) hydrated.get("alpha")!();
      first.pending[0]!.resolve("cancelled"); sibling.pending[0]!.resolve("acknowledged");
      await microtasks();
      if (!hydrationFirst) {
        expect(outcomes).toEqual([false]);
        hydrated.get("alpha")!();
      }
      frame();
      expect(first.pending).toHaveLength(2);
      expect(sibling.pending).toHaveLength(2);
      expect(sessions.every(session => session._cellElement!.classList.contains("transitioning"))).toBe(true);
      first.pending[1]!.resolve("acknowledged");
      await microtasks(); frame(); frame();
      expect(sessions.every(session => session._cellElement!.classList.contains("transitioning"))).toBe(true);
      sibling.pending[1]!.resolve("acknowledged");
      await microtasks(); frame(); frame();
      expect(sessions.every(session => !session._cellElement!.classList.contains("transitioning"))).toBe(true);
      expect(outcomes).toEqual([hydrationFirst]);
    });
  }
}

test("repeated hydration coalesces recovery and a second cancelled socket can retry", async () => {
  const sessions = await mounted(false);
  const [first, sibling] = sessions.map(session => session.controller!);
  grid.scheduleGridStabilizedFit(); frame();
  first.pending[0]!.resolve("cancelled"); sibling.pending[0]!.resolve("acknowledged");
  await microtasks();
  hydrated.get("alpha")!(); hydrated.get("alpha")!(); hydrated.get("beta")!();
  frame();
  expect(first.pending).toHaveLength(2);
  expect(sibling.pending).toHaveLength(2);
  first.pending[1]!.resolve("acknowledged"); sibling.pending[1]!.resolve("cancelled");
  await microtasks();
  expect(sessions.every(session => session._cellElement!.classList.contains("transitioning"))).toBe(true);
  hydrated.get("beta")!(); frame();
  first.pending[2]!.resolve("acknowledged"); sibling.pending[2]!.resolve("acknowledged");
  await microtasks(); frame(); frame();
  expect(sessions.every(session => !session._cellElement!.classList.contains("transitioning"))).toBe(true);
});

for (const retiredBy of ["collapsed", "removed", "replaced controller", "detached cell"] as const) {
  test(`hydration cannot resume grid work for a ${retiredBy} cell`, async () => {
    const sessions = await mounted(false);
    const [first, sibling] = sessions.map(session => session.controller!);
    grid.scheduleGridStabilizedFit(); frame();
    first.pending[0]!.resolve("cancelled"); sibling.pending[0]!.resolve("acknowledged");
    await microtasks();
    const gs = sessions[0]!;
    if (retiredBy === "collapsed") gs._collapsed = true;
    if (retiredBy === "removed") state.gridSessions = [sessions[1]!];
    if (retiredBy === "replaced controller") gs.controller = controller();
    if (retiredBy === "detached cell") gs._cellElement!.remove();
    hydrated.get("alpha")!();
    frame(); await microtasks(); frame(); frame();
    expect(first.pending).toHaveLength(1);
    expect(sibling.pending).toHaveLength(1);
    first.dispose();
  });
}

test("ordinary hydration does not create a relayout when no hidden work remains", async () => {
  const sessions = await mounted(false);
  hydrated.get("alpha")!(); hydrated.get("beta")!(); frame();
  expect(sessions.every(session => session.controller!.pending.length === 0)).toBe(true);
});

test("delegation suspension releases relayout ownership and fences retired hydration", async () => {
  const sessions = await mounted(true);
  const outcomes: boolean[] = [];
  grid.scheduleGridStabilizedFit(outcome => outcomes.push(outcome));
  frame();
  const retired = sessions.map(session => session.controller!);
  grid.suspendDelegationGridTerminals();
  expect(outcomes).toEqual([false]);
  hydrated.get("alpha")!(); hydrated.get("beta")!();
  await microtasks(); frame(); frame();
  expect(retired.every(item => item.pending.length === 1)).toBe(true);
  expect(outcomes).toEqual([false]);
});
