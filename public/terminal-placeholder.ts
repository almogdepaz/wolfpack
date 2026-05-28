export const CACHED_TERMINAL_PLACEHOLDER_CLASS = "cached-terminal-placeholder";

const MAX_PLACEHOLDER_LINES = 80;

export function cachedSnapshotPlaceholderText(snapshot: string, maxLines = MAX_PLACEHOLDER_LINES): string {
  if (!snapshot) return "";
  const withoutControls = snapshot
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  const lines = withoutControls.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  return lines.slice(-maxLines).join("\n").trimEnd();
}
