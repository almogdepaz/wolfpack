import { TERMINAL_PREFILL_MODE } from "./terminal-prefill.js";
import type { TerminalPrefillMode } from "./terminal-prefill.js";

export const LAYOUT_STABLE_DEBUG_MODE_KEY = "wolfpackLayoutStableDebugMode";

export type LayoutStableDebugMode = "after-paint" | "immediate-and-after-paint" | "viewport-immediate-and-after-paint";

export type LayoutStablePrefillMode = TerminalPrefillMode;

export function resolveLayoutStableDebugMode(
  storage: Pick<Storage, "getItem"> | null,
  debugEnabled: boolean,
): LayoutStableDebugMode {
  if (!debugEnabled || !storage) return "after-paint";
  const value = storage.getItem(LAYOUT_STABLE_DEBUG_MODE_KEY);
  return value === "immediate-and-after-paint" || value === "viewport-immediate-and-after-paint"
    ? value
    : "after-paint";
}

export function shouldSendImmediateLayoutStable(
  mode: LayoutStableDebugMode,
  prefillMode: LayoutStablePrefillMode,
): boolean {
  return mode === "immediate-and-after-paint"
    || (mode === "viewport-immediate-and-after-paint" && prefillMode === TERMINAL_PREFILL_MODE.VIEWPORT);
}
