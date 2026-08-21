// ── Grid UI Functions ──
// Extracted from app.ts — imported back via bundler (inlined at build time)
// Uses dependency injection to avoid circular imports with app.ts

import {
  esc, escAttr, state, setState, wpSettings,
  TERM_PRESETS, isDesktop,
} from "./app-state";
import { gridTerminalScrollbackBudget } from "../src/grid-scrollback-policy";
import { __wfTraceEvent, __wfTraceGet, __wfTraceStart } from "./app-debug";
import {
  createTerminalSlowPathIndicator,
  setTerminalLoadVisualState,
} from "./terminal-loading-ui";
import { scheduleTakeControlFallback } from "./take-control-coordinator";
import { TERMINAL_PREFILL_MODE } from "../src/terminal-prefill";
import {
  addToGridState,
  removeFromGridState,
  resumeGridState,
  suspendGridState,
} from "../src/grid-logic";
import {
  classifyDisconnect,
  handleControlGranted,
  handleDisplaced,
  handleViewerConflict,
} from "../src/take-control-logic";
import type { OrderedResizeSettlement } from "./ordered-resize";

// ── Dependency injection ──

interface GridTerminalController {
  readonly isConnected: boolean;
  readonly hydration?: { forceFinish(): void };
  readonly term?: { options: { disableStdin: boolean; cursorBlink: boolean } };
  mount(cell: HTMLElement, opts: { readonly cached?: string | null }): Promise<void>;
  connect(opts?: { readonly takeControl?: boolean }): void;
  reconnect(opts?: { readonly takeControl?: boolean }): void;
  scheduleReconnect(): void;
  sendTakeControl(): void;
  forceRepaint(): void;
  focus(): void;
  readonly supportsOrderedResize: boolean;
  resize(): void | Promise<OrderedResizeSettlement>;
  dispose(): void;
}

interface GridSession {
  readonly session: string;
  readonly machine: string;
  controller?: GridTerminalController | null;
  _cellElement?: HTMLElement | null;
  _displaced?: boolean;
  _autoTakeControl?: boolean;
  _slowLoad?: ReturnType<typeof createTerminalSlowPathIndicator> | null;
  _delegation?: boolean;
  _delegationRole?: "root" | "child";
  _statusClass?: string;
  _statusLabel?: string;
  _idle?: boolean;
  _collapsed?: boolean;
  _gridIsolationFailed?: boolean;
  [field: string]: unknown;
}

export interface DelegationGridMember {
  readonly session: string;
  readonly machine: string;
  readonly role: "root" | "child";
  readonly statusClass: string;
  readonly statusLabel: string;
  readonly idle: boolean;
}

interface GridDeps {
  showView: (name: string, skipAnimation?: boolean) => void;
  openSession: (name: string, machineUrl?: string) => void;
  destroyTerminal: () => void;
  initTerminal: (cached?: string | null) => void;
  backToSessions: () => void;
  renderSidebar: () => void;
  createPtyTerminalController: (opts: { session: string; machine?: string; scrollback: number; [k: string]: unknown }) => GridTerminalController;
  createConflictOverlay: (message: string, buttonLabel: string, onClick: (e: Event) => void) => HTMLElement;
  showNotice: (title: string, message: string) => void;
  canUseWasmTerminal?: () => boolean;
  isGhosttyRendererReady?: () => boolean;
  ensureGridIsolation?: () => Promise<boolean>;
  focusDelegationSession?: (session: string, machine: string) => void;
  leaveDelegationWorkspace?: () => void;
}

let deps: GridDeps;
let reportedGridIsolationFailure = false;
const pendingGridMountCells = new WeakMap<GridSession, HTMLElement>();

export function initGridDeps(d: GridDeps) {
  deps = d;
}

// ── Relayout transition helpers ──

function setGridCellLoading(gs, loading) {
  gs._loading = loading;
  const cell = getGridCellElement(gs);
  if (cell) cell.classList.toggle("grid-loading", loading);
}

function cancelGridRelayoutTransition() {
  state.gridRelayoutTransitionId += 1;
  if (_gridRelayoutFitRaf != null) {
    cancelAnimationFrame(_gridRelayoutFitRaf);
    _gridRelayoutFitRaf = null;
  }
  if (_gridRelayoutRevealRaf != null) {
    cancelAnimationFrame(_gridRelayoutRevealRaf);
    _gridRelayoutRevealRaf = null;
  }
  for (const gs of _gridRelayoutHiddenSessions) gs._cellElement?.classList.remove("transitioning");
  _gridRelayoutHiddenSessions.clear();
}

// ── Multi-terminal grid state ──
let _gridRelayoutFitRaf: number | null = null;
let _gridRelayoutRevealRaf: number | null = null;
const _gridRelayoutHiddenSessions = new Set<GridSession>();
const MAX_GRID_CELLS = 6;

export function isGridActive() {
  return !state.activeDelegationRoot && (
    state.gridSessions.length >= 2 || state.gridSessions[0]?._retainedSingle === true
  );
}

export function canOpenMultiTerminalGrid(): boolean {
  if (!(deps.canUseWasmTerminal ? deps.canUseWasmTerminal() : isDesktop())) {
    console.warn("[grid] WebAssembly unavailable — cannot open grid terminal");
    return false;
  }
  // Without per-Terminal WASM isolation, all grid cells share one
  // WebAssembly.Memory. Concurrent fit()/write() across cells produce
  // out-of-bounds memory accesses that crash every terminal in the tab.
  // A missing factory before the lazy renderer resolves is expected. Once the
  // renderer has resolved, though, its absence means this bundle is unsafe for
  // concurrent terminals and must remain blocked.
  if (deps.isGhosttyRendererReady?.() && typeof window.createIsolatedGhostty !== "function") {
    console.error("[grid] createIsolatedGhostty unavailable — grid mode disabled to prevent WASM OOB crash. Reload to pick up a newer ghostty-web bundle.");
    deps.showNotice(
      "Grid mode unavailable",
      "Grid mode is disabled in this tab. The terminal WASM bundle does not support per-cell isolation, which is required to safely show multiple terminals at once. Reload the page to pick up a fresh bundle.",
    );
    return false;
  }
  return true;
}

function sessionsForGridSession(gs: GridSession): GridSession[] {
  return gs._delegation ? state.delegationGridSessions : state.gridSessions;
}

function focusIndexForGridSession(gs: GridSession): number {
  return gs._delegation ? state.delegationGridFocusIndex : state.gridFocusIndex;
}

function gridContainerForSession(gs: GridSession): HTMLElement | null {
  return document.getElementById(gs._delegation ? "delegation-grid-container" : "desktop-grid-container");
}

function setGridSessionFocus(gs: GridSession, index: number): void {
  if (gs._delegation) setDelegationGridFocus(index);
  else setGridFocus(index);
}

function gridLayoutClass(count) {
  if (count <= 1) return "grid-1";
  if (count >= 2 && count <= 6) return "grid-" + count;
  return "grid-6";
}

export function updateGridLayout() {
  const container = document.getElementById("desktop-grid-container");
  if (!isGridActive()) {
    container.className = "";
    container.style.display = "";
    return;
  }
  // Remove old grid-N classes, add current; clear any inline style override
  container.className = "active " + gridLayoutClass(state.gridSessions.length);
  container.style.display = "";
  // Ensure single-terminal container is hidden
  document.getElementById("desktop-terminal-container").style.display = "none";
  document.getElementById("input-bar").style.display = "none";
  document.getElementById("cmd-palette").classList.remove("visible");
  document.getElementById("kb-accessory").classList.remove("visible");
}

function createGridCell(gs: GridSession, idx: number): HTMLElement {
  const existingTrace = __wfTraceGet(gs.session, gs.machine || "");
  const trace = existingTrace?._meta.mode === "grid" && existingTrace.events.some((event) => event.kind === "addToGrid.start")
    ? existingTrace
    : __wfTraceStart(gs.session, gs.machine || "", { mode: gs._delegation ? "delegation-grid" : "grid", gridIndex: idx });
  __wfTraceEvent(trace, "dom.cell.created", { gridIndex: idx });
  const cell = document.createElement("div");
  cell.className = "grid-cell" + (gs._delegation ? " delegation-grid-cell" : "")
    + (idx === focusIndexForGridSession(gs) ? " grid-focused" : "")
    + (gs._loading ? " grid-loading" : "")
    + (gs._collapsed ? " collapsed" : "");
  cell.dataset.gridIndex = String(idx);
  cell.dataset.session = gs.session;

  if (gs._delegation) {
    const collapseButton = gs._delegationRole === "child"
      ? `<button type="button" class="delegation-cell-collapse" aria-label="${gs._collapsed ? "Expand" : "Collapse"} ${esc(gs.session)}">${gs._collapsed ? "expand" : "collapse"}</button>`
      : "";
    cell.innerHTML = `<div class="grid-cell-header"><div class="grid-cell-label">${esc(gs.session)}</div><div class="delegation-cell-actions"><span class="triage-badge ${esc(gs._statusClass || "idle")}">${esc(gs._statusLabel || "idle")}</span>${collapseButton}<button type="button" class="delegation-cell-focus" aria-label="Focus ${esc(gs.session)}">focus</button></div></div><div class="grid-cell-loading">Loading terminal</div>`;
    cell.querySelector(".delegation-cell-collapse")?.addEventListener("click", (event) => {
      event.stopPropagation();
      gs._collapsed = !gs._collapsed;
      renderDelegationGridCells();
      deps.renderSidebar();
    });
    cell.querySelector(".delegation-cell-focus")?.addEventListener("click", (event) => {
      event.stopPropagation();
      deps.focusDelegationSession?.(gs.session, gs.machine || "");
    });
  } else {
    cell.innerHTML = '<div class="grid-cell-header"><div class="grid-cell-label">' + esc(gs.session) + '</div><button type="button" class="grid-cell-close" title="Remove from grid" aria-label="Remove ' + escAttr(gs.session) + ' from grid">&times;</button></div><div class="grid-cell-loading">Loading terminal</div>';
    cell.querySelector(".grid-cell-close")?.addEventListener("click", (event) => {
      event.stopPropagation();
      const index = parseInt(cell.dataset.gridIndex || "-1", 10);
      removeFromGrid(index);
    });
  }

  setTerminalLoadVisualState(cell, "prefill-loading");
  gs._slowLoad = createTerminalSlowPathIndicator(cell);
  gs._slowLoad.start("waiting for grid cell snapshot");
  cell.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, .grid-cell-close")) return;
    const selection = window.getSelection ? window.getSelection() : null;
    if (selection && !selection.isCollapsed) return;
    const index = parseInt(cell.dataset.gridIndex || "-1", 10);
    setGridSessionFocus(gs, index);
  });
  gs._cellElement = cell;
  return cell;
}

function ownsGridMount(gs: GridSession, cell: HTMLElement): boolean {
  return !gs._collapsed && pendingGridMountCells.get(gs) === cell &&
    sessionsForGridSession(gs).includes(gs) && gs._cellElement === cell && cell.parentNode !== null;
}

function clearPendingGridMount(gs: GridSession, cell: HTMLElement): void {
  if (pendingGridMountCells.get(gs) === cell) pendingGridMountCells.delete(gs);
}

async function mountGridController(gs, cell, idx) {
  if (gs.controller || pendingGridMountCells.get(gs) !== cell) return;
  let hasGridIsolation = true;
  try {
    hasGridIsolation = deps.ensureGridIsolation ? await deps.ensureGridIsolation() : true;
  } catch (error) {
    console.error("[grid] Ghostty renderer failed before isolation could be verified:", error);
    hasGridIsolation = false;
  }
  // Lazy renderer resolution yields control to topology changes. Only the
  // cell that still owns this logical session may create or activate a PTY.
  if (!ownsGridMount(gs, cell)) {
    clearPendingGridMount(gs, cell);
    return;
  }
  if (!hasGridIsolation) {
    clearPendingGridMount(gs, cell);
    gs._gridIsolationFailed = true;
    gs._slowLoad?.stop();
    setTerminalLoadVisualState(cell, "failed");
    if (!reportedGridIsolationFailure) {
      reportedGridIsolationFailure = true;
      deps.showNotice(
        "Grid mode unavailable",
        "Grid mode is disabled in this tab. The terminal WASM bundle does not support per-cell isolation, which is required to safely show multiple terminals at once. Reload the page to pick up a fresh bundle.",
      );
    }
    return;
  }
  const tp = TERM_PRESETS[wpSettings.termFontSize] || TERM_PRESETS.medium;
  const controller = deps.createPtyTerminalController({
    session: gs.session,
    machine: gs.machine || "",
    fontSize: Math.max(tp.fontSize - 2, 10),
    scrollback: gridTerminalScrollbackBudget(
      sessionsForGridSession(gs).length,
      (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    ),
    cursorBlink: idx === focusIndexForGridSession(gs),
    disableStdin: idx !== focusIndexForGridSession(gs),
    resetPty: gs._resetPty,
    prefillMode: TERMINAL_PREFILL_MODE.VIEWPORT,
    shouldFocus: () => sessionsForGridSession(gs)[focusIndexForGridSession(gs)] === gs,
    shouldReconnect: () => sessionsForGridSession(gs).includes(gs),
    canAcceptInput: () => !!(gs.controller && gs.controller.isConnected && sessionsForGridSession(gs)[focusIndexForGridSession(gs)] === gs),
    canSendResize: () => !!(gs.controller && gs.controller.isConnected),
    onOpen: () => {
      // Successful WS open means we have the session — clear any stale
      // conflict overlay. If the server sees a conflict, onViewerConflict
      // fires AFTER onOpen and re-shows the overlay.
      gs._displaced = false;
      removeGridCellConflictOverlay(gs);
      setTerminalLoadVisualState(cell, "prefill-loading");
      gs._slowLoad?.start("waiting for grid cell prefill");
    },
    onPtyReady: () => {
      // Parallel of single-terminal fix in commit 75d6ff3. Without this, the
      // canvas keeps showing the manual #0a0a0a fillRect from mount() because
      // the WASM render loop runs with forceAll=false and skips repaint when
      // dimensions/dirty-cells haven't changed. Fires on every reconnect too,
      // so post-sleep / long-background recovery also gets a fresh repaint.
      if (gs.controller) gs.controller.forceRepaint();
      // pty_ready is sent after prefill_done + broker subscribe. From here the
      // cell may still be hidden by hydration, but it is no longer waiting for
      // prefill. Keep the loading UI honest so stale slow-path badges don't sit
      // on top of an otherwise usable terminal.
      setTerminalLoadVisualState(cell, "hydrating");
      gs._slowLoad?.start("hydrating grid cell");
    },
    onViewerConflict: () => {

      var r = handleViewerConflict({ displaced: gs._displaced, autoTakeControl: gs._autoTakeControl });
      gs._displaced = r.newState.displaced;
      gs._autoTakeControl = r.newState.autoTakeControl;
      gs._slowLoad?.stop();
      setTerminalLoadVisualState(cell, gs._displaced ? "displaced" : "viewer-conflict");
      if (r.action === "auto-take-control") {

        gs.controller.sendTakeControl();
      } else {
        showGridCellConflictOverlay(gs);
      }
    },
    onControlGranted: () => {
      var s = handleControlGranted({ displaced: gs._displaced, autoTakeControl: gs._autoTakeControl });
      gs._displaced = s.displaced;
      gs._autoTakeControl = s.autoTakeControl;
      removeGridCellConflictOverlay(gs);
      setTerminalLoadVisualState(cell, "hydrating");
      gs._slowLoad?.start("restoring grid cell control");
      if (sessionsForGridSession(gs)[focusIndexForGridSession(gs)] === gs) gs.controller.focus();
    },
    onDisconnected: (code, reason) => {
      removeGridCellConflictOverlay(gs);
      if (!sessionsForGridSession(gs).includes(gs)) return;
      var action = classifyDisconnect(code, reason || "");
      if (action === "displaced") {
        var ns = handleDisplaced({ displaced: gs._displaced, autoTakeControl: gs._autoTakeControl });
        gs._displaced = ns.displaced;
        gs._autoTakeControl = ns.autoTakeControl;
        gs._slowLoad?.stop();
        setTerminalLoadVisualState(cell, "displaced");
        showGridCellConflictOverlay(gs);
      } else if (action === "session-ended" || action === "pty-exited") {
        gs._slowLoad?.stop();
        if (gs.controller?.term) gs.controller.term.options.disableStdin = true;
        setTerminalLoadVisualState(cell, "ended");
      } else {
        gs.controller.scheduleReconnect();
      }
    },
    onReconnecting: () => {
      setTerminalLoadVisualState(cell, "reconnecting");
      gs._slowLoad?.start("reconnecting grid cell");
    },
    onReconnectExhausted: () => {
      gs._slowLoad?.stop();
      setTerminalLoadVisualState(cell, "failed");
    },
    onRouteUnavailable: () => {
      gs._slowLoad?.stop();
      if (gs.controller?.term) gs.controller.term.options.disableStdin = true;
      setTerminalLoadVisualState(cell, "failed");
    },
    onHydrationStart: () => {
      setTerminalLoadVisualState(cell, "hydrating");
      gs._slowLoad?.start("hydrating grid cell");
    },
    onHydrated: () => {
      gs._slowLoad?.stop();
      setTerminalLoadVisualState(cell, "live");
    },
  });
  gs.controller = controller;
  delete gs._resetPty;
  try {
    await controller.mount(cell, {});
  } catch (error) {
    clearPendingGridMount(gs, cell);
    if (gs.controller === controller) gs.controller = null;
    controller.dispose();
    throw error;
  }
  if (!ownsGridMount(gs, cell) || gs.controller !== controller) {
    clearPendingGridMount(gs, cell);
    controller.dispose();
    if (gs.controller === controller) gs.controller = null;
    return;
  }
  clearPendingGridMount(gs, cell);
  gs._needsConnect = true;
}

function renderGridSessionCells(
  sessions: GridSession[],
  container: HTMLElement,
  focusIndex: number,
  updateLayout: () => void,
  forceRelayout: boolean,
): void {
  // Each controller observes its own cell. Grid topology changes below use
  // one rAF relayout request; do not add a competing window-resize fan-out.
  const existingCells = container.querySelectorAll(".grid-cell");
  const existingCellSessions: GridSession[] = [];
  let topologyChanged = false;
  sessions.forEach((gs, idx) => {
    if (gs._cellElement && gs._cellElement.parentNode === container && (
      !!gs.controller || pendingGridMountCells.get(gs) === gs._cellElement || gs._gridIsolationFailed
    )) {
      gs._cellElement.dataset.gridIndex = String(idx);
      gs._cellElement.classList.toggle("grid-focused", idx === focusIndex);
      const wasCollapsed = gs._cellElement.classList.contains("collapsed");
      gs._cellElement.classList.toggle("collapsed", !!gs._collapsed);
      if (wasCollapsed !== !!gs._collapsed) topologyChanged = true;
      if (gs._collapsed) {
        clearPendingGridMount(gs, gs._cellElement);
        clearGridCellTakeControlTimer(gs);
        gs._slowLoad?.stop();
        gs.controller?.dispose();
        gs.controller = null;
        gs._loading = false;
      }
      const statusBadge = gs._cellElement.querySelector<HTMLElement>(".triage-badge");
      if (statusBadge) {
        statusBadge.className = `triage-badge ${gs._statusClass || "idle"}`;
        statusBadge.textContent = gs._statusLabel || "idle";
      }
      const collapseButton = gs._cellElement.querySelector<HTMLButtonElement>(".delegation-cell-collapse");
      if (collapseButton) {
        collapseButton.textContent = gs._collapsed ? "expand" : "collapse";
        collapseButton.setAttribute("aria-label", `${gs._collapsed ? "Expand" : "Collapse"} ${gs.session}`);
      }
      existingCellSessions.push(gs);
    } else {
      topologyChanged = true;
      gs._loading = !gs._collapsed;
      const cell = createGridCell(gs, idx);
      container.appendChild(cell);
      if (gs._collapsed) {
        gs._slowLoad?.stop();
        return;
      }
      pendingGridMountCells.set(gs, cell);
      void mountGridController(gs, cell, idx).then(() => {
        if (!sessionsForGridSession(gs).includes(gs)) return;
        if (gs._cellElement !== cell || cell.parentNode !== container) return;
        if (gs._needsConnect && gs.controller) {
          delete gs._needsConnect;
          gs.controller.connect();
        }
        setGridCellLoading(gs, false);
      }).catch(err => {
        if (!sessionsForGridSession(gs).includes(gs)) return;
        if (gs._cellElement !== cell || cell.parentNode !== container) return;
        setGridCellLoading(gs, false);
        gs._slowLoad?.stop();
        setTerminalLoadVisualState(cell, "failed");
        console.error("[grid] mount failed:", err);
      });
    }
  });
  const activeCellElements = new Set(sessions.map(gs => gs._cellElement));
  existingCells.forEach(cell => {
    if (!activeCellElements.has(cell as HTMLElement)) {
      topologyChanged = true;
      cell.remove();
    }
  });
  const orderedCells = sessions
    .map(gs => gs._cellElement)
    .filter((cell): cell is HTMLElement => !!cell && cell.parentNode === container);
  const needsReorder = orderedCells.some((cell, index) => container.children[index] !== cell);
  if (needsReorder) {
    topologyChanged = true;
    for (const cell of orderedCells) container.appendChild(cell);
  }
  updateLayout();
  if (forceRelayout || topologyChanged) {
    scheduleGridRelayoutFit(
      existingCellSessions.filter(session => !session._collapsed),
      topologyChanged,
      container.id,
      sessions.filter(session => !session._collapsed),
    );
  }
}

export function renderGridCells(): void {
  const container = document.getElementById("desktop-grid-container");
  if (!container) return;
  renderGridSessionCells(state.gridSessions, container, state.gridFocusIndex, updateGridLayout, true);
}

function renderDelegationCollapsedStrip(): void {
  const strip = document.getElementById("delegation-collapsed-strip");
  if (!strip) return;
  const collapsedSessions = state.delegationGridSessions.filter(session => session._collapsed);
  strip.classList.toggle("visible", collapsedSessions.length > 0);
  strip.innerHTML = collapsedSessions.map(session => `
    <button type="button" class="delegation-collapsed-tab" data-session="${escAttr(session.session)}" aria-label="Expand ${escAttr(session.session)}">
      <span class="delegation-collapsed-name">${esc(session.session)}</span>
      <span class="triage-badge ${esc(session._statusClass || "idle")}">${esc(session._statusLabel || "idle")}</span>
    </button>
  `).join("");
  strip.querySelectorAll<HTMLButtonElement>(".delegation-collapsed-tab").forEach(button => {
    button.addEventListener("click", () => {
      const name = button.dataset.session || "";
      const session = state.delegationGridSessions.find(entry => entry.session === name);
      if (!session) return;
      session._collapsed = false;
      renderDelegationGridCells();
      deps.renderSidebar();
    });
  });
}

export function renderDelegationGridCells(): void {
  const container = document.getElementById("delegation-grid-container");
  if (!container) return;
  renderGridSessionCells(state.delegationGridSessions, container, state.delegationGridFocusIndex, () => {
    const visibleCount = state.delegationGridSessions.filter(session => !session._collapsed).length;
    container.className = visibleCount > 0 ? `active ${gridLayoutClass(visibleCount)}` : "";
    renderDelegationCollapsedStrip();
  }, false);
}

function gridSessionKey(session: string, machine: string): string {
  return `${machine}|${session}`;
}

export function setDelegationGridMembers(members: readonly DelegationGridMember[]): void {
  const previous = new Map(
    state.delegationGridSessions.map(gs => [gridSessionKey(gs.session, gs.machine || ""), gs]),
  );
  const next = members.map(member => {
    const key = gridSessionKey(member.session, member.machine || "");
    const existing = previous.get(key);
    previous.delete(key);
    const gridSession = existing || {
      session: member.session,
      machine: member.machine || "",
      controller: null,
      _delegation: true,
      _collapsed: false,
    };
    gridSession._delegation = true;
    gridSession._delegationRole = member.role;
    gridSession._statusClass = member.statusClass;
    gridSession._statusLabel = member.statusLabel;
    gridSession._idle = member.idle;
    return gridSession;
  });

  for (const removed of previous.values()) {
    clearGridCellTakeControlTimer(removed);
    removed._slowLoad?.stop();
    removed.controller?.dispose();
    removed._cellElement?.remove();
    removed._cellElement = null;
  }
  state.delegationGridSessions = next;
  state.delegationGridFocusIndex = Math.max(0, Math.min(state.delegationGridFocusIndex, next.length - 1));
}

export function suspendDelegationGridTerminals(): void {
  for (const session of state.delegationGridSessions) {
    clearGridCellTakeControlTimer(session);
    session._slowLoad?.stop();
    session.controller?.dispose();
    session.controller = null;
    session._cellElement?.remove();
    session._cellElement = null;
    session._loading = false;
  }
  const container = document.getElementById("delegation-grid-container");
  if (container) container.innerHTML = "";
}

export function disposeDelegationGrid(): void {
  suspendDelegationGridTerminals();
  state.delegationGridSessions = [];
  state.delegationGridFocusIndex = 0;
  const container = document.getElementById("delegation-grid-container");
  if (container) container.className = "";
  const strip = document.getElementById("delegation-collapsed-strip");
  if (strip) {
    strip.classList.remove("visible");
    strip.innerHTML = "";
  }
}

export function getGridCellElement(gs: GridSession): HTMLElement | null {
  if (gs._cellElement) return gs._cellElement;
  const sessions = sessionsForGridSession(gs);
  const idx = sessions.indexOf(gs);
  if (idx < 0) return null;
  return gridContainerForSession(gs)?.querySelector<HTMLElement>('.grid-cell[data-grid-index="' + idx + '"]') ?? null;
}

/** Reclaim control of a single grid cell. */
function takeControlOfCell(gs) {
  if (!gs.controller) return;
  if (gs.controller.isConnected) {
    // Socket still open (viewer_conflict path) — send take_control directly
    gs.controller.sendTakeControl();
    // Safety net: if control_granted stalls, retry through an authoritative
    // takeover attach. Single-terminal mode uses the same coordinator.
    if (gs._takeControlTimer) clearTimeout(gs._takeControlTimer);
    gs._takeControlTimer = scheduleTakeControlFallback({
      getTransport: () => gs.controller ?? null,
      isPending: () => {
        const cell = getGridCellElement(gs);
        return !!cell?.querySelector(".viewer-conflict-overlay");
      },
      prepareRetry: () => {
        gs._takeControlTimer = null;
        gs._autoTakeControl = true;
      },
    });
  } else {
    // Socket closed (displaced) — reconnect with takeControl flag in attach.
    // Server sees takeControl=true and does immediate takeover, no extra
    // viewer_conflict → take_control round trip needed.
    // Set autoTakeControl so the viewer_conflict callback (which still fires
    // before control_granted) doesn't flash the conflict overlay.
    gs._autoTakeControl = true;
    gs.controller.connect({ takeControl: true });
  }
}

function clearGridCellTakeControlTimer(gs) {
  if (gs._takeControlTimer) { clearTimeout(gs._takeControlTimer); gs._takeControlTimer = null; }
}

function removeGridCellConflictOverlay(gs) {
  clearGridCellTakeControlTimer(gs);
  const cell = getGridCellElement(gs);
  if (!cell) return;
  cell.querySelectorAll(".viewer-conflict-overlay").forEach(el => el.remove());
}

function showGridCellConflictOverlay(gs) {
  const cell = getGridCellElement(gs);
  if (!cell) return;
  // Force hydration complete so overlay is visible (cell may be opacity:0)
  if (gs.controller && gs.controller.hydration) gs.controller.hydration.forceFinish();
  removeGridCellConflictOverlay(gs);
  const overlay = deps.createConflictOverlay("Active on another device", "Take Control", (e) => {
    e.stopPropagation();
    takeControlOfCell(gs);
  });
  overlay.dataset.conflictType = "conflict";
  cell.appendChild(overlay);
}

export function hasPreservedGrid() {
  return state.preservedGridSessions.length >= 2;
}

export function clearPreservedGrid() {
  state.preservedGridSessions = [];
  state.preservedGridFocusIndex = 0;
}

export function retirePreservedGridSessionsForMachine(machine: string): boolean {
  const previous = state.preservedGridSessions;
  if (!previous.some(session => session.machine === machine)) return false;
  const focused = previous[state.preservedGridFocusIndex];
  const remaining = previous.filter(session => session.machine !== machine);
  if (remaining.length <= 1) {
    clearPreservedGrid();
    return true;
  }
  state.preservedGridSessions = remaining;
  state.preservedGridFocusIndex = focused && remaining.includes(focused)
    ? remaining.indexOf(focused)
    : Math.min(state.preservedGridFocusIndex, remaining.length - 1);
  return true;
}

export type GridRetirementResult = "unaffected" | "grid" | "single" | "empty";

export function retireGridSessionsForMachine(machine: string): GridRetirementResult {
  const previous = state.gridSessions;
  if (!previous.some(session => session.machine === machine)) return "unaffected";
  const focused = previous[state.gridFocusIndex];
  const remaining = previous.filter(session => session.machine !== machine);
  for (const session of previous) {
    if (session.machine !== machine) continue;
    clearGridCellTakeControlTimer(session);
    session._slowLoad?.stop();
    session.controller?.dispose();
    session.controller = null;
    session._cellElement?.remove();
    session._cellElement = null;
  }
  state.gridSessions = remaining;
  state.gridFocusIndex = focused && remaining.includes(focused)
    ? remaining.indexOf(focused)
    : Math.min(state.gridFocusIndex, Math.max(0, remaining.length - 1));
  if (remaining.length >= 2) {
    renderGridCells();
    setGridFocus(state.gridFocusIndex);
    return "grid";
  }
  if (remaining.length === 1) {
    // Keep the mounted controller/socket authoritative rather than remounting
    // it as a single terminal during peer retirement. This marker makes the
    // exceptional live one-cell grid participate in the normal grid lifecycle.
    remaining[0]._retainedSingle = true;
    renderGridCells();
    setGridFocus(state.gridFocusIndex);
    return "grid";
  }
  updateGridLayout();
  return "empty";
}

export function setCurrentSessionFromGridFocus(sessions, focusIndex) {
  if (!sessions.length) return;
  const idx = Math.max(0, Math.min(focusIndex, sessions.length - 1));
  const focused = sessions[idx];
  if (!focused) return;
  setState({ currentSession: focused.session, currentMachine: focused.machine || "" });
}

export function returnToTerminalView() {
  deps.showView("terminal");
  if (restorePreservedGrid()) return true;
  if (!state.currentSession) return false;
  if (!state.terminalController) deps.initTerminal();
  return true;
}

function applyGridFocus(
  sessions: GridSession[],
  idx: number,
  containerSelector: string,
  setFocusIndex: (index: number) => void,
): void {
  if (idx < 0 || idx >= sessions.length) return;
  setFocusIndex(idx);
  sessions.forEach((gs, index) => {
    if (!gs.controller?.term) return;
    const focused = index === idx;
    gs.controller.term.options.disableStdin = !focused;
    gs.controller.term.options.cursorBlink = focused;
  });
  document.querySelectorAll(`${containerSelector} .grid-cell`).forEach((cell, index) => {
    cell.classList.toggle("grid-focused", index === idx);
  });
  const focusedSession = sessions[idx];
  if (!focusedSession) return;
  setState({ currentSession: focusedSession.session, currentMachine: focusedSession.machine || "" });
  deps.renderSidebar();
  focusedSession.controller?.focus();
}

export function setGridFocus(idx: number): void {
  applyGridFocus(state.gridSessions, idx, "#desktop-grid-container", index => { state.gridFocusIndex = index; });
}

export function setDelegationGridFocus(idx: number): void {
  applyGridFocus(state.delegationGridSessions, idx, "#delegation-grid-container", index => {
    state.delegationGridFocusIndex = index;
  });
}

export function suspendGridMode() {
  const preserved = suspendGridState(state.gridSessions, state.gridFocusIndex);
  if (preserved.sessions.length >= 2) {
    state.preservedGridSessions = preserved.sessions;
    state.preservedGridFocusIndex = preserved.focusIndex;
  } else {
    clearPreservedGrid();
  }
  cancelGridRelayoutTransition();
  for (const gs of state.gridSessions) {
    clearGridCellTakeControlTimer(gs);
    if (gs.controller) gs.controller.dispose();
    if (gs._cellElement) { gs._cellElement.remove(); gs._cellElement = null; }
  }
  state.gridSessions = [];
  state.gridFocusIndex = 0;
  const container = document.getElementById("desktop-grid-container");
  container.className = "";
  container.style.display = "";
  container.innerHTML = "";
  const dtc = document.getElementById("desktop-terminal-container");
  dtc.style.display = "none";
  dtc.innerHTML = "";
  state.terminalController = null;
  if (preserved.focusedSession) {
    setState({
      currentSession: preserved.focusedSession.session,
      currentMachine: preserved.focusedSession.machine || "",
    });
  }
}

export function restorePreservedGrid() {
  if (!hasPreservedGrid()) return false;
  // Stale sessions (broker session exited while grid was suspended) are
  // handled gracefully: each cell's controller will receive
  // CLOSE_CODE_SESSION_UNAVAILABLE (4001) and transition to "session-ended"
  // state without crashing the grid.
  const restored = resumeGridState(state.preservedGridSessions, state.preservedGridFocusIndex);
  state.gridSessions = restored.sessions.map(gs => ({
    session: gs.session,
    machine: gs.machine || "",
    controller: null,
  }));
  state.gridFocusIndex = restored.focusIndex;
  clearPreservedGrid();
  setCurrentSessionFromGridFocus(state.gridSessions, state.gridFocusIndex);
  renderGridCells();
  deps.renderSidebar();
  return true;
}

export function backFromSettings() {
  if (state.viewBeforeSettings === "terminal") {
    if (returnToTerminalView()) return;
    deps.backToSessions();
    return;
  }
  if (state.viewBeforeSettings === "sessions") {
    deps.backToSessions();
    return;
  }
  deps.showView(state.viewBeforeSettings || "sessions");
}

export function addToGrid(session: string, machine?: string): void {
  if (state.activeDelegationRoot) deps.leaveDelegationWorkspace?.();
  const trace = __wfTraceStart(session, machine || "", { mode: "grid" });
  __wfTraceEvent(trace, "addToGrid.start");
  if (!canOpenMultiTerminalGrid()) return;
  const targetMachine = machine || "";
  if (state.currentView !== "terminal" && hasPreservedGrid()) {
    const result = addToGridState(
      state.preservedGridSessions,
      session,
      targetMachine,
      state.currentSession || "",
      state.currentMachine || "",
    );
    if (!result) return;
    state.preservedGridSessions = result.sessions;
    state.preservedGridFocusIndex = result.focusIndex;
    setCurrentSessionFromGridFocus(state.preservedGridSessions, state.preservedGridFocusIndex);
    deps.showView("terminal", true);
    restorePreservedGrid();
    return;
  }
  if (state.gridSessions.length >= MAX_GRID_CELLS) return;
  // Must be on terminal view to build a grid — switch if needed
  if (state.currentView !== "terminal") {
    deps.showView("terminal", true);
  }
  // If sidebar is auto-expanded (hover), force it collapsed synchronously so
  // the grid sizes against the final layout. Without this, grid cells fit to
  // the expanded width and leave a gap on the right after the sidebar closes.
  if (state.sidebarAutoExpanded) {
    const sb = document.getElementById("desktop-sidebar");
    if (sb) {
      sb.style.transition = "none";
      sb.classList.add("collapsed");
      void sb.offsetHeight;
      sb.style.transition = "";
    }
    state.sidebarCollapsed = true;
    state.sidebarAutoExpanded = false;
  }
  // Already in grid?
  if (state.gridSessions.some(gs => gs.session === session && (gs.machine || "") === (machine || ""))) return;
  // Track which session had a full-width PTY (needs reset on grid connect)
  const singleTermSession = (state.terminalController?.term && state.currentSession) ? state.currentSession : null;
  const singleTermMachine = singleTermSession ? (state.currentMachine || "") : "";
  const gs = {
    session,
    machine: machine || "",
    controller: null,
  };
  state.gridSessions.push(gs);
  // If transitioning from single to grid, add current session too
  if (state.gridSessions.length === 1 && state.currentSession) {
    const alreadyAdded = session === state.currentSession && (machine || "") === state.currentMachine;
    if (!alreadyAdded) {
      state.gridSessions.unshift({
        session: state.currentSession,
        machine: state.currentMachine,
        controller: null,
      });
    }
  }
  // Mark sessions that had a full-width PTY for reset
  if (singleTermSession) {
    for (const g of state.gridSessions) {
      if (g.session === singleTermSession && (g.machine || "") === singleTermMachine) {
        g._resetPty = true;
      }
    }
  }
  if (isGridActive()) {
    // Destroy single-terminal mode
    deps.destroyTerminal();
    state.gridFocusIndex = state.gridSessions.length - 1;
    renderGridCells();
    deps.renderSidebar();
  } else {
    // Only 1 session queued — no current session to pair with.
    // Fall back to just opening it as a single terminal.
    state.gridSessions = [];
    deps.openSession(session, machine || undefined);
  }
}

export function removeFromGrid(idx) {
  if (idx < 0 || idx >= state.gridSessions.length) return;
  const gs = state.gridSessions[idx];
  // Cleanup controller before removing DOM (dispose needs container for removeEventListener)
  clearGridCellTakeControlTimer(gs);
  if (gs.controller) gs.controller.dispose();
  if (gs._cellElement) { gs._cellElement.remove(); gs._cellElement = null; }
  state.gridSessions.splice(idx, 1);
  // Adjust focus — shift left when a cell before the focused one is removed
  if (idx < state.gridFocusIndex) {
    state.gridFocusIndex--;
  } else if (state.gridFocusIndex >= state.gridSessions.length) {
    state.gridFocusIndex = Math.max(0, state.gridSessions.length - 1);
  }
  if (state.gridSessions.length <= 1) {
    // Exit grid mode → single terminal
    exitGridMode();
  } else {
    // Update layout and indices without full renderGridCells
    state.gridSessions.forEach((g, i) => {
      if (g._cellElement) {
        g._cellElement.dataset.gridIndex = i;
        g._cellElement.classList.toggle("grid-focused", i === state.gridFocusIndex);
      }
    });
    updateGridLayout();
    // Topology changes may not trigger an observer in every browser.
    scheduleGridRelayoutFit(state.gridSessions, true);
    setGridFocus(state.gridFocusIndex);
  }
  deps.renderSidebar();
}

// skipRestore: when true, preserves session identity state but does NOT call
// initTerminal(). Pass true when navigating AWAY from terminal view so
// the caller controls when the terminal is next initialized.
export function exitGridMode(skipRestore?) {
  cancelGridRelayoutTransition();
  // Determine which session to restore before destroying
  const remaining = state.gridSessions.length >= 1 ? state.gridSessions[0] : null;
  const restoreSession = remaining ? remaining.session : state.currentSession;
  const restoreMachine = remaining ? (remaining.machine || "") : state.currentMachine;
  // Destroy all grid sessions
  for (const gs of state.gridSessions) {
    clearGridCellTakeControlTimer(gs);
    if (gs._cellElement) { gs._cellElement.remove(); gs._cellElement = null; }
    if (gs.controller) gs.controller.dispose();
  }
  state.gridSessions = [];
  state.gridFocusIndex = 0;
  clearPreservedGrid();
  // Fully clean up grid container
  const container = document.getElementById("desktop-grid-container");
  container.className = "";
  container.style.display = "";
  container.innerHTML = "";
  // Ensure single-terminal container is reset
  const dtc = document.getElementById("desktop-terminal-container");
  dtc.style.display = "none";
  dtc.innerHTML = "";
  // Clear state.terminalController reference in case it's stale
  state.terminalController = null;
  // Preserve which session to restore when returning to terminal view
  if (restoreSession) {
    setState({ currentSession: restoreSession, currentMachine: restoreMachine });
  }
  // Restore single-terminal mode (skip when navigating away from terminal view)
  if (!skipRestore && restoreSession) {
    deps.initTerminal();
    deps.renderSidebar();
  }
}

function scheduleGridRelayoutFit(
  sessions: GridSession[] = state.gridSessions,
  hideUntilRepaint = false,
  containerId = "desktop-grid-container",
  activeSessions: GridSession[] = state.gridSessions,
  onSettled?: (acknowledged: boolean) => void,
): void {
  if (_gridRelayoutFitRaf != null) cancelAnimationFrame(_gridRelayoutFitRaf);
  if (_gridRelayoutRevealRaf != null) {
    cancelAnimationFrame(_gridRelayoutRevealRaf);
    _gridRelayoutRevealRaf = null;
  }
  const cells = sessions.filter(gs => !!gs.controller);
  if (hideUntilRepaint) {
    for (const gs of cells) {
      gs._cellElement?.classList.add("transitioning");
      _gridRelayoutHiddenSessions.add(gs);
    }
  }
  const transitionId = ++state.gridRelayoutTransitionId;
  _gridRelayoutFitRaf = requestAnimationFrame(() => {
    _gridRelayoutFitRaf = null;
    if (transitionId !== state.gridRelayoutTransitionId) return;
    if (activeSessions.length < 1) { onSettled?.(true); return; }
    const container = document.getElementById(containerId);
    if (container) void container.offsetWidth;
    const revealAfterRepaint = () => {
      if (transitionId !== state.gridRelayoutTransitionId) return;
      if (_gridRelayoutHiddenSessions.size === 0) { onSettled?.(true); return; }
      _gridRelayoutRevealRaf = requestAnimationFrame(() => {
        if (transitionId !== state.gridRelayoutTransitionId) return;
        for (const gs of _gridRelayoutHiddenSessions) {
          if (activeSessions.includes(gs) && gs.controller) {
            try { gs.controller.forceRepaint(); } catch (e) { console.warn("[grid] cell repaint failed:", e); }
          }
        }
        _gridRelayoutRevealRaf = requestAnimationFrame(() => {
          if (transitionId !== state.gridRelayoutTransitionId) return;
          _gridRelayoutRevealRaf = null;
          for (const gs of _gridRelayoutHiddenSessions) {
            gs._cellElement?.classList.remove("transitioning");
          }
          _gridRelayoutHiddenSessions.clear();
          onSettled?.(true);
        });
      });
    };
    const orderedSettlements: Promise<OrderedResizeSettlement>[] = [];
    for (const gs of cells) {
      if (!activeSessions.includes(gs) || !gs.controller) continue;
      const controller = gs.controller;
      const supportsOrderedResize = controller.supportsOrderedResize;
      try {
        const settlement = controller.resize();
        if (supportsOrderedResize) {
          orderedSettlements.push(Promise.resolve(settlement).then((outcome) => {
            return outcome === "acknowledged" || outcome === "cancelled" ? outcome : "cancelled";
          }, (error: unknown) => {
            console.warn("[grid] cell resize settlement failed:", error);
            return "cancelled" as const;
          }));
        }
      } catch (error: unknown) {
        console.warn("[grid] cell resize failed:", error);
        if (supportsOrderedResize) orderedSettlements.push(Promise.resolve("cancelled"));
      }
    }
    if (orderedSettlements.length === 0) {
      revealAfterRepaint();
      return;
    }
    void Promise.all(orderedSettlements).then((outcomes) => {
      if (transitionId !== state.gridRelayoutTransitionId) return;
      if (outcomes.some((outcome) => outcome === "cancelled")) {
        onSettled?.(false);
        return;
      }
      revealAfterRepaint();
    });
  });
}

/** Hide terminal canvases + show loading overlay (before sidebar CSS transition). */
export function hideGridCellsForTransition() {
  const activeSessions = state.activeDelegationRoot && !state.focusedDelegationSession
    ? state.delegationGridSessions
    : (isGridActive() ? state.gridSessions : null);
  if (activeSessions) {
    for (const gs of activeSessions) gs._cellElement?.classList.add("transitioning");
  } else {
    document.getElementById("desktop-terminal-container")?.classList.add("transitioning");
  }
}

/** Remove loading overlay + reveal canvases (no PTY resize). */
export function revealGridCellsWithoutResize() {
  const activeSessions = state.activeDelegationRoot && !state.focusedDelegationSession
    ? state.delegationGridSessions
    : (isGridActive() ? state.gridSessions : null);
  if (activeSessions) {
    for (const gs of activeSessions) gs._cellElement?.classList.remove("transitioning");
  } else {
    document.getElementById("desktop-terminal-container")?.classList.remove("transitioning");
  }
}

export function scheduleGridStabilizedFit(onSettled?: (acknowledged: boolean) => void) {
  if (state.activeDelegationRoot && !state.focusedDelegationSession) {
    scheduleGridRelayoutFit(
      state.delegationGridSessions,
      true,
      "delegation-grid-container",
      state.delegationGridSessions,
      onSettled,
    );
    return;
  }
  if (isGridActive()) scheduleGridRelayoutFit(state.gridSessions, true, "desktop-grid-container", state.gridSessions, onSettled);
  else onSettled?.(true);
}

function isSessionVisibleInDelegationGrid(session, machine): boolean {
  if (!state.activeDelegationRoot || state.focusedDelegationSession) return false;
  return state.delegationGridSessions.some(gs =>
    !gs._collapsed && gs.session === session && (gs.machine || "") === (machine || ""),
  );
}

export function isSessionInGrid(session, machine) {
  if (state.activeDelegationRoot) {
    return isSessionVisibleInDelegationGrid(session, machine);
  }
  const sessions = isGridActive() ? state.gridSessions : state.preservedGridSessions;
  return sessions.some(gs => gs.session === session && (gs.machine || "") === (machine || ""));
}

export function toggleGrid(session, machine, event) {
  if (event) { event.stopPropagation(); event.preventDefault(); }
  if (state.activeDelegationRoot && !state.focusedDelegationSession) {
    const match = state.delegationGridSessions.find(gs => gs.session === session && (gs.machine || "") === (machine || ""));
    if (match) {
      match._collapsed = !match._collapsed;
      renderDelegationGridCells();
      deps.renderSidebar();
      return;
    }
  }
  if (!isGridActive() && hasPreservedGrid() && state.currentView !== "terminal") {
    const idx = state.preservedGridSessions.findIndex(gs => gs.session === session && (gs.machine || "") === (machine || ""));
    if (idx !== -1) {
      const result = removeFromGridState(state.preservedGridSessions, idx, state.preservedGridFocusIndex);
      if (result.exitGrid) {
        state.preservedGridSessions = [];
        state.preservedGridFocusIndex = 0;
        if (result.restoreSession) {
          setState({
            currentSession: result.restoreSession.session,
            currentMachine: result.restoreSession.machine || "",
          });
        }
      } else {
        state.preservedGridSessions = result.sessions;
        state.preservedGridFocusIndex = result.focusIndex;
        setCurrentSessionFromGridFocus(state.preservedGridSessions, state.preservedGridFocusIndex);
      }
      deps.renderSidebar();
      return;
    }
  }
  if (isSessionInGrid(session, machine)) {
    const idx = state.gridSessions.findIndex(gs => gs.session === session && (gs.machine || "") === (machine || ""));
    if (idx !== -1) removeFromGrid(idx);
  } else {
    addToGrid(session, machine);
  }
}
