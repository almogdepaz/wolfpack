import { describe, expect, test } from "bun:test";
import { shouldUseAttachAckFallback } from "../../src/attach-ack.ts";

describe("attach_ack compatibility fallback", () => {
  test("uses the fallback only while the current attach still awaits an acknowledgement", () => {
    expect(shouldUseAttachAckFallback({ ackReceived: false, awaitingAck: true })).toBe(true);
  });

  test("ignores a stale fallback after attach_ack arrives", () => {
    expect(shouldUseAttachAckFallback({ ackReceived: true, awaitingAck: false })).toBe(false);
  });

  test("ignores a fallback after a newer attach cycle replaces the pending one", () => {
    expect(shouldUseAttachAckFallback({ ackReceived: false, awaitingAck: false })).toBe(false);
  });
});
