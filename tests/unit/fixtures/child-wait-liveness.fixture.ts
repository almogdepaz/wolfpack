import { afterEach, beforeEach, expect, test } from "bun:test";

// Runs in an owned process: a starved event loop never reaches bun's own test
// timeout, so the parent's lifecycle deadline is the watchdog (review A8-1).
process.env.WOLFPACK_TEST = "1";
const { __resetChildEventsForTests, childMessageEvent, noteChildCreated } = await import("../../../src/server/child-events.ts");
const { waitForChildren } = await import("../../../src/server/child-wait.ts");
const { clearParentInbox } = await import("../../../src/server/parent-inbox.ts");

const PARENT = { wolfpackSessionId: "parent-id", wolfpackSessionName: "lead" };
const WORKER = { session: "worker", sessionId: "worker-id" };

/** A reader that resolves at once and emits a real child event on every read. */
function emittingReader(settled: boolean): { reads: () => number; listChildren: () => Promise<{ session: string; sessionId: string; settled: boolean }[]> } {
  let reads = 0;
  return {
    reads: () => reads,
    listChildren: async () => {
      reads += 1;
      childMessageEvent(PARENT.wolfpackSessionId, "worker", `read ${reads}`, () => {});
      return [{ ...WORKER, settled }];
    },
  };
}

beforeEach(() => {
  __resetChildEventsForTests();
  clearParentInbox(PARENT.wolfpackSessionId);
  noteChildCreated(WORKER.sessionId, WORKER.session, PARENT);
});

afterEach(() => {
  __resetChildEventsForTests();
  clearParentInbox(PARENT.wolfpackSessionId);
});

for (const settled of [false, true]) {
  test(`all: a fast reader that emits on every read (${settled ? "settled" : "not settled"}) times out on time`, async () => {
    const reader = emittingReader(settled);
    const started = performance.now();
    const result = await waitForChildren({ parentSessionId: PARENT.wolfpackSessionId, mode: "all", timeoutMs: 50, recheckMs: 60_000, listChildren: reader.listChildren });
    const elapsed = performance.now() - started;
    expect(result?.outcome).toBe("timeout");
    if (settled) expect(result?.pending).toBeUndefined();
    else expect(result?.pending).toEqual([WORKER]);
    expect(reader.reads()).toBeGreaterThan(1);
    expect(elapsed).toBeLessThan(1_000);
  });
}

test("all: a disconnect ends the wait during a fast event stream", async () => {
  const reader = emittingReader(true);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const started = performance.now();
  const result = await waitForChildren({ parentSessionId: PARENT.wolfpackSessionId, mode: "all", timeoutMs: 5_000, recheckMs: 60_000, listChildren: reader.listChildren, signal: controller.signal });
  expect(result).toBeUndefined();
  expect(performance.now() - started).toBeLessThan(1_000);
});
