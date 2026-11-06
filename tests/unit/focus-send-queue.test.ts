import { expect, test } from "bun:test";
import { FocusSendQueue } from "../../src/focus-send-queue.ts";
import { genericHarness, piHarness } from "../../src/focus-harness.ts";
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
  expect(genericHarness.isIdle({ screen: "Allow? (y/n)\n› ", quietMs: 5000 })).toBe(false);
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
