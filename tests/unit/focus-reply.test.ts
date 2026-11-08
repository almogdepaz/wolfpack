import { describe, expect, test } from "bun:test";
import { ASK_TERMINAL_AFTER_MS, focusReplyView, observePendingAsk, type PendingAsk } from "../../src/focus-reply.ts";

const t0 = Date.parse("2026-11-08T12:00:00.000Z");
const reply = (updatedAt: string, text = "Broker leak first.", author = "assistant") => ({ text, updatedAt, author });
const ask = (patch: Partial<PendingAsk> = {}): PendingAsk => ({ text: "what next?", askedAt: t0, delivery: "sent", priorReplyAt: null, sawWorking: false, ...patch });
const idle = { state: "done", queued: 0 };

describe("inline ask reply", () => {
  test("no ask in memory: the latest reply, or nothing", () => {
    expect(focusReplyView(undefined, undefined, idle, t0)).toEqual({ kind: "none" });
    expect(focusReplyView(undefined, reply("2026-11-08T11:00:00.000Z"), idle, t0)).toEqual({ kind: "reply", reply: reply("2026-11-08T11:00:00.000Z") });
    // an empty reply (it may be cleared) shows nothing
    expect(focusReplyView(undefined, reply("2026-11-08T11:00:00.000Z", ""), idle, t0)).toEqual({ kind: "none" });
  });
  test("a sent ask waits until a reply other than the one on screen at ask time arrives", () => {
    const prior = "2026-11-08T11:00:00.000Z";
    const pending = ask({ priorReplyAt: prior });
    expect(focusReplyView(pending, reply(prior), { state: "working", queued: 0 }, t0 + 1000)).toMatchObject({ kind: "waiting" });
    // the home server's clock may lag the browser's: a new reply is new by identity, not by comparing clocks
    const skewed = reply("2026-11-08T11:59:30.000Z", "Answer prompt-project.");
    expect(focusReplyView(pending, skewed, { state: "working", queued: 0 }, t0 + 1000)).toEqual({ kind: "answered", ask: pending, reply: skewed });
  });
  test("queued while the server still holds it; failed shows the error; a reply still wins", () => {
    expect(focusReplyView(ask({ delivery: "queued" }), undefined, { state: "working", queued: 1 }, t0)).toMatchObject({ kind: "queued" });
    // the queue drained: it was sent, now it waits like any sent ask
    expect(focusReplyView(ask({ delivery: "queued" }), undefined, { state: "working", queued: 0 }, t0)).toMatchObject({ kind: "waiting" });
    expect(focusReplyView(ask({ delivery: "failed" }), undefined, idle, t0)).toMatchObject({ kind: "failed" });
    expect(focusReplyView(ask({ delivery: "failed" }), reply("2026-11-08T12:00:05.000Z"), idle, t0)).toMatchObject({ kind: "answered" });
  });
  test("answered in its terminal: the turn ran (seen working, now resting, nothing queued) without a reply, or 90 s passed", () => {
    expect(focusReplyView(ask(), undefined, idle, t0 + 5000)).toMatchObject({ kind: "waiting" });
    expect(focusReplyView(ask({ sawWorking: true }), undefined, idle, t0 + 5000)).toMatchObject({ kind: "terminal" });
    expect(focusReplyView(ask({ sawWorking: true }), undefined, { state: "idle", queued: 0 }, t0 + 5000)).toMatchObject({ kind: "terminal" });
    expect(focusReplyView(ask({ sawWorking: true }), undefined, { state: "done", queued: 1 }, t0 + 5000)).toMatchObject({ kind: "waiting" });
    expect(focusReplyView(ask({ sawWorking: true }), undefined, { state: "working", queued: 0 }, t0 + 5000)).toMatchObject({ kind: "waiting" });
    expect(focusReplyView(ask(), undefined, { state: "working", queued: 0 }, t0 + ASK_TERMINAL_AFTER_MS)).toMatchObject({ kind: "terminal" });
  });
  test("the working latch is set from polls while an ask is pending", () => {
    const pending = ask();
    expect(observePendingAsk(pending, { state: "done", queued: 0 })).toBe(pending);
    expect(observePendingAsk(pending, { state: "working", queued: 0 })).toEqual({ ...pending, sawWorking: true });
    expect(observePendingAsk(undefined, { state: "working", queued: 0 })).toBeUndefined();
  });
});
