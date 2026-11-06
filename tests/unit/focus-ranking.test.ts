import { expect, test } from "bun:test";
import { rankFocus, linkedFocusSessions, type FocusSession } from "../../src/focus-ranking.ts";
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
