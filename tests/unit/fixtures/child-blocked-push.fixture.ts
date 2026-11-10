import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNotificationFixtureHome } from "./run-notification-test.ts";
assertNotificationFixtureHome();
const { MockBackend } = await import("../../../src/server/mock-backend.ts");
const { __setTestBackend, getBackend } = await import("../../../src/server/backend.ts");
const { addSubscription, removeSubscription, _testing } = await import("../../../src/server/push.ts");
const {
  __resetSessionObservationForTests,
  __runSessionNotificationObservationForTests,
  stopSessionNotificationObserver,
} = await import("../../../src/server/session-observation.ts");
const { __resetChildEventsForTests } = await import("../../../src/server/child-events.ts");
const { clearParentInbox, listParentNotifications } = await import("../../../src/server/parent-inbox.ts");
const { PROGRAM_STATUS_STATE } = await import("../../../src/program-status-contract.ts");
const { QUIET_ALERT_MODE } = await import("../../../src/quiet-alert-policy.ts");

// A blocked child event must reach the phone through the quiet-alert policy
// even when the child's screen never changes (review R4).
const realNow = Date.now;
let offsetMs = 0;
let backend: InstanceType<typeof MockBackend>;
let previousBackend: ReturnType<typeof getBackend>;
let endpoint: string;
let payloads: string[];
let projectDir: string;
const loadSettings = () => ({ agentCmd: "claude" });

function writeQuietAlertMode(mode: string): void {
  writeFileSync(process.env.WOLFPACK_SETTINGS_PATH!, JSON.stringify({ agentCmd: "shell", cmds: [], quietAlerts: { mode, quietAfterSeconds: 30 } }));
}

async function observeAfter(seconds: number): Promise<void> {
  offsetMs += seconds * 1_000;
  await __runSessionNotificationObservationForTests();
}

async function spawnChild(): Promise<{ parentId: string; childId: string }> {
  const parent = await backend.createSession("lead", projectDir, "claude", loadSettings);
  const parentSession = { wolfpackSessionId: parent.wolfpackSessionId, wolfpackSessionName: "lead" };
  const child = await backend.createSession("worker", projectDir, "claude", loadSettings, { parentSession });
  clearParentInbox(parent.wolfpackSessionId);
  return { parentId: parent.wolfpackSessionId, childId: child.wolfpackSessionId };
}

function setChildStatus(state: (typeof PROGRAM_STATUS_STATE)[keyof typeof PROGRAM_STATUS_STATE], kind?: "permission"): void {
  backend.setProgramStatus("worker", { id: "", state, ...(kind && { kind }), updatedAtMs: Date.now() });
}

beforeEach(() => {
  offsetMs = 0;
  Date.now = () => realNow() + offsetMs;
  writeQuietAlertMode(QUIET_ALERT_MODE.NEEDS_INPUT_ONLY);
  projectDir = mkdtempSync(join(tmpdir(), "wolfpack-blocked-push-"));
  previousBackend = getBackend();
  backend = new MockBackend();
  backend.setCapturePane(async () => "$ same screen");
  __setTestBackend(backend);
  __resetSessionObservationForTests();
  __resetChildEventsForTests();
  endpoint = `https://fcm.googleapis.com/blocked-push-${realNow()}-${Math.random()}`;
  addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
  payloads = [];
  _testing.sessionPushSender = async payload => { payloads.push(`${payload.title}: ${payload.body}`); return { sent: 1, failed: 0, pruned: 0 }; };
});

afterEach(async () => {
  await stopSessionNotificationObserver();
  _testing.sessionPushSender = null;
  removeSubscription(endpoint);
  __setTestBackend(previousBackend);
  Date.now = realNow;
  rmSync(projectDir, { recursive: true, force: true });
});

test("a program child that goes working → blocked with no screen change gets one push after the policy delay", async () => {
  const { parentId } = await spawnChild();
  setChildStatus(PROGRAM_STATUS_STATE.WORKING);
  await observeAfter(0);
  await observeAfter(5);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(5);
  expect(listParentNotifications(parentId).map(entry => entry.childEvent?.event)).toEqual(["blocked"]);
  await observeAfter(20);
  expect(payloads).toEqual([]);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(11);
  expect(payloads).toEqual(["Wolfpack: worker: Needs input (permission)"]);
  // The same blocked episode does not push again.
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(40);
  expect(payloads).toHaveLength(1);
});

test("a manifest child that reports needs-input with no screen change gets one push", async () => {
  const { parentId, childId } = await spawnChild();
  const writeManifest = (state: string) => {
    mkdirSync(join(projectDir, ".wolfpack"), { recursive: true });
    writeFileSync(join(projectDir, ".wolfpack", "agent-status.json"), JSON.stringify({
      state, observedAt: new Date(Date.now()).toISOString(), capabilities: ["semantic-state"], runId: childId,
    }));
  };
  writeManifest("running");
  await observeAfter(0);
  await observeAfter(5);
  writeManifest("needs-input");
  await observeAfter(5);
  expect(listParentNotifications(parentId).map(entry => entry.childEvent?.event)).toEqual(["blocked"]);
  writeManifest("needs-input");
  await observeAfter(31);
  expect(payloads).toEqual(["Wolfpack: worker: Needs input"]);
});

test("a blocked child whose screen changed sends one push, not two", async () => {
  await spawnChild();
  setChildStatus(PROGRAM_STATUS_STATE.WORKING);
  await observeAfter(0);
  backend.setCapturePane(async () => "$ approve rm? [y/n]");
  backend.setOutputSequence("worker", "1");
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(5);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(31);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(40);
  expect(payloads).toEqual(["Wolfpack: worker: Needs input (permission)"]);
});

test("the disabled quiet-alert mode sends no push for a blocked child", async () => {
  writeQuietAlertMode(QUIET_ALERT_MODE.DISABLED);
  const { parentId } = await spawnChild();
  setChildStatus(PROGRAM_STATUS_STATE.WORKING);
  await observeAfter(0);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(5);
  expect(listParentNotifications(parentId).map(entry => entry.childEvent?.event)).toEqual(["blocked"]);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(31);
  expect(payloads).toEqual([]);
});

test("a child that became blocked during a capture gap gets one push after capture recovers, with no screen change (review A3-2)", async () => {
  const { parentId } = await spawnChild();
  let failCapture = false;
  backend.setCapturePane(async () => {
    if (failCapture) throw new Error("capture unavailable");
    return "$ same screen";
  });
  setChildStatus(PROGRAM_STATUS_STATE.WORKING);
  await observeAfter(0);
  failCapture = true;
  backend.setOutputSequence("worker", "1");
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(1);
  expect(listParentNotifications(parentId).map(entry => entry.childEvent?.event)).toEqual(["blocked"]);
  failCapture = false;
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(1);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(31);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(31);
  expect(payloads).toEqual(["Wolfpack: worker: Needs input (permission)"]);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(40);
  expect(payloads).toHaveLength(1);
});

test("a child that leaves blocked during a capture gap gets no push after recovery", async () => {
  // Also no fabricated quiet alert: the screen never changed.
  writeQuietAlertMode(QUIET_ALERT_MODE.QUIET_AFTER_ACTIVITY);
  await spawnChild();
  let failCapture = false;
  backend.setCapturePane(async () => {
    if (failCapture) throw new Error("capture unavailable");
    return "$ same screen";
  });
  setChildStatus(PROGRAM_STATUS_STATE.WORKING);
  await observeAfter(0);
  failCapture = true;
  backend.setOutputSequence("worker", "1");
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(1);
  setChildStatus(PROGRAM_STATUS_STATE.WORKING);
  await observeAfter(1);
  failCapture = false;
  await observeAfter(1);
  await observeAfter(31);
  await observeAfter(31);
  expect(payloads).toEqual([]);
});

test("a child pushed for its block gets no second push after a capture gap while still blocked", async () => {
  await spawnChild();
  let failCapture = false;
  backend.setCapturePane(async () => {
    if (failCapture) throw new Error("capture unavailable");
    return "$ same screen";
  });
  setChildStatus(PROGRAM_STATUS_STATE.WORKING);
  await observeAfter(0);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(5);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(31);
  expect(payloads).toEqual(["Wolfpack: worker: Needs input (permission)"]);
  failCapture = true;
  backend.setOutputSequence("worker", "1");
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(1);
  failCapture = false;
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(1);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(31);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(31);
  expect(payloads).toHaveLength(1);
});

test("a screen change after the push keeps the blocked episode; leaving and re-entering blocked pushes again (review A3-3)", async () => {
  await spawnChild();
  setChildStatus(PROGRAM_STATUS_STATE.WORKING);
  await observeAfter(0);
  await observeAfter(5);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(5);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(31);
  expect(payloads).toEqual(["Wolfpack: worker: Needs input (permission)"]);

  // Still blocked: the screen redraws, then stays quiet.
  backend.setCapturePane(async () => "$ approve rm? [y/n]");
  backend.setOutputSequence("worker", "1");
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(1);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(31);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(31);
  expect(payloads).toHaveLength(1);

  // The child leaves blocked and blocks again: a new episode.
  backend.setCapturePane(async () => "$ running");
  backend.setOutputSequence("worker", "2");
  setChildStatus(PROGRAM_STATUS_STATE.WORKING);
  await observeAfter(5);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(5);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(31);
  expect(payloads).toHaveLength(2);
});

test("the reviewer's blocked-push probe: a redraw after the push while still blocked sends no second push (review A3-3)", async () => {
  backend.setCapturePane(async () => "initial child screen");
  const { parentId } = await spawnChild();
  setChildStatus(PROGRAM_STATUS_STATE.WORKING);
  await observeAfter(0);
  offsetMs += 1_000;
  backend.setProgramStatus("worker", { id: "", state: PROGRAM_STATUS_STATE.BLOCKED, kind: "permission", message: "approve command?", updatedAtMs: Date.now() });
  await observeAfter(0);
  await observeAfter(60);
  expect(listParentNotifications(parentId).map(entry => entry.childEvent?.event)).toEqual(["blocked"]);
  expect(payloads).toHaveLength(1);
  // The status is not refreshed; only the screen changes.
  backend.setCapturePane(async () => "changed permission prompt");
  backend.setOutputSequence("worker", "1");
  await observeAfter(1);
  await observeAfter(31);
  expect(payloads).toHaveLength(1);
});

test("a child pushed for its block gets no second push after a capture gap and a later redraw while still blocked", async () => {
  await spawnChild();
  let failCapture = false;
  let screen = "$ same screen";
  backend.setCapturePane(async () => {
    if (failCapture) throw new Error("capture unavailable");
    return screen;
  });
  setChildStatus(PROGRAM_STATUS_STATE.WORKING);
  await observeAfter(0);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(5);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(31);
  expect(payloads).toHaveLength(1);
  failCapture = true;
  backend.setOutputSequence("worker", "1");
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(1);
  failCapture = false;
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(1);
  screen = "$ approve rm? [y/n]";
  backend.setOutputSequence("worker", "2");
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(1);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(31);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(31);
  expect(payloads).toHaveLength(1);
});

/** A sender that fails the first `failures` attempts, then succeeds; counts attempts and successes. */
function failingSender(failures: number): { attempts: () => number; delivered: () => number } {
  let attempts = 0;
  let delivered = 0;
  _testing.sessionPushSender = async (_payload, endpoints) => {
    attempts += 1;
    if (attempts <= failures) return { sent: 0, failed: endpoints.size, pruned: 0, successfulEndpoints: [], failedEndpoints: [...endpoints] };
    delivered += 1;
    return { sent: endpoints.size, failed: 0, pruned: 0, successfulEndpoints: [...endpoints], failedEndpoints: [] };
  };
  return { attempts: () => attempts, delivered: () => delivered };
}

/** Working, then blocked; the first push attempt runs after the policy delay. */
async function blockAndAttemptPush(capture: { fail: boolean }, screen: { text: string }): Promise<void> {
  backend.setCapturePane(async () => {
    if (capture.fail) throw new Error("capture unavailable");
    return screen.text;
  });
  setChildStatus(PROGRAM_STATUS_STATE.WORKING);
  await observeAfter(0);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(1);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(31);
}

async function captureGap(capture: { fail: boolean }, outputSequence: string): Promise<void> {
  capture.fail = true;
  backend.setOutputSequence("worker", outputSequence);
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(1);
  capture.fail = false;
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(1);
}

async function stayBlocked(times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
    await observeAfter(31);
  }
}

test("the reviewer's failed-push-gap-recovery ordering: a failed blocked push retries after a capture gap and succeeds once (review A5-1)", async () => {
  await spawnChild();
  const sender = failingSender(1);
  const capture = { fail: false };
  await blockAndAttemptPush(capture, { text: "unchanged screen" });
  expect(sender.attempts()).toBe(1);
  await captureGap(capture, "1");
  await stayBlocked(3);
  expect(sender.attempts()).toBe(2);
  expect(sender.delivered()).toBe(1);
});

test("the reviewer's failed-push-gap-redraw ordering: a redraw after the gap keeps the retry of the same episode (review A5-1)", async () => {
  await spawnChild();
  const sender = failingSender(1);
  const capture = { fail: false };
  const screen = { text: "unchanged screen" };
  await blockAndAttemptPush(capture, screen);
  expect(sender.attempts()).toBe(1);
  await captureGap(capture, "1");
  screen.text = "permission prompt redraw";
  backend.setOutputSequence("worker", "2");
  setChildStatus(PROGRAM_STATUS_STATE.BLOCKED, "permission");
  await observeAfter(1);
  await stayBlocked(3);
  expect(sender.attempts()).toBe(2);
  expect(sender.delivered()).toBe(1);
});

test("a blocked push that always fails stops at three attempts, with or without a capture gap (review A5-1)", async () => {
  await spawnChild();
  const sender = failingSender(Number.POSITIVE_INFINITY);
  const capture = { fail: false };
  await blockAndAttemptPush(capture, { text: "unchanged screen" });
  await stayBlocked(4);
  expect(sender.attempts()).toBe(3);
  await captureGap(capture, "1");
  await stayBlocked(3);
  expect(sender.attempts()).toBe(3);
});

test("a gap between failed attempts does not reset the three-attempt budget (review A5-1)", async () => {
  await spawnChild();
  const sender = failingSender(Number.POSITIVE_INFINITY);
  const capture = { fail: false };
  await blockAndAttemptPush(capture, { text: "unchanged screen" });
  await captureGap(capture, "1");
  await stayBlocked(1);
  await captureGap(capture, "2");
  await stayBlocked(4);
  expect(sender.attempts()).toBe(3);
});
