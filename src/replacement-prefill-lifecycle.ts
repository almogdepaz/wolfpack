export interface ReplacementPrefillAction {
  readonly activateHydration: boolean;
}

export interface ReplacementPrefillLifecycle {
  begin(hideImmediately: boolean): ReplacementPrefillAction;
  onPrefillDone(): ReplacementPrefillAction;
  onBinaryData(): ReplacementPrefillAction;
  onReplacePrefill(): void;
  reset(): void;
}

export function createReplacementPrefillLifecycle(): ReplacementPrefillLifecycle {
  let replacementPending = false;

  return {
    begin(hideImmediately): ReplacementPrefillAction {
      replacementPending = !hideImmediately;
      return { activateHydration: hideImmediately };
    },
    onPrefillDone(): ReplacementPrefillAction {
      if (!replacementPending) return { activateHydration: false };
      replacementPending = false;
      return { activateHydration: true };
    },
    onBinaryData(): ReplacementPrefillAction {
      if (!replacementPending) return { activateHydration: false };
      replacementPending = false;
      return { activateHydration: true };
    },
    onReplacePrefill(): void {},
    reset(): void {
      replacementPending = false;
    },
  };
}
