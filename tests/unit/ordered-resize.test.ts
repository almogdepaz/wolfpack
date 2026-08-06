import { describe, expect, test } from "bun:test";
import { OrderedResizeTracker } from "../../public/ordered-resize";

describe("ordered terminal resize", () => {
  test("commits only the newest broker acknowledgement", () => {
    const tracker = new OrderedResizeTracker();
    const first = tracker.request({ cols: 100, rows: 30 });
    const second = tracker.request({ cols: 120, rows: 40 });

    expect(tracker.acknowledge({ ...first, type: "resize_ack" })).toBeNull();
    expect(tracker.acknowledge({ ...second, type: "resize_ack" })).toEqual({ cols: 120, rows: 40 });
  });

  test("rejects malformed acknowledgement geometry", () => {
    const tracker = new OrderedResizeTracker();
    const request = tracker.request({ cols: 100, rows: 30 });
    expect(tracker.acknowledge({ resizeId: request.resizeId, cols: 0, rows: 30 })).toBeNull();
  });
});
