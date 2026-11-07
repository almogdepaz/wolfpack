import { expect, test } from "bun:test";
import { FocusSendQueue } from "../../src/focus-send-queue.ts";
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
  const queue = new FocusSendQueue(async (_id, text) => { sent.push(text); });
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
  const queue = new FocusSendQueue(async (_id, text) => { sent.push(text); });
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
  const queue = new FocusSendQueue(async () => { if (fail) throw new Error("pty gone"); });
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
