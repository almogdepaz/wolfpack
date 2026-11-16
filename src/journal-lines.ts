/** Only newline-terminated rows are committed; report a partial tail in bytes. */
export function parseJournalLines<R>(text: string, valid: (value: unknown) => value is R): { rows: R[]; partialTailBytes: number } {
  const end = text.lastIndexOf("\n") + 1;
  const rows: R[] = [];
  for (const line of text.slice(0, end).split("\n")) {
    if (!line) continue;
    try { const value: unknown = JSON.parse(line); if (valid(value)) rows.push(value); } catch { /* malformed complete row: skipped */ }
  }
  return { rows, partialTailBytes: Buffer.byteLength(text.slice(end)) };
}
