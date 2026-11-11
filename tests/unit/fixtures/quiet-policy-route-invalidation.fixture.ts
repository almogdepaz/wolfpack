import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { createPushFixture } from "./push-service-fixture.ts";
const pushFixture = createPushFixture();
afterAll(() => pushFixture.close());
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { assertNotificationFixtureHome } from "./run-notification-test.ts";
assertNotificationFixtureHome();
const { createProjectSettingsRoutes } = await import("../../../src/server/project-settings-routes.ts");
const { createServerContext } = await import("../../../src/server/context.ts");
const { MockBackend } = await import("../../../src/server/mock-backend.ts");
const context = createServerContext({ backend: new MockBackend() });
const projectSettingsRoutes = createProjectSettingsRoutes(context);
const { quietAlertPolicyEpoch } = await import("../../../src/quiet-alert-policy-invalidation.ts");
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
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await context.close(); });
beforeEach(() => {
  writeFileSync(process.env.WOLFPACK_SETTINGS_PATH!, JSON.stringify({ agentCmd: "shell", cmds: [], quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 } }));
  pushFixture.reset();
  pushFixture.service.addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
});
afterEach(() => { pushFixture.service.removeSubscription(endpoint); pushFixture.reset(); });
async function post(mode: "needs-input-only" | "disabled"): Promise<void> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quietAlerts: { mode, quietAfterSeconds: 30 } }) });
  expect(response.status).toBe(200);
  expect((await response.json()).settings.quietAlerts.mode).toBe(mode);
}
const fact = (sessionId: string, kind: "quiet" | "needs-input" = "quiet") => ({ name: sessionId, identity: { wolfpackSessionId: sessionId },
  quietAlert: { kind, sessionId, episodeId: `episode-${sessionId}`, eligibleAtMs: Date.now(), observedAtMs: Date.now() } });

test.each(["needs-input-only", "disabled"] as const)("POST %s retires the second local Idle before it starts, not the already-started push", async mode => {
  const facts = [fact("first"), fact("second")];
  for (const session of facts) pushFixture.service.recordQuietAlertEmission(session.identity.wolfpackSessionId, session.quietAlert.episodeId);
  const capturedEpoch = quietAlertPolicyEpoch();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const sends: string[] = [];
  pushFixture.dependencies.sender = async payload => { sends.push(payload.body); if (sends.length === 1) await held; return { sent: 1, failed: 0, pruned: 0 }; };
  const pending = pushFixture.service.checkSessionTransitions(facts, capturedEpoch);
  try {
    expect(sends).toEqual(["Idle"]);
    await post(mode);
  } finally { release(); await pending; }
  expect(sends).toEqual(["Idle"]);
  expect(quietAlertPolicyEpoch()).toBe(capturedEpoch + 1);
  // Neither an old captured batch nor a newly collected repeat of an already
  // emitted old fact may resurrect its retired recipient ownership.
  await pushFixture.service.checkSessionTransitions(facts, capturedEpoch);
  await pushFixture.service.checkSessionTransitions(facts);
  expect(sends).toEqual(["Idle"]);
});

test("restrictive POST clears a failed local retry and fences its late transport completion", async () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const session = fact("retry");
  pushFixture.service.recordQuietAlertEmission("retry", session.quietAlert.episodeId);
  const capturedEpoch = quietAlertPolicyEpoch();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let sends = 0;
  pushFixture.dependencies.sender = async () => { sends++; await held; return { sent: 0, failed: 1, pruned: 0, failedEndpoints: [endpoint] }; };
  const pending = pushFixture.service.checkSessionTransitions([session], capturedEpoch);
  try {
    expect(sends).toBe(1);
    await post("needs-input-only");
    release(); await pending;
    now += 30_000;
    await pushFixture.service.checkSessionTransitions([session], capturedEpoch);
    await pushFixture.service.checkSessionTransitions([session]);
    expect(sends).toBe(1);
  } finally { release(); await pending; Date.now = originalNow; }
});

test.each([undefined, "needs-input-only", "disabled"] as const)("pending needs-input retry retains original enrollment after POST %s without new output", async mode => {
  const originalNow = Date.now;
  let now = 3_000_000;
  Date.now = () => now;
  const session = fact("input-retry", "needs-input");
  pushFixture.service.recordQuietAlertEmission("input-retry", session.quietAlert.episodeId, session.quietAlert.kind);
  const capturedEpoch = quietAlertPolicyEpoch();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const targets: string[][] = [];
  const lateEndpoint = `${endpoint}-late`;
  pushFixture.dependencies.sender = async (_payload, endpoints) => {
    targets.push([...endpoints]);
    if (targets.length === 1) { await held; return { sent: 0, failed: 1, pruned: 0, failedEndpoints: [endpoint] }; }
    return { sent: 1, failed: 0, pruned: 0 };
  };
  const pending = pushFixture.service.checkSessionTransitions([session], capturedEpoch);
  try {
    expect(targets).toEqual([[endpoint]]);
    if (mode) await post(mode);
    pushFixture.service.addSubscription({ endpoint: lateEndpoint, keys: { p256dh: "key", auth: "auth" } });
    release(); await pending;
    now += 30_000;
    await pushFixture.service.checkSessionTransitions([session]);
    expect(targets).toEqual(mode === "disabled" ? [[endpoint]] : [[endpoint], [endpoint]]);
    now += 30_000;
    await pushFixture.service.checkSessionTransitions([session]);
    expect(targets).toHaveLength(mode === "disabled" ? 1 : 2);
  } finally { release(); await pending; pushFixture.service.removeSubscription(lateEndpoint); Date.now = originalNow; }
});

test.each(["needs-input-only", "disabled"] as const)("completed failed needs-input attempt remains retryable only when eligible after POST %s", async mode => {
  const originalNow = Date.now;
  let now = 4_000_000;
  Date.now = () => now;
  const session = fact("completed-input", "needs-input");
  pushFixture.service.recordQuietAlertEmission(session.name, session.quietAlert.episodeId, session.quietAlert.kind);
  let sends = 0;
  pushFixture.dependencies.sender = async () => { sends++; return { sent: 0, failed: 1, pruned: 0, failedEndpoints: [endpoint] }; };
  try {
    await pushFixture.service.checkSessionTransitions([session]);
    await post(mode);
    now += 30_000;
    await pushFixture.service.checkSessionTransitions([session]);
    expect(sends).toBe(mode === "disabled" ? 1 : 2);
    // A new enrollment at the same endpoint is not the original recipient.
    pushFixture.service.removeSubscription(endpoint);
    pushFixture.service.addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    now += 30_000;
    await pushFixture.service.checkSessionTransitions([session]);
    expect(sends).toBe(mode === "disabled" ? 1 : 2);
  } finally { Date.now = originalNow; }
});

test.each(["quiet", "needs-input"] as const)("restrictive POST preserves mixed captured batch with %s first", async firstKind => {
  const facts = [fact("mixed-first", firstKind), fact("mixed-second", firstKind === "quiet" ? "needs-input" : "quiet")];
  for (const session of facts) pushFixture.service.recordQuietAlertEmission(session.name, session.quietAlert.episodeId, session.quietAlert.kind);
  const capturedEpoch = quietAlertPolicyEpoch();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const sends: string[] = [];
  pushFixture.dependencies.sender = async payload => { sends.push(payload.body); if (sends.length === 1) await held; return { sent: 1, failed: 0, pruned: 0 }; };
  const pending = pushFixture.service.checkSessionTransitions(facts, capturedEpoch);
  try { await post("needs-input-only"); } finally { release(); await pending; }
  expect(sends).toEqual(firstKind === "quiet" ? ["Idle", "Needs input"] : ["Needs input"]);
  await pushFixture.service.checkSessionTransitions(facts, capturedEpoch);
  await pushFixture.service.checkSessionTransitions(facts);
  expect(sends).toHaveLength(firstKind === "quiet" ? 2 : 1);
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
  pushFixture.dependencies.sender = async payload => {
    sends.push(payload.body);
    if (sends.length === 1) { await held; return { sent: 0, failed: 1, pruned: 0, failedEndpoints: [endpoint] }; }
    return { sent: 1, failed: 0, pruned: 0 };
  };
  const pending = pushFixture.service.checkSessionTransitions(facts, capturedEpoch, undefined, peer);
  try {
    expect(sends).toEqual(["Needs input"]);
    await post(mode);
    release(); await pending;
    expect(sends).toEqual(["Needs input", "Idle"]);
    now += 30_000;
    await pushFixture.service.checkSessionTransitions(facts, quietAlertPolicyEpoch(), undefined, peer);
    expect(sends).toEqual(["Needs input", "Idle", "Needs input"]);
  } finally { release(); await pending; Date.now = originalNow; }
});
