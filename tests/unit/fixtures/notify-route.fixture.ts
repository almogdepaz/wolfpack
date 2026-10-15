import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertNotificationFixtureHome } from "./run-notification-test.ts";
import { isJsonObject, validateControlApiSchemaValue } from "../../control-api-schema-validator.ts";
import type { JsonObject } from "../../control-api-schema-validator.ts";
assertNotificationFixtureHome();
const { CONTROL_API_SCHEMA_ARTIFACT } = await import("../../../src/control-api/schema.ts");
const { addSubscription, removeSubscription, _testing } = await import("../../../src/server/push.ts");
const { pushNotifyRoutes } = await import("../../../src/server/push-routes.ts");
const fetcher = globalThis.fetch;
const artifact = JSON.parse(readFileSync(CONTROL_API_SCHEMA_ARTIFACT, "utf8")) as JsonObject;
function validateResponse(body: unknown): void {
  const http = artifact.http;
  const operation = isJsonObject(http) ? http.sendNotification : undefined;
  if (!isJsonObject(operation)) throw new Error("missing notify schema");
  expect(validateControlApiSchemaValue(operation.response, body, artifact)).toEqual([]);
}
const server = createServer((req, res) => {
  const route = pushNotifyRoutes[`${req.method} ${req.url}`];
  if (!route) { res.writeHead(404); res.end(); return; }
  void Promise.resolve(route(req, res)).catch(error => { res.writeHead(500); res.end(String(error)); });
});
let url: string;
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  url = `http://127.0.0.1:${address.port}/api/notify`;
});
beforeEach(() => { _testing.resetDebounce(); });
afterAll(async () => { globalThis.fetch = fetcher; await new Promise<void>(resolve => server.close(() => resolve())); });
const notify = () => fetcher(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "child ready for review" }),
});
function pushServiceAnswers(status: number): void {
  globalThis.fetch = Object.assign(async () => new Response(null, { status }), { preconnect: fetcher.preconnect });
}
function enroll(endpoint: string): void {
  const client = createECDH("prime256v1"); client.generateKeys();
  addSubscription({ endpoint, keys: { p256dh: client.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 3).toString("base64url") } });
}

test("no enrolled subscription is accepted but reported as not delivered", async () => {
  const response = await notify();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ ok: true, sent: 0, failed: 0, pruned: 0, delivered: false, reason: "no_subscriptions" });
  validateResponse(body);
});

test("a push service that rejects every endpoint reports delivery_failed", async () => {
  const endpoint = "https://fcm.googleapis.com/notify-rejected";
  enroll(endpoint);
  try {
    pushServiceAnswers(403);
    const response = await notify();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, sent: 0, failed: 1, pruned: 0, delivered: false, reason: "delivery_failed" });
    validateResponse(body);
  } finally { globalThis.fetch = fetcher; removeSubscription(endpoint); }
});

test("an accepted push is delivered without a reason", async () => {
  const endpoint = "https://fcm.googleapis.com/notify-accepted";
  enroll(endpoint);
  try {
    pushServiceAnswers(201);
    const response = await notify();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, sent: 1, failed: 0, pruned: 0, delivered: true });
    validateResponse(body);
  } finally { globalThis.fetch = fetcher; removeSubscription(endpoint); }
});

test("an expired only subscription is pruned and leaves nothing to deliver to", async () => {
  const endpoint = "https://fcm.googleapis.com/notify-expired";
  enroll(endpoint);
  try {
    pushServiceAnswers(410);
    const response = await notify();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, sent: 0, failed: 0, pruned: 1, delivered: false, reason: "no_subscriptions" });
    validateResponse(body);
  } finally { globalThis.fetch = fetcher; removeSubscription(endpoint); }
});
