import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as asyncFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeStateStore, RUNTIME_STATE_PERSIST_DEBOUNCE_MS } from "../../src/server/agent-status.ts";
import type { AgentRuntimeState, AgentRuntimeStateInput } from "../../src/server/agent-status.ts";

const FIRST = "2026-07-25T00:00:00.000Z";
const LATER = "2026-07-25T00:01:00.000Z";
function input(sessionKey = "s1", observedAt = FIRST): AgentRuntimeStateInput {
  return {
    sessionKey,
    broker: { state: "alive", observedAt },
    sources: [],
    fallback: { rawOutputChanged: false, observedAt },
    currentRun: { runId: sessionKey, runOrder: 1 },
  };
}

let dir: string;
let path: string;
let restores: (() => void)[];
let stores: AgentRuntimeStateStore[];
let now: number;
const timers = new Map<object, { at: number; run: () => void }>();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
function storeAt(file = path): AgentRuntimeStateStore {
  const store = new AgentRuntimeStateStore(file);
  stores.push(store);
  return store;
}
function advance(ms: number): void {
  now += ms;
  for (const [handle, timer] of [...timers]) {
    if (timer.at > now) continue;
    timers.delete(handle);
    realClearTimeout(Number(handle));
    timer.run();
  }
}
async function settle(store: AgentRuntimeStateStore): Promise<void> {
  await (Reflect.get(store, "inFlight") as Promise<boolean> | null);
}
async function persistWindow(store: AgentRuntimeStateStore): Promise<void> {
  advance(RUNTIME_STATE_PERSIST_DEBOUNCE_MS);
  await settle(store);
}
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "runtime-batching-"));
  path = join(dir, "state.json");
  restores = [];
  stores = [];
  now = 0;
  // Bun's referenced broker test currently has no fake clock. Intercept only
  // timer scheduling; persistence still uses real async filesystem operations.
  const schedule = (callback: TimerHandler, delay?: number, ...args: unknown[]): ReturnType<typeof setTimeout> => {
    const handle = realSetTimeout(() => {}, 2_147_483_647);
    handle.unref();
    timers.set(handle, { at: now + (delay ?? 0), run: () => {
      if (typeof callback !== "function") throw new Error("expected timer callback");
      callback(...args);
    } });
    return handle;
  };
  // Narrow the global's overlapping DOM/Node overloads to the store's actual
  // callback API; this is the same global object, not a replacement store.
  const timerApi: { setTimeout: (callback: () => void, delay?: number) => ReturnType<typeof setTimeout> } = globalThis;
  track(spyOn(timerApi, "setTimeout").mockImplementation(schedule));
  track(spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    if (typeof handle === "object" && handle !== null) timers.delete(handle);
    realClearTimeout(typeof handle === "object" && handle !== null ? Number(handle) : handle);
  }));
});
afterEach(async () => {
  for (const store of stores) {
    store.cancelScheduledPersist();
    await settle(store);
    store.cancelScheduledPersist();
  }
  for (const handle of timers.keys()) realClearTimeout(Number(handle));
  timers.clear();
  for (const restore of restores.reverse()) restore();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runtime-state batching ownership and work budgets", () => {
  for (const size of [10, 100, 1_000]) {
    test(`${size} per-entry updates never enumerate/copy the session map`, async () => {
      const store = storeAt();
      const keys = new Set(Array.from({ length: size }, (_, i) => `s${i}`));
      for (const key of keys) store.reduce(input(key), { persist: false });
      store.flush();
      await persistWindow(store);
      const file = Reflect.get(store, "file") as { sessions: Record<string, AgentRuntimeState> };
      let enumerations = 0;
      let reads = 0;
      const backing = new Proxy(file.sessions, {
        ownKeys(target) { enumerations++; return Reflect.ownKeys(target); },
        get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); },
      });
      file.sessions = backing;
      const rename = track(spyOn(asyncFs, "rename"));
      for (const key of keys) store.reduce(input(key, LATER), { persist: false });
      expect(enumerations).toBe(0);
      expect((Reflect.get(store, "file") as typeof file).sessions).toBe(backing);
      store.prune(keys, { persist: false });
      store.flush();
      await persistWindow(store);
      expect(rename).toHaveBeenCalledTimes(0);
      expect(enumerations).toBe(1); // Prune only; observation does not serialize.
      expect(reads).toBeLessThanOrEqual(4 * size + 5);
      store.acknowledge("s0", 1, LATER);
      expect(enumerations).toBe(1);
      await persistWindow(store);
      expect(rename).toHaveBeenCalledTimes(1);
      expect(enumerations).toBe(2);
      store.flush();
      await persistWindow(store);
      expect(enumerations).toBe(2);
    });
  }

  test("equivalent and observation-only reductions perform zero write attempts", async () => {
    const store = storeAt();
    const first = store.reduce(input());
    await persistWindow(store);
    const bytes = fs.readFileSync(path, "utf8");
    const before = fs.statSync(path);
    const write = track(spyOn(asyncFs, "writeFile"));
    const rename = track(spyOn(asyncFs, "rename"));
    expect(store.reduce(input())).toBe(first);
    store.reduce(input("s1", LATER));
    store.prune(new Set(["s1"]));
    store.flush();
    storeAt().flush();
    await persistWindow(store);
    expect(write).toHaveBeenCalledTimes(0);
    expect(rename).toHaveBeenCalledTimes(0);
    expect(fs.readFileSync(path, "utf8")).toBe(bytes);
    expect(fs.statSync(path).ino).toBe(before.ino);
    expect(fs.statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(store.get("s1")?.observedAt).toBe(LATER);
  });

  test("three semantic changes coalesce into one atomic write after exactly one window", async () => {
    const store = storeAt();
    const write = track(spyOn(asyncFs, "writeFile"));
    const rename = track(spyOn(asyncFs, "rename"));
    const sync = track(spyOn(fs, "fsyncSync"));
    const first = store.reduce(input());
    advance(500);
    store.acknowledge("s1", first.transitionSequence, FIRST);
    advance(500);
    store.acknowledge("s1", first.transitionSequence, LATER);
    advance(RUNTIME_STATE_PERSIST_DEBOUNCE_MS - 1_001);
    expect(fs.existsSync(path)).toBe(false);
    expect(write).toHaveBeenCalledTimes(0);
    advance(1);
    await settle(store);
    expect(write).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(0);
    expect(storeAt().get("s1")).toEqual(store.get("s1"));
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    advance(10_000);
    await settle(store);
    expect(write).toHaveBeenCalledTimes(1);
  });

  test("observed timestamps piggyback on acknowledgement, while acknowledgement changes persist", async () => {
    const store = storeAt();
    const first = store.reduce(input());
    await persistWindow(store);
    const observed = store.reduce(input("s1", LATER));
    expect(observed.changedAt).toBe(first.changedAt);
    expect(observed.transitionSequence).toBe(first.transitionSequence);
    const ack = store.acknowledge("s1", first.transitionSequence, FIRST);
    expect(store.acknowledge("s1", first.transitionSequence, FIRST)).toBe(ack);
    store.acknowledge("s1", first.transitionSequence, LATER);
    await persistWindow(store);
    expect(storeAt().get("s1")).toMatchObject({ observedAt: LATER, acknowledgedAt: LATER, unseen: false });
    for (const sequence of [NaN, -1, 0.5, first.transitionSequence + 1]) {
      expect(store.acknowledge("s1", sequence)).toBeNull();
    }
    expect(store.acknowledge("missing", first.transitionSequence)).toBeNull();
  });

  test("dirty changes during a real write produce exactly one single-flight follow-up", async () => {
    const store = storeAt();
    const originalRename = asyncFs.rename;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const rename = track(spyOn(asyncFs, "rename").mockImplementationOnce(async (...args) => {
      started();
      await gate;
      await originalRename(...args);
    }));
    const first = store.reduce(input());
    advance(RUNTIME_STATE_PERSIST_DEBOUNCE_MS);
    try {
      await entered;
      store.acknowledge("s1", first.transitionSequence, FIRST);
      store.acknowledge("s1", first.transitionSequence, LATER);
      advance(10_000);
      expect(rename).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await settle(store);
    }
    expect(storeAt().get("s1")?.unseen).toBe(true);
    advance(RUNTIME_STATE_PERSIST_DEBOUNCE_MS - 1);
    expect(rename).toHaveBeenCalledTimes(1);
    advance(1);
    await settle(store);
    expect(rename).toHaveBeenCalledTimes(2);
    expect(storeAt().get("s1")?.acknowledgedAt).toBe(LATER);
    await persistWindow(store);
    expect(rename).toHaveBeenCalledTimes(2);
  });

  test("observation-only collection during initial write schedules no follow-up", async () => {
    const store = storeAt();
    const originalRename = asyncFs.rename;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const rename = track(spyOn(asyncFs, "rename").mockImplementationOnce(async (...args) => {
      started();
      await gate;
      await originalRename(...args);
    }));
    store.reduce(input());
    advance(RUNTIME_STATE_PERSIST_DEBOUNCE_MS);
    try {
      await entered;
      store.reduce(input("s1", LATER));
      store.flush();
    } finally {
      release();
      await settle(store);
    }
    await persistWindow(store);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  test("unusable directory leaves dirty state and automatically retries next window", async () => {
    const blocked = join(dir, "blocked");
    fs.writeFileSync(blocked, "not a directory");
    const store = storeAt(join(blocked, "state.json"));
    expect(() => store.reduce(input())).not.toThrow();
    await persistWindow(store);
    expect(fs.existsSync(store.path)).toBe(false);
    expect(Reflect.get(store, "dirty")).toBe(true);
    fs.unlinkSync(blocked);
    fs.mkdirSync(blocked);
    advance(RUNTIME_STATE_PERSIST_DEBOUNCE_MS - 1);
    expect(fs.existsSync(store.path)).toBe(false);
    advance(1);
    await settle(store);
    expect(storeAt(store.path).get("s1")).toEqual(store.get("s1"));
    expect(fs.readdirSync(blocked)).toEqual(["state.json"]);
  });

  for (const operation of ["writeFile", "rename", "rm"] as const) {
    test(`${operation} failure preserves acknowledgement and retries without throwing`, async () => {
      const store = storeAt();
      const first = store.reduce(input());
      await persistWindow(store);
      const before = fs.readFileSync(path, "utf8");
      const failure = track(spyOn(asyncFs, operation).mockRejectedValueOnce(new Error("injected persistence failure")));
      expect(() => store.acknowledge("s1", first.transitionSequence, LATER)).not.toThrow();
      await persistWindow(store);
      expect(Reflect.get(store, "dirty")).toBe(true);
      expect(store.get("s1")?.unseen).toBe(false);
      if (operation !== "rm") expect(fs.readFileSync(path, "utf8")).toBe(before);
      expect(fs.readdirSync(dir)).toEqual(["state.json"]);
      failure.mockRestore();
      await persistWindow(store);
      expect(storeAt().get("s1")?.acknowledgedAt).toBe(LATER);
    });
  }

  test("old snapshots/results remain stable and public aliases cannot evade dirty tracking", async () => {
    const store = storeAt();
    const caller = input();
    const first = store.reduce(caller);
    const snapshot = store.snapshot();
    for (const value of [caller, caller.broker, caller.currentRun, caller.sources]) expect(Object.isFrozen(value)).toBe(false);
    for (const value of [first, store.get("s1")!, snapshot.sessions.s1!]) {
      expect(Object.isFrozen(value)).toBe(true);
      expect(Reflect.set(value, "unseen", false)).toBe(false);
    }
    delete snapshot.sessions.s1;
    expect(store.get("s1")).toBe(first);
    const held = store.snapshot();
    const ack = store.acknowledge("s1", first.transitionSequence, LATER)!;
    expect(Object.isFrozen(ack)).toBe(true);
    expect(first.unseen).toBe(true);
    expect(held.sessions.s1).toBe(first);
    store.reduce(input("s2"));
    store.prune(new Set(["s2"]));
    await persistWindow(store);
    expect(Object.keys(held.sessions)).toEqual(["s1"]);
    expect(store.get("s1")).toBeUndefined();
    expect(storeAt().get("s1")).toBeUndefined();
  });

  test("loaded extension graphs are owned/frozen and acknowledgement preserves them", async () => {
    const seedStore = storeAt();
    const seed = seedStore.reduce(input());
    await persistWindow(seedStore);
    fs.writeFileSync(path, JSON.stringify({ schemaVersion: 1, sessions: {
      s1: { ...seed, extension: { labels: ["original"] } },
    } }));
    const store = storeAt();
    const state = store.get("s1") as AgentRuntimeState & { extension: { labels: string[] } };
    expect(Object.isFrozen(state.extension)).toBe(true);
    expect(Reflect.set(state.extension.labels, "0", "mutated")).toBe(false);
    store.acknowledge("s1", state.transitionSequence, LATER);
    await persistWindow(store);
    expect(JSON.parse(fs.readFileSync(path, "utf8")).sessions.s1.extension.labels).toEqual(["original"]);
  });

  test("opaque prototype-like session keys survive updates, snapshot, restart and pruning", async () => {
    const store = storeAt();
    const keys = ["__proto__", "constructor", "toString"];
    for (const key of keys) {
      expect(store.get(key)).toBeUndefined();
      store.reduce(input(key), { persist: false });
    }
    store.flush();
    await persistWindow(store);
    expect(Object.keys(store.snapshot().sessions)).toEqual(keys);
    const restarted = storeAt();
    for (const key of keys) expect(restarted.get(key)?.runId).toBe(key);
    restarted.prune(new Set(["__proto__"]));
    await persistWindow(restarted);
    expect(restarted.get("constructor")).toBeUndefined();
    expect(Object.keys(storeAt().snapshot().sessions)).toEqual(["__proto__"]);
  });

  test("missing/invalid files initialize and deleting a clean file permits recreation", async () => {
    const store = storeAt();
    store.flush();
    await persistWindow(store);
    expect(JSON.parse(fs.readFileSync(path, "utf8"))).toEqual({ schemaVersion: 1, sessions: {} });
    store.reduce(input());
    await persistWindow(store);
    fs.unlinkSync(path);
    store.flush();
    await persistWindow(store);
    expect(storeAt().get("s1")).toEqual(store.get("s1"));
    fs.writeFileSync(path, '{"schemaVersion":0,"sessions":{}}');
    const invalid = storeAt();
    invalid.flush();
    await persistWindow(invalid);
    expect(JSON.parse(fs.readFileSync(path, "utf8"))).toEqual({ schemaVersion: 1, sessions: {} });
    fs.writeFileSync(path, "{invalid-json");
    expect(() => storeAt()).toThrow();
  });

  test("shutdown drains pending semantic state without waiting for debounce", async () => {
    const store = storeAt();
    store.reduce(input());
    expect(fs.existsSync(path)).toBe(false);
    await store.flushForShutdown();
    expect(storeAt().get("s1")).toEqual(store.get("s1"));
    expect(timers.size).toBe(0);
  });
});
