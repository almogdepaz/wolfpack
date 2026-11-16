import { expect, test } from "bun:test";
import { buildFocusRetro } from "../../src/focus-retro";
import { formatFocusRetro } from "../../src/cli/focus-retro";
import { ACTIVITY_KIND as K, INPUT_SOURCE, type ActivityRow } from "../../src/activity-journal";
import { FOCUS_UI_ACTION as A, FOCUS_UI_CARD as C, type FocusUiRow } from "../../src/focus-ui-log";
const date = "2026-11-16", at = (seconds: number) => new Date(Date.parse(`${date}T12:00:00.000Z`) + seconds * 1000).toISOString();
const card = (id: string, rank = 1, machine = "home") => ({ session: id, sessionId: id, machine, rank, kind: "action" as const, reason: "rules" as const });
const stamp = (seq: number, seconds: number, visit = "v1") => ({ seq, at: at(seconds), visit });
const state = (sessionId: string, state: string, seconds: number, seq = seconds + 1): ActivityRow => ({ seq, at: at(seconds), kind: K.SESSION_STATE, session: sessionId, sessionId, state, label: "PRIVATE_LABEL" });
test("retro uses continuous impressions, resets on rank/set changes and visit leave, and reports ignored cards", () => {
  const ui: FocusUiRow[] = [
    { ...stamp(1, 0), action: A.OPEN }, { ...stamp(2, 1), action: A.SHOWN, cards: [card("a"), card("b", 2)] },
    { ...stamp(3, 3), action: A.CARD, control: C.EXPAND, ...cardIdentity("a") },
    { ...stamp(4, 4), action: A.SHOWN, cards: [card("a"), card("c", 2)] },
    { ...stamp(5, 6), action: A.CARD, control: C.REPLY, ...cardIdentity("a") },
    { ...stamp(6, 7), action: A.SHOWN, cards: [card("c"), card("a", 2)] },
    { ...stamp(7, 8), action: A.LEFT, visibleMs: 8000 },
    { ...stamp(8, 9), action: A.CARD, control: C.OPEN, ...cardIdentity("c") },
    { ...stamp(9, 10, "v2"), action: A.OPEN },
  ];
  const result = buildFocusRetro(date, ui, [], "home");
  expect(result.visits).toEqual([{ visit: "v1", openedAt: at(0), leftAt: at(8), visibleMs: 8000 }, { visit: "v2", openedAt: at(10), leftAt: null, visibleMs: null }]);
  expect(result.cards).toHaveLength(5);
  expect(result.cards[0]).toMatchObject({ sessionId: "a", firstAction: { control: C.EXPAND, latencyMs: 2000 } });
  expect(result.cards[1]!.firstAction).toBeNull();
  expect(result.cards.filter(c => c.sessionId === "c").every(c => c.firstAction === null)).toBe(true);
});
function cardIdentity(sessionId: string, machine = "home") { return { session: sessionId, sessionId, machine }; }
test("retro matches intention actions to the rendered card surface without confusing session IDs", () => {
  const ui: FocusUiRow[] = [
    { ...stamp(1, 0), action: A.OPEN },
    { ...stamp(2, 1), action: A.SHOWN, cards: [card("ship"), { intentionId: "ship", rank: 2, kind: "action", reason: "needs-you" }, { intentionId: "ship", surface: "today", rank: 3, kind: "action", reason: "rules" }] },
    { ...stamp(3, 3), action: A.CARD, intentionId: "ship", control: "review" },
    { ...stamp(4, 5), action: A.CARD, intentionId: "ship", surface: "today", control: C.DONE },
  ];
  const result = buildFocusRetro(date, ui, []);
  expect(result.cards.map(c => c.firstAction?.control ?? null)).toEqual([null, "review", C.DONE]);
  expect(result.cards[1]!.firstAction?.latencyMs).toBe(2000);
  expect(formatFocusRetro(result)).toContain("intention ship (action/needs-you) → review after 2.0s");
});
test("needs-input resolution excludes unknown, deduplicates episodes, and attributes only local exact identities", () => {
  const ui: FocusUiRow[] = [
    { ...stamp(1, 3), action: A.CARD, control: C.EXPAND, ...cardIdentity("a") },
    { ...stamp(2, 4), action: A.CARD, control: C.REPLY, ...cardIdentity("a") },
    { ...stamp(3, 5), action: A.CARD, control: C.REPLY, ...cardIdentity("b", "remote") },
    { ...stamp(4, 12), action: A.CARD, control: C.OPEN, ...cardIdentity("a") },
  ];
  const activity: ActivityRow[] = [state("a", "needs-input", 1), state("a", "needs-input", 2), state("a", "unknown", 3), state("a", "working", 7), state("b", "needs-input", 2),
    { kind: K.INPUT, seq: 22, at: at(6), session: "b", sessionId: "b", source: INPUT_SOURCE.CLI, bucket: at(0) }, state("b", "working", 8),
    state("a", "needs-input", 10), { kind: K.INPUT, seq: 23, at: at(13), session: "a", sessionId: "a", source: INPUT_SOURCE.BROWSER, bucket: at(0) }, state("a", "working", 14),
    state("c", "needs-input", 15), state("d", "needs-input", 20), state("d", "done", 25)];
  const result = buildFocusRetro(date, ui, activity, "home");
  expect(result.needsInput).toHaveLength(5);
  expect(result.needsInput.find(e => e.sessionId === "a")).toMatchObject({ startedAt: at(1), resolutionMs: 6000, via: "focus", focusAction: C.REPLY });
  expect(result.needsInput.find(e => e.sessionId === "b")).toMatchObject({ resolutionMs: 6000, via: "elsewhere" });
  expect(result.needsInput.filter(e => e.sessionId === "a")[1]).toMatchObject({ resolutionMs: 4000, via: "focus", focusAction: C.OPEN });
  expect(result.needsInput.find(e => e.sessionId === "c")).toMatchObject({ resolvedAt: null, resolutionMs: null, via: "unknown" });
  expect(result.needsInput.find(e => e.sessionId === "d")).toMatchObject({ resolutionMs: 5000, via: "unknown" });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_LABEL");
  expect(buildFocusRetro(date, ui, activity).needsInput.every(e => e.via !== "focus")).toBe(true);
});
test("names cannot alias a different incarnation; exit resolves only its UUID; cross-day rows are excluded", () => {
  const activity: ActivityRow[] = [state("old-id", "needs-input", 0),
    { kind: K.SESSION_CREATED, seq: 2, at: at(1), session: "old-id", sessionId: "new-id", cwd: "/PRIVATE_CWD" },
    { kind: K.SESSION_STATE, seq: 3, at: at(2), session: "old-id", state: "working", label: "" },
    { kind: K.SESSION_EXITED, seq: 4, at: at(3), sessionId: "old-id", reason: "exited" },
    { ...state("tomorrow", "needs-input", 1), at: "2026-11-17T00:00:00.000Z" }];
  expect(buildFocusRetro(date, [], activity).needsInput).toEqual([{ session: "old-id", sessionId: "old-id", startedAt: at(0), resolvedAt: at(3), resolutionMs: 3000, via: "unknown", focusAction: null }]);
});
