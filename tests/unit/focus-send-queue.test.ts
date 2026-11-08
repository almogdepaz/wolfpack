import { expect, test } from "bun:test";
import { FocusSendQueue, ROUTINE_FAILURE_FENCE_MS, sendDelivery, type SendDelivery } from "../../src/focus-send-queue.ts";
import { genericHarness, piHarness } from "../../src/focus-harness.ts";
import { AGENT_STATUS_AUTHORITY, AGENT_STATUS_STATE } from "../../src/agent-status-contract.ts";
test("pi semantic status distinguishes resting from input dialogs, rejects stale or fallback facts", () => {
  expect(piHarness.isIdle({ state: "done", authority: "program", stale: false })).toBe(true);
  expect(piHarness.needsScreen({ state: "done", authority: "program", stale: false })).toBe(false);
  expect(piHarness.needsScreen({ state: "idle", authority: "manifest", stale: true })).toBe(true);
  expect(piHarness.needsScreen({ state: "idle", authority: "identity", stale: false })).toBe(true);
  expect(genericHarness.needsScreen({ state: "done", authority: "program", stale: false })).toBe(true);
  expect(piHarness.isIdle({ state: "needs-input", authority: "program", stale: false })).toBe(false);
  expect(piHarness.needsInput({ state: "needs-input", authority: "program", stale: false })).toBe(true);
  expect(piHarness.isIdle({ state: "idle", authority: "fallback", stale: false })).toBe(false);
  expect(piHarness.isIdle({ state: "idle", authority: "program", stale: true })).toBe(false);
  expect(genericHarness.isIdle({ screen: "› ", quietMs: 5000 })).toBe(true);
  // A real broker capture is the whole screen: the prompt row is followed by blank rows.
  expect(genericHarness.isIdle({ screen: "output\n$\n\n\n", quietMs: 5000 })).toBe(true);
  expect(genericHarness.isIdle({ screen: "Allow? (y/n)\n$ \n\n", quietMs: 5000 })).toBe(false);
  expect(genericHarness.isIdle({ screen: "Allow? (y/n)\n› ", quietMs: 5000 })).toBe(false);
  // mid-turn markdown that pauses with a lone blockquote or heading marker is not a prompt
  expect(genericHarness.isIdle({ screen: "Here is the plan:\n\n>\n\n\n", quietMs: 6000 })).toBe(false);
  expect(genericHarness.isIdle({ screen: "Done with step one.\n\n#\n\n\n", quietMs: 6000 })).toBe(false);
  expect(genericHarness.isIdle({ screen: "output\n❯ \n\n", quietMs: 5000 })).toBe(true);
});
// pi 1.3.0's select dialogs (trust folder, login, resume) emit no semantic status; the screen ends with pi's
// navigation footer, not a prompt. live 2026-11-07: the pinned assistant sat on "Trust project folder?" all afternoon
// while the ui said idle. that screen must read as needs-input and never as idle.
const TRUST_DIALOG = "Warning: No project session found with id 'focus-assistant'; creating a new session with that id.\n────────────\n\n Trust project folder?\n /home/almog/.wolfpack/assistant\n\n This allows pi to load .pi settings and resources, install missing project packages, and execute project extensions.\n\n → Trust\n   Trust parent folder (/home/almog/.wolfpack)\n   Trust (this session only)\n   Do not trust\n   Do not trust (this session only)\n\n ↑↓ navigate  enter select  escape/ctrl+c cancel\n\n────────────\n\n\n\n";
test("a pi select dialog without semantic status is needs-input, not idle", () => {
  const sample = { state: "idle", authority: "fallback", stale: false, screen: TRUST_DIALOG, quietMs: 60_000 };
  expect(piHarness.needsScreen(sample)).toBe(true);
  expect(piHarness.needsInput(sample)).toBe(true);
  expect(piHarness.isIdle(sample)).toBe(false);
  expect(genericHarness.needsInput(sample)).toBe(true);
  // the footer only counts when it is the last non-blank row; scrolled-away dialog text is not a dialog
  expect(piHarness.needsInput({ ...sample, screen: "enter select escape\nmore output\n› \n\n" })).toBe(false);
  expect(piHarness.isIdle({ ...sample, screen: "enter select escape\nmore output\n› \n\n" })).toBe(true);
});
test("fresh program/manifest non-resting states veto a generic quiet prompt, without changing stale/fallback heuristics", () => {
  for (const authority of [AGENT_STATUS_AUTHORITY.PROGRAM, AGENT_STATUS_AUTHORITY.MANIFEST]) {
    for (const state of Object.values(AGENT_STATUS_STATE)) {
      const sample = { state, authority, stale: false, screen: "› ", quietMs: 6000 };
      expect(genericHarness.needsScreen(sample)).toBe(true);
      expect(genericHarness.isIdle(sample)).toBe(state === AGENT_STATUS_STATE.IDLE || state === AGENT_STATUS_STATE.DONE);
    }
  }
  expect(genericHarness.isIdle({ state: AGENT_STATUS_STATE.WORKING, authority: AGENT_STATUS_AUTHORITY.MANIFEST, stale: true, screen: "› ", quietMs: 6000 })).toBe(true);
  expect(genericHarness.isIdle({ state: AGENT_STATUS_STATE.WORKING, authority: AGENT_STATUS_AUTHORITY.FALLBACK, stale: false, screen: "› ", quietMs: 6000 })).toBe(true);
});
test("one outstanding send; stale idle cannot release the next; queue bounded and incarnation pinned", async () => {
  const sent: string[] = [];
  const queue = new FocusSendQueue(async (_id, text) => { sent.push(text); return "submitted"; });
  expect(queue.enqueue("a", "one")).toBe("queued");
  queue.enqueue("a", "two");
  await queue.tick({ id: "a", idle: true, token: "idle1" });
  expect(sent).toEqual(["one"]);
  await queue.tick({ id: "a", idle: true, token: "idle1" });
  expect(sent).toEqual(["one"]);
  await queue.tick({ id: "a", idle: false, token: "working" });
  await queue.tick({ id: "a", idle: true, token: "done2" });
  expect(sent).toEqual(["one", "two"]);
  queue.enqueue("a", "three");
  await queue.tick({ id: "b", idle: true, token: "new" });
  expect(sent).toEqual(["one", "two"]);
  expect(queue.error).toContain("restarted");
});
test("a fast completed turn releases the queue via a new program timestamp even if working was not sampled", async () => {
  const sent: string[] = [];
  const queue = new FocusSendQueue(async (_id, text) => { sent.push(text); return "submitted"; });
  queue.enqueue("a", "one"); queue.enqueue("a", "two");
  await queue.tick({ id: "a", idle: true, token: "program:1000" });
  await queue.tick({ id: "a", idle: true, token: "program:1001" });
  expect(sent).toEqual(["one", "two"]);
});

test("send failure is surfaced, never blindly replayed", async () => {
  const queue = new FocusSendQueue(async () => { throw new Error("disconnected"); });
  queue.enqueue("a", "hello");
  await queue.tick({ id: "a", idle: true, token: "idle" });
  expect(queue.error).toContain("disconnected");
  expect(queue.size).toBe(0);
});
test("per-item outcomes: sent, failed, or dropped by a clear/restart; busy until the outstanding turn settles", async () => {
  const outcomes: string[] = [];
  let fail = false;
  const queue = new FocusSendQueue(async () => { if (fail) throw new Error("pty gone"); return "submitted"; });
  queue.enqueue("a", "one", o => outcomes.push(`one:${o}`));
  queue.enqueue("a", "two", o => outcomes.push(`two:${o}`));
  expect(queue.busy).toBe(true);
  await queue.tick({ id: "a", idle: true, token: "t1" });
  expect(outcomes).toEqual(["one:sent"]);
  await queue.tick({ id: "a", idle: false, token: "t2" });
  fail = true;
  await queue.tick({ id: "a", idle: true, token: "t3" });
  expect(outcomes).toEqual(["one:sent", "two:failed"]);
  expect(queue.busy).toBe(false);
  fail = false;
  queue.enqueue("a", "three", o => outcomes.push(`three:${o}`));
  await queue.tick({ id: "b", idle: true, token: "t4" });
  expect(outcomes.at(-1)).toBe("three:dropped");
  queue.enqueue("b", "four", o => outcomes.push(`four:${o}`));
  await queue.tick({ id: "b", idle: true, token: "t5" });
  expect(queue.busy).toBe(true);
  await queue.tick({ id: "b", idle: true, token: "t6" });
  expect(queue.busy).toBe(false);
  queue.enqueue("b", "five", o => outcomes.push(`five:${o}`));
  queue.clear("disabled");
  expect(outcomes.slice(-2)).toEqual(["four:sent", "five:dropped"]);
});

test("a routine send that cannot be verified settles failed without costing the user's queued asks or setting an error", async () => {
  const outcomes: string[] = [];
  const sent: string[] = [];
  let fail = true;
  const queue = new FocusSendQueue(async (_id, text) => { if (fail) throw new Error("send not_delivered"); sent.push(text); return "submitted"; });
  queue.enqueue("a", "process inbox inbox/catch-up-20261106T100000Z.json", o => outcomes.push(`routine:${o}`), "routine");
  queue.enqueue("a", "what next?", o => outcomes.push(`ask:${o}`));
  await queue.tick({ id: "a", idle: true, token: "t1" });
  expect(outcomes).toEqual(["routine:failed"]);
  expect(queue.error).toBeUndefined();
  expect(queue.size).toBe(1);
  fail = false;
  await queue.tick({ id: "a", idle: true, token: "t2" });
  expect(sent).toEqual(["what next?"]);
  expect(outcomes).toEqual(["routine:failed", "ask:sent"]);
});
test("after an unverified routine send the next item waits for a new idle token or a short fence, never the same sample (P10)", async () => {
  let now = 1_000_000;
  const sent: string[] = [];
  let fail = true;
  const queue = new FocusSendQueue(async (_id, text) => { if (fail) { fail = false; throw new Error("send not_delivered"); } sent.push(text); return "submitted"; }, () => now);
  queue.enqueue("a", "process inbox inbox/catch-up-20261106T100000Z.json", undefined, "routine");
  queue.enqueue("a", "user ask");
  await queue.tick({ id: "a", idle: true, token: "idle1" });
  await queue.tick({ id: "a", idle: true, token: "idle1" });
  expect(sent).toEqual([]);
  expect(queue.busy).toBe(true);
  now += ROUTINE_FAILURE_FENCE_MS;
  await queue.tick({ id: "a", idle: true, token: "idle1" });
  expect(sent).toEqual(["user ask"]);
  // a changed idle token (the unverified line did start a turn) releases it without waiting
  const second = new FocusSendQueue(async (_id, text) => { if (text.startsWith("process")) throw new Error("send not_delivered"); sent.push(text); return "submitted"; }, () => now);
  second.enqueue("a", "process inbox inbox/catch-up-20261106T110000Z.json", undefined, "routine");
  second.enqueue("a", "second ask");
  await second.tick({ id: "a", idle: true, token: "idle1" });
  await second.tick({ id: "a", idle: true, token: "program:2" });
  expect(sent).toEqual(["user ask", "second ask"]);
});
test("a clear during an in-flight routine send leaves no phantom slot: a later user ask is delivered (P11)", async () => {
  const sent: string[] = [];
  const outcomes: string[] = [];
  let reject!: (error: Error) => void;
  const queue = new FocusSendQueue((_id, text) => {
    if (text.startsWith("process")) return new Promise<SendDelivery>((_resolve, fail) => { reject = fail; });
    sent.push(text);
    return Promise.resolve<SendDelivery>("submitted");
  });
  queue.enqueue("a", "process inbox inbox/catch-up-20261106T100000Z.json", o => outcomes.push(`routine:${o}`), "routine");
  const inFlight = queue.tick({ id: "a", idle: true, token: "idle1" });
  queue.clear();
  queue.enqueue("a", "user ask", o => outcomes.push(`ask:${o}`));
  reject(new Error("send not_delivered"));
  await inFlight;
  await queue.tick({ id: "a", idle: true, token: "idle1" });
  expect(sent).toEqual(["user ask"]);
  expect(outcomes).toEqual(["routine:failed", "ask:sent"]);
  expect(queue.error).toBeUndefined();
});

test("a user ask whose submission cannot be verified is unconfirmed, not failed: no error, the next item waits for a new idle token or the fence", async () => {
  let now = 5_000_000;
  const sent: string[] = [];
  const outcomes: string[] = [];
  const queue = new FocusSendQueue(async (_id, text) => { sent.push(text); return text === "whats up" ? "unverified" : "submitted"; }, () => now);
  queue.enqueue("a", "whats up", o => outcomes.push(`ask:${o}`));
  queue.enqueue("a", "and then?", o => outcomes.push(`next:${o}`));
  await queue.tick({ id: "a", idle: true, token: "program:1" });
  expect(sent).toEqual(["whats up"]);
  expect(queue.error).toBeUndefined();
  expect(queue.busy).toBe(true);
  // the same idle sample cannot release the next ask: the line may have started a turn that was not sampled yet
  await queue.tick({ id: "a", idle: true, token: "program:1" });
  expect(sent).toEqual(["whats up"]);
  // the assistant's turn was observed: the unverified ask did arrive, the next one goes out after it
  await queue.tick({ id: "a", idle: false, token: "program:2" });
  await queue.tick({ id: "a", idle: true, token: "program:3" });
  expect(sent).toEqual(["whats up", "and then?"]);
  expect(queue.error).toBeUndefined();
  expect(outcomes).toEqual(["ask:failed", "next:sent"]);
  // no turn seen at all: the fence releases the queue, still without a failure
  const quiet = new FocusSendQueue(async () => "unverified", () => now);
  quiet.enqueue("a", "anyone there?");
  quiet.enqueue("a", "hello?");
  await quiet.tick({ id: "a", idle: true, token: "idle" });
  await quiet.tick({ id: "a", idle: true, token: "idle" });
  expect(quiet.busy).toBe(true);
  now += ROUTINE_FAILURE_FENCE_MS;
  await quiet.tick({ id: "a", idle: true, token: "idle" });
  expect(quiet.size).toBe(0);
  expect(quiet.error).toBeUndefined();
});
test("sendDelivery maps the send contract: submitted and unverified are deliveries, anything else is a failure", () => {
  expect(sendDelivery("submitted")).toBe("submitted");
  expect(sendDelivery("unverified")).toBe("unverified");
  for (const outcome of ["pasted_not_submitted", "delivered", "not_delivered"] as const) expect(() => sendDelivery(outcome)).toThrow(`send ${outcome}`);
});
