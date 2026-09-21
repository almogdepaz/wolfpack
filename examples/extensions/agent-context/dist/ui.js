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
function bullet(value) {
  if (!value || typeof value !== "object")
    return false;
  const item = value;
  return typeof item.id === "string" && typeof item.text === "string" && (item.details === undefined || typeof item.details === "string");
}
function bullets(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" || bullet(item) && typeof item.details === "string");
}
function document2(value) {
  if (!value || typeof value !== "object")
    return false;
  const item = value;
  return item.schemaVersion === 1 && typeof item.goal === "string" && bullets(item.decisions) && bullets(item.blockers) && bullets(item.nextSteps) && Array.isArray(item.planItems) && item.planItems.every((plan) => bullet(plan) && ("status" in plan) && typeof plan.status === "string" && ["pending", "in_progress", "complete", "blocked"].includes(plan.status));
}
function acceptsRevision(previous, next) {
  return Number.isSafeInteger(next) && next >= previous;
}
function contextViewModel(value, revision = 0) {
  if (value === null)
    return { state: "empty", revision: 0 };
  if (!document2(value))
    return { state: "error", revision };
  return { ...value, state: "ready", revision };
}

// examples/extensions/agent-context/src/styles.ts
var styles = `
.wolfpack-agent-context {
  --wac-bg: var(--bg-surface, #131715);
  --wac-border: var(--border, #28312b);
  --wac-text: var(--text-primary, #edf3ef);
  --wac-muted: var(--text-muted, #a4b2a9);
  --wac-accent: var(--accent, #45ed7e);
  display: grid; gap: 20px; max-width: 760px; min-width: 0; margin-inline: auto;
  color: var(--wac-text); font: 13px/1.55 var(--font-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  overflow-wrap: anywhere; container-type: inline-size;
}
.wolfpack-agent-context *, .wolfpack-agent-context *::before, .wolfpack-agent-context *::after { box-sizing: border-box; }
.wolfpack-agent-context[hidden], .wolfpack-agent-context [hidden] { display: none !important; }
.wolfpack-agent-context h2, .wolfpack-agent-context h3, .wolfpack-agent-context p, .wolfpack-agent-context ul { margin: 0; padding: 0; }
.wolfpack-agent-context .wac-meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; color: var(--wac-muted); font-size: 11px; }
.wolfpack-agent-context .wac-revision { border: 1px solid var(--wac-border); border-radius: 5px; padding: 1px 6px; font-variant-numeric: tabular-nums; }
.wolfpack-agent-context .wac-goal { display: grid; gap: 8px; padding: 14px; border: 1px solid var(--wac-border); border-left: 2px solid var(--wac-accent); border-radius: 8px; background: var(--wac-bg); }
.wolfpack-agent-context .wac-eyebrow { color: var(--wac-accent); font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.wolfpack-agent-context h2 { font-size: 17px; font-weight: 600; line-height: 1.45; letter-spacing: -.015em; text-wrap: pretty; }
.wolfpack-agent-context .wac-content { display: grid; gap: 22px; min-width: 0; }
.wolfpack-agent-context .wac-section { min-width: 0; display: grid; align-content: start; gap: 10px; }
.wolfpack-agent-context .wac-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.wolfpack-agent-context h3 { color: var(--wac-muted); font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
.wolfpack-agent-context .wac-count { color: var(--wac-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.wolfpack-agent-context .wac-list { display: grid; gap: 8px; list-style: none; }
.wolfpack-agent-context .wac-item { border: 1px solid var(--wac-border); background: var(--wac-bg); border-radius: 8px; min-width: 0; overflow: clip; }
.wolfpack-agent-context .wac-item[data-status="blocked"] { border-color: var(--warning, #ebca78); }
.wolfpack-agent-context summary { list-style: none; cursor: pointer; }
.wolfpack-agent-context summary::-webkit-details-marker { display: none; }
.wolfpack-agent-context .wac-item summary { min-height: 44px; padding: 11px 12px; }
.wolfpack-agent-context .wac-item summary:hover { background: var(--bg-hover, #1b231e); }
.wolfpack-agent-context summary:focus-visible, .wolfpack-agent-context button:focus-visible, .wolfpack-agent-context textarea:focus-visible { outline: 2px solid var(--wac-accent); outline-offset: -2px; border-radius: 5px; }
.wolfpack-agent-context .wac-caption { display: flex; align-items: flex-start; gap: 9px; min-width: 0; }
.wolfpack-agent-context .wac-static { padding: 11px 12px; }
.wolfpack-agent-context .wac-caption-text { display: grid; flex: 1; min-width: 0; gap: 4px; }
.wolfpack-agent-context .wac-title { font-weight: 500; line-height: 1.45; }
.wolfpack-agent-context .wac-status { color: var(--wac-muted); font-size: 10px; line-height: 1.4; }
.wolfpack-agent-context [data-status="complete"] .wac-marker { color: var(--wac-accent); }
.wolfpack-agent-context [data-status="in_progress"] .wac-marker, .wolfpack-agent-context [data-status="in_progress"] .wac-status { color: var(--cmd-accent, #66ccff); }
.wolfpack-agent-context [data-status="blocked"] .wac-marker, .wolfpack-agent-context [data-status="blocked"] .wac-status { color: var(--warning, #ebca78); }
.wolfpack-agent-context .wac-marker { flex: 0 0 16px; color: var(--wac-muted); font-size: 12px; font-weight: 600; text-align: center; line-height: 19px; font-variant-numeric: tabular-nums; }
.wolfpack-agent-context .wac-chevron { flex: 0 0 14px; width: 14px; height: 14px; margin-top: 3px; fill: none; stroke: var(--wac-muted); stroke-width: 1.6; transition: transform .15s ease; }
.wolfpack-agent-context details[open] > summary .wac-chevron { transform: rotate(90deg); }
.wolfpack-agent-context .wac-detail { padding: 0 12px 13px 37px; color: var(--text-secondary, #bac6be); font-size: 12px; line-height: 1.65; white-space: pre-wrap; }
.wolfpack-agent-context .wac-progress { width: 100%; height: 3px; border: 0; border-radius: 3px; overflow: hidden; background: var(--wac-border); color: var(--wac-accent); accent-color: var(--wac-accent); }
.wolfpack-agent-context .wac-progress::-webkit-progress-bar { background: var(--wac-border); }
.wolfpack-agent-context .wac-progress::-webkit-progress-value { background: var(--wac-accent); }
.wolfpack-agent-context .wac-progress::-moz-progress-bar { background: var(--wac-accent); }
.wolfpack-agent-context .wac-clear { color: var(--wac-muted); font-size: 11px; }
.wolfpack-agent-context .wac-blockers h3 { color: var(--warning, #ebca78); }
.wolfpack-agent-context .wac-tools { display: grid; border-top: 1px solid var(--wac-border); }
.wolfpack-agent-context .wac-tool > summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; color: var(--wac-muted); font-size: 12px; }
.wolfpack-agent-context .wac-tool > summary:hover { color: var(--wac-text); }
.wolfpack-agent-context .wac-tool-body { display: grid; gap: 10px; padding-bottom: 14px; color: var(--wac-muted); font-size: 11px; }
.wolfpack-agent-context .wac-session-id { font: 11px/1.6 var(--font-mono, monospace); color: var(--text-secondary, #bac6be); user-select: all; }
.wolfpack-agent-context textarea { display: block; width: 100%; min-height: 112px; resize: vertical; padding: 10px; border: 1px solid var(--border-input, #36433b); border-radius: 7px; background: var(--bg-inset, #0d100e); color: var(--wac-text); font: inherit; line-height: 1.6; }
.wolfpack-agent-context textarea::placeholder { color: var(--wac-muted); }
.wolfpack-agent-context .wac-guidance { display: grid; gap: 12px; color: var(--wac-muted); }
.wolfpack-agent-context .wac-request { display: block; padding: 12px; border: 1px solid var(--wac-border); border-radius: 7px; color: var(--wac-text); background: var(--wac-bg); user-select: all; }
.wolfpack-agent-context .wac-button { justify-self: start; min-height: 44px; padding: 7px 12px; border: 1px solid var(--border-hover, #405047); border-radius: 6px; color: var(--wac-text); background: var(--wac-bg); font: inherit; cursor: pointer; }
.wolfpack-agent-context .wac-button:hover { border-color: var(--wac-accent); }
.wolfpack-agent-context .wac-feedback { font-size: 11px; color: var(--wac-muted); }
.wolfpack-agent-context .wac-feedback:empty { display: none; }
@container (min-width: 560px) {
  .wolfpack-agent-context .wac-content { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; }
  .wolfpack-agent-context .wac-goal { padding: 20px; }
  .wolfpack-agent-context h2 { font-size: 21px; }
}
@media (max-width: 768px) { .wolfpack-agent-context textarea { font-size: 16px; } }
@media (prefers-reduced-motion: reduce) { .wolfpack-agent-context .wac-chevron { transition: none; } }
`;

// examples/extensions/agent-context/src/ui.ts
function node(tag, className = "", value = "") {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = value;
  return element;
}
function setText(element, value) {
  if (element.textContent !== value)
    element.textContent = value;
}
function chevron() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "wac-chevron");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", "m6 3 5 5-5 5");
  svg.append(path);
  return svg;
}
var statuses = {
  pending: { label: "Pending", marker: "○" },
  in_progress: { label: "In progress", marker: "→" },
  complete: { label: "Complete", marker: "✓" },
  blocked: { label: "Blocked", marker: "!" }
};
var view = {
  id: "context",
  title: "Agent Context",
  mount(container, context) {
    const root = node("section", "wolfpack-agent-context");
    const events = new AbortController;
    let latest = -1;
    let stopped = false;
    let unsubscribe = () => {};
    const saved = (key) => {
      try {
        return context.storage.get(key);
      } catch {
        return null;
      }
    };
    const save = (key, value) => {
      try {
        context.storage.set(key, value);
        return true;
      } catch {
        return false;
      }
    };
    const meta = node("div", "wac-meta");
    const revisionLabel = node("span", "wac-revision");
    meta.append(node("span", "", "Agent-authored"), revisionLabel);
    const goalCard = node("div", "wac-goal");
    const goal = node("h2");
    goalCard.append(node("span", "wac-eyebrow", "Current goal"), goal);
    const feedback = node("p", "wac-feedback");
    feedback.setAttribute("role", "status");
    function copyButton(label, value) {
      const button = node("button", "wac-button", label);
      button.type = "button";
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(value);
          if (!stopped)
            setText(feedback, "Copied to clipboard.");
        } catch {
          if (!stopped)
            setText(feedback, "Could not copy. Select the text and copy it manually.");
        }
      }, { signal: events.signal });
      return button;
    }
    const guidance = node("div", "wac-guidance");
    const request = "Update this session's context using the wolfpack-agent-context skill.";
    guidance.append(node("p", "", "Ask your agent to publish a brief for this session. It will resolve the session automatically."), node("p", "wac-request", request), copyButton("Copy request", request), node("p", "", "Context is not extracted automatically from terminal output."));
    const unavailable = node("p", "wac-feedback", "The document could not be read or did not match the context format. Ask the agent to check its published document. Your local draft is unaffected.");
    const content = node("div", "wac-content");
    const clear = node("p", "wac-clear", "✓  No blockers reported");
    function section(title, className = "") {
      const element = node("section", `wac-section ${className}`);
      element.setAttribute("aria-label", title);
      const heading = node("div", "wac-section-head");
      const count = node("span", "wac-count");
      const list = node("ul", "wac-list");
      list.setAttribute("role", "list");
      heading.append(node("h3", "", title), count);
      element.append(heading, list);
      return { element, heading, count, list };
    }
    const plan = section("Plan");
    const next = section("Next steps");
    const decisions = section("Decisions");
    const blockers = section("Blockers", "wac-blockers");
    const progress = node("progress", "wac-progress");
    progress.setAttribute("aria-label", "Agent-reported plan completion");
    plan.heading.after(progress);
    content.append(plan.element, next.element, decisions.element);
    function tool(title, key, defaultOpen = false) {
      const element = node("details", "wac-tool");
      const summary = node("summary");
      summary.append(node("span", "", title), chevron());
      const body = node("div", "wac-tool-body");
      element.append(summary, body);
      element.open = saved(key) === "true" || saved(key) === null && defaultOpen;
      element.addEventListener("toggle", () => save(key, String(element.open)), { signal: events.signal });
      return { element, body };
    }
    const draft = node("textarea");
    draft.placeholder = "Ideas to keep for later…";
    draft.setAttribute("aria-label", "Local draft");
    draft.value = saved("draft") ?? "";
    const draftTool = tool("Local draft", "draft-open", draft.value.length > 0);
    const draftNote = node("p", "", "Saved in this browser only. Not published to the agent.");
    draft.addEventListener("input", () => setText(draftNote, save("draft", draft.value) ? "Saved in this browser only. Not published to the agent." : "Could not save in this browser. Copy your draft before leaving."), { signal: events.signal });
    draftTool.body.append(draft, draftNote);
    const sessionTool = tool("Session details", "session-open");
    sessionTool.body.append(node("code", "wac-session-id", context.scope.sessionId), copyButton("Copy session ID", context.scope.sessionId), node("p", "", "Agent-authored context — not verified task or execution evidence."));
    const tools = node("div", "wac-tools");
    tools.append(draftTool.element, sessionTool.element);
    root.append(node("style", "", styles), meta, goalCard, guidance, unavailable, blockers.element, clear, content, tools, feedback);
    container.replaceChildren(root);
    const rows = new Map;
    function makeRow(key, initiallyOpen) {
      const li = node("li", "wac-item");
      li.dataset.bullet = key;
      const disclosure = node("details");
      const summary = node("summary");
      const plain = node("div", "wac-static");
      const caption = node("span", "wac-caption");
      const title = node("span", "wac-title");
      const status = node("span", "wac-status");
      const marker = node("span", "wac-marker");
      marker.setAttribute("aria-hidden", "true");
      const words = node("span", "wac-caption-text");
      const arrow = chevron();
      words.append(title, status);
      caption.append(marker, words, arrow);
      const body = node("p", "wac-detail");
      summary.append(caption);
      disclosure.append(summary, body);
      li.append(disclosure, plain);
      const preference = saved(`bullet-open:${key}`);
      disclosure.open = preference === "true" || preference === null && initiallyOpen;
      disclosure.ontoggle = () => {
        if (!stopped)
          save(`bullet-open:${key}`, String(disclosure.open));
      };
      return { li, disclosure, summary, plain, caption, title, status, marker, body, arrow };
    }
    function renderList(group, name, values, planStatuses) {
      const wanted = new Set;
      const occurrences = new Map;
      let cursor = group.list.firstElementChild;
      values.forEach((value, index) => {
        const bullet = typeof value === "string" ? { id: `legacy-${index}`, text: value } : value;
        const occurrence = occurrences.get(bullet.id) ?? 0;
        occurrences.set(bullet.id, occurrence + 1);
        const key = JSON.stringify([name, bullet.id, occurrence]);
        wanted.add(key);
        let row = rows.get(key);
        if (!row) {
          row = makeRow(key, name === "blockers");
          rows.set(key, row);
        }
        const status = planStatuses?.[index];
        const hasDetails = Boolean(bullet.details);
        setText(row.title, bullet.text);
        setText(row.body, bullet.details ?? "");
        setText(row.status, status ? statuses[status].label : "");
        row.status.hidden = !status;
        setText(row.marker, status ? statuses[status].marker : name === "next" ? String(index + 1) : name === "blockers" ? "!" : "·");
        row.li.dataset.status = status ?? (name === "blockers" ? "blocked" : "");
        row.disclosure.hidden = !hasDetails;
        row.plain.hidden = hasDetails;
        row.arrow.style.display = hasDetails ? "" : "none";
        const parent = hasDetails ? row.summary : row.plain;
        if (row.caption.parentElement !== parent)
          parent.append(row.caption);
        if (row.li !== cursor)
          group.list.insertBefore(row.li, cursor);
        cursor = row.li.nextElementSibling;
      });
      for (const [key, row] of rows) {
        if (row.li.parentElement === group.list && !wanted.has(key)) {
          row.disclosure.ontoggle = null;
          row.li.remove();
          rows.delete(key);
        }
      }
      group.element.hidden = values.length === 0;
      setText(group.count, String(values.length));
    }
    const render = (value, revision) => {
      if (stopped || !acceptsRevision(latest, revision))
        return;
      latest = revision;
      const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
      const model = contextViewModel(value, revision);
      setText(revisionLabel, model.state === "empty" ? "Not published" : `Revision ${model.revision}`);
      guidance.hidden = model.state !== "empty";
      unavailable.hidden = model.state !== "error";
      content.hidden = clear.hidden = blockers.element.hidden = model.state !== "ready";
      if (model.state !== "ready") {
        setText(goal, model.state === "empty" ? "No context yet" : "Context unavailable");
        return;
      }
      setText(goal, model.goal);
      renderList(plan, "plan", model.planItems, model.planItems.map((item) => item.status));
      renderList(next, "next", model.nextSteps);
      renderList(decisions, "decisions", model.decisions);
      renderList(blockers, "blockers", model.blockers);
      clear.hidden = model.blockers.length > 0;
      const completed = model.planItems.filter((item) => item.status === "complete").length;
      progress.max = Math.max(1, model.planItems.length);
      progress.value = completed;
      progress.setAttribute("aria-valuetext", `${completed} of ${model.planItems.length} items complete, reported by the agent`);
      setText(plan.count, `${completed} / ${model.planItems.length} done`);
      if (active?.isConnected && active.getClientRects().length && document.activeElement !== active)
        active.focus({ preventScroll: true });
    };
    setText(goal, "Loading context…");
    setText(revisionLabel, "Loading");
    guidance.hidden = unavailable.hidden = content.hidden = blockers.element.hidden = clear.hidden = true;
    const cleanup = () => {
      if (stopped)
        return;
      stopped = true;
      events.abort();
      unsubscribe();
      for (const row of rows.values())
        row.disclosure.ontoggle = null;
    };
    context.signal.addEventListener("abort", cleanup, { once: true });
    if (context.signal.aborted)
      cleanup();
    else {
      try {
        const release = context.documents.subscribe("context", render);
        if (stopped)
          release();
        else
          unsubscribe = release;
      } catch {
        render(undefined, 0);
      }
    }
    return { setVisible(visible) {
      if (!stopped)
        root.hidden = !visible;
    }, dispose() {
      cleanup();
      context.signal.removeEventListener("abort", cleanup);
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
