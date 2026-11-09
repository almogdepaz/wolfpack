import { expect, test } from "bun:test";
import { ViewerRedrawTracker, VIEWER_REDRAW_MS } from "../../src/server/viewer-redraw";
import type { SessionListFact } from "../../src/server/backend-contract";

const fact = (seq: string, id = "one") => ({ name: "work", alive: true, outputSequence: seq, identity: { wolfpackSessionId: id } }) as SessionListFact;

test("redraw reuses observed identity, coalesces reads and retains a full-width watermark for delayed observation", async () => {
  let current = fact("9007199254740993");
  let reads = 0;
  const tracker = new ViewerRedrawTracker({ listSessionFacts: async () => { reads++; return [current]; } });
  tracker.prune([current]);
  tracker.begin("work");
  tracker.begin("work");
  tracker.begin("work");
  expect(reads).toBe(0); // No RPC or await precedes the geometry send.
  expect(tracker.includes(current)).toBe(true);
  current = fact("9007199254740994");
  await Bun.sleep(VIEWER_REDRAW_MS + 40);
  expect(reads).toBe(1); // One off-path watermark lookup for the settled geometry burst.
  expect(tracker.includes(current)).toBe(true);
  expect(tracker.includes(fact("9007199254740995"))).toBe(false);
  tracker.begin("work");
  expect(tracker.includes(fact("1", "replacement"))).toBe(false);
  tracker.clear();
});

test("explicit input cancels redraw immediately and final attach geometry cannot re-arm it", () => {
  const tracker = new ViewerRedrawTracker({ listSessionFacts: async () => [fact("1")] });
  tracker.prune([fact("1")]);
  tracker.begin("work");
  tracker.input("work");
  expect(tracker.includes(fact("2"))).toBe(false);
  tracker.begin("work");
  expect(tracker.includes(fact("2"))).toBe(false);
  tracker.clear();
});

test("late watermark read cannot restore attribution after input cancelled it", async () => {
  let release!: (facts: SessionListFact[]) => void;
  const read = new Promise<SessionListFact[]>(resolve => { release = resolve; });
  const tracker = new ViewerRedrawTracker({ listSessionFacts: () => read });
  tracker.prune([fact("1")]);
  tracker.begin("work");
  await Bun.sleep(VIEWER_REDRAW_MS + 40);
  tracker.input("work");
  release([fact("2")]);
  await read;
  expect(tracker.includes(fact("2"))).toBe(false);
  tracker.clear();
});

test("canonical observation prunes ended/replaced incarnations and old input history", () => {
  const tracker = new ViewerRedrawTracker({ listSessionFacts: async () => [fact("1")] });
  tracker.prune([fact("1")]);
  tracker.begin("work");
  tracker.prune([]);
  expect(tracker.includes(fact("1"))).toBe(false);
  tracker.input("work");
  tracker.prune([fact("1")]);
  tracker.prune([fact("1", "replacement")]);
  tracker.begin("work");
  expect(tracker.includes(fact("1", "replacement"))).toBe(true);
  tracker.clear();
});

test("unobserved sessions fail open without a lookup on the resize path", () => {
  let reads = 0;
  const tracker = new ViewerRedrawTracker({ listSessionFacts: async () => { reads++; return [fact("1")]; } });
  tracker.begin("work");
  expect(reads).toBe(0);
  expect(tracker.includes(fact("1"))).toBe(false);
});

test("failed watermark lookup fails open", async () => {
  const tracker = new ViewerRedrawTracker({ listSessionFacts: async () => { throw new Error("broker not connected"); } });
  tracker.prune([fact("1")]);
  tracker.begin("work");
  await Bun.sleep(VIEWER_REDRAW_MS + 40);
  expect(tracker.includes(fact("1"))).toBe(false);
  tracker.clear();
});
