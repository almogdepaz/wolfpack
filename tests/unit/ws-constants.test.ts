import { describe, test, expect } from "bun:test";

// Import from the canonical source
import {
  CLOSE_CODE_NORMAL,
  CLOSE_CODE_SESSION_UNAVAILABLE,
  CLOSE_CODE_DISPLACED,
  CLOSE_CODE_PREFILL_TIMEOUT,
  WS_CLOSE_REASONS,
} from "../../src/ws-constants";

describe("WS_CLOSE_REASONS", () => {
  test("reason strings are defined", () => {
    expect(WS_CLOSE_REASONS.PTY_EXITED).toBe("pty exited");
    expect(WS_CLOSE_REASONS.SESSION_UNAVAILABLE).toBe("session unavailable");
    expect(WS_CLOSE_REASONS.DISPLACED).toBe("displaced");
    expect(WS_CLOSE_REASONS.PTY_TEARDOWN).toBe("pty teardown");
    expect(WS_CLOSE_REASONS.SESSION_ENDED).toBe("session ended");
    expect(WS_CLOSE_REASONS.PREFILL_TIMEOUT).toBe("prefill timeout");
  });

  test("close codes are correct", () => {
    expect(CLOSE_CODE_NORMAL).toBe(1000);
    expect(CLOSE_CODE_SESSION_UNAVAILABLE).toBe(4001);
    expect(CLOSE_CODE_DISPLACED).toBe(4002);
    expect(CLOSE_CODE_PREFILL_TIMEOUT).toBe(4003);
  });
});
