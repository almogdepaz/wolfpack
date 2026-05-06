/**
 * TS mirror of `broker/src/protocol.rs` — shared protocol types.
 * Codec transport types (ControlRequest, ControlResponse, etc.) live in codec.ts.
 */

export const PROTOCOL_VERSION = 2;

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

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
  /** True when the terminal auto-wrapped at end-of-line (no explicit LF). */
  wrapped?: boolean;
}

export interface CursorState {
  row: number;
  col: number;
  visible?: boolean;
  shape?: "block" | "underline" | "bar";
}

export interface Snapshot {
  session_id: string;
  seq: number;
  cols: number;
  rows: number;
  visible_screen: StyledLine[];
  scrollback?: StyledLine[];
  cursor: CursorState;
  captured_at_ms: number;
}
