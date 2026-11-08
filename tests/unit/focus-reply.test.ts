import { describe, expect, test } from "bun:test";
import { ASK_TERMINAL_AFTER_MS, focusReplyView, observePendingAsk, startPendingAsk, type AssistantActivity, type PendingAsk } from "../../src/focus-reply.ts";

const t0 = Date.parse("2026-11-08T12:00:00.000Z");
const reply = (updatedAt: string, text = "Broker leak first.", author = "assistant") => ({ text, updatedAt, author });
const live = (patch: Partial<AssistantActivity> = {}): AssistantActivity => ({ state: "done", queued: 0, sessionId: "incarnation-1", ...patch });
const idle = live();
/** A sent ask as the view records it from the POST /focus/ask answer. */
const sent = (patch: Partial<PendingAsk> = {}, at = live()): PendingAsk => ({ ...startPendingAsk("what next?", "sent", null, at, t0), ...patch });
/** Replays polls through the view's two calls; returns the label after each. */
function polls(ask: PendingAsk, steps: [number, AssistantActivity][]) {
  let current: PendingAsk | undefined = ask;
  return steps.map(([at, assistant]) => { current = observePendingAsk(current, assistant, at); return focusReplyView(current, undefined, assistant, at).kind; });
}

describe("inline ask reply", () => {
  test("no ask in memory: the latest reply, or nothing", () => {
    expect(focusReplyView(undefined, undefined, idle, t0)).toEqual({ kind: "none" });
    expect(focusReplyView(undefined, reply("2026-11-08T11:00:00.000Z"), idle, t0)).toEqual({ kind: "reply", reply: reply("2026-11-08T11:00:00.000Z") });
    // an empty reply (it may be cleared) shows nothing
    expect(focusReplyView(undefined, reply("2026-11-08T11:00:00.000Z", ""), idle, t0)).toEqual({ kind: "none" });
  });
  test("a sent ask waits until a reply other than the one on screen at ask time arrives", () => {
    const prior = "2026-11-08T11:00:00.000Z";
    const pending = sent({ priorReplyAt: prior });
    expect(focusReplyView(pending, reply(prior), live({ state: "working" }), t0 + 1000)).toMatchObject({ kind: "waiting" });
    // the home server's clock may lag the browser's: a new reply is new by identity, not by comparing clocks
    const skewed = reply("2026-11-08T11:59:30.000Z", "Answer prompt-project.");
    expect(focusReplyView(pending, skewed, live({ state: "working" }), t0 + 1000)).toEqual({ kind: "answered", ask: pending, reply: skewed });
  });
  test("queued while the server still holds it; failed shows the error; a reply still wins", () => {
    const queued = startPendingAsk("what next?", "queued", null, live({ state: "working", queued: 1 }), t0);
    expect(focusReplyView(queued, undefined, live({ state: "working", queued: 1 }), t0)).toMatchObject({ kind: "queued" });
    const failed = startPendingAsk("what next?", "failed", null, live({ error: "assistant send failed: send not_delivered" }), t0);
    expect(focusReplyView(failed, undefined, idle, t0)).toEqual({ kind: "failed", ask: failed, error: "assistant send failed: send not_delivered" });
    expect(focusReplyView(failed, reply("2026-11-08T12:00:05.000Z"), idle, t0)).toMatchObject({ kind: "answered" });
  });
  test("answered in its terminal: the ask's turn ran (seen working after it was sent, now resting, nothing queued), or 90 s resting", () => {
    expect(polls(sent(), [[t0 + 5000, idle]])).toEqual(["waiting"]);
    expect(polls(sent(), [[t0 + 5000, live({ state: "working" })], [t0 + 10_000, idle]])).toEqual(["waiting", "terminal"]);
    expect(polls(sent(), [[t0 + 5000, live({ state: "working" })], [t0 + 10_000, live({ state: "idle" })]])).toEqual(["waiting", "terminal"]);
    expect(polls(sent(), [[t0 + 5000, live({ state: "working" })], [t0 + 10_000, live({ queued: 1 })]])).toEqual(["waiting", "waiting"]);
    // a turn too short for the 5 s poll: resting 90 s after the send is the fallback
    expect(polls(sent(), [[t0 + ASK_TERMINAL_AFTER_MS, idle]])).toEqual(["terminal"]);
    // a visibly working assistant is still answering, however long it takes
    expect(polls(sent(), [[t0 + ASK_TERMINAL_AFTER_MS + 5000, live({ state: "working" })]])).toEqual(["waiting"]);
  });
  test("an ask queued behind a routine: its turn starts when the queue drains, not before (S1)", () => {
    const busy = live({ state: "working", queued: 1 });
    const ask = startPendingAsk("what next?", "queued", null, busy, t0);
    expect(ask.sawWorking).toBe(false);
    expect(polls(ask, [
      [t0 + 5000, busy],
      [t0 + 10_000, idle], // the routine's turn ended and the queue sent the ask; pi has not started it yet
      [t0 + 15_000, live({ state: "working" })],
      [t0 + 20_000, idle],
    ])).toEqual(["queued", "waiting", "waiting", "terminal"]);
    // the 90 s fallback runs from the drain, not from the submit
    expect(polls(ask, [[t0 + 60_000, busy], [t0 + 95_000, idle], [t0 + 95_000 + ASK_TERMINAL_AFTER_MS - 1, idle], [t0 + 95_000 + ASK_TERMINAL_AFTER_MS, idle]])).toEqual(["queued", "waiting", "waiting", "terminal"]);
  });
  test("an ask dropped after it was queued is not sent, even after a routine resets the error (B1)", () => {
    const ask = startPendingAsk("what next?", "queued", null, live({ state: "working", queued: 1 }), t0);
    const dropped = "assistant restarted; queued messages were not sent";
    let current = observePendingAsk(ask, live({ queued: 0, error: dropped }), t0 + 5000);
    expect(focusReplyView(current, undefined, live({ error: dropped }), t0 + 5000)).toEqual({ kind: "failed", ask: current!, error: dropped });
    // the restart's catch-up enqueues a routine line, which clears the queue's error on the next poll
    current = observePendingAsk(current, live({ state: "working" }), t0 + 10_000);
    expect(focusReplyView(current, undefined, live({ state: "working" }), t0 + 10_000)).toMatchObject({ kind: "failed", error: dropped });
    expect(focusReplyView(current, undefined, idle, t0 + 10_000 + 2 * ASK_TERMINAL_AFTER_MS)).toMatchObject({ kind: "failed" });
    // a reply that arrives anyway still wins
    expect(focusReplyView(current, reply("2026-11-08T12:03:00.000Z"), idle, t0 + 20_000)).toMatchObject({ kind: "answered" });
  });
  test("a sent ask whose assistant restarted (new incarnation, no error text) is not confirmed (B1)", () => {
    expect(polls(sent(), [[t0 + 5000, live({ sessionId: "incarnation-2" })], [t0 + 10_000 + ASK_TERMINAL_AFTER_MS, live({ sessionId: "incarnation-2" })]])).toEqual(["unconfirmed", "unconfirmed"]);
    // a status without a session id is no evidence of a restart; only a defined, different id is (R-1)
    expect(polls(sent(), [[t0 + 5000, live({ sessionId: undefined, state: "starting" })], [t0 + 10_000, live({ state: "working" })]])).toEqual(["waiting", "waiting"]);
    expect(polls(sent(), [[t0 + 5000, live({ sessionId: undefined, state: "starting" })], [t0 + 10_000, live({ sessionId: "incarnation-2" })]])).toEqual(["waiting", "unconfirmed"]);
    // a hard failure of the ask itself (not_delivered) clears the queue with an error: not sent
    expect(polls(sent(), [[t0 + 5000, live({ error: "assistant send failed: send not_delivered; delivery may be uncertain" })]])).toEqual(["failed"]);
  });
  test("a finished ask stays finished: a later relaunch or pin error does not flip it (R-1)", () => {
    const ran: [number, AssistantActivity][] = [[t0 + 5000, live({ state: "working" })], [t0 + 10_000, idle]];
    const hour = t0 + 3_600_000;
    expect(polls(sent(), [...ran, [hour, live({ sessionId: "incarnation-2" })]])).toEqual(["waiting", "terminal", "terminal"]);
    expect(polls(sent(), [...ran, [hour, live({ error: "conflicting ownership of the assistant directory" })]])).toEqual(["waiting", "terminal", "terminal"]);
    // the timeout path settles too
    expect(polls(sent(), [[t0 + ASK_TERMINAL_AFTER_MS, idle], [hour, live({ sessionId: "incarnation-2", error: "assistant restarted; queued messages were not sent" })]])).toEqual(["terminal", "terminal"]);
    // a later routine turn does not reopen it either
    expect(polls(sent(), [...ran, [hour, live({ state: "working" })]])).toEqual(["waiting", "terminal", "terminal"]);
  });
  test("an error that was already there when the ask was answered (a pin note) is not the ask's failure", () => {
    const note = "conflicting ownership of the assistant directory";
    expect(polls(sent({}, live({ error: note })), [[t0 + 5000, live({ error: note })]])).toEqual(["waiting"]);
  });
});
