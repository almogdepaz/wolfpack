export const LAYOUT_CONTRACT_VERSION = 1;
export const MAX_LAYOUT_TRACKS = 12;
export const MAX_LAYOUT_PANES = 12;

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

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function paneId(value: unknown): value is string {
  return typeof value === "string" && /^[^\u0000-\u0020\u007f]{1,256}$/.test(value);
}
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value); }

function validatePanes(value: unknown): readonly TerminalPaneReference[] {
  if (!Array.isArray(value)) throw new LayoutValidationError("UNKNOWN_PANE", "host panes must be an array");
  if (value.length > MAX_LAYOUT_PANES) throw new LayoutValidationError("TOO_MANY_PANES", `at most ${MAX_LAYOUT_PANES} panes are supported`);
  const seen = new Set<string>();
  const panes: TerminalPaneReference[] = [];
  for (const pane of value) {
    if (!object(pane) || !paneId(pane.id)) throw new LayoutValidationError("UNKNOWN_PANE", "host pane must have a bounded nonblank ID");
    if (seen.has(pane.id)) throw new LayoutValidationError("DUPLICATE_PANE", "host supplied duplicate pane IDs");
    seen.add(pane.id);
    panes.push({ id: pane.id });
  }
  return panes;
}

function validateTracks(value: unknown): readonly LayoutTrack[] {
  if (!Array.isArray(value) || value.length === 0) throw new LayoutValidationError("EMPTY_TRACKS", "layouts require at least one row and one column");
  if (value.length > MAX_LAYOUT_TRACKS) throw new LayoutValidationError("TOO_MANY_TRACKS", `layouts support at most ${MAX_LAYOUT_TRACKS} rows and columns`);
  const tracks: LayoutTrack[] = [];
  for (const track of value) {
    if (!object(track) || typeof track.size !== "number" || !Number.isFinite(track.size) || track.size <= 0 || track.size > 10_000) {
      throw new LayoutValidationError("INVALID_TRACK", "layout track sizes must be finite positive values no greater than 10000");
    }
    tracks.push({ size: track.size });
  }
  return tracks;
}

/** Geometry only; return detached known fields, never plugin-owned mutable objects. */
export function validateTerminalLayout(layout: unknown, panes: unknown): TerminalLayout {
  if (!object(layout) || layout.version !== LAYOUT_CONTRACT_VERSION) throw new LayoutValidationError("INVALID_PLACEMENT", "layout must use contract version 1");
  const expectedPanes = validatePanes(panes);
  const rows = validateTracks(layout.rows);
  const columns = validateTracks(layout.columns);
  if (!Array.isArray(layout.placements) || layout.placements.length > MAX_LAYOUT_PANES) throw new LayoutValidationError("INVALID_PLACEMENT", "layout placements must be a bounded array");
  const expected = new Set(expectedPanes.map((pane) => pane.id));
  const placed = new Set<string>();
  const occupied = new Set<string>();
  const placements: PanePlacement[] = [];
  for (const placement of layout.placements) {
    if (!object(placement) || !paneId(placement.paneId)) throw new LayoutValidationError("INVALID_PLACEMENT", "placement must have a bounded pane ID");
    const rowSpan = placement.rowSpan === undefined ? 1 : placement.rowSpan;
    const columnSpan = placement.columnSpan === undefined ? 1 : placement.columnSpan;
    if (!expected.has(placement.paneId)) throw new LayoutValidationError("UNKNOWN_PANE", "layout names an unknown host pane");
    if (placed.has(placement.paneId)) throw new LayoutValidationError("DUPLICATE_PANE", "layout places the same pane more than once");
    if (
      !integer(placement.row) || !integer(placement.column) || !integer(rowSpan) || !integer(columnSpan) ||
      placement.row < 0 || placement.column < 0 || rowSpan < 1 || columnSpan < 1 ||
      placement.row + rowSpan > rows.length || placement.column + columnSpan > columns.length
    ) throw new LayoutValidationError("INVALID_PLACEMENT", "layout placement is not a bounded integer rectangle");
    placed.add(placement.paneId);
    for (let row = placement.row; row < placement.row + rowSpan; row++) {
      for (let column = placement.column; column < placement.column + columnSpan; column++) {
        const cell = `${row}:${column}`;
        if (occupied.has(cell)) throw new LayoutValidationError("OVERLAPPING_PLACEMENT", "layout placements overlap");
        occupied.add(cell);
      }
    }
    placements.push({ paneId: placement.paneId, row: placement.row, column: placement.column, rowSpan, columnSpan });
  }
  if (placed.size !== expected.size) throw new LayoutValidationError("MISSING_PANE", "layout omitted a host pane");
  return { version: 1, rows, columns, placements };
}

function validateContext(context: LayoutContext): LayoutContext {
  if (!object(context)) throw new LayoutValidationError("INVALID_PLACEMENT", "layout context must be an object");
  const panes = validatePanes(context.panes);
  if (context.selectedPaneId !== null && !paneId(context.selectedPaneId)) throw new LayoutValidationError("UNKNOWN_PANE", "selected pane must be a bounded ID or null");
  if (!object(context.viewport) || !Number.isFinite(context.viewport.width) || !Number.isFinite(context.viewport.height) || context.viewport.width < 0 || context.viewport.height < 0) {
    throw new LayoutValidationError("INVALID_PLACEMENT", "layout viewport must have finite nonnegative dimensions");
  }
  return { panes, selectedPaneId: context.selectedPaneId, viewport: { ...context.viewport } };
}
function tracks(count: number): readonly LayoutTrack[] { return Array.from({ length: Math.max(1, count) }, () => ({ size: 1 })); }

export function equalGridLayout(input: LayoutContext): TerminalLayout {
  const context = validateContext(input);
  const count = context.panes.length;
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / columns));
  return validateTerminalLayout({
    version: 1, rows: tracks(rows), columns: tracks(columns),
    placements: context.panes.map((pane, index) => ({ paneId: pane.id, row: Math.floor(index / columns), column: index % columns })),
  }, context.panes);
}

export function leadStackLayout(input: LayoutContext): TerminalLayout {
  const context = validateContext(input);
  if (context.panes.length < 2) return equalGridLayout(context);
  const lead = context.selectedPaneId && context.panes.some((pane) => pane.id === context.selectedPaneId) ? context.selectedPaneId : context.panes[0]!.id;
  const others = context.panes.filter((pane) => pane.id !== lead);
  return validateTerminalLayout({
    version: 1, rows: tracks(others.length), columns: tracks(2),
    placements: [
      { paneId: lead, row: 0, column: 0, rowSpan: others.length },
      ...others.map((pane, index) => ({ paneId: pane.id, row: index, column: 1 })),
    ],
  }, context.panes);
}

export function verticalStackLayout(input: LayoutContext): TerminalLayout {
  const context = validateContext(input);
  return validateTerminalLayout({
    version: 1, rows: tracks(context.panes.length), columns: tracks(1),
    placements: context.panes.map((pane, row) => ({ paneId: pane.id, row, column: 0 })),
  }, context.panes);
}
