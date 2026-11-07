import { expect, test } from "bun:test";
import { rankFocus, linkedFocusSessions, doneToday, type FocusSession } from "../../src/focus-ranking.ts";
import { emptyFocus, reduceFocus } from "../../src/focus-contract.ts";
const now = "2026-11-06T12:00:00.000Z";
const doc = () => reduceFocus(emptyFocus(), [
  { type: "add", intention: { id: "a", title: "first", project: "/a", sessions: ["linked", "busy"] } },
  { type: "add", intention: { id: "b", title: "second", project: "/b", machine: "home" } },
  { type: "add", intention: { id: "c", title: "done" } }, { type: "done", id: "c" },
], now);
const session = (id: string, state: string, changedAt: string, cwd = "/a"): FocusSession => ({ id, name: id, state, changedAt, cwd, machine: "home" });
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
