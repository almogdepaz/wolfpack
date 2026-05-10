import { describe, test, expect } from "bun:test";
import {
  MAX_GRID_CELLS,
  gridLayoutClass,
  isGridActive,
  addToGridState,
  removeFromGridState,
  suspendGridState,
  resumeGridState,
  gridTemplate,
  gridArrowNav,
  canAcceptInput,
  canSendResize,
  canAcceptInputDefault,
  computeInputGate,
  type GridSession,
  type InputGateState,
} from "../../src/grid-logic";

describe("gridLayoutClass", () => {
  test("returns grid-N for 2-6", () => {
    expect(gridLayoutClass(2)).toBe("grid-2");
    expect(gridLayoutClass(3)).toBe("grid-3");
    expect(gridLayoutClass(4)).toBe("grid-4");
    expect(gridLayoutClass(5)).toBe("grid-5");
    expect(gridLayoutClass(6)).toBe("grid-6");
  });

  test("falls back to grid-2 for out of range", () => {
    expect(gridLayoutClass(0)).toBe("grid-2");
    expect(gridLayoutClass(1)).toBe("grid-2");
    expect(gridLayoutClass(7)).toBe("grid-2");
  });
});

describe("isGridActive", () => {
  test("inactive with 0 or 1 sessions", () => {
    expect(isGridActive([])).toBe(false);
    expect(isGridActive([{ session: "a", machine: "" }])).toBe(false);
  });

  test("active with 2+ sessions", () => {
    expect(isGridActive([
      { session: "a", machine: "" },
      { session: "b", machine: "" },
    ])).toBe(true);
  });
});

describe("addToGridState", () => {
  test("adds session to empty grid — also adds current session", () => {
    const result = addToGridState([], "new-session", "", "current", "");
    expect(result).not.toBeNull();
    expect(result!.sessions).toHaveLength(2);
    expect(result!.sessions[0].session).toBe("current");
    expect(result!.sessions[1].session).toBe("new-session");
    expect(result!.focusIndex).toBe(1);
  });

  test("adds session to empty grid — same as current, no duplicate", () => {
    const result = addToGridState([], "current", "", "current", "");
    expect(result).not.toBeNull();
    expect(result!.sessions).toHaveLength(1);
    expect(result!.sessions[0].session).toBe("current");
  });

  test("adds session to existing grid", () => {
    const existing: GridSession[] = [
      { session: "a", machine: "" },
      { session: "b", machine: "" },
    ];
    const result = addToGridState(existing, "c", "", "a", "");
    expect(result).not.toBeNull();
    expect(result!.sessions).toHaveLength(3);
    expect(result!.focusIndex).toBe(2);
  });

  test("rejects duplicate session", () => {
    const existing: GridSession[] = [
      { session: "a", machine: "" },
      { session: "b", machine: "" },
    ];
    const result = addToGridState(existing, "a", "", "a", "");
    expect(result).toBeNull();
  });

  test("rejects when at max capacity", () => {
    const existing: GridSession[] = Array.from({ length: MAX_GRID_CELLS }, (_, i) => ({
      session: `s${i}`,
      machine: "",
    }));
    const result = addToGridState(existing, "overflow", "", "s0", "");
    expect(result).toBeNull();
  });

  test("distinguishes sessions by machine", () => {
    const existing: GridSession[] = [
      { session: "app", machine: "host-a" },
      { session: "app", machine: "host-b" },
    ];
    // Same session name, different machine — should be in grid
    expect(existing).toHaveLength(2);
    // Adding same session+machine — rejected
    const dup = addToGridState(existing, "app", "host-a", "app", "host-a");
    expect(dup).toBeNull();
    // Adding same session, new machine — accepted
    const ok = addToGridState(existing, "app", "host-c", "app", "host-a");
    expect(ok).not.toBeNull();
    expect(ok!.sessions).toHaveLength(3);
  });
});

describe("removeFromGridState", () => {
  const three: GridSession[] = [
    { session: "a", machine: "" },
    { session: "b", machine: "" },
    { session: "c", machine: "" },
  ];

  test("removes middle session, grid stays active", () => {
    const result = removeFromGridState(three, 1, 1);
    expect(result.exitGrid).toBe(false);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.map(s => s.session)).toEqual(["a", "c"]);
  });

  test("removes last session from 2-cell grid — exits grid", () => {
    const two: GridSession[] = [
      { session: "a", machine: "" },
      { session: "b", machine: "" },
    ];
    const result = removeFromGridState(two, 1, 1);
    expect(result.exitGrid).toBe(true);
    expect(result.restoreSession?.session).toBe("a");
    expect(result.sessions).toHaveLength(0);
  });

  test("focus adjusts when removing last cell", () => {
    const result = removeFromGridState(three, 2, 2);
    expect(result.focusIndex).toBe(1);
    expect(result.exitGrid).toBe(false);
  });

  test("focus shifts left when removing cell before focused one", () => {
    const result = removeFromGridState(three, 0, 2);
    // focus was 2, removed index 0, so focused session "c" is now at index 1
    expect(result.focusIndex).toBe(1);
    expect(result.sessions[1].session).toBe("c");
    expect(result.exitGrid).toBe(false);
  });

  test("focus stays when removing cell after focused one", () => {
    const result = removeFromGridState(three, 2, 0);
    // focus was 0, removed index 2 — focus should remain at 0
    expect(result.focusIndex).toBe(0);
    expect(result.sessions[0].session).toBe("a");
    expect(result.exitGrid).toBe(false);
  });

  test("4-cell grid: focus tracks correct session when earlier cell removed", () => {
    const four: GridSession[] = [
      { session: "a", machine: "" },
      { session: "b", machine: "" },
      { session: "c", machine: "" },
      { session: "d", machine: "" },
    ];
    // Focus on "d" (index 3), remove "b" (index 1)
    const result = removeFromGridState(four, 1, 3);
    expect(result.focusIndex).toBe(2);
    expect(result.sessions[2].session).toBe("d");
    expect(result.exitGrid).toBe(false);
  });

  test("invalid index returns unchanged", () => {
    const result = removeFromGridState(three, -1, 0);
    expect(result.sessions).toEqual(three);
    expect(result.exitGrid).toBe(false);
  });

  test("removing from 2 → exits grid with remaining session", () => {
    const two: GridSession[] = [
      { session: "x", machine: "m1" },
      { session: "y", machine: "m2" },
    ];
    const result = removeFromGridState(two, 0, 0);
    expect(result.exitGrid).toBe(true);
    expect(result.restoreSession).toEqual({ session: "y", machine: "m2" });
  });
});

describe("suspendGridState", () => {
  test("preserves the full grid working set and focused session", () => {
    const grid: GridSession[] = [
      { session: "a", machine: "" },
      { session: "b", machine: "host-b" },
      { session: "c", machine: "" },
    ];
    const result = suspendGridState(grid, 1);
    expect(result.sessions).toEqual(grid);
    expect(result.focusIndex).toBe(1);
    expect(result.focusedSession).toEqual({ session: "b", machine: "host-b" });
    expect(result.sessions).not.toBe(grid);
  });

  test("clamps out-of-range focus to the last session", () => {
    const result = suspendGridState([
      { session: "a", machine: "" },
      { session: "b", machine: "" },
    ], 99);
    expect(result.focusIndex).toBe(1);
    expect(result.focusedSession).toEqual({ session: "b", machine: "" });
  });
});

describe("resumeGridState", () => {
  test("restores preserved sessions with the same focus", () => {
    const preserved: GridSession[] = [
      { session: "a", machine: "" },
      { session: "b", machine: "" },
      { session: "c", machine: "host-c" },
    ];
    const result = resumeGridState(preserved, 2);
    expect(result.sessions).toEqual(preserved);
    expect(result.focusIndex).toBe(2);
    expect(result.focusedSession).toEqual({ session: "c", machine: "host-c" });
    expect(result.sessions).not.toBe(preserved);
  });

  test("keeps added sessions when resuming after an off-terminal update", () => {
    const suspended = suspendGridState([
      { session: "a", machine: "" },
      { session: "b", machine: "" },
    ], 1);
    const added = addToGridState(
      suspended.sessions,
      "c",
      "",
      suspended.focusedSession!.session,
      suspended.focusedSession!.machine,
    );
    expect(added).not.toBeNull();
    const resumed = resumeGridState(added!.sessions, added!.focusIndex);
    expect(resumed.sessions.map(s => s.session)).toEqual(["a", "b", "c"]);
    expect(resumed.focusIndex).toBe(2);
    expect(resumed.focusedSession?.session).toBe("c");
  });
});

describe("gridTemplate", () => {
  test("2 cells: side-by-side", () => {
    const t = gridTemplate(2);
    expect(t.columns).toBe("1fr 1fr");
    expect(t.rows).toBe("1fr");
  });

  test("4 cells: 2x2", () => {
    const t = gridTemplate(4);
    expect(t.columns).toBe("1fr 1fr");
    expect(t.rows).toBe("1fr 1fr");
  });

  test("6 cells: 3x2", () => {
    const t = gridTemplate(6);
    expect(t.columns).toBe("1fr 1fr 1fr");
    expect(t.rows).toBe("1fr 1fr");
  });
});

describe("gridArrowNav", () => {
  test("2 cells: left/right navigation", () => {
    expect(gridArrowNav("right", 0, 2)).toBe(1);
    expect(gridArrowNav("left", 1, 2)).toBe(0);
    // boundary: can't go past edges
    expect(gridArrowNav("left", 0, 2)).toBe(0);
    expect(gridArrowNav("right", 1, 2)).toBe(1);
  });

  test("2 cells: up/down does nothing (single row)", () => {
    expect(gridArrowNav("up", 0, 2)).toBe(0);
    expect(gridArrowNav("down", 0, 2)).toBe(0);
    expect(gridArrowNav("down", 1, 2)).toBe(1);
  });

  test("4 cells (2x2): full navigation", () => {
    // Layout: [0][1]
    //         [2][3]
    expect(gridArrowNav("right", 0, 4)).toBe(1);
    expect(gridArrowNav("down", 0, 4)).toBe(2);
    expect(gridArrowNav("down", 1, 4)).toBe(3);
    expect(gridArrowNav("up", 2, 4)).toBe(0);
    expect(gridArrowNav("up", 3, 4)).toBe(1);
    expect(gridArrowNav("left", 3, 4)).toBe(2);
  });

  test("6 cells (3x2): navigation", () => {
    // Layout: [0][1][2]
    //         [3][4][5]
    expect(gridArrowNav("right", 0, 6)).toBe(1);
    expect(gridArrowNav("right", 1, 6)).toBe(2);
    expect(gridArrowNav("down", 0, 6)).toBe(3);
    expect(gridArrowNav("up", 5, 6)).toBe(2);
    expect(gridArrowNav("left", 3, 6)).toBe(2);
  });

  test("single cell: no movement", () => {
    expect(gridArrowNav("left", 0, 1)).toBe(0);
    expect(gridArrowNav("right", 0, 1)).toBe(0);
  });

  test("3 cells (2+1 layout): nav wraps correctly", () => {
    // Layout: [0][1]
    //         [ 2  ] (spanning)
    // With cols=2: down from 0→2, down from 1→stays (index 3 OOB)
    expect(gridArrowNav("down", 0, 3)).toBe(2);
    expect(gridArrowNav("down", 1, 3)).toBe(1); // 1+2=3, OOB
    expect(gridArrowNav("up", 2, 3)).toBe(0);
  });
});

// ─── Input-Gating Logic ───────────────────────────────────────────

describe("canAcceptInput", () => {
  test("accepts when controller exists, connected, and focused", () => {
    expect(canAcceptInput({ hasController: true, isConnected: true, isFocused: true })).toBe(true);
  });

  test("rejects when no controller", () => {
    expect(canAcceptInput({ hasController: false, isConnected: true, isFocused: true })).toBe(false);
  });

  test("rejects when not connected", () => {
    expect(canAcceptInput({ hasController: true, isConnected: false, isFocused: true })).toBe(false);
  });

  test("rejects when not focused", () => {
    expect(canAcceptInput({ hasController: true, isConnected: true, isFocused: false })).toBe(false);
  });

  test("rejects when all false", () => {
    expect(canAcceptInput({ hasController: false, isConnected: false, isFocused: false })).toBe(false);
  });

  test("rejects when connected but no controller and not focused", () => {
    expect(canAcceptInput({ hasController: false, isConnected: true, isFocused: false })).toBe(false);
  });
});

describe("canSendResize", () => {
  test("allows when connected with controller, regardless of focus", () => {
    expect(canSendResize({ hasController: true, isConnected: true, isFocused: false })).toBe(true);
    expect(canSendResize({ hasController: true, isConnected: true, isFocused: true })).toBe(true);
  });

  test("rejects when not connected", () => {
    expect(canSendResize({ hasController: true, isConnected: false, isFocused: true })).toBe(false);
  });

  test("rejects when no controller", () => {
    expect(canSendResize({ hasController: false, isConnected: true, isFocused: true })).toBe(false);
  });
});

describe("canAcceptInputDefault (non-grid / single terminal)", () => {
  test("accepts when pty client exists and socket is open", () => {
    expect(canAcceptInputDefault(true, true)).toBe(true);
  });

  test("rejects when no pty client", () => {
    expect(canAcceptInputDefault(false, true)).toBe(false);
  });

  test("rejects when socket is closed", () => {
    expect(canAcceptInputDefault(true, false)).toBe(false);
  });

  test("rejects when both missing", () => {
    expect(canAcceptInputDefault(false, false)).toBe(false);
  });
});

describe("computeInputGate", () => {
  const sessions: GridSession[] = [
    { session: "a", machine: "" },
    { session: "b", machine: "" },
    { session: "c", machine: "" },
  ];

  test("focused cell gets isFocused=true", () => {
    const gate = computeInputGate(sessions, 1, 1, true);
    expect(gate).toEqual({ hasController: true, isConnected: true, isFocused: true });
  });

  test("unfocused cell gets isFocused=false", () => {
    const gate = computeInputGate(sessions, 0, 2, true);
    expect(gate).toEqual({ hasController: true, isConnected: true, isFocused: false });
  });

  test("disconnected cell", () => {
    const gate = computeInputGate(sessions, 1, 1, false);
    expect(gate).toEqual({ hasController: true, isConnected: false, isFocused: true });
  });

  test("out-of-bounds cellIndex is never focused", () => {
    const gate = computeInputGate(sessions, 0, 5, true);
    expect(gate.isFocused).toBe(false);
  });

  test("negative cellIndex is never focused", () => {
    const gate = computeInputGate(sessions, 0, -1, true);
    expect(gate.isFocused).toBe(false);
  });

  test("composes with canAcceptInput — focused + connected = accepts", () => {
    const gate = computeInputGate(sessions, 2, 2, true);
    expect(canAcceptInput(gate)).toBe(true);
  });

  test("composes with canAcceptInput — unfocused = rejects", () => {
    const gate = computeInputGate(sessions, 0, 2, true);
    expect(canAcceptInput(gate)).toBe(false);
  });

  test("composes with canSendResize — unfocused but connected = allows resize", () => {
    const gate = computeInputGate(sessions, 0, 2, true);
    expect(canSendResize(gate)).toBe(true);
  });

  test("composes with canSendResize — disconnected = rejects resize", () => {
    const gate = computeInputGate(sessions, 2, 2, false);
    expect(canSendResize(gate)).toBe(false);
  });
});

// ─── Focus Switching + Stdin Guard (multi-cell scenarios) ───────────

describe("focus switching: stdin guard across grid transitions", () => {
  test("exactly one cell accepts input at any time in a 4-cell grid", () => {
    const sessions: GridSession[] = [
      { session: "a", machine: "" },
      { session: "b", machine: "" },
      { session: "c", machine: "" },
      { session: "d", machine: "" },
    ];

    for (let focusIdx = 0; focusIdx < 4; focusIdx++) {
      const accepting = [];
      for (let cellIdx = 0; cellIdx < 4; cellIdx++) {
        const gate = computeInputGate(sessions, focusIdx, cellIdx, true);
        if (canAcceptInput(gate)) accepting.push(cellIdx);
      }
      expect(accepting).toEqual([focusIdx]);
    }
  });

  test("all cells can resize regardless of focus in a 6-cell grid", () => {
    const sessions: GridSession[] = Array.from({ length: 6 }, (_, i) => ({
      session: `s${i}`,
      machine: "",
    }));

    const focusIdx = 2;
    for (let cellIdx = 0; cellIdx < 6; cellIdx++) {
      const gate = computeInputGate(sessions, focusIdx, cellIdx, true);
      expect(canSendResize(gate)).toBe(true);
    }
  });

  test("disconnected cells block both input AND resize regardless of focus", () => {
    const sessions: GridSession[] = [
      { session: "a", machine: "" },
      { session: "b", machine: "" },
      { session: "c", machine: "" },
    ];

    // Cell 1 is focused but disconnected
    const gate = computeInputGate(sessions, 1, 1, false);
    expect(canAcceptInput(gate)).toBe(false);
    expect(canSendResize(gate)).toBe(false);
  });

  test("focus change: old cell loses input, new cell gains it", () => {
    const sessions: GridSession[] = [
      { session: "a", machine: "" },
      { session: "b", machine: "" },
    ];

    // Focus on cell 0
    const gate0_before = computeInputGate(sessions, 0, 0, true);
    const gate1_before = computeInputGate(sessions, 0, 1, true);
    expect(canAcceptInput(gate0_before)).toBe(true);
    expect(canAcceptInput(gate1_before)).toBe(false);

    // Focus switches to cell 1
    const gate0_after = computeInputGate(sessions, 1, 0, true);
    const gate1_after = computeInputGate(sessions, 1, 1, true);
    expect(canAcceptInput(gate0_after)).toBe(false);
    expect(canAcceptInput(gate1_after)).toBe(true);
  });

  test("after removing a cell, focus index is recomputed correctly", () => {
    const sessions: GridSession[] = [
      { session: "a", machine: "" },
      { session: "b", machine: "" },
      { session: "c", machine: "" },
    ];

    // Focus on "c" (index 2), remove "a" (index 0)
    const result = removeFromGridState(sessions, 0, 2);
    expect(result.exitGrid).toBe(false);
    expect(result.focusIndex).toBe(1); // "c" shifted to index 1

    // Verify "c" at new index 1 still accepts input
    const gate = computeInputGate(result.sessions, result.focusIndex, 1, true);
    expect(canAcceptInput(gate)).toBe(true);
    expect(result.sessions[1].session).toBe("c");

    // And "b" at index 0 does NOT accept input
    const gateB = computeInputGate(result.sessions, result.focusIndex, 0, true);
    expect(canAcceptInput(gateB)).toBe(false);
  });

  test("after adding a cell, new cell is focused and accepts input", () => {
    const sessions: GridSession[] = [
      { session: "a", machine: "" },
      { session: "b", machine: "" },
    ];

    const result = addToGridState(sessions, "c", "", "a", "");
    expect(result).not.toBeNull();
    expect(result!.focusIndex).toBe(2); // new cell focused

    // New cell accepts input
    const gateNew = computeInputGate(result!.sessions, result!.focusIndex, 2, true);
    expect(canAcceptInput(gateNew)).toBe(true);

    // Old cells don't
    const gateA = computeInputGate(result!.sessions, result!.focusIndex, 0, true);
    const gateB = computeInputGate(result!.sessions, result!.focusIndex, 1, true);
    expect(canAcceptInput(gateA)).toBe(false);
    expect(canAcceptInput(gateB)).toBe(false);
  });

  test("exit grid on remove: last remaining session has no grid gate", () => {
    const sessions: GridSession[] = [
      { session: "a", machine: "" },
      { session: "b", machine: "" },
    ];

    const result = removeFromGridState(sessions, 0, 0);
    expect(result.exitGrid).toBe(true);
    expect(result.restoreSession?.session).toBe("b");
    // After exit, single-terminal mode uses canAcceptInputDefault (no focus gating)
    expect(canAcceptInputDefault(true, true)).toBe(true);
  });
});

describe("gridArrowNav: focus switching across all grid sizes", () => {
  test("5 cells (3+2 layout): full navigation map", () => {
    // Layout: [0][1][2]
    //         [ 3 ][ 4 ]
    // cols=3 for 5-cell grid
    expect(gridArrowNav("right", 0, 5)).toBe(1);
    expect(gridArrowNav("right", 1, 5)).toBe(2);
    expect(gridArrowNav("right", 2, 5)).toBe(3);
    expect(gridArrowNav("down", 0, 5)).toBe(3);
    expect(gridArrowNav("down", 1, 5)).toBe(4);
    expect(gridArrowNav("down", 2, 5)).toBe(2); // 2+3=5, OOB
    expect(gridArrowNav("up", 3, 5)).toBe(0);
    expect(gridArrowNav("up", 4, 5)).toBe(1);
    expect(gridArrowNav("left", 4, 5)).toBe(3);
    // Boundary: can't go past edges
    expect(gridArrowNav("left", 0, 5)).toBe(0);
    expect(gridArrowNav("right", 4, 5)).toBe(4);
  });

  test("6 cells (3x2): complete boundary checks", () => {
    // Layout: [0][1][2]
    //         [3][4][5]
    // Top-left corner: can't go up or left
    expect(gridArrowNav("up", 0, 6)).toBe(0);
    expect(gridArrowNav("left", 0, 6)).toBe(0);
    // Bottom-right corner: can't go down or right
    expect(gridArrowNav("down", 5, 6)).toBe(5);
    expect(gridArrowNav("right", 5, 6)).toBe(5);
    // Full traversal right→down→left→up back to start
    let pos = 0;
    pos = gridArrowNav("right", pos, 6); expect(pos).toBe(1);
    pos = gridArrowNav("right", pos, 6); expect(pos).toBe(2);
    pos = gridArrowNav("down", pos, 6); expect(pos).toBe(5);
    pos = gridArrowNav("left", pos, 6); expect(pos).toBe(4);
    pos = gridArrowNav("left", pos, 6); expect(pos).toBe(3);
    pos = gridArrowNav("up", pos, 6); expect(pos).toBe(0);
  });
});
