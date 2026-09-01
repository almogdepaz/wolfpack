export interface TerminalLiveGate {
  readonly onHydrationStart: () => void;
  readonly onHydrated: () => void;
  readonly onPostMountReady: () => void;
}

interface TerminalLiveGateOptions {
  readonly waitForPostMount: boolean;
  readonly onLive: () => void;
}

export function createTerminalLiveGate(options: TerminalLiveGateOptions): TerminalLiveGate {
  let hydrated = false;
  let postMountReady = !options.waitForPostMount;
  let markedLive = false;

  const markLiveIfReady = (): void => {
    if (!hydrated || !postMountReady || markedLive) return;
    markedLive = true;
    options.onLive();
  };

  return {
    onHydrationStart: () => {
      hydrated = false;
      markedLive = false;
    },
    onHydrated: () => {
      hydrated = true;
      markLiveIfReady();
    },
    onPostMountReady: () => {
      postMountReady = true;
      markLiveIfReady();
    },
  };
}
