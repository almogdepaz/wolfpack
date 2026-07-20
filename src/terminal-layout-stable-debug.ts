export const LAYOUT_STABLE_DEBUG_MODE_KEY = "wolfpackLayoutStableDebugMode";

export type LayoutStableDebugMode = "after-paint" | "immediate-and-after-paint" | "viewport-immediate-and-after-paint";

export type LayoutStablePrefillMode = "full" | "viewport" | "none";

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
    || (mode === "viewport-immediate-and-after-paint" && prefillMode === "viewport");
}
