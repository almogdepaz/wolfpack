export const GHOSTTY_PREWARM_DEBUG_DELAY_KEY = "wolfpackGhosttyPrewarmDelayMs";

export interface GhosttyPrewarmTimingDefaults {
  readonly delayMs: number;
}

export interface GhosttyPrewarmDebugTimingOptions {
  readonly debugEnabled: boolean;
  readonly storage: Pick<Storage, "getItem"> | null;
  readonly defaults: GhosttyPrewarmTimingDefaults;
}

function parseNonNegativeMs(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

export function resolveGhosttyPrewarmDebugTiming(opts: GhosttyPrewarmDebugTimingOptions): GhosttyPrewarmTimingDefaults {
  if (!opts.debugEnabled || !opts.storage) return opts.defaults;

  return {
    delayMs: parseNonNegativeMs(opts.storage.getItem(GHOSTTY_PREWARM_DEBUG_DELAY_KEY)) ?? opts.defaults.delayMs,
  };
}
