import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertNotificationFixtureHome } from "./run-notification-test.ts";
import { isJsonObject, validateControlApiSchemaValue } from "../../control-api-schema-validator.ts";
import type { JsonObject } from "../../control-api-schema-validator.ts";
assertNotificationFixtureHome();
const { CONTROL_API_SCHEMA_ARTIFACT } = await import("../../../src/control-api/schema.ts");
const { addSubscription, removeSubscription, _testing } = await import("../../../src/server/push.ts");
const { pushSubscriptionRoutes } = await import("../../../src/server/push-routes.ts");
const fetcher = globalThis.fetch;
const artifact = JSON.parse(readFileSync(CONTROL_API_SCHEMA_ARTIFACT, "utf8")) as JsonObject;
function validateResponse(status: number, body: unknown): void {
  const http = artifact.http;
  const operation = isJsonObject(http) ? http.sendTestNotification : undefined;
  if (!isJsonObject(operation)) throw new Error("missing push test schema");
  const schema = status === 200 ? operation.response
    : { $ref: status === 502 ? "#/$defs/PushTestDeliveryFailure" : "#/$defs/ErrorEnvelope" };
  expect(validateControlApiSchemaValue(schema, body, artifact)).toEqual([]);
}
const server = createServer((req, res) => {
  const route = pushSubscriptionRoutes[`${req.method} ${req.url}`];
  if (!route) { res.writeHead(404); res.end(); return; }
  void Promise.resolve(route(req, res)).catch(error => { res.writeHead(500); res.end(String(error)); });
});
let url: string;
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  url = `http://127.0.0.1:${address.port}/api/push/test`;
});
afterAll(async () => { globalThis.fetch = fetcher; await new Promise<void>(resolve => server.close(() => resolve())); });
const post = (body: unknown) => fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("test route rejects malformed/unknown endpoints and shares notify rate limit", async () => {
  _testing.resetDebounce();
  const malformed = await post({});
  expect(malformed.status).toBe(400);
  validateResponse(malformed.status, await malformed.json());
  const unknown = await post({ endpoint: "https://fcm.googleapis.com/unknown" });
  expect(unknown.status).toBe(404);
  validateResponse(unknown.status, await unknown.json());
  _testing.notifyTimestamps = Array(10).fill(Date.now());
  const limited = await post({ endpoint: "https://fcm.googleapis.com/unknown" });
  expect(limited.status).toBe(429);
  validateResponse(limited.status, await limited.json());
});

test("test notification delivers only to the registered caller endpoint and reports failure", async () => {
  _testing.resetDebounce();
  const client = createECDH("prime256v1"); client.generateKeys();
  const keys = { p256dh: client.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 2).toString("base64url") };
  const endpoint = "https://fcm.googleapis.com/test-caller";
  const other = "https://fcm.googleapis.com/test-other";
  addSubscription({ endpoint, keys }); addSubscription({ endpoint: other, keys });
  const calls: string[] = [];
  try {
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input)); return new Response(null, { status: 201 });
    }, { preconnect: fetcher.preconnect });
    const response = await post({ endpoint });
    expect(response.status).toBe(200);
    const success = await response.json();
    expect(success).toMatchObject({ sent: 1, failed: 0 });
    validateResponse(response.status, success);
    expect(calls).toEqual([endpoint]);
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 403 }), { preconnect: fetcher.preconnect });
    const rejected = await post({ endpoint });
    expect(rejected.status).toBe(502);
    validateResponse(rejected.status, await rejected.json());
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 410 }), { preconnect: fetcher.preconnect });
    const expired = await post({ endpoint });
    expect(expired.status).toBe(502);
    const expiredBody = await expired.json();
    expect(expiredBody).toEqual({ ok: false, sent: 0, failed: 0, pruned: 1 });
    validateResponse(expired.status, expiredBody);
  } finally { globalThis.fetch = fetcher; removeSubscription(endpoint); removeSubscription(other); }
});
