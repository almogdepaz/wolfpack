/**
 * Pure decision functions for the take-control flow (viewer conflict + recovery).
 *
 * Extracted from index.html to enable unit testing of the state machine
 * without DOM or WebSocket dependencies.
 */

import {
  CLOSE_CODE_DISPLACED,
  CLOSE_CODE_SESSION_UNAVAILABLE,
  CLOSE_CODE_NORMAL,
  WS_CLOSE_REASONS,
} from "./ws-constants.js";

// Re-export close codes so existing consumers don't break
export {
  CLOSE_CODE_DISPLACED,
  CLOSE_CODE_SESSION_UNAVAILABLE,
  CLOSE_CODE_NORMAL,
  WS_CLOSE_REASONS,
};

// ── Decision types ──

export type ConflictAction = "auto-take-control" | "show-overlay";
export type DisconnectAction = "displaced" | "session-ended" | "pty-exited" | "reconnect";
export type TakeControlClickAction = "send-take-control" | "reconnect-with-auto";

// ── Grid cell take-control state ──

export interface GridCellTakeControlState {
  displaced: boolean;
  autoTakeControl: boolean;
}

export function initialTakeControlState(): GridCellTakeControlState {
  return { displaced: false, autoTakeControl: false };
}

// ── Decision functions ──

/**
 * When a viewer_conflict message arrives, decide whether to auto-send
 * take_control (user already clicked "Take Control" on a displaced cell)
 * or show the conflict overlay.
 */
export function handleViewerConflict(state: GridCellTakeControlState): {
  action: ConflictAction;
  newState: GridCellTakeControlState;
} {
  if (state.autoTakeControl) {
    return {
      action: "auto-take-control",
      newState: { ...state, autoTakeControl: false },
    };
  }
  return {
    action: "show-overlay",
    newState: { ...state },
  };
}

/**
 * When control_granted arrives, clear displaced flag.
 */
export function handleControlGranted(state: GridCellTakeControlState): GridCellTakeControlState {
  return { ...state, displaced: false, autoTakeControl: false };
}

/**
 * Classify a WebSocket close event into the appropriate recovery action.
 */
export function classifyDisconnect(code: number, reason: string): DisconnectAction {
  if (code === CLOSE_CODE_DISPLACED) return "displaced";
  if (code === CLOSE_CODE_SESSION_UNAVAILABLE) return "session-ended";
  if (
    code === CLOSE_CODE_NORMAL
    && (reason === WS_CLOSE_REASONS.PTY_EXITED || reason === WS_CLOSE_REASONS.PTY_TEARDOWN)
  ) return "pty-exited";
  return "reconnect";
}

/**
 * When the user clicks "Take Control" on a conflict overlay,
 * decide whether to send immediately or reconnect first.
 */
export function handleTakeControlClick(isConnected: boolean): TakeControlClickAction {
  return isConnected ? "send-take-control" : "reconnect-with-auto";
}

/**
 * Update grid cell state when disconnected with the displaced code.
 */
export function handleDisplaced(state: GridCellTakeControlState): GridCellTakeControlState {
  return { ...state, displaced: true };
}

/**
 * Prepare state for a reconnect-with-auto-take-control click.
 */
export function prepareAutoTakeControl(state: GridCellTakeControlState): GridCellTakeControlState {
  return { ...state, autoTakeControl: true };
}
