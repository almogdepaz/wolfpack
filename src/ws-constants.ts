/**
 * Shared WebSocket close codes and reason strings.
 *
 * Both server (websocket.ts) and client (take-control-logic.ts) reference
 * these constants so the string contract is enforced at compile time.
 */

// ── Close codes ──

export const CLOSE_CODE_NORMAL = 1000;
export const CLOSE_CODE_POLICY_VIOLATION = 1008;
/** RFC 6455 1011 — "server error". Used when the broker subscribe RPC fails
 * after the WS is open: the viewer would otherwise sit idle with no data
 * stream forever. */
export const CLOSE_CODE_SERVER_ERROR = 1011;
export const CLOSE_CODE_SESSION_UNAVAILABLE = 4001;
export const CLOSE_CODE_DISPLACED = 4002;
/** Client-side prefill deadline. The default disconnect path reconnects. */
export const CLOSE_CODE_PREFILL_TIMEOUT = 4003;

// ── Binary frame limits ──

/** Maximum accepted stdin frame size on /ws/pty. Clients split larger input. */
export const PTY_BINARY_FRAME_MAX_BYTES = 16_384;

// ── Close reason strings ──

export const WS_CLOSE_REASONS = {
  PTY_EXITED: "pty exited",
  SESSION_UNAVAILABLE: "session unavailable",
  DISPLACED: "displaced",
  PTY_TEARDOWN: "pty teardown",
  SESSION_ENDED: "session ended",
  SUBSCRIBE_FAILED: "subscribe rpc failed",
  WRITE_FAILED: "write failed",
  INPUT_RATE_LIMITED: "input rate limit exceeded",
  PENDING_INPUT_LIMITED: "pending input limit exceeded",
  PREFILL_TIMEOUT: "prefill timeout",
  RESIZE_FAILED: "resize failed",
  SLOW_VIEWER: "slow viewer",
} as const;
