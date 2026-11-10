import { afterEach, beforeEach, describe, expect, test } from "bun:test";

process.env.WOLFPACK_TEST = "1";

import { CHILD_WAIT_LIMITS } from "../../src/child-event-contract.ts";
import { SESSION_EXIT_REASON } from "../../src/events-contract.ts";
import {
  __resetChildEventsForTests,
  childMessageEvent,
  childSessionExited,
  noteChildCreated,
} from "../../src/server/child-events.ts";
import {
  ChildWaitBusyError,
  childEventsSince,
  waitForChildren,
  type ChildWaitChild,
} from "../../src/server/child-wait.ts";
import { appendParentNotification, clearParentInbox, PARENT_INBOX_BOOT_ID } from "../../src/server/parent-inbox.ts";

const PARENT = { wolfpackSessionId: "parent-id", wolfpackSessionName: "lead" };
const publish = () => {};

function child(name: string, settled: boolean): ChildWaitChild {
  return { session: name, sessionId: `${name}-id`, settled };
}

/** Emit one real child event through child-events (a `message` from a tracked child). */
function emitMessage(name = "worker", text = "ready") {
  noteChildCreated(`${name}-id`, name, PARENT);
  return childMessageEvent(PARENT.wolfpackSessionId, name, text, publish);
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  __resetChildEventsForTests();
  clearParentInbox(PARENT.wolfpackSessionId);
});

afterEach(() => {
  __resetChildEventsForTests();
  clearParentInbox(PARENT.wolfpackSessionId);
});

describe("childEventsSince", () => {
  test("scopes since to the current boot and reads every event otherwise", () => {
    emitMessage("a");
    appendParentNotification(PARENT.wolfpackSessionId, { message: "plain", from: "x" });
    emitMessage("b");
    const current = childEventsSince(PARENT.wolfpackSessionId, 1, PARENT_INBOX_BOOT_ID);
    expect(current).toMatchObject({ bootId: PARENT_INBOX_BOOT_ID, since: 1, cursor: 3 });
    expect(current.events.map(event => event.childName)).toEqual(["b"]);
    expect(current.truncated).toBeUndefined();
    for (const bootId of [undefined, "other-boot"]) {
      const all = childEventsSince(PARENT.wolfpackSessionId, 1, bootId);
      expect(all).toMatchObject({ since: 0, cursor: 3 });
      expect(all.events.map(event => event.childName)).toEqual(["a", "b"]);
    }
  });

  test("keeps the cursor at since when nothing is newer and marks dropped entries", () => {
    expect(childEventsSince(PARENT.wolfpackSessionId, 4, PARENT_INBOX_BOOT_ID)).toMatchObject({ since: 4, cursor: 4, events: [] });
    for (let i = 0; i < 105; i++) appendParentNotification(PARENT.wolfpackSessionId, { message: `m${i}` });
    const read = childEventsSince(PARENT.wolfpackSessionId, 2, PARENT_INBOX_BOOT_ID);
    expect(read).toMatchObject({ cursor: 105, truncated: true });
    expect(childEventsSince(PARENT.wolfpackSessionId, 5, PARENT_INBOX_BOOT_ID).truncated).toBeUndefined();
  });
});

describe("waitForChildren", () => {
  test("any: returns existing events at once", async () => {
    emitMessage();
    const result = await waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "any", timeoutMs: 5_000, listChildren: async () => [child("worker", false)],
    });
    expect(result).toMatchObject({ outcome: "events", cursor: 1 });
    expect(result?.events).toHaveLength(1);
  });

  test("any: wakes on a later child event, including an exit", async () => {
    noteChildCreated("worker-id", "worker", PARENT);
    const pending = waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "any", timeoutMs: 5_000, listChildren: async () => [child("worker", false)],
    });
    await tick();
    childSessionExited("worker-id", { reason: SESSION_EXIT_REASON.EXIT, exitCode: 0 }, publish);
    const result = await pending;
    expect(result?.outcome).toBe("events");
    expect(result?.events.map(event => event.event)).toEqual(["exited"]);
  });

  test("any: an event during the children read is not lost", async () => {
    let release!: () => void;
    let calls = 0;
    const pending = waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId,
      mode: "any",
      timeoutMs: 5_000,
      listChildren: () => {
        calls += 1;
        if (calls > 1) return Promise.resolve([child("worker", false)]);
        return new Promise(resolve => { release = () => resolve([child("worker", false)]); });
      },
    });
    await tick();
    emitMessage();
    release();
    expect((await pending)?.outcome).toBe("events");
  });

  test("any: a retained event returns events while the children read is held, even at a short timeout", async () => {
    emitMessage();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      const result = await waitForChildren({
        parentSessionId: PARENT.wolfpackSessionId, mode: "any", timeoutMs: 30,
        listChildren: async () => { await gate; return [child("worker", false)]; },
      });
      expect(result).toMatchObject({ outcome: "events", cursor: 1 });
      expect(result?.events).toHaveLength(1);
    } finally {
      release();
    }
  });

  test("any: an event while the children read is held returns events without waiting for the read", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      const pending = waitForChildren({
        parentSessionId: PARENT.wolfpackSessionId, mode: "any", timeoutMs: 5_000,
        listChildren: async () => { await gate; return [child("worker", false)]; },
      });
      await tick();
      emitMessage();
      const raced = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve("held"), 50))]);
      expect(raced).toMatchObject({ outcome: "events", cursor: 1 });
    } finally {
      release();
    }
  });

  test("any: ignores events of another parent and other-boot cursors read the current boot", async () => {
    noteChildCreated("other-id", "other", { wolfpackSessionId: "other-parent", wolfpackSessionName: "x" });
    childMessageEvent("other-parent", "other", "hi", publish);
    clearParentInbox("other-parent");
    const stale = await waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "any", timeoutMs: 30, since: 0, bootId: "old-boot",
      listChildren: async () => [child("worker", false)],
    });
    expect(stale).toMatchObject({ outcome: "timeout", events: [], since: 0, cursor: 0 });
    emitMessage();
    const read = await waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "any", timeoutMs: 30, since: 9, bootId: "old-boot",
      listChildren: async () => [child("worker", false)],
    });
    expect(read).toMatchObject({ outcome: "events", since: 0, cursor: 1 });
  });

  test("any: no children and no events, and a timeout check-in", async () => {
    expect(await waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "any", timeoutMs: 5_000, listChildren: async () => [],
    })).toMatchObject({ outcome: "no_children", events: [] });
    emitMessage();
    expect(await waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "any", timeoutMs: 20, since: 1, bootId: PARENT_INBOX_BOOT_ID,
      listChildren: async () => [child("worker", false)],
    })).toMatchObject({ outcome: "timeout", events: [], since: 1, cursor: 1 });
  });

  test("all: settled when every live child is settled; pending children on timeout", async () => {
    expect(await waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "all", timeoutMs: 5_000,
      listChildren: async () => [child("a", true), child("b", true)],
    })).toMatchObject({ outcome: "settled" });
    const timedOut = await waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "all", timeoutMs: 30, recheckMs: 5,
      listChildren: async () => [child("a", true), child("b", false)],
    });
    expect(timedOut).toMatchObject({ outcome: "timeout", pending: [{ session: "b", sessionId: "b-id" }] });
  });

  test("all: no live children is settled after events, otherwise no_children", async () => {
    expect((await waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "all", timeoutMs: 5_000, listChildren: async () => [],
    }))?.outcome).toBe("no_children");
    emitMessage();
    expect((await waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "all", timeoutMs: 5_000, listChildren: async () => [],
    }))?.outcome).toBe("settled");
  });

  test("all: re-checks without an event and resolves when the child settles", async () => {
    let settled = false;
    const pending = waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "all", timeoutMs: 5_000, recheckMs: 5,
      listChildren: async () => [child("worker", settled)],
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    settled = true;
    const result = await pending;
    expect(result?.outcome).toBe("settled");
    expect(result?.pending).toBeUndefined();
  });

  test("all: an event during a stale children read runs one more read before the re-check", async () => {
    let release!: () => void;
    let calls = 0;
    const pending = waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "all", timeoutMs: 300, recheckMs: 60_000,
      listChildren: () => {
        calls += 1;
        if (calls > 1) return Promise.resolve([child("worker", true)]);
        return new Promise(resolve => { release = () => resolve([child("worker", false)]); });
      },
    });
    await tick();
    emitMessage();
    release();
    expect((await pending)?.outcome).toBe("settled");
    expect(calls).toBe(2);
  });

  test("all: an event during a settled children read invalidates it; the reread finds a new working child", async () => {
    let release!: () => void;
    let calls = 0;
    const pending = waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "all", timeoutMs: 50, recheckMs: 60_000,
      listChildren: () => {
        calls += 1;
        if (calls > 1) return Promise.resolve([child("a", true), child("b", false)]);
        return new Promise(resolve => { release = () => resolve([child("a", true)]); });
      },
    });
    await tick();
    emitMessage("b", "started");
    release();
    const result = await pending;
    expect(result).toMatchObject({ outcome: "timeout", pending: [{ session: "b", sessionId: "b-id" }] });
    expect(calls).toBe(2);
  });

  test("resolves to undefined on abort and rejects when the children read fails", async () => {
    const controller = new AbortController();
    const pending = waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "any", timeoutMs: 5_000, signal: controller.signal,
      listChildren: async () => [child("worker", false)],
    });
    await tick();
    controller.abort();
    expect(await pending).toBeUndefined();
    const aborted = new AbortController();
    aborted.abort();
    expect(await waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "any", timeoutMs: 5_000, signal: aborted.signal,
      listChildren: async () => [],
    })).toBeUndefined();
    await expect(waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "any", timeoutMs: 5_000,
      listChildren: async () => { throw new Error("backend down"); },
    })).rejects.toThrow("backend down");
  });

  test("refuses waits above the concurrent waiter cap and frees slots after they end", async () => {
    const controller = new AbortController();
    const waits = Array.from({ length: CHILD_WAIT_LIMITS.WAITERS }, () => waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "any", timeoutMs: 5_000, signal: controller.signal,
      listChildren: async () => [child("worker", false)],
    }));
    await expect(waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "any", timeoutMs: 5_000, listChildren: async () => [],
    })).rejects.toBeInstanceOf(ChildWaitBusyError);
    controller.abort();
    await Promise.all(waits);
    expect((await waitForChildren({
      parentSessionId: PARENT.wolfpackSessionId, mode: "any", timeoutMs: 5_000, listChildren: async () => [],
    }))?.outcome).toBe("no_children");
  });
});
