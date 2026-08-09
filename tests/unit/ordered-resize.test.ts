import { describe, expect, test } from "bun:test";
import {
  OrderedResizeTracker,
  shouldSendResizeRequest,
} from "../../public/ordered-resize.ts";

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

    expect(tracker.acknowledge({ type: "resize_ack", resizeId: request.resizeId, cols: 0, rows: 30 })).toBeNull();
  });

  test("settles superseded waiters only when the newest resize commits", async () => {
    const tracker = new OrderedResizeTracker();
    const first = tracker.request({ cols: 100, rows: 30 });
    let firstSettlement: string | null = null;
    const firstWaiter = tracker.waitForSettlement().then((settlement) => { firstSettlement = settlement; });
    const second = tracker.request({ cols: 120, rows: 40 });

    expect(tracker.acknowledge({ ...first, type: "resize_ack" })).toBeNull();
    await Promise.resolve();
    expect<string | null>(firstSettlement).toBeNull();

    expect(tracker.acknowledge({ ...second, type: "resize_ack" })).toEqual({ cols: 120, rows: 40 });
    await firstWaiter;
    expect<string | null>(firstSettlement).toBe("acknowledged");
  });

  test("keeps a latest ordered proposal matching the last sent geometry sendable", () => {
    const tracker = new OrderedResizeTracker();
    tracker.request({ cols: 100, rows: 30 }); // sent A / id1
    tracker.request({ cols: 120, rows: 40 }); // queued B / id2

    expect(tracker.hasPending()).toBe(true);
    expect(tracker.hasPendingDimensions({ cols: 100, rows: 30 })).toBe(false);

    const latest = tracker.request({ cols: 100, rows: 30 }); // queued A / id3
    expect(shouldSendResizeRequest(latest, "100x30", false)).toBe(true);
    expect(shouldSendResizeRequest({ type: "resize", cols: 100, rows: 30 }, "100x30", false)).toBe(false);
  });

  test("cancels every queued waiter without treating the transport loss as acknowledgement", async () => {
    const tracker = new OrderedResizeTracker();
    tracker.request({ cols: 100, rows: 30 });
    const firstWaiter = tracker.waitForSettlement();
    tracker.request({ cols: 120, rows: 40 });
    const secondWaiter = tracker.waitForSettlement();

    tracker.clear();

    await expect(firstWaiter).resolves.toBe("cancelled");
    await expect(secondWaiter).resolves.toBe("cancelled");
  });
});
