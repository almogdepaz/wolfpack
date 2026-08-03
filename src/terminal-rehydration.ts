import { shouldRehydrate } from "./reconnect-hydration.ts";

export const TERMINAL_REHYDRATION_ACTION = {
  NONE: "none",
  IMMEDIATE: "immediate",
  REPLACEMENT: "replacement",
} as const;

export type TerminalRehydrationAction =
  typeof TERMINAL_REHYDRATION_ACTION[keyof typeof TERMINAL_REHYDRATION_ACTION];

export interface TerminalRehydrationState {
  readonly wasReconnect: boolean;
  readonly hydrationStarted: boolean;
  readonly hasAuthoritativePrefill: boolean;
}

/**
 * Chooses how an opened PTY socket restores the terminal display.
 *
 * Replacement hydration retains the previous frame until the reconnect's
 * authoritative bytes arrive. Immediate hydration is used only for a manual
 * retry that replaces an already-hydrated display.
 */
export function terminalRehydrationAction(
  state: TerminalRehydrationState,
): TerminalRehydrationAction {
  if (!shouldRehydrate(
    state.wasReconnect,
    state.hydrationStarted,
    state.hasAuthoritativePrefill,
  )) {
    return TERMINAL_REHYDRATION_ACTION.NONE;
  }

  return state.wasReconnect
    ? TERMINAL_REHYDRATION_ACTION.REPLACEMENT
    : TERMINAL_REHYDRATION_ACTION.IMMEDIATE;
}
