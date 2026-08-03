export interface ReplacementPrefillAction {
  readonly activateHydration: boolean;
  readonly resetTerminal?: boolean;
}

export interface ReplacementPrefillLifecycle {
  begin(hideImmediately: boolean): ReplacementPrefillAction;
  onPrefillDone(): ReplacementPrefillAction;
  onBinaryData(): ReplacementPrefillAction;
  onReplacePrefill(): void;
  reset(): void;
}

export function createReplacementPrefillLifecycle(): ReplacementPrefillLifecycle {
  let resetPending = false;
  let replacementPending = false;

  return {
    begin(hideImmediately): ReplacementPrefillAction {
      resetPending = true;
      replacementPending = !hideImmediately;
      return { activateHydration: hideImmediately };
    },
    onPrefillDone(): ReplacementPrefillAction {
      if (!replacementPending) return { activateHydration: false };
      replacementPending = false;
      const resetTerminal = resetPending;
      resetPending = false;
      return { activateHydration: true, ...(resetTerminal ? { resetTerminal: true } : {}) };
    },
    onBinaryData(): ReplacementPrefillAction {
      if (!resetPending) return { activateHydration: false };
      const activateHydration = replacementPending;
      replacementPending = false;
      resetPending = false;
      return { activateHydration, resetTerminal: true };
    },
    onReplacePrefill(): void {
      resetPending = false;
    },
    reset(): void {
      resetPending = false;
      replacementPending = false;
    },
  };
}
