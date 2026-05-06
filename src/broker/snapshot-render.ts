/**
 * Snapshot → ANSI byte renderer.
 *
 * Reconnect contract (broker-protocol.md): a client that applies the snapshot
 * must land on a state visually equivalent to a viewer that had been attached
 * the whole time. This module emits the byte stream that, when fed into a
 * fresh terminal emulator (xterm.js, VTE, etc.), reconstructs the snapshot:
 *
 *   1. clear visible + scrollback + reset SGR + cursor home (on primary)
 *   2. scrollback as plain text (oldest first), one line per `\r\n`
 *      — always painted on the primary screen because the broker emulator
 *      only accumulates scrollback while NOT on alt screen, so this is the
 *      primary's true history regardless of where the live cursor sits
 *   3. if the snapshot was captured on alt screen, switch into alt with
 *      `CSI ?1049h` BEFORE painting visible cells, so the alt buffer
 *      contents land on the alt buffer (not on top of primary scrollback)
 *   4. visible_screen with per-cell SGR transitions, lines separated by `\r\n`
 *   5. SGR reset, mode preamble for non-default DEC modes (DECCKM, mouse,
 *      bracketed paste, application keypad, auto-wrap, origin mode),
 *      explicit cursor positioning, then cursor visibility
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

/** Mirror of `broker::protocol::TerminalModes`. All fields optional so
 *  older snapshots without a `modes` block still render. `auto_wrap` defaults
 *  to true on the wire (matches DECAWM default); other booleans default false. */
export type MouseMode = "off" | "x10" | "vt200" | "button_event" | "any_event" | "sgr";

export interface TerminalModes {
  alt_screen?: boolean;
  application_cursor?: boolean;
  application_keypad?: boolean;
  bracketed_paste?: boolean;
  mouse_mode?: MouseMode;
  origin_mode?: boolean;
  /** DECAWM. Default true; emit `CSI ?7l` only when explicitly false. */
  auto_wrap?: boolean;
  insert_mode?: boolean;
}

export interface SnapshotForRender {
  cols?: number;
  rows?: number;
  visible_screen?: StyledLine[];
  scrollback?: StyledLine[];
  cursor?: CursorState;
  modes?: TerminalModes;
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

/**
 * Render one StyledLine to plain text with trailing pad-space columns
 * trimmed. Char class includes both ASCII space (U+0020) and NBSP (U+00A0)
 * — the broker's VT emulator emits NBSP for hard-spaced cells in some TUI
 * redraws. Exported so other broker-side renderers can share one
 * trim-and-flatten implementation.
 */
export function plainLine(line: StyledLine): string {
  if (!line.cells || line.cells.length === 0) return "";
  let out = "";
  for (const c of line.cells) out += c.ch ?? "";
  return out.replace(/[  ]+$/, "");
}

/** Build the trailing DEC-mode preamble that brings the receiving emulator
 *  into the same mode set the broker had at snapshot time. `alt_screen` is
 *  handled separately upstream because it must be emitted BEFORE
 *  visible_screen paints. Other modes don't affect rendering, only behavior
 *  (arrow-key encoding, mouse reporting, paste delimiting) — still required
 *  for reconnect to feel identical to a continuous attach. */
function modePreamble(modes: TerminalModes | undefined): string {
  if (!modes) return "";
  const out: string[] = [];
  // DECCKM — application cursor keys (vim/less/etc rely on this for arrows).
  if (modes.application_cursor) out.push(`${CSI}?1h`);
  // DECOM — origin mode.
  if (modes.origin_mode) out.push(`${CSI}?6h`);
  // DECAWM — default is on; only emit a disable if the broker had it off.
  if (modes.auto_wrap === false) out.push(`${CSI}?7l`);
  // Mouse reporting — each mode is mutually exclusive on the wire side, but
  // SGR extended (1006) layers on top of any reporting mode.
  switch (modes.mouse_mode) {
    case "x10":          out.push(`${CSI}?9h`); break;
    case "vt200":        out.push(`${CSI}?1000h`); break;
    case "button_event": out.push(`${CSI}?1002h`); break;
    case "any_event":    out.push(`${CSI}?1003h`); break;
    case "sgr":          out.push(`${CSI}?1000h`, `${CSI}?1006h`); break;
    default: break; // "off" or undefined
  }
  if (modes.bracketed_paste) out.push(`${CSI}?2004h`);
  // Application keypad — ESC =, not a CSI.
  if (modes.application_keypad) out.push("\x1b=");
  // IRM — ANSI insert mode (CSI 4h, no `?`).
  if (modes.insert_mode) out.push(`${CSI}4h`);
  return out.join("");
}

/**
 * Render a broker snapshot to the byte sequence a terminal emulator can
 * replay to reach the same visual state. Output is a UTF-8 Buffer suitable
 * for sending directly over the WS prefill channel.
 */
export function renderSnapshotToAnsi(snap: SnapshotForRender): Buffer {
  const parts: string[] = [];
  parts.push(CLEAR_AND_HOME);

  // Scrollback as plain text — always painted on the primary screen because
  // the broker only accumulates scrollback while NOT on alt screen, so the
  // bytes here represent the primary's true history. Style fidelity for
  // scrollback is intentionally dropped to keep the prefill payload bounded.
  const scrollback = snap.scrollback ?? [];
  for (const line of scrollback) {
    parts.push(plainLine(line));
    parts.push("\r\n");
  }

  // If the snapshot was captured on the alt screen, switch into alt BEFORE
  // painting visible cells. CSI ?1049h saves the primary cursor and clears
  // the alt buffer on entry, so the visible_screen contents land on a clean
  // alt buffer instead of being painted on top of the primary scrollback.
  // Without this, a TUI reconnect renders the alt buffer onto primary and
  // the next SIGWINCH-triggered redraw produces visual confusion.
  const onAlt = snap.modes?.alt_screen === true;
  if (onAlt) parts.push(`${CSI}?1049h`);

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

  // Restore non-default DEC modes so subsequent live-stream bytes (arrow
  // keys, mouse events, pastes) are interpreted the same way they would be
  // on a continuous attach. Emitted AFTER visible-screen paint and BEFORE
  // cursor position so a mode that affects cursor placement (origin mode)
  // applies to the final CUP.
  parts.push(modePreamble(snap.modes));

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
