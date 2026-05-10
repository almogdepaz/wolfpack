/**
 * Pure grid layout and state logic — extracted from index.html for testability.
 * The frontend uses inline versions of these; this module is the canonical source
 * for testing grid behavior without a browser DOM.
 */

export const MAX_GRID_CELLS = 6;

export interface GridSession {
  session: string;
  machine: string;
}

export function gridLayoutClass(count: number): string {
  if (count >= 2 && count <= 6) return "grid-" + count;
  return "grid-2";
}

export function isGridActive(sessions: GridSession[]): boolean {
  return sessions.length >= 2;
}

/**
 * Compute what happens when adding a session to the grid.
 * Returns the new grid state or null if the add is rejected.
 */
export function addToGridState(
  gridSessions: GridSession[],
  session: string,
  machine: string,
  currentSession: string,
  currentMachine: string,
): { sessions: GridSession[]; focusIndex: number } | null {
  if (gridSessions.length >= MAX_GRID_CELLS) return null;
  // Already in grid?
  if (gridSessions.some(gs => gs.session === session && gs.machine === machine)) return null;

  const newSessions = [...gridSessions, { session, machine }];

  // If transitioning from empty/single to grid, add current session too
  if (newSessions.length === 1 && currentSession) {
    const alreadyAdded = session === currentSession && machine === currentMachine;
    if (!alreadyAdded) {
      newSessions.unshift({ session: currentSession, machine: currentMachine });
    }
  }

  return {
    sessions: newSessions,
    focusIndex: newSessions.length - 1,
  };
}

/**
 * Compute what happens when removing a session from the grid.
 * Returns new state, or { exitGrid: true, restoreSession } if grid should be exited.
 */
export function removeFromGridState(
  gridSessions: GridSession[],
  idx: number,
  focusIndex: number,
): {
  sessions: GridSession[];
  focusIndex: number;
  exitGrid: boolean;
  restoreSession?: GridSession;
} {
  if (idx < 0 || idx >= gridSessions.length) {
    return { sessions: gridSessions, focusIndex, exitGrid: false };
  }

  const newSessions = [...gridSessions];
  newSessions.splice(idx, 1);

  let newFocus = focusIndex;
  if (idx < focusIndex) {
    newFocus--;
  } else if (newFocus >= newSessions.length) {
    newFocus = Math.max(0, newSessions.length - 1);
  }

  if (newSessions.length <= 1) {
    return {
      sessions: [],
      focusIndex: 0,
      exitGrid: true,
      restoreSession: newSessions.length === 1 ? newSessions[0] : undefined,
    };
  }

  return { sessions: newSessions, focusIndex: newFocus, exitGrid: false };
}

type ClonedGridState = {
  sessions: GridSession[];
  focusIndex: number;
  focusedSession?: GridSession;
};

function cloneGridState(sessions: GridSession[], focusIndex: number): ClonedGridState {
  const cloned = sessions.map(gs => ({ session: gs.session, machine: gs.machine }));
  if (!cloned.length) return { sessions: [], focusIndex: 0 };
  const clamped = Math.max(0, Math.min(focusIndex, cloned.length - 1));
  return { sessions: cloned, focusIndex: clamped, focusedSession: cloned[clamped] };
}

/**
 * Preserve the current grid working set while suspending live controllers.
 * Returns a cloned session list, clamped focus index, and the focused session.
 */
export function suspendGridState(
  gridSessions: GridSession[],
  focusIndex: number,
): ClonedGridState {
  return cloneGridState(gridSessions, focusIndex);
}

/**
 * Restore a suspended grid working set into an active grid state.
 * Returns cloned sessions plus a clamped focus index.
 */
export function resumeGridState(
  suspendedSessions: GridSession[],
  focusIndex: number,
): ClonedGridState {
  return cloneGridState(suspendedSessions, focusIndex);
}

/**
 * Compute the grid CSS template for a given cell count.
 * Returns { columns, rows } as CSS grid-template strings.
 */
export function gridTemplate(count: number): { columns: string; rows: string } {
  switch (count) {
    case 2: return { columns: "1fr 1fr", rows: "1fr" };
    case 3: return { columns: "1fr 1fr", rows: "1fr 1fr" };
    case 4: return { columns: "1fr 1fr", rows: "1fr 1fr" };
    case 5: return { columns: "repeat(6, 1fr)", rows: "1fr 1fr" };
    case 6: return { columns: "1fr 1fr 1fr", rows: "1fr 1fr" };
    default: return { columns: "1fr 1fr", rows: "1fr" };
  }
}

/**
 * Compute new focus index for arrow-key grid navigation.
 * Returns new index or current if move is invalid.
 */
export function gridArrowNav(
  direction: "left" | "right" | "up" | "down",
  currentIndex: number,
  cellCount: number,
): number {
  if (cellCount < 2) return currentIndex;

  // Determine columns per row based on layout
  let cols: number;
  switch (cellCount) {
    case 2: cols = 2; break;
    case 3: cols = 2; break; // 2 top + 1 bottom spanning
    case 4: cols = 2; break;
    case 5: cols = 3; break; // 3 top + 2 bottom
    case 6: cols = 3; break;
    default: cols = 2;
  }

  let newIndex = currentIndex;
  switch (direction) {
    case "left":
      newIndex = currentIndex - 1;
      break;
    case "right":
      newIndex = currentIndex + 1;
      break;
    case "up":
      newIndex = currentIndex - cols;
      break;
    case "down":
      newIndex = currentIndex + cols;
      break;
  }

  if (newIndex < 0 || newIndex >= cellCount) return currentIndex;
  return newIndex;
}

/**
 * Input-gating state for a grid cell.
 * Mirrors the checks used in the frontend's canAcceptInput/canSendResize lambdas.
 */
export interface InputGateState {
  hasController: boolean;
  isConnected: boolean;
  isFocused: boolean;
}

/**
 * Whether a grid cell should accept keyboard/paste input.
 * Requires: controller exists AND connected AND cell is focused.
 * Frontend equivalent: `!!(gs.controller && gs.controller.isConnected && gridSessions[gridFocusIndex] === gs)`
 */
export function canAcceptInput(state: InputGateState): boolean {
  return state.hasController && state.isConnected && state.isFocused;
}

/**
 * Whether a grid cell should send resize events.
 * Requires: controller exists AND connected (no focus requirement).
 * Frontend equivalent: `!!(gs.controller && gs.controller.isConnected)`
 */
export function canSendResize(state: InputGateState): boolean {
  return state.hasController && state.isConnected;
}

/**
 * Default input gate (non-grid / single terminal mode).
 * Only checks that PTY client exists and socket is open.
 */
export function canAcceptInputDefault(hasPtyClient: boolean, isOpen: boolean): boolean {
  return hasPtyClient && isOpen;
}

/**
 * Compute InputGateState for a grid cell given current grid state.
 */
export function computeInputGate(
  gridSessions: GridSession[],
  focusIndex: number,
  cellIndex: number,
  isConnected: boolean,
): InputGateState {
  return {
    hasController: true, // caller only invokes this if controller exists
    isConnected,
    isFocused: cellIndex >= 0 && cellIndex < gridSessions.length && focusIndex === cellIndex,
  };
}
