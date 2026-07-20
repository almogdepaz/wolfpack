export const HYDRATION_DEBUG_MIN_PENDING_KEY = "wolfpackHydrationMinPendingMs";
export const HYDRATION_DEBUG_SILENCE_KEY = "wolfpackHydrationSilenceMs";

export interface HydrationTimingDefaults {
  readonly minPendingMs: number;
  readonly silenceMs: number;
}

export interface HydrationDebugTimingOptions {
  readonly debugEnabled: boolean;
  readonly storage: Pick<Storage, "getItem"> | null;
  readonly defaults: HydrationTimingDefaults;
}

function parseNonNegativeMs(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

export function resolveHydrationDebugTiming(opts: HydrationDebugTimingOptions): HydrationTimingDefaults {
  if (!opts.debugEnabled || !opts.storage) return opts.defaults;

  return {
    minPendingMs: parseNonNegativeMs(opts.storage.getItem(HYDRATION_DEBUG_MIN_PENDING_KEY)) ?? opts.defaults.minPendingMs,
    silenceMs: parseNonNegativeMs(opts.storage.getItem(HYDRATION_DEBUG_SILENCE_KEY)) ?? opts.defaults.silenceMs,
  };
}
