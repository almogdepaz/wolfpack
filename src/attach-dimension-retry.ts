export interface AttachDimensionRetryTimerApi<TTimer> {
  setTimeout(callback: () => void, delayMs: number): TTimer;
  clearTimeout(timer: TTimer): void;
}

export interface AttachDimensionRetryState {
  setAttempt(attempt: number): void;
  schedule(callback: () => void, delayMs: number): void;
  clear(): void;
  readonly attempt: number;
  readonly hasPendingTimer: boolean;
}

export function createAttachDimensionRetryState<TTimer = ReturnType<typeof setTimeout>>(
  timerApi: AttachDimensionRetryTimerApi<TTimer> = {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs) as TTimer,
    clearTimeout: (timer) => { clearTimeout(timer as ReturnType<typeof setTimeout>); },
  },
): AttachDimensionRetryState {
  let timer: TTimer | null = null;
  let attempt = 0;

  return {
    setAttempt(nextAttempt: number): void {
      attempt = nextAttempt;
    },
    schedule(callback: () => void, delayMs: number): void {
      if (timer !== null) return;
      timer = timerApi.setTimeout(() => {
        timer = null;
        callback();
      }, delayMs);
    },
    clear(): void {
      if (timer !== null) {
        timerApi.clearTimeout(timer);
        timer = null;
      }
      attempt = 0;
    },
    get attempt(): number {
      return attempt;
    },
    get hasPendingTimer(): boolean {
      return timer !== null;
    },
  };
}
