import { expect, test } from "bun:test";
import { rankFocus, stoppedUnseen, linkedFocusSessions, doneToday, focusSessionLabel, focusActionVerb, type FocusSession } from "../../src/focus-ranking.ts";
import { emptyFocus, reduceFocus } from "../../src/focus-contract.ts";
const now = "2026-11-06T12:00:00.000Z";
const doc = () => reduceFocus(emptyFocus(), [
  { type: "add", intention: { id: "a", title: "first", project: "/a", sessions: ["linked", "busy"] } },
  { type: "add", intention: { id: "b", title: "second", project: "/b", machine: "home" } },
  { type: "add", intention: { id: "c", title: "done" } }, { type: "done", id: "c" },
], now);
const session = (id: string, state: string, changedAt: string, cwd = "/a"): FocusSession => ({ id, name: id, state, changedAt, cwd, machine: "home" });
test("next labels and verbs describe the session state, not stale input metadata", () => {
  for (const [inputKind, label, verb] of [["permission", "permission", "approve"], ["question", "question", "answer"], ["auth", "auth", "log in"], [undefined, "needs you", "open"]] as const) {
    const s = { ...session("broker-leak", "needs-input", now), inputKind };
    expect(focusSessionLabel(s)).toBe(label);
    expect(focusActionVerb({ kind: "open", session: s, reason: "" })).toBe(verb);
  }
  for (const [state, unseen, label, verb] of [["failed", true, "failed", "retry"], ["done", true, "stopped", "review"], ["idle", true, "stopped", "review"], ["done", false, "finished", "open"]] as const) {
    const s = { ...session("broker-leak", state, now), inputKind: "permission" as const, unseen, stoppedSequence: 2 };
    expect(focusSessionLabel(s)).toBe(label);
    expect(focusActionVerb({ kind: "open", session: s, reason: "" })).toBe(verb);
  }
  expect(focusActionVerb({ kind: "start", reason: "" })).toBe("start");
});
test("linked attention then starts then unlinked attention, oldest first; working omitted", () => {
  const sessions = [session("unlinked", "needs-input", "2026-01-01"), session("linked", "failed", "2026-11-01"), session("busy", "working", now)];
  expect(rankFocus(doc(), sessions, 5).map(row => [row.kind, row.session?.id ?? row.intention?.id])).toEqual([["open", "linked"], ["start", "b"], ["open", "unlinked"]]);
  expect(rankFocus(doc(), sessions, 1)).toHaveLength(1);
  expect(linkedFocusSessions(doc().intentions[0]!, sessions).map(s => s.id)).toEqual(["linked", "busy"]);
});
test("explicit links win over cwd; fallback cwd is machine scoped and needs input ties stable", () => {
  const sessions = [session("wrong", "needs-input", now, "/a"), session("b2", "needs-input", now, "/b"), session("b1", "needs-input", now, "/b")];
  expect(rankFocus(doc(), sessions, 10).map(r => r.session?.id ?? r.intention?.id)).toEqual(["b1", "b2", "a", "wrong"]);
  expect(linkedFocusSessions(doc().intentions[1]!, [{ ...sessions[1]!, machine: "other" }])).toEqual([]);
});
test("an explicitly empty sessions list wins over cwd fallback", () => {
  const intention = { ...doc().intentions[0]!, sessions: [] };
  expect(linkedFocusSessions(intention, [session("same-cwd", "working", now)])).toEqual([]);
});

test("idle sessions are live chips, not next actions or starts", () => {
  expect(rankFocus(doc(), [session("linked", "idle", now)], 5).map(r => r.intention?.id)).toEqual(["b"]);
});
test("a linked session that finished recently is a next action after attention and starts; older finishes are chips", () => {
  const nowMs = Date.parse(now);
  const sessions = [session("linked", "done", "2026-11-06T11:40:00.000Z"), session("busy", "working", now), session("unlinked", "needs-input", "2026-11-06T09:00:00.000Z")];
  expect(rankFocus(doc(), sessions, 5, nowMs).map(row => [row.kind, row.session?.id ?? row.intention?.id])).toEqual([["start", "b"], ["open", "linked"], ["open", "unlinked"]]);
  expect(rankFocus(doc(), sessions, 5, nowMs)[1]?.reason).toMatch(/finished/i);
  const stale = [session("linked", "done", "2026-11-04T11:40:00.000Z")];
  expect(rankFocus(doc(), stale, 5, nowMs).map(r => r.session?.id ?? r.intention?.id)).toEqual(["b"]);
});
test("stopped unseen excludes startup idle, seen work and busy/attention states", () => {
  expect(stoppedUnseen({ state: "done", unseen: true, stoppedSequence: 2 })).toBe(true);
  expect(stoppedUnseen({ state: "idle", unseen: true, stoppedSequence: 2 })).toBe(true);
  expect(stoppedUnseen({ state: "idle", unseen: true })).toBe(false);
  expect(stoppedUnseen({ state: "done", unseen: true })).toBe(false);
  for (const state of ["done", "idle"]) {
    expect(stoppedUnseen({ state, unseen: false, stoppedSequence: 2 })).toBe(false);
    expect(stoppedUnseen({ state, unseen: true, stoppedSequence: 2, acknowledgedSequence: 2 })).toBe(false);
  }
  for (const state of ["working", "output", "needs-input", "failed", "off", "unknown"]) expect(stoppedUnseen({ state, unseen: true, stoppedSequence: 2 })).toBe(false);
});
test("linked needs-you then stopped unseen then starts then unlinked needs-you then stopped, without an age window", () => {
  const focus = reduceFocus(doc(), [{ type: "edit", id: "a", patch: { sessions: ["linked", "busy", "stop1", "stop2"] } }], now);
  const stopped = (id: string, at: string, state = "done") => ({ ...session(id, state, at), unseen: true, stoppedSequence: 2 });
  const sessions = [stopped("stop2", "2020-01-02", "idle"), stopped("u-stop2", "2020-01-02"), session("linked", "failed", now), stopped("stop1", "2020-01-01"), session("u-needs", "needs-input", now), stopped("u-stop1", "2020-01-01")];
  expect(rankFocus(focus, sessions, 10, Date.parse(now)).map(r => r.session?.id ?? r.intention?.id)).toEqual(["linked", "stop1", "stop2", "b", "u-needs", "u-stop1", "u-stop2"]);
  expect(rankFocus(focus, sessions, 10, Date.parse(now))[1]?.reason).toMatch(/stopped.*not.*seen/i);
  expect(rankFocus(focus, sessions.map(s => ({ ...s, unseen: false })), 10, Date.parse(now)).map(r => r.session?.id ?? r.intention?.id)).toEqual(["linked", "b", "u-needs"]);
});
for (const state of ["needs-input", "failed"]) test(`done intentions do not claim ${state} sessions by project or explicit id`, () => {
  const focus = reduceFocus(emptyFocus(), [
    { type: "add", intention: { id: "project", title: "completed project", project: "/repo" } },
    { type: "add", intention: { id: "explicit", title: "completed explicit", sessions: ["s2"] } },
    { type: "done", id: "project" }, { type: "done", id: "explicit" },
  ], now);
  const sessions = [session("s1", state, now, "/repo"), session("s2", state, now, "/other"), session("s3", state, now, "/other")];
  const rows = rankFocus(focus, sessions, 5, Date.parse(now));
  expect(rows.map(row => row.session?.id)).toEqual(["s1", "s2", "s3"]);
  expect(rows.every(row => !row.intention && row.reason.startsWith("Unlinked session"))).toBe(true);
  const active = reduceFocus(focus, [{ type: "add", intention: { id: "active", title: "still active", sessions: ["s2"] } }], now);
  expect(rankFocus(active, sessions, 5, Date.parse(now)).map(row => [row.session?.id, row.intention?.id])).toEqual([["s2", "active"], ["s1", undefined], ["s3", undefined]]);
});
for (const state of ["done", "idle"]) test(`unseen ${state} under a done intention falls through to unlinked stops; seen finishes stay hidden`, () => {
  const focus = reduceFocus(emptyFocus(), [
    { type: "add", intention: { id: "project", title: "completed project", project: "/repo" } },
    { type: "add", intention: { id: "explicit", title: "completed explicit", sessions: ["explicit-stop"] } },
    { type: "done", id: "project" }, { type: "done", id: "explicit" },
  ], now);
  const sessions = [
    { ...session("project-stop", state, now, "/repo"), unseen: true, stoppedSequence: 2 },
    { ...session("explicit-stop", state, now, "/other"), unseen: true, stoppedSequence: 2 },
    { ...session("seen", "done", now, "/repo"), unseen: false, stoppedSequence: 2, acknowledgedSequence: 2 },
  ];
  const rows = rankFocus(focus, sessions, 5, Date.parse(now));
  expect(rows.map(row => row.session?.id)).toEqual(["explicit-stop", "project-stop"]);
  expect(rows.every(row => !row.intention && row.reason.startsWith("Stopped unlinked"))).toBe(true);
});
test("done today lists ticked intentions and finished linked sessions of the day, newest first", () => {
  const nowMs = Date.parse(now);
  const ticked = reduceFocus(doc(), [{ type: "done", id: "a" }], "2026-11-06T10:05:00.000Z");
  const sessions = [session("linked", "done", "2026-11-06T11:40:00.000Z"), session("busy", "working", now), session("old", "done", "2026-11-05T11:40:00.000Z")];
  const items = doneToday(ticked, sessions, nowMs, at => at.slice(0, 10));
  expect(items.map(i => [i.kind, i.kind === "intention" ? i.intention.id : i.session.id, i.at])).toEqual([
    ["intention", "c", now], ["session", "linked", "2026-11-06T11:40:00.000Z"], ["intention", "a", "2026-11-06T10:05:00.000Z"],
  ]);
  // an intention ticked before doneAt existed stays a done intention in the list, not a timeline entry
  const legacy = { ...ticked, intentions: ticked.intentions.map(i => { const { doneAt: _, ...rest } = i; return i.id === "c" ? rest : i; }) };
  expect(doneToday(legacy, sessions, nowMs, at => at.slice(0, 10)).some(i => i.kind === "intention" && i.intention.id === "c")).toBe(false);
});
