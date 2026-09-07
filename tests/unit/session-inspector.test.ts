import { afterEach, beforeEach, expect, test } from "bun:test";
import { createSessionInspector, type SessionSnapshot } from "../../public/session-inspector";

class FakeElement extends EventTarget {
  textContent = "";
  focus(): void {}
}

class FakeDialog extends FakeElement {
  open = false;
  showModal(): void { this.open = true; }
  close(): void { this.open = false; this.dispatchEvent(new Event("close")); }
}

interface InspectorDom {
  readonly dialog: FakeDialog;
  readonly title: FakeElement;
  readonly status: FakeElement;
  readonly metadata: FakeElement;
  readonly output: FakeElement;
  readonly close: FakeElement;
  readonly retry: FakeElement;
  visibilityState: "visible" | "hidden";
  dispatchVisibility(): void;
}

function installDom(): InspectorDom {
  const events = new EventTarget();
  const dialog = new FakeDialog();
  const title = new FakeElement();
  const status = new FakeElement();
  const metadata = new FakeElement();
  const output = new FakeElement();
  const close = new FakeElement();
  const retry = new FakeElement();
  const elements = new Map<string, FakeElement>([
    ["session-inspector-dialog", dialog],
    ["session-inspector-title", title],
    ["session-inspector-status", status],
    ["session-inspector-metadata", metadata],
    ["session-inspector-output", output],
    ["session-inspector-close", close],
    ["session-inspector-retry", retry],
  ]);
  const dom: InspectorDom = {
    dialog,
    title,
    status,
    metadata,
    output,
    close,
    retry,
    visibilityState: "visible",
    dispatchVisibility: () => events.dispatchEvent(new Event("visibilitychange")),
  };
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FakeElement });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get visibilityState(): "visible" | "hidden" { return dom.visibilityState; },
      getElementById: (id: string) => elements.get(id) ?? null,
      addEventListener: events.addEventListener.bind(events),
    },
  });
  return dom;
}

const target = { session: "alpha", sessionId: "550e8400-e29b-41d4-a716-446655440000", machine: "n-peer:install-a" };
const snapshot = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  session: "alpha",
  sessionId: target.sessionId,
  text: "captured text",
  capturedAt: new Date(Date.now() - 3_000).toISOString(),
  cols: 120,
  rows: 40,
  truncated: false,
  freshness: "fresh",
  ...overrides,
});

interface ControlledTimer {
  readonly id: number;
  readonly callback: () => void;
  cleared: boolean;
  fired: boolean;
}

function installControlledTimers(): { readonly active: () => ControlledTimer[]; readonly fire: (timer: ControlledTimer) => void } {
  const timers: ControlledTimer[] = [];
  let nextId = 1;
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: (callback: () => void): number => {
      const timer = { id: nextId++, callback, cleared: false, fired: false };
      timers.push(timer);
      return timer.id;
    },
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    value: (id: number): void => { const timer = timers.find((candidate) => candidate.id === id); if (timer) timer.cleared = true; },
  });
  return {
    active: () => timers.filter((timer) => !timer.cleared && !timer.fired),
    fire: (timer) => { timer.fired = true; timer.callback(); },
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

let priorDocument: PropertyDescriptor | undefined;
let priorHTMLElement: PropertyDescriptor | undefined;
let priorSetTimeout: PropertyDescriptor | undefined;
let priorClearTimeout: PropertyDescriptor | undefined;

beforeEach(() => {
  priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  priorHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  priorSetTimeout = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
  priorClearTimeout = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
});

afterEach(() => {
  if (priorDocument) Object.defineProperty(globalThis, "document", priorDocument);
  else delete (globalThis as { document?: unknown }).document;
  if (priorHTMLElement) Object.defineProperty(globalThis, "HTMLElement", priorHTMLElement);
  else delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  if (priorSetTimeout) Object.defineProperty(globalThis, "setTimeout", priorSetTimeout);
  if (priorClearTimeout) Object.defineProperty(globalThis, "clearTimeout", priorClearTimeout);
});

test("marks retained output unavailable when the stable peer loses readiness, then resumes only that same identity", async () => {
  const dom = installDom();
  let ready = true;
  let calls = 0;
  const inspector = createSessionInspector({
    isMachineReady: () => ready,
    requestSnapshot: async () => {
      calls++;
      return snapshot();
    },
  });

  inspector.open(target, dom.retry as unknown as HTMLElement);
  await Promise.resolve();
  expect(dom.output.textContent).toBe("captured text");
  expect(calls).toBe(1);

  ready = false;
  dom.retry.dispatchEvent(new Event("click"));
  await Promise.resolve();
  expect(dom.status.textContent).toContain("unavailable");
  expect(dom.output.textContent).toBe("captured text");
  expect(dom.metadata.textContent).toContain("captured");
  expect(calls).toBe(1);

  ready = true;
  dom.retry.dispatchEvent(new Event("click"));
  await Promise.resolve();
  expect(calls).toBe(2);
  dom.dialog.close();
});

test("marks a response unavailable when the stable peer retires during its request", async () => {
  const dom = installDom();
  const pending = deferred<SessionSnapshot>();
  let ready = true;
  const inspector = createSessionInspector({
    isMachineReady: () => ready,
    requestSnapshot: async () => pending.promise,
  });

  inspector.open(target, dom.retry as unknown as HTMLElement);
  ready = false;
  pending.resolve(snapshot({ text: "retired peer text" }));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(dom.status.textContent).toContain("unavailable");
  expect(dom.output.textContent).not.toBe("retired peer text");
  dom.dialog.close();
});

test("rejects a late or mismatched response without replacing the active stable target", async () => {
  const dom = installDom();
  const first = deferred<SessionSnapshot>();
  const second = deferred<SessionSnapshot>();
  let calls = 0;
  const inspector = createSessionInspector({
    isMachineReady: () => true,
    requestSnapshot: async () => (calls++ === 0 ? first.promise : second.promise),
  });
  const replacement = { ...target, session: "beta", sessionId: "11111111-1111-4111-8111-111111111111" };

  inspector.open(target, dom.retry as unknown as HTMLElement);
  inspector.open(replacement, dom.retry as unknown as HTMLElement);
  first.resolve(snapshot({ text: "late alpha" }));
  await Promise.resolve();
  await Promise.resolve();
  expect(dom.title.textContent).toBe("Inspect beta");
  expect(dom.output.textContent).not.toBe("late alpha");

  second.resolve(snapshot({ session: "wrong", sessionId: target.sessionId, text: "wrong target" }));
  await Promise.resolve();
  await Promise.resolve();
  expect(dom.status.textContent).toContain("unavailable");
  expect(dom.output.textContent).not.toBe("wrong target");
  dom.dialog.close();
});

test("updates stale capture age after a hidden-page resume fails", async () => {
  const dom = installDom();
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  let calls = 0;
  const inspector = createSessionInspector({
    isMachineReady: () => true,
    requestSnapshot: async () => {
      calls++;
      if (calls === 1) return snapshot({ capturedAt: new Date(now - 3_000).toISOString() });
      throw new Error("peer unavailable");
    },
  });
  try {
    inspector.open(target, dom.retry as unknown as HTMLElement);
    await Promise.resolve();
    expect(dom.metadata.textContent).toContain("3s ago");

    dom.visibilityState = "hidden";
    dom.dispatchVisibility();
    expect(dom.status.textContent).toContain("hidden");
    now += 5_000;
    dom.visibilityState = "visible";
    dom.dispatchVisibility();
    await Promise.resolve();
    await Promise.resolve();
    expect(dom.status.textContent).toContain("unavailable");
    expect(dom.metadata.textContent).toContain("8s ago");
  } finally {
    Date.now = originalNow;
    dom.dialog.close();
  }
});

test("a superseded request cannot orphan cadence timers across close and reopen", async () => {
  const dom = installDom();
  const timers = installControlledTimers();
  const first = deferred<SessionSnapshot>();
  const retry = deferred<SessionSnapshot>();
  let calls = 0;
  const beta = { ...target, session: "beta", sessionId: "11111111-1111-4111-8111-111111111111" };
  const inspector = createSessionInspector({
    isMachineReady: () => true,
    requestSnapshot: async (sessionId) => {
      calls++;
      if (calls === 1) return first.promise;
      if (calls === 2) return retry.promise;
      return snapshot({ session: "beta", sessionId, text: `beta result ${calls}` });
    },
  });

  inspector.open(target, dom.retry as unknown as HTMLElement);
  dom.retry.dispatchEvent(new Event("click"));
  retry.resolve(snapshot({ text: "retry result" }));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const alphaTimer = timers.active().at(0);
  expect(timers.active()).toHaveLength(1);

  first.resolve(snapshot({ text: "late alpha" }));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(timers.active()).toHaveLength(1);

  dom.dialog.close();
  inspector.open(beta, dom.retry as unknown as HTMLElement);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(timers.active()).toHaveLength(1);
  if (!alphaTimer) throw new Error("alpha cadence timer was not scheduled");
  timers.fire(alphaTimer);
  expect(timers.active()).toHaveLength(1);

  const betaTimer = timers.active().at(0);
  if (!betaTimer) throw new Error("beta cadence timer was not scheduled");
  timers.fire(betaTimer);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toBe(4);
  expect(timers.active()).toHaveLength(1);
  dom.dialog.close();
});

test("a retry aborts an older request and only renders the newer response", async () => {
  const dom = installDom();
  const first = deferred<SessionSnapshot>();
  const second = deferred<SessionSnapshot>();
  let calls = 0;
  let firstSignal: AbortSignal | undefined;
  const inspector = createSessionInspector({
    isMachineReady: () => true,
    requestSnapshot: async (_sessionId, _machine, signal) => {
      calls++;
      if (calls === 1) { firstSignal = signal; return first.promise; }
      return second.promise;
    },
  });

  inspector.open(target, dom.retry as unknown as HTMLElement);
  dom.retry.dispatchEvent(new Event("click"));
  expect(firstSignal?.aborted).toBe(true);
  second.resolve(snapshot({ text: "retry result" }));
  await Promise.resolve();
  await Promise.resolve();
  first.resolve(snapshot({ text: "late result" }));
  await Promise.resolve();
  await Promise.resolve();
  expect(dom.output.textContent).toBe("retry result");
  dom.dialog.close();
});
