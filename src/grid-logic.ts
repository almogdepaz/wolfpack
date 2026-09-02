/**
 * Pure grid layout and state logic imported directly by the browser frontend
 * and unit tests.
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

const GRID_NAVIGATION_ROWS: Readonly<Record<number, readonly (readonly number[])[]>> = {
  2: [[0, 1]],
  3: [[0, 1], [2]],
  4: [[0, 1], [2, 3]],
  5: [[0, 1, 2], [3, 4]],
  6: [[0, 1, 2], [3, 4, 5]],
};

/** Follow the visual grid rows, wrapping vertically and clamping horizontally. */
export function gridArrowNav(
  direction: "left" | "right" | "up" | "down",
  currentIndex: number,
  cellCount: number,
): number {
  const rows = GRID_NAVIGATION_ROWS[cellCount];
  const rowIndex = rows?.findIndex(row => row.includes(currentIndex)) ?? -1;
  const currentRow = rows?.[rowIndex];
  if (!rows || !currentRow) return currentIndex;

  const columnIndex = currentRow.indexOf(currentIndex);
  if (direction === "left" || direction === "right") {
    const targetColumn = columnIndex + (direction === "left" ? -1 : 1);
    return currentRow[targetColumn] ?? currentIndex;
  }
  if (rows.length === 1) return currentIndex;

  const targetRowIndex = direction === "up"
    ? (rowIndex - 1 + rows.length) % rows.length
    : (rowIndex + 1) % rows.length;
  const targetRow = rows[targetRowIndex];
  if (!targetRow) return currentIndex;

  const currentCenter = (columnIndex + 0.5) / currentRow.length;
  let nearest = currentIndex;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [candidateColumn, candidate] of targetRow.entries()) {
    const distance = Math.abs((candidateColumn + 0.5) / targetRow.length - currentCenter);
    if (distance >= nearestDistance) continue;
    nearest = candidate;
    nearestDistance = distance;
  }
  return nearest;
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
