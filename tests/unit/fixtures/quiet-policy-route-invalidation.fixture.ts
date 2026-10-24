import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { assertNotificationFixtureHome } from "./run-notification-test.ts";
assertNotificationFixtureHome();
const { projectSettingsRoutes } = await import("../../../src/server/project-settings-routes.ts");
const { quietAlertPolicyEpoch } = await import("../../../src/quiet-alert-policy-invalidation.ts");
const { addSubscription, removeSubscription, recordQuietAlertEmission, checkSessionTransitions, _testing } = await import("../../../src/server/push.ts");
const endpoint = "https://fcm.googleapis.com/restrictive-settings-boundary";
const peer = { identity: "node-a:11111111-1111-4111-8111-111111111111", name: "peer" };
const server = createServer((req, res) => {
  const route = projectSettingsRoutes[`${req.method} ${req.url}`];
  if (!route) { res.writeHead(404); res.end(); return; }
  void Promise.resolve(route(req, res)).catch(error => { res.writeHead(500); res.end(String(error)); });
});
let url: string;
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing private settings server address");
  url = `http://127.0.0.1:${address.port}/api/settings`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => {
  writeFileSync(process.env.WOLFPACK_SETTINGS_PATH!, JSON.stringify({ agentCmd: "shell", cmds: [], quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 } }));
  _testing.resetDebounce();
  addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
});
afterEach(() => { removeSubscription(endpoint); _testing.resetDebounce(); });
async function post(mode: "needs-input-only" | "disabled"): Promise<void> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quietAlerts: { mode, quietAfterSeconds: 30 } }) });
  expect(response.status).toBe(200);
  expect((await response.json()).settings.quietAlerts.mode).toBe(mode);
}
const fact = (sessionId: string, kind: "quiet" | "needs-input" = "quiet") => ({ name: sessionId, identity: { wolfpackSessionId: sessionId },
  quietAlert: { kind, sessionId, episodeId: `episode-${sessionId}`, eligibleAtMs: Date.now(), observedAtMs: Date.now() } });

test.each(["needs-input-only", "disabled"] as const)("POST %s retires the second local Idle before it starts, not the already-started push", async mode => {
  const facts = [fact("first"), fact("second")];
  for (const session of facts) recordQuietAlertEmission(session.identity.wolfpackSessionId, session.quietAlert.episodeId);
  const capturedEpoch = quietAlertPolicyEpoch();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const sends: string[] = [];
  _testing.sessionPushSender = async payload => { sends.push(payload.body); if (sends.length === 1) await held; return { sent: 1, failed: 0, pruned: 0 }; };
  const pending = checkSessionTransitions(facts, capturedEpoch);
  try {
    expect(sends).toEqual(["Idle"]);
    await post(mode);
  } finally { release(); await pending; }
  expect(sends).toEqual(["Idle"]);
  expect(quietAlertPolicyEpoch()).toBe(capturedEpoch + 1);
  // Neither an old captured batch nor a newly collected repeat of an already
  // emitted old fact may resurrect its retired recipient ownership.
  await checkSessionTransitions(facts, capturedEpoch);
  await checkSessionTransitions(facts);
  expect(sends).toEqual(["Idle"]);
  expect(_testing.quietAlertRecipientSnapshots.size).toBe(0);
});

test("restrictive POST clears a failed local retry and fences its late transport completion", async () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const session = fact("retry");
  recordQuietAlertEmission("retry", session.quietAlert.episodeId);
  const capturedEpoch = quietAlertPolicyEpoch();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let sends = 0;
  _testing.sessionPushSender = async () => { sends++; await held; return { sent: 0, failed: 1, pruned: 0, failedEndpoints: [endpoint] }; };
  const pending = checkSessionTransitions([session], capturedEpoch);
  try {
    expect(sends).toBe(1);
    await post("needs-input-only");
    release(); await pending;
    expect(_testing.quietAlertDeliveries.has("retry")).toBe(false);
    now += 30_000;
    await checkSessionTransitions([session], capturedEpoch);
    await checkSessionTransitions([session]);
    expect(sends).toBe(1);
  } finally { release(); await pending; Date.now = originalNow; }
});

test.each(["needs-input-only", "disabled"] as const)("local POST %s leaves a held peer batch and peer retries source-policy-owned", async mode => {
  const originalNow = Date.now;
  let now = 2_000_000;
  Date.now = () => now;
  const facts = [fact("peer-input", "needs-input"), fact("peer-idle")];
  const capturedEpoch = quietAlertPolicyEpoch();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const sends: string[] = [];
  _testing.sessionPushSender = async payload => {
    sends.push(payload.body);
    if (sends.length === 1) { await held; return { sent: 0, failed: 1, pruned: 0, failedEndpoints: [endpoint] }; }
    return { sent: 1, failed: 0, pruned: 0 };
  };
  const pending = checkSessionTransitions(facts, capturedEpoch, undefined, peer);
  try {
    expect(sends).toEqual(["Needs input"]);
    await post(mode);
    release(); await pending;
    expect(sends).toEqual(["Needs input", "Idle"]);
    now += 30_000;
    await checkSessionTransitions(facts, quietAlertPolicyEpoch(), undefined, peer);
    expect(sends).toEqual(["Needs input", "Idle", "Needs input"]);
  } finally { release(); await pending; Date.now = originalNow; }
});
