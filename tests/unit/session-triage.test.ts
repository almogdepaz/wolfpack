import { expect, test } from "bun:test";
import { projectDelegationSessions } from "../../public/delegation-sessions";
import { orderTriageSessionRows } from "../../public/session-triage";

function session(name: string, state: string, at?: string, parent?: string) {
  return {
    name, identity: { wolfpackSessionId: name, ...(parent ? { parentSession: { wolfpackSessionId: parent, wolfpackSessionName: parent } } : {}) },
    runtimeState: { state, authority: "manifest", source: "local-manifest", freshness: "fresh", stale: false, changedAt: at },
    activity: { lastRenderedActivityAt: at },
  };
}
const older = "2026-10-20T10:00:00Z";
const newer = "2026-10-20T11:00:00Z";
function order(sessions: ReturnType<typeof session>[], manual = sessions.map(s => s.name)) {
  return orderTriageSessionRows(projectDelegationSessions(sessions), manual.map(sessionId => ({ machineUrl: "", sessionId })), "").map(row => row.session.name);
}

test("need oldest first, fail, work latest output first, idle latest first; manual order breaks ties", () => {
  const sessions = [session("idle-old", "idle", older), session("work-old", "working", older), session("need-new", "needs-input", newer), session("fail", "failed"), session("idle-new", "done", newer), session("work-new", "working", newer), session("need-old", "needs-input", older), session("work-tie", "working", newer)];
  expect(order(sessions)).toEqual(["need-old", "need-new", "fail", "work-new", "work-tie", "work-old", "idle-new", "idle-old"]);
});
test("manual order wins only equal priority, including absent or invalid timestamps", () => {
  const sessions = [session("a", "working"), session("b", "working", "invalid"), session("c", "working")];
  expect(order(sessions, ["c", "a", "b"])).toEqual(["c", "a", "b"]);
});
test("waiting age uses runtime transition, not newer output or prompt text", () => {
  const a = { ...session("a", "needs-input", older), activity: { lastRenderedActivityAt: newer }, lastLine: "working" };
  const b = { ...session("b", "needs-input", newer), activity: { lastRenderedActivityAt: older }, lastLine: "failed" };
  expect(order([b, a])).toEqual(["a", "b"]);
});
test("delegation stays contiguous, with triage applied to roots and siblings", () => {
  const sessions = [session("root", "working"), session("child-idle", "idle", undefined, "root"), session("child-need", "needs-input", older, "root"), session("solo", "needs-input", newer)];
  expect(order(sessions)).toEqual(["solo", "root", "child-need", "child-idle"]);
});
test("work recency uses rendered activity rather than runtime state transition", () => {
  const a = { ...session("a", "working", newer), activity: { lastRenderedActivityAt: older } };
  const b = { ...session("b", "working", older), activity: { lastRenderedActivityAt: newer } };
  expect(order([a, b])).toEqual(["b", "a"]);
});
