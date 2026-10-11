export const CURSOR_BLINK_DEBUG_DISABLED_KEY = "wolfpackCursorBlinkDisabled";

/** Debug-only override so canvas-hash probes don't see cursor blink toggles. */
export function isCursorBlinkDebugDisabled(storage: Pick<Storage, "getItem"> | null, debugEnabled: boolean): boolean {
  if (!debugEnabled || !storage) return false;
  return storage.getItem(CURSOR_BLINK_DEBUG_DISABLED_KEY) === "1";
}
