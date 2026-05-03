/**
 * Snapshot → ANSI byte renderer.
 *
 * Reconnect contract (broker-protocol.md): a client that applies the snapshot
 * must land on a state visually equivalent to a viewer that had been attached
 * the whole time. This module emits the byte stream that, when fed into a
 * fresh terminal emulator (xterm.js, VTE, etc.), reconstructs the snapshot:
 *
 *   1. clear visible + scrollback + reset SGR + cursor home
 *   2. scrollback as plain text (oldest first), one line per `\r\n`
 *   3. visible_screen with per-cell SGR transitions, lines separated by `\r\n`
 *   4. SGR reset, then explicit cursor positioning, then cursor visibility
 *
 * Per-cell SGR is emitted only when the cell's attrs differ from the last
 * cell we rendered. Each transition is a full `CSI 0;…m` so the receiver
 * never has to merge with whatever state was previously active.
 */

export interface CellAttrs {
  fg?: number | null;
  bg?: number | null;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  reverse?: boolean;
  blink?: boolean;
  strike?: boolean;
  dim?: boolean;
  hidden?: boolean;
}

export interface StyledCell {
  ch?: string;
  attrs?: CellAttrs;
}

export interface StyledLine {
  cells?: StyledCell[];
  wrapped?: boolean;
}

export interface CursorState {
  row: number;
  col: number;
  visible?: boolean;
  shape?: "block" | "underline" | "bar";
}

export interface SnapshotForRender {
  cols?: number;
  rows?: number;
  visible_screen?: StyledLine[];
  scrollback?: StyledLine[];
  cursor?: CursorState;
}

const CSI = "\x1b[";
const SGR_RESET = "\x1b[0m";
const CLEAR_AND_HOME = "\x1b[2J\x1b[3J\x1b[H\x1b[0m";

const DEFAULT_ATTRS: CellAttrs = {
  fg: null,
  bg: null,
  bold: false,
  italic: false,
  underline: false,
  reverse: false,
  blink: false,
  strike: false,
  dim: false,
  hidden: false,
};

function attrsEqual(a: CellAttrs, b: CellAttrs): boolean {
  return (
    (a.fg ?? null) === (b.fg ?? null) &&
    (a.bg ?? null) === (b.bg ?? null) &&
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.reverse === !!b.reverse &&
    !!a.blink === !!b.blink &&
    !!a.strike === !!b.strike &&
    !!a.dim === !!b.dim &&
    !!a.hidden === !!b.hidden
  );
}

function isDefault(a: CellAttrs): boolean {
  return attrsEqual(a, DEFAULT_ATTRS);
}

function sgrFor(attrs: CellAttrs): string {
  // Always lead with `0` so the receiver doesn't need to know prior state.
  const params: number[] = [0];
  if (attrs.bold) params.push(1);
  if (attrs.dim) params.push(2);
  if (attrs.italic) params.push(3);
  if (attrs.underline) params.push(4);
  if (attrs.blink) params.push(5);
  if (attrs.reverse) params.push(7);
  if (attrs.hidden) params.push(8);
  if (attrs.strike) params.push(9);
  if (attrs.fg !== null && attrs.fg !== undefined) {
    const r = (attrs.fg >> 16) & 0xff;
    const g = (attrs.fg >> 8) & 0xff;
    const b = attrs.fg & 0xff;
    params.push(38, 2, r, g, b);
  }
  if (attrs.bg !== null && attrs.bg !== undefined) {
    const r = (attrs.bg >> 16) & 0xff;
    const g = (attrs.bg >> 8) & 0xff;
    const b = attrs.bg & 0xff;
    params.push(48, 2, r, g, b);
  }
  return `${CSI}${params.join(";")}m`;
}

function plainLine(line: StyledLine): string {
  if (!line.cells || line.cells.length === 0) return "";
  let out = "";
  for (const c of line.cells) out += c.ch ?? "";
  // Strip trailing pad spaces (regular + non-breaking) so transcripts copied
  // out of scrollback don't carry a wall of right-padding.
  return out.replace(/[  ]+$/, "");
}

/**
 * Render a broker snapshot to the byte sequence a terminal emulator can
 * replay to reach the same visual state. Output is a UTF-8 Buffer suitable
 * for sending directly over the WS prefill channel.
 */
export function renderSnapshotToAnsi(snap: SnapshotForRender): Buffer {
  const parts: string[] = [];
  parts.push(CLEAR_AND_HOME);

  // Scrollback as plain text — task spec: scrollback rendered as plain lines.
  // Style fidelity for scrollback is intentionally dropped to keep the
  // prefill payload bounded and reconnect-fast.
  const scrollback = snap.scrollback ?? [];
  for (const line of scrollback) {
    parts.push(plainLine(line));
    parts.push("\r\n");
  }

  // Visible screen with per-cell SGR transitions.
  const visible = snap.visible_screen ?? [];
  let lastAttrs: CellAttrs = DEFAULT_ATTRS;
  let inDefault = true;
  for (let r = 0; r < visible.length; r++) {
    const cells = visible[r].cells ?? [];
    for (const cell of cells) {
      const attrs = cell.attrs ?? DEFAULT_ATTRS;
      if (!attrsEqual(attrs, lastAttrs)) {
        // Skip a no-op SGR if we're already in default and this cell is too.
        if (!(inDefault && isDefault(attrs))) {
          parts.push(sgrFor(attrs));
          inDefault = isDefault(attrs);
        }
        lastAttrs = attrs;
      }
      parts.push(cell.ch ?? "");
    }
    if (r < visible.length - 1) parts.push("\r\n");
  }

  // Cap the styled run with a reset before we emit cursor controls.
  if (!inDefault) parts.push(SGR_RESET);

  // Position cursor (broker uses 0-based; CSI H is 1-based).
  const cur = snap.cursor;
  if (cur) {
    const row = Math.max(0, cur.row | 0) + 1;
    const col = Math.max(0, cur.col | 0) + 1;
    parts.push(`${CSI}${row};${col}H`);
    parts.push(cur.visible === false ? `${CSI}?25l` : `${CSI}?25h`);
  }

  return Buffer.from(parts.join(""), "utf8");
}

/**
 * Render a broker snapshot to plain text — scrollback + visible screen with
 * trailing whitespace trimmed and no ANSI/SGR. Drops trailing blank rows so
 * a copied transcript ends at the last meaningful line.
 *
 * Used by the "Copy session" mobile action where ANSI noise would just hurt
 * the paste experience.
 */
export function renderSnapshotToPlainText(snap: SnapshotForRender): string {
  const lines: string[] = [];
  for (const line of snap.scrollback ?? []) lines.push(plainLine(line));
  for (const line of snap.visible_screen ?? []) lines.push(plainLine(line));
  // Drop trailing blank rows — visible_screen is always padded to `rows`.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
