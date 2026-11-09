import { describe, expect, test } from "bun:test";
import {
  ASSISTANT_TIMING_DEFAULTS,
  activityDayOf,
  activityDayWindow,
  addDays,
  decideRoutines,
  pendingNeedsInput,
  parseAssistantTiming,
  validateAssistantTiming,
  type SchedulerInput,
} from "../../src/focus-scheduler.ts";

/** Local wall-clock times keep these cases independent of the test machine's zone. */
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

function input(patch: Partial<SchedulerInput> = {}): SchedulerInput {
  return {
    now: at(6, 15),
    timing: ASSISTANT_TIMING_DEFAULTS,
    enabled: true,
    idle: true,
    booting: false,
    restarted: false,
    manual: false,
    machines: [{ id: "home", reachable: true, pendingRows: false, lastRowAt: iso(at(6, 9)), lastInputAt: iso(at(6, 14, 50)) }],
    reviewedThrough: "2026-11-05",
    lastRun: { "catch-up": iso(at(6, 14)) },
    inbox: null,
    ...patch,
  };
}

describe("activity day boundary", () => {
  test("the day turns at the fallback time, so late work belongs to the day it started", () => {
    expect(activityDayOf(at(6, 22, 30), "03:00")).toBe("2026-11-06");
    expect(activityDayOf(at(7, 1), "03:00")).toBe("2026-11-06");
    expect(activityDayOf(at(7, 2, 59), "03:00")).toBe("2026-11-06");
    expect(activityDayOf(at(7, 3), "03:00")).toBe("2026-11-07");
    expect(activityDayWindow("2026-11-06", "03:00")).toEqual({ start: at(6, 3), end: at(7, 3) });
  });
  test("an evening boundary labels the window by the date holding most of it", () => {
    expect(activityDayOf(at(6, 22, 59), "23:00")).toBe("2026-11-06");
    expect(activityDayOf(at(6, 23), "23:00")).toBe("2026-11-07");
    expect(activityDayWindow("2026-11-07", "23:00")).toEqual({ start: at(6, 23), end: at(7, 23) });
    expect(activityDayOf(at(6, 0, 0), "00:00")).toBe("2026-11-06");
  });
  test("calendar arithmetic", () => {
    expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("assistant timing settings", () => {
  test("defaults and ranges", () => {
    expect(ASSISTANT_TIMING_DEFAULTS).toEqual({ quietMinutes: 90, fallbackTime: "03:00", catchUpDebounceMinutes: 15, urgentCatchUpSpacingMinutes: 2, journalRetentionDays: 30 });
    expect(parseAssistantTiming(undefined)).toEqual(ASSISTANT_TIMING_DEFAULTS);
    expect(parseAssistantTiming({ quietMinutes: 5, fallbackTime: "25:00", catchUpDebounceMinutes: 30 })).toEqual({ ...ASSISTANT_TIMING_DEFAULTS, catchUpDebounceMinutes: 30 });
    const edge = { quietMinutes: 15, fallbackTime: "23:59", catchUpDebounceMinutes: 120, urgentCatchUpSpacingMinutes: 120, journalRetentionDays: 365 };
    expect(validateAssistantTiming(edge)).toEqual({ ok: true, value: edge });
    for (const urgentCatchUpSpacingMinutes of [0, 121, 1.5, "2", null]) {
      expect(validateAssistantTiming({ ...ASSISTANT_TIMING_DEFAULTS, urgentCatchUpSpacingMinutes }).ok).toBe(false);
      expect(parseAssistantTiming({ urgentCatchUpSpacingMinutes }).urgentCatchUpSpacingMinutes).toBe(2);
    }
    for (const bad of [{ quietMinutes: 14 }, { quietMinutes: 481 }, { fallbackTime: "3:00" }, { fallbackTime: "24:00" }, { catchUpDebounceMinutes: 0 }, { catchUpDebounceMinutes: 121 }, { journalRetentionDays: 0 }, { quietMinutes: 20.5 }, { other: 1 }]) {
      expect(validateAssistantTiming({ ...ASSISTANT_TIMING_DEFAULTS, ...bad }).ok).toBe(false);
    }
  });
});

describe("pending needs-input journal transitions", () => {
  const baseline = (needsInputSessions: string[] = []) => ({ complete: true, needsInputSessions, sessionIdentities: {} });
  const row = (state: string, sessionId = "one") => ({ kind: "session.state" as const, session: "app", sessionId, state, label: "", seq: 1, at: iso(at(6, 15)) });
  test("acknowledged needs-input and label-only repeats are not new", () => {
    expect(pendingNeedsInput([row("needs-input")], baseline(["id:one"]))).toMatchObject({ newlyNeedsInput: false, needsInputSessions: ["id:one"] });
    expect(pendingNeedsInput([row("failed")], baseline())).toMatchObject({ newlyNeedsInput: false, needsInputSessions: [] });
  });
  test("unknown baselines never mint urgency, but an explicit transition can establish it", () => {
    expect(pendingNeedsInput([row("needs-input")], undefined).newlyNeedsInput).toBe(false);
    expect(pendingNeedsInput([row("working"), row("needs-input")], undefined).newlyNeedsInput).toBe(true);
    const waiting = pendingNeedsInput([row("needs-input")], undefined);
    expect(pendingNeedsInput([{ ...row("needs-input"), sessionId: undefined }], waiting).newlyNeedsInput).toBe(false);
    expect(pendingNeedsInput([{ ...row("needs-input", "unseen"), session: "unseen" }], waiting).newlyNeedsInput).toBe(false);
    expect(pendingNeedsInput([row("needs-input", "replacement")], waiting).newlyNeedsInput).toBe(true);
    const working = pendingNeedsInput([row("working")], undefined);
    expect(pendingNeedsInput([row("needs-input")], working).newlyNeedsInput).toBe(true);
  });
  test("delayed creation confirms only a pending wait, not acknowledged or resolved waits", () => {
    const created = { kind: "session.created" as const, session: "app", sessionId: "one", cwd: "/repo", seq: 2, at: iso(at(6, 15)) };
    expect(pendingNeedsInput([row("needs-input"), created]).newlyNeedsInput).toBe(true);
    expect(pendingNeedsInput([created, row("needs-input")]).newlyNeedsInput).toBe(true);
    const acknowledged = pendingNeedsInput([row("needs-input")]);
    expect(pendingNeedsInput([created], acknowledged).newlyNeedsInput).toBe(false);
    expect(pendingNeedsInput([row("needs-input"), created], acknowledged).newlyNeedsInput).toBe(false);
    expect(pendingNeedsInput([row("needs-input"), row("working"), created]).newlyNeedsInput).toBe(false);
    expect(pendingNeedsInput([row("needs-input"), created, row("working")]).newlyNeedsInput).toBe(false);
    expect(pendingNeedsInput([row("needs-input")]).newlyNeedsInput).toBe(false);
  });
  test("resolved prompts do not wake the assistant; unknown rows preserve waiting state", () => {
    expect(pendingNeedsInput([row("needs-input"), row("working")], baseline()).newlyNeedsInput).toBe(false);
    expect(pendingNeedsInput([row("needs-input"), { kind: "session.exited", sessionId: "one", reason: "exit", seq: 2, at: iso(at(6, 15)) }], baseline()).newlyNeedsInput).toBe(false);
    expect(pendingNeedsInput([row("unknown"), row("needs-input")], baseline(["id:one"])).newlyNeedsInput).toBe(false);
    expect(pendingNeedsInput([row("unknown")], baseline(["id:one"])).needsInputSessions).toEqual(["id:one"]);
  });
  test("named lifecycle facts reconcile legacy keys without clearing a newer UUID", () => {
    const legacy = { ...row("needs-input"), sessionId: undefined };
    const exit = { kind: "session.exited" as const, session: "app", sessionId: "old", reason: "exit", seq: 2, at: iso(at(6, 15)) };
    const created = { kind: "session.created" as const, session: "app", sessionId: "new", cwd: "/repo", seq: 3, at: iso(at(6, 15)) };
    expect(pendingNeedsInput([exit], baseline(["name:app"])).needsInputSessions).toEqual([]);
    expect(pendingNeedsInput([exit, created, legacy], baseline(["name:app"])).newlyNeedsInput).toBe(true);
    const linked = pendingNeedsInput([row("needs-input")], baseline(["name:app"]));
    expect(linked.newlyNeedsInput).toBe(false);
    expect(linked.needsInputSessions).toEqual(["id:one"]);
    expect(pendingNeedsInput([legacy, row("needs-input")], baseline()).newlyNeedsInput).toBe(true);
    const waiting = pendingNeedsInput([created, row("needs-input", "new"), exit], baseline());
    expect(waiting.needsInputSessions).toEqual(["id:new"]);
  });
  test("a new incarnation or a genuine re-entry counts; exited sessions are forgotten", () => {
    expect(pendingNeedsInput([row("needs-input", "two")], baseline(["id:one"])).newlyNeedsInput).toBe(true);
    expect(pendingNeedsInput([row("working"), row("needs-input")], baseline(["id:one"])).newlyNeedsInput).toBe(true);
    expect(pendingNeedsInput([{ kind: "session.exited", sessionId: "one", reason: "exit", seq: 2, at: iso(at(6, 15)) }], baseline(["id:one"])).needsInputSessions).toEqual([]);
  });
});

describe("routine decisions", () => {
  const pending = (patch = {}) => [{ id: "home", reachable: true, pendingRows: true, lastRowAt: iso(at(6, 14, 55)), lastInputAt: iso(at(6, 14, 50)), ...patch }];
  test("nothing happens while disabled, busy, or without new rows", () => {
    expect(decideRoutines(input({ enabled: false, machines: pending() }))).toEqual([]);
    expect(decideRoutines(input({ idle: false, machines: pending() }))).toEqual([]);
    expect(decideRoutines(input())).toEqual([]);
  });
  test("catch-up needs new rows, an idle assistant and the debounce", () => {
    expect(decideRoutines(input({ machines: pending(), lastRun: { "catch-up": iso(at(6, 14, 50)) } }))).toEqual([]);
    expect(decideRoutines(input({ machines: pending(), lastRun: { "catch-up": iso(at(6, 14, 45)) } }))).toEqual([{ type: "catch-up", reason: "activity" }]);
    expect(decideRoutines(input({ machines: pending(), lastRun: {} }))).toEqual([{ type: "catch-up", reason: "activity" }]);
  });
  test("new needs-input bypasses ordinary debounce but respects independent urgent spacing", () => {
    const recent = { "catch-up": iso(at(6, 14, 59)) };
    const urgent = input({ machines: pending({ newlyNeedsInput: true }), lastRun: recent });
    expect(decideRoutines(urgent)).toEqual([{ type: "catch-up", reason: "urgent" }]);
    expect(decideRoutines({ ...urgent, lastUrgentCatchUpAt: iso(at(6, 14, 59)) })).toEqual([]);
    expect(decideRoutines({ ...urgent, lastUrgentCatchUpAt: iso(at(6, 14, 58)) })).toEqual([{ type: "catch-up", reason: "urgent" }]);
    expect(decideRoutines({ ...urgent, machines: pending({ newlyNeedsInput: false }) })).toEqual([]);
    expect(decideRoutines({ ...urgent, idle: false })).toEqual([]);
    for (const extra of [{ queued: true }, { surfaced: true }, {}]) {
      expect(decideRoutines({ ...urgent, inbox: { file: "catch-up-x.json", routine: "catch-up", sends: 1, lastSentAt: iso(at(6, 14, 59)), queued: false, surfaced: false, ...extra } })).toEqual([]);
    }
    expect(decideRoutines({ ...urgent, lastUrgentCatchUpAt: iso(at(6, 14, 56)), timing: { ...ASSISTANT_TIMING_DEFAULTS, urgentCatchUpSpacingMinutes: 5 } })).toEqual([]);
  });
  test("opening wolfpack never bypasses the debounce; an assistant restart or boot does", () => {
    const recent = { "catch-up": iso(at(6, 14, 55)) };
    expect(decideRoutines(input({ machines: pending(), lastRun: recent }))).toEqual([]);
    expect(decideRoutines(input({ machines: pending(), lastRun: recent, restarted: true }))).toEqual([{ type: "catch-up", reason: "restart" }]);
    expect(decideRoutines(input({ machines: pending(), lastRun: recent, booting: true }))).toEqual([{ type: "catch-up", reason: "boot" }]);
    expect(decideRoutines(input({ lastRun: recent, restarted: true }))).toEqual([]);
  });
  test("gap review covers every completed day after reviewedThrough, bounded by retention", () => {
    expect(decideRoutines(input({ reviewedThrough: "2026-11-02", booting: true }))).toEqual([{ type: "gap-review", days: ["2026-11-03", "2026-11-04", "2026-11-05"] }]);
    expect(decideRoutines(input({ reviewedThrough: null }))).toEqual([{ type: "gap-review", days: ["2026-11-05"] }]);
    const far = decideRoutines(input({ reviewedThrough: "2026-01-01", timing: { ...ASSISTANT_TIMING_DEFAULTS, journalRetentionDays: 3 } }));
    expect(far).toEqual([{ type: "gap-review", days: ["2026-11-03", "2026-11-04", "2026-11-05"] }]);
  });
  test("the fallback reviews yesterday at the boundary while up, regardless of quiet", () => {
    const busyNight = [{ id: "home", reachable: true, pendingRows: false, lastRowAt: iso(at(7, 2, 50)), lastInputAt: iso(at(7, 2, 55)) }];
    expect(decideRoutines(input({ now: at(7, 2, 59), reviewedThrough: "2026-11-05", machines: busyNight }))).toEqual([]);
    expect(decideRoutines(input({ now: at(7, 3), reviewedThrough: "2026-11-05", machines: busyNight }))).toEqual([{ type: "day-review", days: ["2026-11-06"], reason: "fallback" }]);
  });
  test("day review fires once every machine with rows today has been quiet for the threshold", () => {
    const machines = [
      { id: "home", reachable: true, pendingRows: false, lastRowAt: iso(at(6, 18)), lastInputAt: iso(at(6, 18)) },
      { id: "laptop", reachable: false, pendingRows: false, lastRowAt: iso(at(6, 17)), lastInputAt: iso(at(6, 19)) },
      { id: "idle-box", reachable: true, pendingRows: false, lastRowAt: iso(at(5, 12)), lastInputAt: iso(at(5, 12)) },
    ];
    const base = { reviewedThrough: "2026-11-05", machines };
    expect(decideRoutines(input({ ...base, now: at(6, 20, 29) }))).toEqual([]);
    expect(decideRoutines(input({ ...base, now: at(6, 20, 30) }))).toEqual([{ type: "day-review", days: ["2026-11-06"], reason: "quiet" }]);
    expect(decideRoutines(input({ ...base, now: at(7, 0, 30), reviewedThrough: "2026-11-06" }))).toEqual([]);
    // a provisional review of today already ran: no second quiet review that day, even after more quiet
    expect(decideRoutines(input({ ...base, now: at(6, 23), provisional: "2026-11-06" }))).toEqual([]);
    expect(decideRoutines(input({ ...base, now: at(6, 23), provisional: "2026-11-05" }))).toEqual([{ type: "day-review", days: ["2026-11-06"], reason: "quiet" }]);
    // work that ends at 23:00 still reviews its own day at 00:30
    const late = [{ id: "home", reachable: true, pendingRows: false, lastRowAt: iso(at(6, 23)), lastInputAt: iso(at(6, 23)) }];
    expect(decideRoutines(input({ now: at(7, 0, 30), machines: late }))).toEqual([{ type: "day-review", days: ["2026-11-06"], reason: "quiet" }]);
    // agents ran but nobody typed today: wait for the fallback
    const unattended = [{ id: "home", reachable: true, pendingRows: false, lastRowAt: iso(at(6, 14)), lastInputAt: iso(at(5, 22)) }];
    expect(decideRoutines(input({ now: at(6, 20), machines: unattended }))).toEqual([]);
  });
  test("an outstanding inbox is re-sent with the next catch-up, capped at 3 re-sends, then surfaced", () => {
    const inbox = (sends: number, extra = {}) => ({ file: "catch-up-x.json", routine: "catch-up" as const, sends, lastSentAt: iso(at(6, 14, 40)), queued: false, surfaced: false, ...extra });
    expect(decideRoutines(input({ machines: pending(), inbox: inbox(1, { queued: true }) }))).toEqual([]);
    expect(decideRoutines(input({ machines: pending(), inbox: inbox(1, { lastSentAt: iso(at(6, 14, 50)) }) }))).toEqual([]);
    expect(decideRoutines(input({ inbox: inbox(1) }))).toEqual([{ type: "resend", file: "catch-up-x.json" }]);
    expect(decideRoutines(input({ inbox: inbox(3) }))).toEqual([{ type: "resend", file: "catch-up-x.json" }]);
    expect(decideRoutines(input({ inbox: inbox(4) }))).toEqual([{ type: "surface", file: "catch-up-x.json" }]);
    expect(decideRoutines(input({ machines: pending(), inbox: inbox(4, { surfaced: true }) }))).toEqual([]);
    // a never-delivered item (dropped by a restart) is offered again without counting as a send
    expect(decideRoutines(input({ inbox: inbox(0, { lastSentAt: null }) }))).toEqual([{ type: "resend", file: "catch-up-x.json" }]);
  });
  test("manual catch up now clears a stuck inbox and runs even while the debounce holds", () => {
    expect(decideRoutines(input({ manual: true, machines: pending(), lastRun: { "catch-up": iso(at(6, 14, 59)) }, inbox: { file: "catch-up-x.json", routine: "catch-up", sends: 4, lastSentAt: null, queued: false, surfaced: true } })))
      .toEqual([{ type: "drop-inbox", file: "catch-up-x.json" }, { type: "catch-up", reason: "manual" }]);
    expect(decideRoutines(input({ manual: true, idle: false }))).toEqual([{ type: "catch-up", reason: "manual" }]);
    // an inbox still in flight (not surfaced) is never dropped by catch up now
    expect(decideRoutines(input({ manual: true, machines: pending(), inbox: { file: "catch-up-x.json", routine: "catch-up", sends: 1, lastSentAt: null, queued: false, surfaced: false } }))).toEqual([]);
  });
});
