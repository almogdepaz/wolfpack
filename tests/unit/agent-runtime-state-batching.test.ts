import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeStateStore } from "../../src/server/agent-status.ts";
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
function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "runtime-batching-"));
  path = join(dir, "state.json");
  restores = [];
});
afterEach(() => {
  for (const restore of restores.reverse()) restore();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runtime-state batching ownership and work budgets", () => {
  for (const size of [10, 100, 1_000]) {
    test(`${size} per-entry updates never enumerate/copy the session map`, () => {
      const store = new AgentRuntimeStateStore(path);
      const keys = new Set(Array.from({ length: size }, (_, i) => `s${i}`));
      for (const key of keys) store.reduce(input(key), { persist: false });
      store.flush();
      // Observe the real backing dictionary: do not mock away the production
      // store/reducer. A spread, stringify or map replacement must fail here.
      const file = Reflect.get(store, "file") as { sessions: Record<string, AgentRuntimeState> };
      let enumerations = 0;
      let reads = 0;
      const backing = new Proxy(file.sessions, {
        ownKeys(target) { enumerations++; return Reflect.ownKeys(target); },
        get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); },
      });
      file.sessions = backing;
      const rename = track(spyOn(fs, "renameSync"));
      for (const key of keys) store.reduce(input(key, LATER), { persist: false });
      expect(enumerations).toBe(0);
      expect((Reflect.get(store, "file") as typeof file).sessions).toBe(backing);
      expect(rename).toHaveBeenCalledTimes(0);
      store.prune(keys, { persist: false });
      store.flush();
      expect(rename).toHaveBeenCalledTimes(1);
      expect(enumerations).toBe(2); // One prune traversal, one serialization.
      expect(reads).toBeLessThanOrEqual(4 * size + 5);
      store.flush();
      expect(enumerations).toBe(2); // A clean flush does not even serialize.
      expect(rename).toHaveBeenCalledTimes(1);
    });
  }

  test("equivalent reductions, unchanged prune and clean/restarted flush do no writes", () => {
    const store = new AgentRuntimeStateStore(path);
    const first = store.reduce(input());
    const bytes = fs.readFileSync(path, "utf8");
    const inode = fs.statSync(path).ino;
    const rename = track(spyOn(fs, "renameSync"));
    const write = track(spyOn(fs, "writeFileSync"));
    expect(store.reduce(input())).toBe(first);
    store.prune(new Set(["s1"]));
    store.flush();
    new AgentRuntimeStateStore(path).flush();
    expect(rename).toHaveBeenCalledTimes(0);
    expect(write).toHaveBeenCalledTimes(0);
    expect(fs.readFileSync(path, "utf8")).toBe(bytes);
    expect(fs.statSync(path).ino).toBe(inode);
  });

  test("observation and acknowledgement timestamps remain meaningful changes", () => {
    const store = new AgentRuntimeStateStore(path);
    const first = store.reduce(input());
    const rename = track(spyOn(fs, "renameSync"));
    const observed = store.reduce(input("s1", LATER));
    expect(observed.observedAt).toBe(LATER);
    expect(observed.changedAt).toBe(first.changedAt);
    expect(observed.transitionSequence).toBe(first.transitionSequence);
    expect(rename).toHaveBeenCalledTimes(1);
    const ack = store.acknowledge("s1", first.transitionSequence, FIRST);
    expect(rename).toHaveBeenCalledTimes(2);
    expect(store.acknowledge("s1", first.transitionSequence, FIRST)).toBe(ack);
    expect(rename).toHaveBeenCalledTimes(2);
    store.acknowledge("s1", first.transitionSequence, LATER);
    expect(rename).toHaveBeenCalledTimes(3);
    expect(new AgentRuntimeStateStore(path).get("s1")?.acknowledgedAt).toBe(LATER);
    for (const sequence of [NaN, -1, 0.5, first.transitionSequence + 1]) {
      expect(store.acknowledge("s1", sequence)).toBeNull();
    }
    expect(store.acknowledge("missing", first.transitionSequence)).toBeNull();
    expect(rename).toHaveBeenCalledTimes(3);
  });

  test("old snapshots/results remain stable and public aliases cannot evade dirty tracking", () => {
    const store = new AgentRuntimeStateStore(path);
    const caller = input();
    const first = store.reduce(caller);
    const snapshot = store.snapshot();
    expect(Object.isFrozen(caller)).toBe(false);
    expect(Object.isFrozen(caller.broker)).toBe(false);
    expect(Object.isFrozen(caller.currentRun)).toBe(false);
    expect(Object.isFrozen(caller.sources)).toBe(false);
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
    expect(Object.keys(held.sessions)).toEqual(["s1"]);
    expect(store.get("s1")).toBeUndefined();
    expect(new AgentRuntimeStateStore(path).get("s1")).toBeUndefined();
  });

  test("loaded extension graphs are owned/frozen and acknowledgement preserves them", () => {
    const seed = new AgentRuntimeStateStore(path).reduce(input());
    fs.writeFileSync(path, JSON.stringify({ schemaVersion: 1, sessions: {
      s1: { ...seed, extension: { labels: ["original"] } },
    } }));
    const store = new AgentRuntimeStateStore(path);
    const state = store.get("s1") as AgentRuntimeState & { extension: { labels: string[] } };
    expect(Object.isFrozen(state.extension)).toBe(true);
    expect(Reflect.set(state.extension.labels, "0", "mutated")).toBe(false);
    store.acknowledge("s1", state.transitionSequence, LATER);
    expect(JSON.parse(fs.readFileSync(path, "utf8")).sessions.s1.extension.labels).toEqual(["original"]);
  });

  test("opaque prototype-like session keys survive updates, snapshot, restart and pruning", () => {
    const store = new AgentRuntimeStateStore(path);
    const keys = ["__proto__", "constructor", "toString"];
    for (const key of keys) {
      expect(store.get(key)).toBeUndefined();
      store.reduce(input(key), { persist: false });
    }
    store.flush();
    expect(Object.keys(store.snapshot().sessions)).toEqual(keys);
    const restarted = new AgentRuntimeStateStore(path);
    for (const key of keys) expect(restarted.get(key)?.runId).toBe(key);
    restarted.prune(new Set(["__proto__"]));
    expect(restarted.get("constructor")).toBeUndefined();
    expect(Object.keys(new AgentRuntimeStateStore(path).snapshot().sessions)).toEqual(["__proto__"]);
  });

  test("missing/invalid files are initialized, and deleting a clean file permits recreation", () => {
    const store = new AgentRuntimeStateStore(path);
    expect(fs.existsSync(path)).toBe(false);
    store.flush();
    expect(JSON.parse(fs.readFileSync(path, "utf8"))).toEqual({ schemaVersion: 1, sessions: {} });
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    store.reduce(input());
    fs.unlinkSync(path);
    store.flush();
    expect(new AgentRuntimeStateStore(path).get("s1")).toEqual(store.get("s1"));
    fs.writeFileSync(path, '{"schemaVersion":0,"sessions":{}}');
    const invalid = new AgentRuntimeStateStore(path);
    invalid.flush();
    expect(JSON.parse(fs.readFileSync(path, "utf8"))).toEqual({ schemaVersion: 1, sessions: {} });
    fs.writeFileSync(path, "{invalid-json");
    expect(() => new AgentRuntimeStateStore(path)).toThrow();
  });

  test("post-rename cleanup failure does not falsely mark the store clean", () => {
    const store = new AgentRuntimeStateStore(path);
    const first = store.reduce(input());
    const cleanup = track(spyOn(fs, "rmSync").mockImplementationOnce(() => { throw new Error("cleanup failure"); }));
    expect(() => store.acknowledge("s1", first.transitionSequence, LATER)).toThrow("cleanup failure");
    cleanup.mockRestore();
    // Rename already succeeded, but the public write operation failed.
    expect(new AgentRuntimeStateStore(path).get("s1")?.acknowledgedAt).toBe(LATER);
    const rename = track(spyOn(fs, "renameSync"));
    store.flush();
    expect(rename).toHaveBeenCalledTimes(1);
    store.flush();
    expect(rename).toHaveBeenCalledTimes(1);
  });

  test("failed recreation of a previously clean file remains retryable after rename", () => {
    const store = new AgentRuntimeStateStore(path);
    store.reduce(input());
    fs.unlinkSync(path);
    const cleanup = track(spyOn(fs, "rmSync").mockImplementationOnce(() => { throw new Error("cleanup failure"); }));
    expect(() => store.flush()).toThrow("cleanup failure");
    cleanup.mockRestore();
    expect(fs.existsSync(path)).toBe(true);
    const rename = track(spyOn(fs, "renameSync"));
    store.flush();
    expect(rename).toHaveBeenCalledTimes(1);
  });

  for (const operation of ["writeFileSync", "fsyncSync", "renameSync"] as const) {
    test(`${operation} failure retains pending acknowledgement for retry`, () => {
      const store = new AgentRuntimeStateStore(path);
      const first = store.reduce(input());
      const diskBefore = fs.readFileSync(path, "utf8");
      const failure = track(spyOn(fs, operation).mockImplementationOnce(() => { throw new Error("injected persistence failure"); }));
      expect(() => store.acknowledge("s1", first.transitionSequence, LATER)).toThrow("injected persistence failure");
      expect(fs.readFileSync(path, "utf8")).toBe(diskBefore);
      expect(store.get("s1")?.unseen).toBe(false); // Existing in-memory-on-error semantics.
      expect(fs.readdirSync(dir)).toEqual(["state.json"]);
      failure.mockRestore();
      store.flush();
      expect(new AgentRuntimeStateStore(path).get("s1")?.acknowledgedAt).toBe(LATER);
      const rename = track(spyOn(fs, "renameSync"));
      store.flush();
      expect(rename).toHaveBeenCalledTimes(0);
    });
  }
});
