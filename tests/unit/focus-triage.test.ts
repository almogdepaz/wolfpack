import { expect, test } from "bun:test";
import { emptyFocus, reduceFocus, type FocusTriage } from "../../src/focus-contract";
import { mergeFocus, type FocusSession } from "../../src/focus-ranking";
const at = "2026-11-09T12:00:00.000Z";
const now = Date.parse(at);
const session = (id: string, state = "done", machineInstallationId = "home"): FocusSession => ({ id, name: id, state, machineInstallationId, stoppedAt: at, changedAt: at, unseen: true, stoppedSequence: 3 });
const triage = (id: string, verdict: FocusTriage["verdict"] = "needs-you", machine = "home"): FocusTriage => ({ ref: { machine, sessionId: id }, stoppedAt: at, verdict, reason: `Reason for ${id}`, ...(verdict === "suggest" ? { suggestion: "Continue the approved plan." } : {}) });
const doc = (rows: FocusTriage[]) => reduceFocus(emptyFocus(), [
  { type: "add", intention: { id: "goal", title: "Ship focus", sessions: ["a", "b", "c"] } },
  { type: "next", rows, author: "assistant" },
], at);
const options = { enabled: true, now, machineReachable: (id: string) => id === "home", machineKnown: (id: string) => ["home", "peer", "other"].includes(id) };
const ids = (result: ReturnType<typeof mergeFocus>) => result.rows.map(r => r.session?.id ?? r.intention?.id ?? (r.triage && "sessionId" in r.triage.ref ? r.triage.ref.sessionId : ""));

test("assistant order survives merge; unjudged needs-you above, other new rules below; cap after merge", () => {
  const focus = doc([triage("b", "suggest"), triage("a")]);
  const sessions = [session("a"), session("b"), session("c"), session("urgent", "needs-input")];
  const result = mergeFocus(focus, sessions, { ...options, cap: 10 });
  expect(ids(result)).toEqual(["urgent", "b", "a", "c"]);
  expect(result.rows.map(r => r.source)).toEqual(["new-rules", "assistant", "assistant", "new-rules"]);
  expect(result.rows[1]?.reason).toBe("Reason for b");
  expect(ids(mergeFocus(focus, sessions, { ...options, cap: 2 }))).toEqual(["urgent", "b"]);
  expect(focus.next?.rows.map(r => r.verdict)).toEqual(["suggest", "needs-you"]);
});
test("quiet suppresses only the judged machine/session/episode, never acknowledges; a new episode resurfaces", () => {
  const focus = doc([triage("a", "quiet")]);
  const a = session("a");
  const peer = session("a", "done", "other");
  expect(ids(mergeFocus(focus, [a, peer], { ...options, cap: 10 }))).toEqual(["a"]);
  expect(mergeFocus(focus, [a, peer], { ...options, cap: 10 }).rows[0]?.session?.machineInstallationId).toBe("other");
  expect(a.unseen).toBe(true); expect(a.stoppedSequence).toBe(3);
  expect(ids(mergeFocus(focus, [{ ...a, stoppedAt: "2026-11-09T12:01:00.000Z" }], options))).toEqual(["a"]);
  expect(mergeFocus(focus, [{ ...a, state: "working" }], options).rows).toEqual([]);
});
for (const state of ["needs-input", "failed"]) for (const reachable of [true, false]) test(`M1/R1: quiet cannot hide ${state}, including cached unavailable episodes (${reachable})`, () => {
  const a = session("a", state);
  const result = mergeFocus(doc([triage("a", "quiet")]), [a], { ...options, machineReachable: () => reachable });
  expect(ids(result)).toEqual(["a"]);
  expect(result.rows[0]).toMatchObject({ source: "new-rules", session: a });
  expect(result.rows[0]?.unavailable === true).toBe(!reachable);
  expect(a.unseen).toBe(true);
});
for (const verdict of ["quiet", "suggest"] as const) test(`R1: stale ${verdict} cannot replace a newer cached episode during an outage`, () => {
  const a = { ...session("a", "needs-input"), stoppedAt: "2026-11-09T12:01:00Z" };
  const result = mergeFocus(doc([triage("a", verdict)]), [a], { ...options, machineReachable: () => false });
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ session: a, source: "new-rules", unavailable: true });
  expect(result.rows[0]?.triage).toBeUndefined();
});

test("ttl boundary, off and stale return rules alone with an honest order status", () => {
  const focus = doc([triage("a", "quiet")]);
  const sessions = [session("a")];
  expect(mergeFocus(focus, sessions, { ...options, now: now + 4 * 3600_000 - 1 }).rows).toEqual([]);
  const expired = mergeFocus(focus, sessions, { ...options, now: now + 4 * 3600_000 });
  expect(ids(expired)).toEqual(["a"]); expect(expired.order).toBe("expired");
  expect(expired.rows[0]?.source).toBe("rules");
  expect(mergeFocus(focus, sessions, { ...options, now: now + 3600_000, ttlHours: 1 }).order).toBe("expired");
  for (const extra of [{ enabled: false }, { stale: true }]) {
    const result = mergeFocus(focus, sessions, { ...options, ...extra });
    expect(ids(result)).toEqual(["a"]); expect(result.order).toBe("rules");
  }
  expect(mergeFocus(emptyFocus(), [], options).order).toBe("rules");
});
test("unreachable peer refs are retained and disabled; reachable missing refs and old episodes drop", () => {
  const focus = doc([triage("gone"), triage("remote", "suggest", "peer"), triage("a")]);
  const result = mergeFocus(focus, [{ ...session("a"), stoppedAt: "2026-11-09T12:02:00.000Z" }], options);
  expect(ids(result)).toEqual(["remote", "a"]);
  expect(result.rows[0]).toMatchObject({ unavailable: true, source: "assistant", reason: "Reason for remote" });
  expect(result.rows[1]?.source).toBe("new-rules");
});
test("L3: unknown installation ids cannot consume a placeholder slot", () => {
  const result = mergeFocus(doc([triage("remote", "suggest", "fabricated")]), [], options);
  expect(result.rows.every(row => !row.triage)).toBe(true);
  expect(ids(result)).toEqual(["goal"]);
});

test("intention refs do not duplicate starts; completed/dropped intentions no longer appear", () => {
  const focus = doc([{ ref: { intentionId: "goal" }, verdict: "suggest", reason: "Looks finished — mark done?", doneIntention: "goal" }]);
  const result = mergeFocus(focus, [], options);
  expect(ids(result)).toEqual(["goal"]); expect(result.rows[0]?.source).toBe("assistant");
  expect(mergeFocus(reduceFocus(focus, [{ type: "done", id: "goal" }], at), [], options).rows).toEqual([]);
  expect(mergeFocus(reduceFocus(focus, [{ type: "drop", id: "goal" }], at), [], options).rows).toEqual([]);
});
test("QA-33: seen finishes disappear from next, but an explicit done suggestion can continue the intention", () => {
  const a = { ...session("a"), unseen: false, acknowledgedSequence: 3 };
  expect(mergeFocus(doc([]), [a], options).rows).toEqual([]);
  const row = { ...triage("a", "suggest"), doneIntention: "goal" };
  expect(ids(mergeFocus(doc([row]), [a], options))).toEqual(["a"]);
});
test("a completed done-only suggestion expires; any unseen stop returns to rules without the stale recommendation", () => {
  const focus = doc([{ ...triage("a", "suggest"), suggestion: undefined, doneIntention: "goal" }]);
  const completed = reduceFocus(focus, [{ type: "done", id: "goal" }], at);
  const result = mergeFocus(completed, [session("a")], options);
  expect(ids(result)).toEqual(["a"]);
  expect(result.rows[0]?.source).toBe("new-rules");
  expect(result.rows[0]?.triage).toBeUndefined();
});

test("an intention quiet verdict cannot suppress a session's unjudged input episode", () => {
  const focus = doc([{ ref: { intentionId: "goal" }, verdict: "quiet", reason: "No start needed" }]);
  expect(ids(mergeFocus(focus, [session("a", "needs-input")], options))).toEqual(["a"]);
});
