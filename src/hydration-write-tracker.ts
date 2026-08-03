export interface HydrationWriteTracker {
  readonly pending: number;
  beginWrite(): number;
  finishWrite(epoch: number): boolean;
  advanceEpoch(): void;
  reset(): void;
}

export function createHydrationWriteTracker(): HydrationWriteTracker {
  let epoch = 0;
  let pending = 0;

  return {
    get pending(): number {
      return pending;
    },
    beginWrite(): number {
      pending++;
      return epoch;
    },
    finishWrite(writeEpoch): boolean {
      if (writeEpoch !== epoch) return false;
      pending = Math.max(0, pending - 1);
      return true;
    },
    advanceEpoch(): void {
      epoch++;
      pending = 0;
    },
    reset(): void {
      pending = 0;
    },
  };
}
