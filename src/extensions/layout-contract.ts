export const LAYOUT_CONTRACT_VERSION = 1;
export const MAX_LAYOUT_TRACKS = 12;
export const MAX_LAYOUT_PANES = 64;

export interface TerminalPaneReference { readonly id: string; }
export interface LayoutTrack { readonly size: number; }
export interface PanePlacement {
  readonly paneId: string;
  readonly row: number;
  readonly column: number;
  readonly rowSpan?: number;
  readonly columnSpan?: number;
}
export interface TerminalLayout {
  readonly version: typeof LAYOUT_CONTRACT_VERSION;
  readonly rows: readonly LayoutTrack[];
  readonly columns: readonly LayoutTrack[];
  readonly placements: readonly PanePlacement[];
}
export interface LayoutContext {
  readonly panes: readonly TerminalPaneReference[];
  readonly selectedPaneId: string | null;
  readonly viewport: Readonly<{ width: number; height: number }>;
}
export interface TerminalLayoutContribution {
  readonly id: string;
  readonly title: string;
  readonly arrange: (context: LayoutContext) => TerminalLayout;
}

export type LayoutValidationErrorCode =
  | "TOO_MANY_PANES" | "EMPTY_TRACKS" | "TOO_MANY_TRACKS" | "INVALID_TRACK"
  | "UNKNOWN_PANE" | "DUPLICATE_PANE" | "MISSING_PANE" | "INVALID_PLACEMENT" | "OVERLAPPING_PLACEMENT";

export class LayoutValidationError extends Error {
  constructor(readonly code: LayoutValidationErrorCode, message: string) {
    super(message);
    this.name = "LayoutValidationError";
  }
}

function integer(value: number): boolean { return Number.isSafeInteger(value); }
function span(value: number | undefined): number { return value ?? 1; }

/**
 * Accepts geometry only. The host retains terminal containers, focus, attachment,
 * controller lifetime, and resize ordering; recipes cannot create or hide panes.
 */
export function validateTerminalLayout(layout: TerminalLayout, panes: readonly TerminalPaneReference[]): TerminalLayout {
  if (panes.length > MAX_LAYOUT_PANES) throw new LayoutValidationError("TOO_MANY_PANES", `at most ${MAX_LAYOUT_PANES} panes are supported`);
  if (!Array.isArray(layout.rows) || !Array.isArray(layout.columns) || layout.rows.length === 0 || layout.columns.length === 0) {
    throw new LayoutValidationError("EMPTY_TRACKS", "layouts require at least one row and one column");
  }
  if (layout.rows.length > MAX_LAYOUT_TRACKS || layout.columns.length > MAX_LAYOUT_TRACKS) {
    throw new LayoutValidationError("TOO_MANY_TRACKS", `layouts support at most ${MAX_LAYOUT_TRACKS} rows and columns`);
  }
  for (const track of [...layout.rows, ...layout.columns]) {
    if (!Number.isFinite(track.size) || track.size <= 0 || track.size > 10_000) {
      throw new LayoutValidationError("INVALID_TRACK", "layout track sizes must be finite positive values no greater than 10000");
    }
  }
  const expected = new Set(panes.map((pane) => pane.id));
  if (expected.size !== panes.length) throw new LayoutValidationError("DUPLICATE_PANE", "host supplied duplicate pane IDs");
  const placed = new Set<string>();
  const occupied = new Set<string>();
  for (const placement of layout.placements) {
    const rowSpan = span(placement.rowSpan);
    const columnSpan = span(placement.columnSpan);
    if (!expected.has(placement.paneId)) throw new LayoutValidationError("UNKNOWN_PANE", `unknown pane: ${placement.paneId}`);
    if (placed.has(placement.paneId)) throw new LayoutValidationError("DUPLICATE_PANE", `pane placed more than once: ${placement.paneId}`);
    if (!integer(placement.row) || !integer(placement.column) || !integer(rowSpan) || !integer(columnSpan)
      || placement.row < 0 || placement.column < 0 || rowSpan < 1 || columnSpan < 1
      || placement.row + rowSpan > layout.rows.length || placement.column + columnSpan > layout.columns.length) {
      throw new LayoutValidationError("INVALID_PLACEMENT", `invalid placement for pane: ${placement.paneId}`);
    }
    placed.add(placement.paneId);
    for (let row = placement.row; row < placement.row + rowSpan; row++) for (let column = placement.column; column < placement.column + columnSpan; column++) {
      const cell = `${row}:${column}`;
      if (occupied.has(cell)) throw new LayoutValidationError("OVERLAPPING_PLACEMENT", "layout placements overlap");
      occupied.add(cell);
    }
  }
  for (const pane of panes) if (!placed.has(pane.id)) throw new LayoutValidationError("MISSING_PANE", `layout omitted pane: ${pane.id}`);
  return layout;
}

function tracks(count: number): readonly LayoutTrack[] { return Array.from({ length: Math.max(1, count) }, () => ({ size: 1 })); }

export function equalGridLayout(context: LayoutContext): TerminalLayout {
  const count = context.panes.length;
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / columns));
  return validateTerminalLayout({ version: 1, rows: tracks(rows), columns: tracks(columns), placements: context.panes.map((pane, index) => ({ paneId: pane.id, row: Math.floor(index / columns), column: index % columns })) }, context.panes);
}

export function leadStackLayout(context: LayoutContext): TerminalLayout {
  if (context.panes.length < 2) return equalGridLayout(context);
  const lead = context.selectedPaneId && context.panes.some((pane) => pane.id === context.selectedPaneId) ? context.selectedPaneId : context.panes[0]!.id;
  const others = context.panes.filter((pane) => pane.id !== lead);
  return validateTerminalLayout({
    version: 1, rows: tracks(others.length), columns: tracks(2),
    placements: [{ paneId: lead, row: 0, column: 0, rowSpan: others.length }, ...others.map((pane, index) => ({ paneId: pane.id, row: index, column: 1 }))],
  }, context.panes);
}

export function verticalStackLayout(context: LayoutContext): TerminalLayout {
  return validateTerminalLayout({ version: 1, rows: tracks(context.panes.length), columns: tracks(1), placements: context.panes.map((pane, row) => ({ paneId: pane.id, row, column: 0 })) }, context.panes);
}
