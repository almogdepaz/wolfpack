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
