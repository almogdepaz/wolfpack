// sdk/extensions.js
var LAYOUT_CONTRACT_VERSION = 1;
var MAX_LAYOUT_TRACKS = 12;
var MAX_LAYOUT_PANES = 12;

class LayoutValidationError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "LayoutValidationError";
  }
}
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function paneId(value) {
  return typeof value === "string" && /^[^\u0000-\u0020\u007f]{1,256}$/.test(value);
}
function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}
function validatePanes(value) {
  if (!Array.isArray(value))
    throw new LayoutValidationError("UNKNOWN_PANE", "host panes must be an array");
  if (value.length > MAX_LAYOUT_PANES)
    throw new LayoutValidationError("TOO_MANY_PANES", `at most ${MAX_LAYOUT_PANES} panes are supported`);
  const seen = new Set;
  const panes = [];
  for (const pane of value) {
    if (!object(pane) || !paneId(pane.id))
      throw new LayoutValidationError("UNKNOWN_PANE", "host pane must have a bounded nonblank ID");
    if (seen.has(pane.id))
      throw new LayoutValidationError("DUPLICATE_PANE", "host supplied duplicate pane IDs");
    seen.add(pane.id);
    panes.push({ id: pane.id });
  }
  return panes;
}
function validateTracks(value) {
  if (!Array.isArray(value) || value.length === 0)
    throw new LayoutValidationError("EMPTY_TRACKS", "layouts require at least one row and one column");
  if (value.length > MAX_LAYOUT_TRACKS)
    throw new LayoutValidationError("TOO_MANY_TRACKS", `layouts support at most ${MAX_LAYOUT_TRACKS} rows and columns`);
  const tracks = [];
  for (const track of value) {
    if (!object(track) || typeof track.size !== "number" || !Number.isFinite(track.size) || track.size <= 0 || track.size > 1e4) {
      throw new LayoutValidationError("INVALID_TRACK", "layout track sizes must be finite positive values no greater than 10000");
    }
    tracks.push({ size: track.size });
  }
  return tracks;
}
function validateTerminalLayout(layout, panes) {
  if (!object(layout) || layout.version !== LAYOUT_CONTRACT_VERSION)
    throw new LayoutValidationError("INVALID_PLACEMENT", "layout must use contract version 1");
  const expectedPanes = validatePanes(panes);
  const rows = validateTracks(layout.rows);
  const columns = validateTracks(layout.columns);
  if (!Array.isArray(layout.placements) || layout.placements.length > MAX_LAYOUT_PANES)
    throw new LayoutValidationError("INVALID_PLACEMENT", "layout placements must be a bounded array");
  const expected = new Set(expectedPanes.map((pane) => pane.id));
  const placed = new Set;
  const occupied = new Set;
  const placements = [];
  for (const placement of layout.placements) {
    if (!object(placement) || !paneId(placement.paneId))
      throw new LayoutValidationError("INVALID_PLACEMENT", "placement must have a bounded pane ID");
    const rowSpan = placement.rowSpan === undefined ? 1 : placement.rowSpan;
    const columnSpan = placement.columnSpan === undefined ? 1 : placement.columnSpan;
    if (!expected.has(placement.paneId))
      throw new LayoutValidationError("UNKNOWN_PANE", "layout names an unknown host pane");
    if (placed.has(placement.paneId))
      throw new LayoutValidationError("DUPLICATE_PANE", "layout places the same pane more than once");
    if (!integer(placement.row) || !integer(placement.column) || !integer(rowSpan) || !integer(columnSpan) || placement.row < 0 || placement.column < 0 || rowSpan < 1 || columnSpan < 1 || placement.row + rowSpan > rows.length || placement.column + columnSpan > columns.length)
      throw new LayoutValidationError("INVALID_PLACEMENT", "layout placement is not a bounded integer rectangle");
    placed.add(placement.paneId);
    for (let row = placement.row;row < placement.row + rowSpan; row++) {
      for (let column = placement.column;column < placement.column + columnSpan; column++) {
        const cell = `${row}:${column}`;
        if (occupied.has(cell))
          throw new LayoutValidationError("OVERLAPPING_PLACEMENT", "layout placements overlap");
        occupied.add(cell);
      }
    }
    placements.push({ paneId: placement.paneId, row: placement.row, column: placement.column, rowSpan, columnSpan });
  }
  if (placed.size !== expected.size)
    throw new LayoutValidationError("MISSING_PANE", "layout omitted a host pane");
  return { version: 1, rows, columns, placements };
}
function validateContext(context) {
  if (!object(context))
    throw new LayoutValidationError("INVALID_PLACEMENT", "layout context must be an object");
  const panes = validatePanes(context.panes);
  if (context.selectedPaneId !== null && !paneId(context.selectedPaneId))
    throw new LayoutValidationError("UNKNOWN_PANE", "selected pane must be a bounded ID or null");
  if (!object(context.viewport) || !Number.isFinite(context.viewport.width) || !Number.isFinite(context.viewport.height) || context.viewport.width < 0 || context.viewport.height < 0) {
    throw new LayoutValidationError("INVALID_PLACEMENT", "layout viewport must have finite nonnegative dimensions");
  }
  return { panes, selectedPaneId: context.selectedPaneId, viewport: { ...context.viewport } };
}
function tracks(count) {
  return Array.from({ length: Math.max(1, count) }, () => ({ size: 1 }));
}
function verticalStackLayout(input) {
  const context = validateContext(input);
  return validateTerminalLayout({
    version: 1,
    rows: tracks(context.panes.length),
    columns: tracks(1),
    placements: context.panes.map((pane, row) => ({ paneId: pane.id, row, column: 0 }))
  }, context.panes);
}

// examples/extensions/notes/src/ui.ts
function register(host) {
  host.registerContextView({
    id: "notes",
    title: "Notes",
    mount(container, context) {
      const root = document.createElement("section");
      const label = document.createElement("label");
      label.textContent = "Local notes for this exact extension scope";
      const editor = document.createElement("textarea");
      editor.value = context.storage.get("notes") ?? "";
      editor.addEventListener("input", () => context.storage.set("notes", editor.value));
      label.append(editor);
      root.append(label);
      container.replaceChildren(root);
      return { setVisible(visible) {
        root.hidden = !visible;
      }, dispose() {
        root.remove();
      } };
    }
  });
  host.registerTerminalLayout({ id: "vertical-stack", title: "Vertical stack", arrange: verticalStackLayout });
}
export {
  register as default
};
