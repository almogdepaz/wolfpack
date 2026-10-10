export const TERMINAL_POOL_DEBUG_SIZE_KEY = "wolfpackTerminalPoolSize";
/** Upper bound for the debug override; each pooled terminal holds a WASM instance. */
export const TERMINAL_POOL_DEBUG_MAX_SIZE = 6;

export interface TerminalPoolDebugSizeOptions {
  readonly debugEnabled: boolean;
  readonly storage: Pick<Storage, "getItem"> | null;
  readonly defaultSize: number;
}

/** Debug-only override (`wolfpackDebug=1`) so the perf harness can compare a
 * size-1 pool (pre-pool behavior) with the default. */
export function resolveTerminalPoolDebugSize(opts: TerminalPoolDebugSizeOptions): number {
  if (!opts.debugEnabled || !opts.storage) return opts.defaultSize;
  const raw = opts.storage.getItem(TERMINAL_POOL_DEBUG_SIZE_KEY);
  if (raw === null || raw.trim() === "") return opts.defaultSize;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= TERMINAL_POOL_DEBUG_MAX_SIZE ? value : opts.defaultSize;
}

export const PARKED_TERMINAL_DEBUG_TTL_KEY = "wolfpackParkedTerminalTtlMs";

export interface ParkedTerminalDebugTtlOptions {
  readonly debugEnabled: boolean;
  readonly storage: Pick<Storage, "getItem"> | null;
  readonly defaultTtlMs: number;
}

/** Debug-only override so e2e can observe parked-entry expiry without
 * waiting minutes. */
export function resolveParkedTerminalDebugTtlMs(opts: ParkedTerminalDebugTtlOptions): number {
  if (!opts.debugEnabled || !opts.storage) return opts.defaultTtlMs;
  const raw = opts.storage.getItem(PARKED_TERMINAL_DEBUG_TTL_KEY);
  if (raw === null || raw.trim() === "") return opts.defaultTtlMs;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : opts.defaultTtlMs;
}
