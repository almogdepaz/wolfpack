// ── Grid UI Functions ──
// Extracted from app.ts — imported back via bundler (inlined at build time)
// Uses dependency injection to avoid circular imports with app.ts

import {
  esc, escAttr, state, setState, wpSettings,
  TERM_PRESETS, GRID_TERMINAL_SCROLLBACK, isDesktop,
} from "./app-state";

// ── Dependency injection ──

interface GridDeps {
  showView: (name: string, skipAnimation?: boolean) => void;
  openSession: (name: string, machineUrl?: string) => void;
  destroyTerminal: () => void;
  initTerminal: (cached?: any) => void;
  backToSessions: () => void;
  renderSidebar: () => void;
  createPtyTerminalController: (opts: any) => any;
  createConflictOverlay: (message: string, buttonLabel: string, onClick: (e: any) => void) => HTMLElement;
  canUseWasmTerminal?: () => boolean;
  saveGridCellSnapshot?: (gs: any) => void;
  flushGridSnapshots?: () => void;
  loadSnapshot?: (machine: string, session: string) => string | null;
}

let deps: GridDeps;

export function initGridDeps(d: GridDeps) {
  deps = d;
}

// ── Relayout transition helpers ──

function setGridCellLoading(gs, loading) {
  gs._loading = loading;
  const cell = getGridCellElement(gs);
  if (cell) cell.classList.toggle("grid-loading", loading);
}

function beginGridRelayoutTransition() {
  state.gridRelayoutTransitionId += 1;
  const transitionId = state.gridRelayoutTransitionId;
  for (const gs of state.gridSessions) setGridCellLoading(gs, true);
  return transitionId;
}

function isGridRelayoutTransitionCurrent(transitionId) {
  return transitionId === state.gridRelayoutTransitionId;
}

function endGridRelayoutTransition(transitionId) {
  if (!isGridRelayoutTransitionCurrent(transitionId)) return;
  // Reveal on next paint — fit already rendered canvas content synchronously.
  requestAnimationFrame(() => {
    if (!isGridRelayoutTransitionCurrent(transitionId)) return;
    for (const gs of state.gridSessions) setGridCellLoading(gs, false);
  });
}

function cancelGridRelayoutTransition() {
  state.gridRelayoutTransitionId += 1;
}

/** Run a two-pass relayout while keeping loading overlay visible. */
function runGridRelayoutTransition(primaryFit) {
  if (!isGridActive()) return;
  const transitionId = beginGridRelayoutTransition();
  requestAnimationFrame(() => {
    if (!isGridRelayoutTransitionCurrent(transitionId) || !isGridActive()) return;
    try { primaryFit(); } catch (e) { console.warn("[grid] primaryFit failed:", e); }
    requestAnimationFrame(() => {
      if (!isGridRelayoutTransitionCurrent(transitionId) || !isGridActive()) return;
      fitAllGridCells();
      endGridRelayoutTransition(transitionId);
    });
  });
}

// ── Multi-terminal grid state ──
let _gridRenderGeneration = 0;
const MAX_GRID_CELLS = 6;

export function isGridActive() { return state.gridSessions.length >= 2; }

function gridLayoutClass(count) {
  if (count >= 2 && count <= 6) return "grid-" + count;
  return "grid-2";
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

function createGridCell(gs, idx) {
  const cell = document.createElement("div");
  cell.className = "grid-cell" + (idx === state.gridFocusIndex ? " grid-focused" : "") + (gs._loading ? " grid-loading" : "");
  cell.dataset.gridIndex = idx;
  cell.innerHTML = '<div class="grid-cell-header"><div class="grid-cell-label">' + esc(gs.session) + '</div><div class="grid-cell-close" title="Remove from grid">&times;</div></div><div class="grid-cell-loading">Loading terminal</div>';
  cell.addEventListener("click", (e) => {
    if (e.target.classList.contains("grid-cell-close")) return;
    const sel = window.getSelection ? window.getSelection() : null;
    if (sel && !sel.isCollapsed) return;
    const i = parseInt(cell.dataset.gridIndex, 10);
    setGridFocus(i);
  });
  cell.querySelector(".grid-cell-close").addEventListener("click", (e) => {
    e.stopPropagation();
    const i = parseInt(cell.dataset.gridIndex, 10);
    removeFromGrid(i);
  });
  gs._cellElement = cell;
  return cell;
}

async function mountGridController(gs, cell, idx) {
  if (gs.controller) return; // already mounted
  const cached = deps.loadSnapshot ? deps.loadSnapshot(gs.machine || "", gs.session) : null;
  if (cached) cell.classList.add("cached-visible");
  let _gridCachedPending = !!cached;
  const tp = TERM_PRESETS[wpSettings.termFontSize] || TERM_PRESETS.medium;
  gs.controller = deps.createPtyTerminalController({
    session: gs.session,
    machine: gs.machine || "",
    fontSize: Math.max(tp.fontSize - 2, 10),
    scrollback: GRID_TERMINAL_SCROLLBACK,
    cursorBlink: idx === state.gridFocusIndex,
    disableStdin: idx !== state.gridFocusIndex,
    resetPty: gs._resetPty,
    prefillMode: "none",
    shouldFocus: () => state.gridSessions[state.gridFocusIndex] === gs,
    shouldReconnect: () => state.gridSessions.includes(gs),
    canAcceptInput: () => !!(gs.controller && gs.controller.isConnected && state.gridSessions[state.gridFocusIndex] === gs),
    canSendResize: () => !!(gs.controller && gs.controller.isConnected),
    onOpen: () => {
      // Successful WS open means we have the session — clear any stale
      // conflict overlay. If the server sees a conflict, onViewerConflict
      // fires AFTER onOpen and re-shows the overlay.
      gs._displaced = false;
      removeGridCellConflictOverlay(gs);
    },
    onOutput: () => {
      if (_gridCachedPending) {
        _gridCachedPending = false;
        cell.classList.remove("cached-visible");
        cell.classList.add("hydrated");
      }
    },
    onViewerConflict: () => {

      var r = WP.handleViewerConflict({ displaced: gs._displaced, autoTakeControl: gs._autoTakeControl });
      gs._displaced = r.newState.displaced;
      gs._autoTakeControl = r.newState.autoTakeControl;
      if (r.action === "auto-take-control") {

        gs.controller.sendTakeControl();
      } else {
        showGridCellConflictOverlay(gs);
      }
    },
    onControlGranted: () => {
      var s = WP.handleControlGranted({ displaced: gs._displaced, autoTakeControl: gs._autoTakeControl });
      gs._displaced = s.displaced;
      gs._autoTakeControl = s.autoTakeControl;
      removeGridCellConflictOverlay(gs);
      if (state.gridSessions[state.gridFocusIndex] === gs) gs.controller.focus();
    },
    onDisconnected: (code, reason) => {
      removeGridCellConflictOverlay(gs);
      if (!state.gridSessions.includes(gs)) return;
      var action = WP.classifyDisconnect(code, reason || "");
      if (action === "displaced") {
        var ns = WP.handleDisplaced({ displaced: gs._displaced, autoTakeControl: gs._autoTakeControl });
        gs._displaced = ns.displaced;
        gs._autoTakeControl = ns.autoTakeControl;
        showGridCellConflictOverlay(gs);
      } else {
        gs.controller.scheduleReconnect();
      }
    },
  });
  delete gs._resetPty;
  await gs.controller.mount(cell, { cached });
  gs._needsConnect = true;
}

export function renderGridCells() {
  const container = document.getElementById("desktop-grid-container");
  // Install resize handler if not yet
  if (!state.gridResizeHandler) {
    state.gridResizeHandler = () => {
      if (!isGridActive()) return;
      for (const gs of state.gridSessions) {
        if (gs.controller) gs.controller.resizeWithTransition();
      }
    };
    window.addEventListener("resize", state.gridResizeHandler);
  }
  // Build set of current sessions for diffing
  const existingCells = container.querySelectorAll(".grid-cell");
  const existingMap = new Map();
  existingCells.forEach(cell => {
    const idx = parseInt(cell.dataset.gridIndex, 10);
    existingMap.set(idx, cell);
  });
  // Track which sessions need new cells vs reuse
  const newCellSessions = [];
  const mountPromises = [];
  state.gridSessions.forEach((gs, idx) => {
    if (gs._cellElement && gs._cellElement.parentNode === container && gs.controller) {
      // Existing cell — just update index and focus state
      gs._cellElement.dataset.gridIndex = idx;
      gs._cellElement.classList.toggle("grid-focused", idx === state.gridFocusIndex);
    } else {
      // New cell needed
      const cell = createGridCell(gs, idx);
      container.appendChild(cell);
      mountPromises.push(mountGridController(gs, cell, idx));
      newCellSessions.push(gs);
    }
  });
  // Remove orphaned cells (sessions removed from grid)
  const activeCellElements = new Set(state.gridSessions.map(gs => gs._cellElement));
  existingCells.forEach(cell => {
    if (!activeCellElements.has(cell)) cell.remove();
  });
  // Reorder DOM to match state.gridSessions order
  state.gridSessions.forEach(gs => {
    if (gs._cellElement && gs._cellElement.parentNode === container) {
      container.appendChild(gs._cellElement);
    }
  });
  updateGridLayout();
  // Add-flow relayout + connect in one transition to avoid visible flicker.
  // Wait for all mounts (WASM init gate) before connecting.
  // Capture render generation so stale Promise.all callbacks bail out
  // if renderGridCells is called again before mounts resolve.
  const renderGen = ++_gridRenderGeneration;
  if (newCellSessions.length > 0) {
    Promise.all(mountPromises).then(() => {
      if (_gridRenderGeneration !== renderGen) return; // stale render
      runGridRelayoutTransition(() => {
        fitAllGridCells();
        newCellSessions.forEach(gs => {
          if (gs._needsConnect) {
            delete gs._needsConnect;
            gs.controller.connect();
          }
        });
      });
    }).catch(err => console.error("[grid] mount failed:", err));
  } else {
    // No new cells — just refit existing (layout may have changed)
    requestAnimationFrame(() => { fitAllGridCells(); });
  }
}

export function getGridCellElement(gs) {
  if (gs._cellElement) return gs._cellElement;
  const idx = state.gridSessions.indexOf(gs);
  if (idx < 0) return null;
  return document.querySelector('#desktop-grid-container .grid-cell[data-grid-index="' + idx + '"]');
}

/** Reclaim control of a single grid cell. */
function takeControlOfCell(gs) {
  if (!gs.controller) return;
  if (gs.controller.isConnected) {
    // Socket still open (viewer_conflict path) — send take_control directly
    gs.controller.sendTakeControl();
    // Safety net: if control_granted doesn't arrive within 3s, force-reconnect
    if (gs._takeControlTimer) clearTimeout(gs._takeControlTimer);
    gs._takeControlTimer = setTimeout(() => {
      gs._takeControlTimer = null;
      if (!gs.controller) return;
      const cell = getGridCellElement(gs);
      if (!cell || !cell.querySelector(".viewer-conflict-overlay")) return;
      gs._autoTakeControl = true;
      if (gs.controller.isConnected) {
        gs.controller.reconnect({ takeControl: true });
      } else {
        gs.controller.connect({ takeControl: true });
      }
    }, 3000);
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

function removeGridCellConflictOverlay(gs) {
  if (gs._takeControlTimer) { clearTimeout(gs._takeControlTimer); gs._takeControlTimer = null; }
  const cell = getGridCellElement(gs);
  if (!cell) return;
  cell.querySelectorAll(".viewer-conflict-overlay").forEach(el => el.remove());
}

function showGridCellConflictOverlay(gs) {
  const cell = getGridCellElement(gs);
  if (!cell) return;
  // Force hydration complete so overlay is visible (cell may be opacity:0)
  if (gs.controller && gs.controller.hydration) gs.controller.hydration.finish();
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

export function setGridFocus(idx) {
  if (idx < 0 || idx >= state.gridSessions.length) return;
  const prev = state.gridFocusIndex;
  state.gridFocusIndex = idx;
  // Update terminal stdin/cursor for old + new focus
  state.gridSessions.forEach((gs, i) => {
    if (!gs.controller || !gs.controller.term) return;
    const focused = i === idx;
    gs.controller.term.options.disableStdin = !focused;
    gs.controller.term.options.cursorBlink = focused;
  });
  // Update cell border highlights
  const cells = document.querySelectorAll("#desktop-grid-container .grid-cell");
  cells.forEach((cell, i) => {
    cell.classList.toggle("grid-focused", i === idx);
  });
  // Sync sidebar highlights
  const focusedGs = state.gridSessions[idx];
  if (focusedGs) {
    setState({ currentSession: focusedGs.session, currentMachine: focusedGs.machine || "" });
    deps.renderSidebar();
    // Focus the terminal
    if (focusedGs.controller) focusedGs.controller.focus();
  }
}

export function suspendGridMode() {
  if (deps.flushGridSnapshots) deps.flushGridSnapshots();
  const preserved = WP.suspendGridState(state.gridSessions, state.gridFocusIndex);
  state.preservedGridSessions = preserved.sessions;
  state.preservedGridFocusIndex = preserved.focusIndex;
  cancelGridRelayoutTransition();
  if (state.gridResizeHandler) {
    window.removeEventListener("resize", state.gridResizeHandler);
    state.gridResizeHandler = null;
  }
  for (const gs of state.gridSessions) {
    if (gs._cellElement) { gs._cellElement.remove(); gs._cellElement = null; }
    if (gs.controller) gs.controller.dispose();
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
  // Stale sessions (tmux exited while grid was suspended) are handled gracefully:
  // each cell's controller will receive CLOSE_CODE_SESSION_UNAVAILABLE (4001)
  // and transition to "session-ended" state without crashing the grid.
  const restored = WP.resumeGridState(state.preservedGridSessions, state.preservedGridFocusIndex);
  state.gridSessions = restored.sessions.map(gs => ({
    session: gs.session,
    machine: gs.machine || "",
    controller: null,
  }));
  state.gridFocusIndex = restored.focusIndex;
  clearPreservedGrid();
  state.sidebarResizeDone = false;
  setCurrentSessionFromGridFocus(state.gridSessions, state.gridFocusIndex);
  renderGridCells();
  deps.renderSidebar();
  return true;
}

export function backFromRalph() {
  if (isDesktop() && hasPreservedGrid()) {
    returnToTerminalView();
    return;
  }
  deps.backToSessions();
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

export function addToGrid(session, machine) {
  if (!(deps.canUseWasmTerminal ? deps.canUseWasmTerminal() : isDesktop())) {
    console.warn("[grid] WebAssembly unavailable — cannot open grid terminal");
    return;
  }
  const targetMachine = machine || "";
  if (state.currentView !== "terminal" && hasPreservedGrid()) {
    const result = WP.addToGridState(
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
  state.sidebarResizeDone = false;
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
  state.sidebarResizeDone = false;
  const gs = state.gridSessions[idx];
  // Save snapshot before disposing
  if (deps.saveGridCellSnapshot) deps.saveGridCellSnapshot(gs);
  // Remove cell DOM immediately (avoids full rebuild flash)
  if (gs._cellElement) { gs._cellElement.remove(); gs._cellElement = null; }
  // Cleanup controller
  if (gs.controller) gs.controller.dispose();
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
    // Remove-flow relayout — per-cell transition hides canvas during refit.
    for (const gs of state.gridSessions) {
      if (gs.controller) gs.controller.resizeWithTransition();
    }
    setGridFocus(state.gridFocusIndex);
  }
  deps.renderSidebar();
}

// skipRestore: when true, preserves session identity state but does NOT call
// initTerminal(). Pass true when navigating AWAY from terminal view so
// the caller controls when the terminal is next initialized.
export function exitGridMode(skipRestore?) {
  cancelGridRelayoutTransition();
  // Remove grid resize handler
  if (state.gridResizeHandler) {
    window.removeEventListener("resize", state.gridResizeHandler);
    state.gridResizeHandler = null;
  }
  // Determine which session to restore before destroying
  const remaining = state.gridSessions.length >= 1 ? state.gridSessions[0] : null;
  const restoreSession = remaining ? remaining.session : state.currentSession;
  const restoreMachine = remaining ? (remaining.machine || "") : state.currentMachine;
  // Destroy all grid sessions
  for (const gs of state.gridSessions) {
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

export function fitAllGridCells() {
  for (const gs of state.gridSessions) {
    if (gs.controller) {
      try { gs.controller.resize(); } catch (e) { console.warn("[grid] cell resize failed:", e); }
    }
  }
}

/** Hide terminal canvases + show loading overlay (before sidebar CSS transition). */
export function hideGridCellsForTransition() {
  if (isGridActive()) {
    for (const gs of state.gridSessions) {
      const el = gs._cellElement;
      if (el) el.classList.add('transitioning');
    }
  } else {
    const el = document.getElementById("desktop-terminal-container");
    if (el) el.classList.add('transitioning');
  }
}

/** Remove loading overlay + reveal canvases (no PTY resize). */
export function revealGridCellsWithoutResize() {
  if (isGridActive()) {
    for (const gs of state.gridSessions) {
      const el = gs._cellElement;
      if (el) el.classList.remove('transitioning');
    }
  } else {
    const el = document.getElementById("desktop-terminal-container");
    if (el) el.classList.remove('transitioning');
  }
}

export function scheduleGridStabilizedFit() {
  if (!isGridActive()) return;
  for (const gs of state.gridSessions) {
    if (gs.controller) gs.controller.resizeWithTransition();
  }
}

export function isSessionInGrid(session, machine) {
  const sessions = isGridActive() ? state.gridSessions : state.preservedGridSessions;
  return sessions.some(gs => gs.session === session && (gs.machine || "") === (machine || ""));
}

export function toggleGrid(session, machine, event) {
  if (event) { event.stopPropagation(); event.preventDefault(); }
  if (!isGridActive() && hasPreservedGrid() && state.currentView !== "terminal") {
    const idx = state.preservedGridSessions.findIndex(gs => gs.session === session && (gs.machine || "") === (machine || ""));
    if (idx !== -1) {
      const result = WP.removeFromGridState(state.preservedGridSessions, idx, state.preservedGridFocusIndex);
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
