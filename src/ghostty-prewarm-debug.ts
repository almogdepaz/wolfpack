export const GHOSTTY_PREWARM_DEBUG_DELAY_KEY = "wolfpackGhosttyPrewarmDelayMs";
export const GHOSTTY_PREWARM_DEBUG_POOL_SIZE_KEY = "wolfpackGhosttyPrewarmPoolSize";

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

export interface GhosttyPrewarmDebugPoolOptions {
  readonly debugEnabled: boolean;
  readonly storage: Pick<Storage, "getItem"> | null;
  readonly defaultPoolSize: number;
}

export function resolveGhosttyPrewarmDebugPoolSize(opts: GhosttyPrewarmDebugPoolOptions): number {
  if (!opts.debugEnabled || !opts.storage) return opts.defaultPoolSize;
  const raw = opts.storage.getItem(GHOSTTY_PREWARM_DEBUG_POOL_SIZE_KEY);
  if (raw === null || raw.trim() === "") return opts.defaultPoolSize;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 2 ? value : opts.defaultPoolSize;
}
