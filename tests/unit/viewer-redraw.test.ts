import { expect, test } from "bun:test";
import { ViewerRedrawTracker, VIEWER_REDRAW_MS } from "../../src/server/viewer-redraw";
import type { SessionListFact } from "../../src/server/backend-contract";

const fact = (seq: string, id = "one") => ({ name: "work", alive: true, outputSequence: seq, identity: { wolfpackSessionId: id } }) as SessionListFact;

test("redraw watermark survives delayed observation, not later work or a reused name", async () => {
  let current = fact("9007199254740993");
  const tracker = new ViewerRedrawTracker({ listSessionFacts: async () => [current] });
  await tracker.begin("work");
  expect(tracker.includes(current)).toBe(true);
  current = fact("9007199254740994");
  await Bun.sleep(VIEWER_REDRAW_MS + 40);
  expect(tracker.includes(current)).toBe(true); // First poll can arrive well after the window.
  expect(tracker.includes(fact("9007199254740995"))).toBe(false);
  await tracker.begin("work");
  expect(tracker.includes(fact("1", "replacement"))).toBe(false);
  tracker.input("work");
});

test("explicit input cancels redraw immediately, including an in-flight begin", async () => {
  const tracker = new ViewerRedrawTracker({ listSessionFacts: async () => [fact("1")] });
  await tracker.begin("work");
  tracker.input("work");
  expect(tracker.includes(fact("2"))).toBe(false);
  await tracker.begin("work"); // Final attach geometry must not re-arm after early input.
  expect(tracker.includes(fact("2"))).toBe(false);
  const fresh = new ViewerRedrawTracker({ listSessionFacts: async () => [fact("1")] });
  const pending = fresh.begin("work");
  fresh.input("work");
  await pending;
  expect(fresh.includes(fact("2"))).toBe(false);
});

test("observation pruning retires ended sessions and their timers", async () => {
  const tracker = new ViewerRedrawTracker({ listSessionFacts: async () => [fact("1")] });
  await tracker.begin("work");
  tracker.prune([]);
  expect(tracker.includes(fact("1"))).toBe(false);
});
