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
function equalGridLayout(input) {
  const context = validateContext(input);
  const count = context.panes.length;
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / columns));
  return validateTerminalLayout({
    version: 1,
    rows: tracks(rows),
    columns: tracks(columns),
    placements: context.panes.map((pane, index) => ({ paneId: pane.id, row: Math.floor(index / columns), column: index % columns }))
  }, context.panes);
}
function leadStackLayout(input) {
  const context = validateContext(input);
  if (context.panes.length < 2)
    return equalGridLayout(context);
  const lead = context.selectedPaneId && context.panes.some((pane) => pane.id === context.selectedPaneId) ? context.selectedPaneId : context.panes[0].id;
  const others = context.panes.filter((pane) => pane.id !== lead);
  return validateTerminalLayout({
    version: 1,
    rows: tracks(others.length),
    columns: tracks(2),
    placements: [
      { paneId: lead, row: 0, column: 0, rowSpan: others.length },
      ...others.map((pane, index) => ({ paneId: pane.id, row: index, column: 1 }))
    ]
  }, context.panes);
}

// examples/extensions/agent-context/src/model.ts
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function document2(value) {
  if (!value || typeof value !== "object")
    return false;
  const item = value;
  return item.schemaVersion === 1 && typeof item.goal === "string" && strings(item.decisions) && strings(item.blockers) && strings(item.nextSteps) && Array.isArray(item.planItems) && item.planItems.every((plan) => plan && typeof plan === "object" && typeof plan.id === "string" && typeof plan.text === "string" && ["pending", "in_progress", "complete", "blocked"].includes(plan.status));
}
function acceptsRevision(previous, next) {
  return Number.isSafeInteger(next) && next >= previous;
}
function contextViewModel(value, revision = 0) {
  if (value === null)
    return { state: "empty", revision: 0 };
  if (!document2(value))
    return { state: "error", revision };
  return { state: "ready", revision, ...value };
}

// examples/extensions/agent-context/src/ui.ts
function text(tag, value = "") {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}
function list(container, values) {
  container.replaceChildren(...values.map((value) => text("li", value)));
}
var view = {
  id: "context",
  title: "Agent Context",
  mount(container, context) {
    const root = document.createElement("section");
    root.className = "wolfpack-agent-context";
    const provenance = text("p", "Agent-authored context — not verified task or execution evidence.");
    const scope = text("p");
    const goal = text("h2");
    const plan = document.createElement("ul");
    const decisions = document.createElement("ul");
    const blockers = document.createElement("ul");
    const nextSteps = document.createElement("ul");
    const draft = document.createElement("textarea");
    draft.placeholder = "Local draft (not published)";
    draft.value = context.storage.get("draft") ?? "";
    draft.addEventListener("input", () => context.storage.set("draft", draft.value));
    root.append(provenance, scope, goal, text("h3", "Plan"), plan, text("h3", "Decisions"), decisions, text("h3", "Blockers"), blockers, text("h3", "Next steps"), nextSteps, draft);
    container.replaceChildren(root);
    let latest = -1;
    let stopped = false;
    const render = (value, revision) => {
      if (stopped || !acceptsRevision(latest, revision))
        return;
      latest = revision;
      const model = contextViewModel(value, revision);
      scope.textContent = `Scope ${context.scope.sessionId} · revision ${model.revision}`;
      if (model.state === "empty") {
        goal.textContent = "No context has been published for this exact scope.";
        list(plan, []);
        list(decisions, []);
        list(blockers, []);
        list(nextSteps, []);
        return;
      }
      if (model.state === "error") {
        goal.textContent = "Published context is unavailable or invalid.";
        list(plan, []);
        list(decisions, []);
        list(blockers, []);
        list(nextSteps, []);
        return;
      }
      goal.textContent = model.goal;
      list(plan, model.planItems.map((item) => `${item.status}: ${item.text}`));
      list(decisions, model.decisions);
      list(blockers, model.blockers);
      list(nextSteps, model.nextSteps);
    };
    let unsubscribe = () => {};
    try {
      unsubscribe = context.documents.subscribe("context", render);
    } catch {
      render(undefined, 0);
    }
    const abort = () => {
      stopped = true;
      unsubscribe();
    };
    context.signal.addEventListener("abort", abort, { once: true });
    return { setVisible(visible) {
      root.hidden = !visible;
    }, dispose() {
      abort();
      context.signal.removeEventListener("abort", abort);
      root.remove();
    } };
  }
};
function register(host) {
  host.registerContextView(view);
  host.registerTerminalLayout({ id: "lead-stack", title: "Lead + stack", arrange: leadStackLayout });
}
export {
  register as default
};
