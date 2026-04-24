export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*\x1b\\)/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

const ESC = 0x1b;

/**
 * Strip any partial/incomplete VT escape sequence from the start of a buffer.
 * Used when slicing into a raw byte stream (e.g. prefill truncation) where
 * the cut point may land mid-CSI.
 */
export function stripLeadingPartialEscape(buf: Buffer): Buffer {
  if (buf.length === 0 || buf[0] === ESC) return buf;

  const scanLimit = Math.min(buf.length, 256);

  // Case 1: starts with `[` — ESC was cut from `\x1b[<params><final>`
  if (buf[0] === 0x5b) {
    let i = 1;
    while (i < scanLimit && buf[i] >= 0x30 && buf[i] <= 0x3f) i++;
    if (i < scanLimit && buf[i] >= 0x40 && buf[i] <= 0x7e) {
      return buf.subarray(i + 1);
    }
    return buf;
  }

  // Case 2: starts with CSI param bytes (0-9 ; ? etc) — `\x1b[` was cut
  if (buf[0] >= 0x30 && buf[0] <= 0x3f) {
    let i = 0;
    while (i < scanLimit && buf[i] >= 0x30 && buf[i] <= 0x3f) i++;
    if (i < scanLimit && buf[i] >= 0x40 && buf[i] <= 0x7e) {
      return buf.subarray(i + 1);
    }
    return buf;
  }

  // Case 3: fragment bytes before first ESC (e.g. "33m\x1b[1mBold")
  let firstEsc = -1;
  for (let i = 0; i < scanLimit; i++) {
    if (buf[i] === ESC) { firstEsc = i; break; }
  }
  if (firstEsc > 0) {
    // Try to parse a CSI fragment in the leading bytes
    let j = 0;
    while (j < firstEsc && buf[j] >= 0x30 && buf[j] <= 0x3f) j++;
    if (j > 0 && j < firstEsc && buf[j] >= 0x40 && buf[j] <= 0x7e) {
      return buf.subarray(j + 1);
    }
    // No clear fragment — check for newlines (normal text)
    for (j = 0; j < firstEsc; j++) {
      if (buf[j] === 0x0a || buf[j] === 0x0d) return buf;
    }
    return buf.subarray(firstEsc);
  }

  return buf;
}
