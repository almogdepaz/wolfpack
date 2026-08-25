import { shouldRehydrate } from "./reconnect-hydration.ts";

export const TERMINAL_REHYDRATION_ACTION = {
  NONE: "none",
  IMMEDIATE: "immediate",
  REPLACEMENT: "replacement",
} as const;

export type TerminalRehydrationAction =
  typeof TERMINAL_REHYDRATION_ACTION[keyof typeof TERMINAL_REHYDRATION_ACTION];

export interface TerminalSocketOpenState {
  readonly wasReconnect: boolean;
  readonly hydrationStarted: boolean;
  readonly hasAuthoritativePrefill: boolean;
  readonly hasPendingResizeScrollRestore: boolean;
}

export interface TerminalSocketOpenAction {
  readonly rehydrationAction: TerminalRehydrationAction;
  readonly resetScrollLock: boolean;
}

export interface TerminalConnectionPrefillAction {
  readonly activateHydration: boolean;
}

export interface TerminalConnectionLifecycle {
  beginConnection(): void;
  beginHydrationWrite(): number;
  finishHydrationWrite(epoch: number): boolean;
  readonly pendingHydrationWrites: number;
  onSocketOpen(state: TerminalSocketOpenState): TerminalSocketOpenAction;
  beginReplacementPrefill(hideImmediately: boolean): TerminalConnectionPrefillAction;
  onPrefillDone(): TerminalConnectionPrefillAction;
  onReplacePrefill(): void;
  onBinaryData(): TerminalConnectionPrefillAction;
  onControlGranted(): TerminalConnectionPrefillAction;
  reset(): void;
}

export function createTerminalConnectionLifecycle(): TerminalConnectionLifecycle {
  let connectionEpoch = 0;
  let pendingHydrationWrites = 0;
  let replacementPrefillPending = false;

  const completeReplacementPrefill = (): TerminalConnectionPrefillAction => {
    if (!replacementPrefillPending) return { activateHydration: false };
    replacementPrefillPending = false;
    return { activateHydration: true };
  };

  const beginReplacementPrefill = (hideImmediately: boolean): TerminalConnectionPrefillAction => {
    pendingHydrationWrites = 0;
    replacementPrefillPending = !hideImmediately;
    return { activateHydration: hideImmediately };
  };

  return {
    beginConnection(): void {
      connectionEpoch++;
      pendingHydrationWrites = 0;
    },
    beginHydrationWrite(): number {
      pendingHydrationWrites++;
      return connectionEpoch;
    },
    finishHydrationWrite(epoch: number): boolean {
      if (epoch !== connectionEpoch) return false;
      pendingHydrationWrites = Math.max(0, pendingHydrationWrites - 1);
      return true;
    },
    get pendingHydrationWrites(): number {
      return pendingHydrationWrites;
    },
    onSocketOpen(state: TerminalSocketOpenState): TerminalSocketOpenAction {
      let rehydrationAction: TerminalRehydrationAction = TERMINAL_REHYDRATION_ACTION.NONE;
      if (shouldRehydrate(
        state.wasReconnect,
        state.hydrationStarted,
        state.hasAuthoritativePrefill,
      )) {
        rehydrationAction = state.wasReconnect
          ? TERMINAL_REHYDRATION_ACTION.REPLACEMENT
          : TERMINAL_REHYDRATION_ACTION.IMMEDIATE;
      }
      if (rehydrationAction !== TERMINAL_REHYDRATION_ACTION.NONE) {
        pendingHydrationWrites = 0;
      }
      return {
        rehydrationAction,
        resetScrollLock: !state.hasPendingResizeScrollRestore,
      };
    },
    beginReplacementPrefill,
    onPrefillDone(): TerminalConnectionPrefillAction {
      return completeReplacementPrefill();
    },
    onReplacePrefill(): void {
      pendingHydrationWrites = 0;
    },
    onBinaryData(): TerminalConnectionPrefillAction {
      return completeReplacementPrefill();
    },
    onControlGranted(): TerminalConnectionPrefillAction {
      return beginReplacementPrefill(true);
    },
    reset(): void {
      pendingHydrationWrites = 0;
      replacementPrefillPending = false;
    },
  };
}
