import { describe, expect, jest, test } from "bun:test";
import {
  createTerminalPool,
  MOBILE_TERMINAL_POOL_SIZE,
  TERMINAL_POOL_SIZE,
  canParkTerminal,
  createParkedTerminalExpiry,
  HIDDEN_PARKED_EVICT_MS,
  PARKED_TERMINAL_TTL_MS,
  shouldEvictParkedTerminal,
  showAfterReleasingStaleVisible,
  type TerminalPool,
  type TerminalPoolKey,
} from "../../public/terminal-pool.ts";

interface FakeEntry {
  readonly key: TerminalPoolKey;
  connects: number;
}

interface PoolHarness {
  readonly pool: TerminalPool<FakeEntry>;
  readonly log: string[];
  readonly created: FakeEntry[];
  capacity: number;
  open(session: string, machine?: string): { readonly entry: FakeEntry; readonly hit: boolean };
}

function name(entry: FakeEntry): string {
  return entry.key.machine ? `${entry.key.machine}|${entry.key.session}` : entry.key.session;
}

function harness(capacity = TERMINAL_POOL_SIZE): PoolHarness {
  const log: string[] = [];
  const created: FakeEntry[] = [];
  const state = { capacity };
  const pool = createTerminalPool<FakeEntry>({
    capacity: () => state.capacity,
    attach: (entry) => log.push(`attach ${name(entry)}`),
    detach: (entry) => log.push(`detach ${name(entry)}`),
    dispose: (entry) => log.push(`dispose ${name(entry)}`),
  });
  return {
    pool,
    log,
    created,
    get capacity() { return state.capacity; },
    set capacity(value: number) { state.capacity = value; },
    open(session: string, machine = "") {
      return pool.open({ session, machine }, () => {
        const entry: FakeEntry = { key: { session, machine }, connects: 0 };
        // The real factory mounts Ghostty and opens the PTY socket.
        entry.connects++;
        created.push(entry);
        log.push(`create ${name(entry)}`);
        return entry;
      });
    },
  };
}

function sessions(pool: TerminalPool<FakeEntry>): string[] {
  return pool.keys().map((key) => key.machine ? `${key.machine}|${key.session}` : key.session);
}

describe("terminal pool", () => {
  test("defaults keep three desktop terminals and one mobile terminal", () => {
    expect(TERMINAL_POOL_SIZE).toBe(3);
    expect(MOBILE_TERMINAL_POOL_SIZE).toBe(1);
  });

  test("orders entries most-recently-shown first", () => {
    const h = harness();
    h.open("a");
    h.open("b");
    h.open("c");
    expect(sessions(h.pool)).toEqual(["c", "b", "a"]);
    h.open("a");
    expect(sessions(h.pool)).toEqual(["a", "c", "b"]);
  });

  test("a hit shows the pooled entry without creating, connecting or attaching a new terminal", () => {
    const h = harness();
    const first = h.open("a");
    h.open("b");
    h.log.length = 0;

    const again = h.open("a");

    expect(again.hit).toBe(true);
    expect(again.entry).toBe(first.entry);
    expect(h.created).toHaveLength(2);
    expect(first.entry.connects).toBe(1);
    expect(h.log).toEqual(["detach b", "attach a"]);
  });

  test("show is hit-only: it never creates and returns null on a miss", () => {
    const h = harness();
    const a = h.open("a").entry;
    h.open("b");
    h.log.length = 0;
    expect(h.pool.show({ session: "c", machine: "" })).toBeNull();
    expect(h.log).toEqual([]);
    expect(h.pool.show({ session: "a", machine: "" })).toBe(a);
    expect(h.log).toEqual(["detach b", "attach a"]);
    expect(h.created).toHaveLength(2);
    expect(sessions(h.pool)).toEqual(["a", "b"]);
  });

  test("opening the visible entry is a no-op hit", () => {
    const h = harness();
    const first = h.open("a");
    h.log.length = 0;
    expect(h.open("a")).toEqual({ entry: first.entry, hit: true });
    expect(h.log).toEqual([]);
  });

  test("keys distinguish machines", () => {
    const h = harness();
    h.open("a");
    const remote = h.open("a", "https://peer");
    expect(remote.hit).toBe(false);
    expect(sessions(h.pool)).toEqual(["https://peer|a", "a"]);
  });

  test("at most one entry is visible and only the visible entry is attached", () => {
    const h = harness();
    const a = h.open("a").entry;
    const b = h.open("b").entry;
    expect(h.pool.visible).toBe(b);
    expect(h.pool.isVisible(a)).toBe(false);
    expect(h.pool.isVisible(b)).toBe(true);
    // A hidden entry is detached from the document: it cannot hold focus or
    // receive keyboard input.
    expect(h.log).toEqual(["create a", "attach a", "detach a", "create b", "attach b"]);
  });

  test("eviction disposes exactly the least-recently-used hidden entry before creating the new one", () => {
    const h = harness(3);
    h.open("a");
    h.open("b");
    h.open("c");
    h.open("a");
    h.log.length = 0;

    h.open("d");

    expect(h.log).toEqual(["detach a", "dispose b", "create d", "attach d"]);
    expect(sessions(h.pool)).toEqual(["d", "a", "c"]);
    expect(h.pool.size).toBe(3);
  });

  test("size 1 reduces to today's teardown-then-create switching", () => {
    const h = harness(1);
    h.open("a");
    h.log.length = 0;

    const b = h.open("b");
    expect(b.hit).toBe(false);
    expect(h.log).toEqual(["detach a", "dispose a", "create b", "attach b"]);

    h.log.length = 0;
    const a = h.open("a");
    expect(a.hit).toBe(false);
    expect(h.log).toEqual(["detach b", "dispose b", "create a", "attach a"]);
    expect(h.pool.size).toBe(1);
  });

  test("a shrunken capacity evicts hidden entries on the next open but never the visible one", () => {
    const h = harness(3);
    h.open("a");
    h.open("b");
    h.open("c");
    h.capacity = 1;
    h.log.length = 0;
    const hit = h.open("b");
    expect(hit.hit).toBe(true);
    expect(h.log).toEqual(["detach c", "attach b", "dispose a", "dispose c"]);
    expect(sessions(h.pool)).toEqual(["b"]);
  });

  test("park hides the visible entry without disposing it", () => {
    const h = harness();
    const a = h.open("a").entry;
    h.log.length = 0;
    expect(h.pool.park()).toBe(a);
    expect(h.pool.visible).toBeNull();
    expect(h.pool.get({ session: "a", machine: "" })).toBe(a);
    expect(h.log).toEqual(["detach a"]);
    expect(h.pool.park()).toBeNull();
  });

  test("evict disposes the entry and clears visibility when it was visible", () => {
    const h = harness();
    h.open("a");
    const b = h.open("b").entry;
    h.log.length = 0;
    expect(h.pool.evict({ session: "b", machine: "" })).toBe(true);
    expect(h.pool.visible).toBeNull();
    expect(h.pool.has({ session: "b", machine: "" })).toBe(false);
    expect(h.log).toEqual([`dispose ${name(b)}`]);
    expect(h.pool.evict({ session: "b", machine: "" })).toBe(false);
  });

  test("evictEntry ignores a stale entry replaced under the same key", () => {
    const h = harness();
    const stale = h.open("a").entry;
    h.pool.evict({ session: "a", machine: "" });
    const fresh = h.open("a").entry;
    h.log.length = 0;
    expect(h.pool.evictEntry(stale)).toBe(false);
    expect(h.pool.get({ session: "a", machine: "" })).toBe(fresh);
    expect(h.log).toEqual([]);
  });

  test("evictMachine disposes hidden entries of that machine only", () => {
    const h = harness();
    h.open("a", "https://peer");
    h.open("b");
    h.open("c", "https://peer");
    h.log.length = 0;

    expect(h.pool.evictMachine("https://peer")).toBe(1);

    // The visible entry's teardown stays with the single-view UI.
    expect(h.log).toEqual(["dispose https://peer|a"]);
    expect(sessions(h.pool)).toEqual(["https://peer|c", "b"]);
  });

  test("evictHidden keeps only the visible entry", () => {
    const h = harness();
    h.open("a");
    h.open("b");
    h.open("c");
    h.log.length = 0;
    expect(h.pool.evictHidden()).toBe(2);
    expect(h.log).toEqual(["dispose b", "dispose a"]);
    expect(sessions(h.pool)).toEqual(["c"]);
  });

  test("clear disposes every entry", () => {
    const h = harness();
    h.open("a");
    h.open("b");
    h.log.length = 0;
    h.pool.clear();
    expect(h.log).toEqual(["dispose b", "dispose a"]);
    expect(h.pool.size).toBe(0);
    expect(h.pool.visible).toBeNull();
  });

  test("a factory that throws leaves the pool without a visible entry", () => {
    const h = harness();
    h.open("a");
    expect(() => h.pool.open({ session: "b", machine: "" }, () => { throw new Error("mount failed"); })).toThrow("mount failed");
    expect(h.pool.visible).toBeNull();
    expect(sessions(h.pool)).toEqual(["a"]);
  });
});

describe("showAfterReleasingStaleVisible", () => {
  test("a stale visible entry for the same key is evicted, never returned as a hit", () => {
    const h = harness();
    h.open("a");
    h.log.length = 0;
    expect(showAfterReleasingStaleVisible(h.pool, { session: "a", machine: "" })).toBeNull();
    expect(h.log).toEqual(["dispose a"]);
    expect(h.pool.size).toBe(0);
  });

  test("a stale visible entry is evicted before a parked entry is shown", () => {
    const h = harness();
    const a = h.open("a").entry;
    h.open("b");
    h.log.length = 0;
    expect(showAfterReleasingStaleVisible(h.pool, { session: "a", machine: "" })).toBe(a);
    expect(h.log).toEqual(["dispose b", "attach a"]);
  });

  test("without a visible entry it is a plain show", () => {
    const h = harness();
    const a = h.open("a").entry;
    h.pool.park();
    h.log.length = 0;
    expect(showAfterReleasingStaleVisible(h.pool, { session: "a", machine: "" })).toBe(a);
    expect(h.log).toEqual(["attach a"]);
  });
});

describe("parked terminal policy", () => {
  test("session end, displacement and terminal connection failures evict a parked entry", () => {
    for (const event of ["displaced", "session-ended", "pty-exited", "viewer-conflict", "reconnect-exhausted", "route-unavailable"] as const) {
      expect(shouldEvictParkedTerminal(event)).toBe(true);
    }
  });

  test("a transient disconnect keeps the parked entry for a reconnect on show", () => {
    expect(shouldEvictParkedTerminal("reconnect")).toBe(false);
  });

  test("only a healthy terminal can be parked", () => {
    expect(canParkTerminal({ hasTerminal: true, displaced: false, loadState: "live" })).toBe(true);
    expect(canParkTerminal({ hasTerminal: true, displaced: false, loadState: "hydrating" })).toBe(true);
    expect(canParkTerminal({ hasTerminal: true, displaced: false, loadState: "reconnecting" })).toBe(true);
    expect(canParkTerminal({ hasTerminal: false, displaced: false, loadState: "live" })).toBe(false);
    expect(canParkTerminal({ hasTerminal: true, displaced: true, loadState: "live" })).toBe(false);
    for (const loadState of ["viewer-conflict", "displaced", "ended", "failed"] as const) {
      expect(canParkTerminal({ hasTerminal: true, displaced: false, loadState })).toBe(false);
    }
  });
});

interface ExpiryHarness {
  readonly pool: TerminalPool<FakeEntry>;
  readonly expiry: ReturnType<typeof createParkedTerminalExpiry<FakeEntry>>;
  readonly disposed: string[];
  open(session: string): FakeEntry;
}

/** Wired the way app.ts wires it: pool hooks drive the expiry timers. */
function expiryHarness(): ExpiryHarness {
  const disposed: string[] = [];
  let pool: TerminalPool<FakeEntry> | null = null;
  const expiry = createParkedTerminalExpiry<FakeEntry>({
    ttlMs: () => PARKED_TERMINAL_TTL_MS,
    hiddenEvictMs: HIDDEN_PARKED_EVICT_MS,
    evictParked: (entry) => { if (pool && !pool.isVisible(entry)) pool.evictEntry(entry); },
    evictAllParked: () => { pool?.evictHidden(); },
  });
  pool = createTerminalPool<FakeEntry>({
    capacity: () => TERMINAL_POOL_SIZE,
    attach: (entry) => expiry.shown(entry),
    detach: (entry) => expiry.parked(entry),
    dispose: (entry) => { expiry.disposed(entry); disposed.push(name(entry)); },
  });
  const ownedPool = pool;
  return {
    pool: ownedPool,
    expiry,
    disposed,
    open: (session) => ownedPool.open({ session, machine: "" }, () => ({ key: { session, machine: "" }, connects: 1 })).entry,
  };
}

describe("parked terminal expiry", () => {
  test("bounds parked control: 2.5 minutes parked, 30 seconds while the page is hidden", () => {
    expect(PARKED_TERMINAL_TTL_MS).toBe(150_000);
    expect(HIDDEN_PARKED_EVICT_MS).toBe(30_000);
  });

  test("a parked entry is evicted when its TTL elapses; the visible entry is not", () => {
    jest.useFakeTimers();
    try {
      const h = expiryHarness();
      h.open("a");
      h.open("b");
      jest.advanceTimersByTime(PARKED_TERMINAL_TTL_MS - 1);
      expect(h.disposed).toEqual([]);
      jest.advanceTimersByTime(1);
      expect(h.disposed).toEqual(["a"]);
      expect(sessions(h.pool)).toEqual(["b"]);
      jest.advanceTimersByTime(PARKED_TERMINAL_TTL_MS * 2);
      expect(h.disposed).toEqual(["a"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("showing a parked entry before its TTL clears the timer; parking again restarts it", () => {
    jest.useFakeTimers();
    try {
      const h = expiryHarness();
      h.open("a");
      h.open("b");
      jest.advanceTimersByTime(PARKED_TERMINAL_TTL_MS - 10);
      h.open("a"); // shows a, parks b
      jest.advanceTimersByTime(10);
      expect(h.disposed).toEqual([]);
      h.open("b"); // parks a again: a fresh TTL
      jest.advanceTimersByTime(PARKED_TERMINAL_TTL_MS - 1);
      expect(h.disposed).toEqual([]);
      jest.advanceTimersByTime(1);
      expect(h.disposed).toEqual(["a"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("an evicted entry leaves no timer behind", () => {
    jest.useFakeTimers();
    try {
      const h = expiryHarness();
      h.open("a");
      h.open("b");
      h.pool.evictHidden();
      expect(h.disposed).toEqual(["a"]);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a hidden page evicts parked entries after 30 seconds and leaves the visible entry", () => {
    jest.useFakeTimers();
    try {
      const h = expiryHarness();
      h.open("a");
      h.open("b");
      h.open("c");
      h.expiry.pageHidden();
      jest.advanceTimersByTime(HIDDEN_PARKED_EVICT_MS - 1);
      expect(h.disposed).toEqual([]);
      jest.advanceTimersByTime(1);
      expect(h.disposed.sort()).toEqual(["a", "b"]);
      expect(sessions(h.pool)).toEqual(["c"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("returning before 30 seconds cancels the hidden-page eviction", () => {
    jest.useFakeTimers();
    try {
      const h = expiryHarness();
      h.open("a");
      h.open("b");
      h.expiry.pageHidden();
      jest.advanceTimersByTime(HIDDEN_PARKED_EVICT_MS - 1);
      h.expiry.pageVisible();
      jest.advanceTimersByTime(HIDDEN_PARKED_EVICT_MS);
      expect(h.disposed).toEqual([]);
      expect(sessions(h.pool)).toEqual(["b", "a"]);
    } finally {
      jest.useRealTimers();
    }
  });
});
