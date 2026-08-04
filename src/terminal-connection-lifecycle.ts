import {
  createHydrationWriteTracker,
} from "./hydration-write-tracker.ts";
import {
  createReplacementPrefillLifecycle,
} from "./replacement-prefill-lifecycle.ts";
import {
  TERMINAL_REHYDRATION_ACTION,
  terminalRehydrationAction,
} from "./terminal-rehydration.ts";
import type { TerminalRehydrationAction } from "./terminal-rehydration.ts";

export { TERMINAL_REHYDRATION_ACTION } from "./terminal-rehydration.ts";

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

function prefillAction(action: {
  readonly activateHydration: boolean;
}): TerminalConnectionPrefillAction {
  return { activateHydration: action.activateHydration };
}

export function createTerminalConnectionLifecycle(): TerminalConnectionLifecycle {
  const hydrationWriteTracker = createHydrationWriteTracker();
  const replacementPrefillLifecycle = createReplacementPrefillLifecycle();

  const beginReplacementPrefill = (hideImmediately: boolean): TerminalConnectionPrefillAction => {
    hydrationWriteTracker.reset();
    return prefillAction(replacementPrefillLifecycle.begin(hideImmediately));
  };

  return {
    beginConnection(): void {
      hydrationWriteTracker.advanceEpoch();
    },
    beginHydrationWrite(): number {
      return hydrationWriteTracker.beginWrite();
    },
    finishHydrationWrite(epoch: number): boolean {
      return hydrationWriteTracker.finishWrite(epoch);
    },
    get pendingHydrationWrites(): number {
      return hydrationWriteTracker.pending;
    },
    onSocketOpen(state: TerminalSocketOpenState): TerminalSocketOpenAction {
      const rehydrationAction = terminalRehydrationAction(state);
      if (rehydrationAction !== TERMINAL_REHYDRATION_ACTION.NONE) {
        hydrationWriteTracker.reset();
      }
      return {
        rehydrationAction,
        resetScrollLock: !state.hasPendingResizeScrollRestore,
      };
    },
    beginReplacementPrefill,
    onPrefillDone(): TerminalConnectionPrefillAction {
      return prefillAction(replacementPrefillLifecycle.onPrefillDone());
    },
    onReplacePrefill(): void {
      replacementPrefillLifecycle.onReplacePrefill();
      hydrationWriteTracker.reset();
    },
    onBinaryData(): TerminalConnectionPrefillAction {
      return prefillAction(replacementPrefillLifecycle.onBinaryData());
    },
    onControlGranted(): TerminalConnectionPrefillAction {
      return beginReplacementPrefill(true);
    },
    reset(): void {
      hydrationWriteTracker.reset();
      replacementPrefillLifecycle.reset();
    },
  };
}
