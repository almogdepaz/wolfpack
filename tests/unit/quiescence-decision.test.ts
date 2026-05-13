/**
 * Regression coverage for issue #129: animated TUIs (spinners, htop,
 * `watch`, claude's pulse spinner) never let the broker byte rate drop
 * below the quiescence threshold, so the old loop always waited the full
 * QUIESCE_TIMEOUT_MS (800ms) before snapshotting — producing a mid-redraw
 * prefill that the live stream then had to overwrite.
 *
 * The new QUIESCE_ANIMATED_CAP_MS short-circuits that wait at 200ms when
 * byte rate stays high through the entire settle window.
 */
import { describe, expect, test } from "bun:test";
import { quiescenceDecision } from "../../src/server/websocket.ts";

type Sample = { t: number; bytes: number };

/** Build a sample array spanning [from, to] with `bytesPerMs` bytes/ms. */
function busySamples(from: number, to: number, bytesPerMs = 20): Sample[] {
  const out: Sample[] = [];
  for (let t = from; t <= to; t += 10) out.push({ t, bytes: bytesPerMs * 10 });
  return out;
}

describe("quiescenceDecision — pure quiescence loop logic", () => {
  test("returns 'continue' before MIN_WAIT_MS even when bytes are quiet", () => {
    expect(
      quiescenceDecision({
        samples: [],
        now: 50, // < MIN_WAIT 80
        lastResizeAt: 0,
        settleStart: 0,
      }),
    ).toBe("continue");
  });

  test("returns 'quiet' after MIN_WAIT_MS when recent bytes are below threshold", () => {
    expect(
      quiescenceDecision({
        samples: [{ t: 50, bytes: 100 }], // 100 < 1024
        now: 100,
        lastResizeAt: 0,
        settleStart: 0,
      }),
    ).toBe("quiet");
  });

  test("returns 'continue' between MIN_WAIT_MS and ANIMATED_CAP_MS while busy", () => {
    expect(
      quiescenceDecision({
        // 150ms × 20 b/ms = 3000 bytes per window — well above 1024
        samples: busySamples(50, 150),
        now: 150,
        lastResizeAt: 0,
        settleStart: 0,
      }),
    ).toBe("continue");
  });

  test("returns 'animated_cap' at ANIMATED_CAP_MS when byte rate stays high", () => {
    expect(
      quiescenceDecision({
        samples: busySamples(100, 200),
        now: 200,
        lastResizeAt: 0,
        settleStart: 0,
      }),
    ).toBe("animated_cap");
  });

  test("returns 'timeout' at QUIESCE_TIMEOUT_MS regardless of byte rate", () => {
    expect(
      quiescenceDecision({
        samples: busySamples(700, 800),
        now: 800,
        lastResizeAt: 0,
        settleStart: 0,
      }),
    ).toBe("timeout");
  });

  test("MIN_WAIT_MS is measured from the most recent resize, not settleStart", () => {
    // 250ms total elapsed, but resize just happened at t=200 — MIN_WAIT not satisfied
    expect(
      quiescenceDecision({
        samples: [],
        now: 250,
        lastResizeAt: 200,
        settleStart: 0,
      }),
    ).toBe("continue");
  });

  test("a resize mid-window does not prevent animated_cap once MIN_WAIT clears", () => {
    // settle started at 0, resize at 100, now at 200 → elapsedSinceResize=100>=80
    // bytes high through the post-resize window
    expect(
      quiescenceDecision({
        samples: busySamples(100, 200),
        now: 200,
        lastResizeAt: 100,
        settleStart: 0,
      }),
    ).toBe("animated_cap");
  });

  test("non-animated session quietens before animated_cap fires", () => {
    // bytes only appear in the first 50ms (initial redraw burst), then nothing
    const samples: Sample[] = [
      { t: 10, bytes: 500 },
      { t: 30, bytes: 500 },
      { t: 50, bytes: 500 },
    ];
    // By t=200 these are all outside the 100ms window → recentBytes=0 → quiet
    expect(
      quiescenceDecision({
        samples,
        now: 200,
        lastResizeAt: 0,
        settleStart: 0,
      }),
    ).toBe("quiet");
  });

  test("quiet wins over animated_cap when both could fire", () => {
    // exactly at 200ms, but recent window happens to be empty
    expect(
      quiescenceDecision({
        samples: [{ t: 50, bytes: 9999 }], // far outside window
        now: 200,
        lastResizeAt: 0,
        settleStart: 0,
      }),
    ).toBe("quiet");
  });

  test("timeout wins over animated_cap when both could fire", () => {
    expect(
      quiescenceDecision({
        samples: busySamples(750, 800),
        now: 800,
        lastResizeAt: 0,
        settleStart: 0,
      }),
    ).toBe("timeout");
  });
});
