import { describe, test, expect } from "bun:test";
import {
  CLOSE_CODE_DISPLACED,
  CLOSE_CODE_SESSION_UNAVAILABLE,
  CLOSE_CODE_NORMAL,
  initialTakeControlState,
  handleViewerConflict,
  handleControlGranted,
  classifyDisconnect,
  handleTakeControlClick,
  handleDisplaced,
  prepareAutoTakeControl,
  type GridCellTakeControlState,
} from "../../src/take-control-logic";

// ── Close code constants ──

describe("close code constants", () => {
  test("displaced = 4002", () => expect(CLOSE_CODE_DISPLACED).toBe(4002));
  test("session unavailable = 4001", () => expect(CLOSE_CODE_SESSION_UNAVAILABLE).toBe(4001));
  test("normal = 1000", () => expect(CLOSE_CODE_NORMAL).toBe(1000));
});

// ── Initial state ──

describe("initialTakeControlState", () => {
  test("starts with displaced=false and autoTakeControl=false", () => {
    const s = initialTakeControlState();
    expect(s.displaced).toBe(false);
    expect(s.autoTakeControl).toBe(false);
  });
});

// ── handleViewerConflict ──

describe("handleViewerConflict", () => {
  test("shows overlay when autoTakeControl is false", () => {
    const s = initialTakeControlState();
    const result = handleViewerConflict(s);
    expect(result.action).toBe("show-overlay");
    expect(result.newState).toEqual(s);
    expect(result.newState).not.toBe(s); // must be a fresh copy, not the original ref
  });

  test("auto-takes control when autoTakeControl is true", () => {
    const s: GridCellTakeControlState = { displaced: true, autoTakeControl: true };
    const result = handleViewerConflict(s);
    expect(result.action).toBe("auto-take-control");
    expect(result.newState.autoTakeControl).toBe(false);
    // displaced unchanged by this handler
    expect(result.newState.displaced).toBe(true);
  });

  test("auto-take-control clears the flag (one-shot)", () => {
    let s: GridCellTakeControlState = { displaced: true, autoTakeControl: true };
    const r1 = handleViewerConflict(s);
    expect(r1.action).toBe("auto-take-control");
    s = r1.newState;

    // Second call should show overlay (flag was consumed)
    const r2 = handleViewerConflict(s);
    expect(r2.action).toBe("show-overlay");
  });
});

// ── handleControlGranted ──

describe("handleControlGranted", () => {
  test("clears displaced flag", () => {
    const s: GridCellTakeControlState = { displaced: true, autoTakeControl: false };
    const result = handleControlGranted(s);
    expect(result.displaced).toBe(false);
  });

  test("clears autoTakeControl flag", () => {
    const s: GridCellTakeControlState = { displaced: false, autoTakeControl: true };
    const result = handleControlGranted(s);
    expect(result.autoTakeControl).toBe(false);
  });

  test("both flags cleared from dirty state", () => {
    const s: GridCellTakeControlState = { displaced: true, autoTakeControl: true };
    const result = handleControlGranted(s);
    expect(result.displaced).toBe(false);
    expect(result.autoTakeControl).toBe(false);
  });

  test("no-op on clean state", () => {
    const s = initialTakeControlState();
    const result = handleControlGranted(s);
    expect(result.displaced).toBe(false);
    expect(result.autoTakeControl).toBe(false);
  });
});

// ── classifyDisconnect ──

describe("classifyDisconnect", () => {
  test("4002 → displaced", () => {
    expect(classifyDisconnect(4002, "displaced")).toBe("displaced");
    expect(classifyDisconnect(4002, "")).toBe("displaced");
    expect(classifyDisconnect(4002, "anything")).toBe("displaced");
  });

  test("4001 → session-ended", () => {
    expect(classifyDisconnect(4001, "session not found")).toBe("session-ended");
    expect(classifyDisconnect(4001, "")).toBe("session-ended");
  });

  test("1000 + terminal teardown reason → pty-exited", () => {
    expect(classifyDisconnect(1000, "pty exited")).toBe("pty-exited");
    expect(classifyDisconnect(1000, "pty teardown")).toBe("pty-exited");
  });

  test("1000 + other reason → reconnect", () => {
    expect(classifyDisconnect(1000, "normal")).toBe("reconnect");
    expect(classifyDisconnect(1000, "")).toBe("reconnect");
  });

  test("unknown codes → reconnect", () => {
    expect(classifyDisconnect(1006, "")).toBe("reconnect");
    expect(classifyDisconnect(1001, "going away")).toBe("reconnect");
    expect(classifyDisconnect(4003, "custom")).toBe("reconnect");
    expect(classifyDisconnect(0, "")).toBe("reconnect");
  });
});

// ── handleTakeControlClick ──

describe("handleTakeControlClick", () => {
  test("connected → send take_control immediately", () => {
    expect(handleTakeControlClick(true)).toBe("send-take-control");
  });

  test("disconnected → reconnect with auto-take-control", () => {
    expect(handleTakeControlClick(false)).toBe("reconnect-with-auto");
  });
});

// ── handleDisplaced ──

describe("handleDisplaced", () => {
  test("sets displaced flag", () => {
    const s = initialTakeControlState();
    const result = handleDisplaced(s);
    expect(result.displaced).toBe(true);
  });

  test("preserves autoTakeControl", () => {
    const s: GridCellTakeControlState = { displaced: false, autoTakeControl: true };
    const result = handleDisplaced(s);
    expect(result.displaced).toBe(true);
    expect(result.autoTakeControl).toBe(true);
  });
});

// ── prepareAutoTakeControl ──

describe("prepareAutoTakeControl", () => {
  test("sets autoTakeControl flag", () => {
    const s = initialTakeControlState();
    const result = prepareAutoTakeControl(s);
    expect(result.autoTakeControl).toBe(true);
  });

  test("preserves displaced flag", () => {
    const s: GridCellTakeControlState = { displaced: true, autoTakeControl: false };
    const result = prepareAutoTakeControl(s);
    expect(result.autoTakeControl).toBe(true);
    expect(result.displaced).toBe(true);
  });
});

// ── Full state machine sequences ──

describe("take-control state machine: full sequences", () => {
  test("normal flow: conflict → show overlay → click → send → granted", () => {
    let s = initialTakeControlState();

    // Viewer conflict arrives
    const r1 = handleViewerConflict(s);
    expect(r1.action).toBe("show-overlay");
    s = r1.newState;

    // User clicks Take Control (WS still connected)
    const action = handleTakeControlClick(true);
    expect(action).toBe("send-take-control");

    // control_granted arrives
    s = handleControlGranted(s);
    expect(s.displaced).toBe(false);
    expect(s.autoTakeControl).toBe(false);
  });

  test("displaced recovery: disconnect 4002 → click → reconnect → auto-take → granted", () => {
    let s = initialTakeControlState();

    // Disconnected with 4002
    const disconnectAction = classifyDisconnect(4002, "displaced");
    expect(disconnectAction).toBe("displaced");
    s = handleDisplaced(s);
    expect(s.displaced).toBe(true);

    // User clicks Take Control (WS closed)
    const clickAction = handleTakeControlClick(false);
    expect(clickAction).toBe("reconnect-with-auto");
    s = prepareAutoTakeControl(s);
    expect(s.autoTakeControl).toBe(true);

    // Reconnect happens → viewer_conflict fires → auto-take-control
    const r = handleViewerConflict(s);
    expect(r.action).toBe("auto-take-control");
    s = r.newState;
    expect(s.autoTakeControl).toBe(false);

    // control_granted
    s = handleControlGranted(s);
    expect(s.displaced).toBe(false);
  });

  test("double displacement: displaced → recover → displaced again → recover", () => {
    let s = initialTakeControlState();

    // First displacement
    s = handleDisplaced(s);
    const click1 = handleTakeControlClick(false);
    expect(click1).toBe("reconnect-with-auto");
    s = prepareAutoTakeControl(s);
    const r1 = handleViewerConflict(s);
    s = r1.newState;
    s = handleControlGranted(s);
    expect(s).toEqual({ displaced: false, autoTakeControl: false });

    // Second displacement
    s = handleDisplaced(s);
    expect(s.displaced).toBe(true);
    s = prepareAutoTakeControl(s);
    const r2 = handleViewerConflict(s);
    expect(r2.action).toBe("auto-take-control");
    s = r2.newState;
    s = handleControlGranted(s);
    expect(s).toEqual({ displaced: false, autoTakeControl: false });
  });

  test("session-ended doesn't trigger take-control flow", () => {
    const action = classifyDisconnect(4001, "session not found");
    expect(action).toBe("session-ended");
    // No state change — UI shows "session unavailable" and doesn't offer Take Control
  });

  test("normal disconnect triggers reconnect, not displacement", () => {
    const action = classifyDisconnect(1006, "");
    expect(action).toBe("reconnect");
    // Auto-reconnect, no conflict overlay
  });
});
