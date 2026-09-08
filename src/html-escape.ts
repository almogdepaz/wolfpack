/**
 * Escape text inserted into HTML text and quoted attribute contexts.
 * These functions are shared by browser rendering code and unit tests.
 */
export function esc(value: unknown): string {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;")
    .replace(/"/g, "&quot;");
}

export function escAttr(value: unknown): string {
  return esc(value);
}
