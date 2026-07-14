import { describe, test, expect } from "bun:test";

// Import from the canonical source
import {
  CLOSE_CODE_NORMAL,
  CLOSE_CODE_SESSION_UNAVAILABLE,
  CLOSE_CODE_DISPLACED,
  CLOSE_CODE_PREFILL_TIMEOUT,
  WS_CLOSE_REASONS,
} from "../../src/ws-constants";

// Import the re-exports from take-control-logic (client consumer)
import {
  CLOSE_CODE_NORMAL as TCL_NORMAL,
  CLOSE_CODE_SESSION_UNAVAILABLE as TCL_SESSION_UNAVAILABLE,
  CLOSE_CODE_DISPLACED as TCL_DISPLACED,
  WS_CLOSE_REASONS as TCL_REASONS,
} from "../../src/take-control-logic";

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

describe("take-control-logic re-exports reference the same constants", () => {
  test("close codes are identical references", () => {
    expect(TCL_NORMAL).toBe(CLOSE_CODE_NORMAL);
    expect(TCL_SESSION_UNAVAILABLE).toBe(CLOSE_CODE_SESSION_UNAVAILABLE);
    expect(TCL_DISPLACED).toBe(CLOSE_CODE_DISPLACED);
  });

  test("WS_CLOSE_REASONS is the same object", () => {
    expect(TCL_REASONS).toBe(WS_CLOSE_REASONS);
  });
});
