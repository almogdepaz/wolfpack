import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { assertNotificationFixtureHome } from "./run-notification-test.ts";
assertNotificationFixtureHome();
const { CONFIG_PATH, saveConfig } = await import("../../../src/cli/config.ts");
const { MockBackend } = await import("../../../src/server/mock-backend.ts");
const { __setTestBackend, getBackend } = await import("../../../src/server/backend.ts");
const { addSubscription, removeSubscription } = await import("../../../src/server/push.ts");
const { __runSessionNotificationObservationForTests, stopSessionNotificationObserver } = await import("../../../src/server/session-observation.ts");
const { buildMachineHandshake } = await import("../../../src/tailnet-machine-contract.ts");

test("a stalled peer cannot hold local observation or the next local pass", async () => {
  const previousConfig = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH) : undefined;
  const previousStatus = process.env.WOLFPACK_TAILSCALE_STATUS_JSON;
  const previousFetch = globalThis.fetch;
  const previousBackend = getBackend();
  const endpoint = "https://fcm.googleapis.com/observer-isolation";
  let lists = 0, peerRequests = 0;
  class EmptyBackend extends MockBackend {
    override async listSessionFacts() { lists++; return []; }
  }
  let release!: (value: Response) => void;
  let started!: () => void;
  const peerStarted = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<Response>(resolve => { release = resolve; });
  const handshake = buildMachineHandshake({ tailscaleHostname: "peer.test.ts.net", tailscaleNodeId: "n123", installationId: "12345678-1234-4234-8234-123456789abc", displayName: "peer", version: "1.0.0" });
  saveConfig({ devDir: "/tmp", port: 18799, tailscaleHostname: "home.test.ts.net" });
  process.env.WOLFPACK_TAILSCALE_STATUS_JSON = JSON.stringify({ BackendState: "Running", Self: { ID: "home", DNSName: "home.test.ts.net", Online: true }, Peer: { peer: { ID: "n123", DNSName: "peer.test.ts.net", Online: true } } });
  __setTestBackend(new EmptyBackend({ sessions: [] }));
  addSubscription({ endpoint, keys: { p256dh: "x", auth: "x" } });
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    peerRequests++;
    if (String(input).endsWith("/api/machine")) { started(); return blocked; }
    return Response.json({ sessions: [] });
  }, { preconnect: previousFetch.preconnect });
  const local = __runSessionNotificationObservationForTests();
  let completed = false;
  void local.then(() => { completed = true; });
  try {
    await peerStarted;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(completed).toBe(true);
    await __runSessionNotificationObservationForTests();
    expect(lists).toBe(2);
    expect(peerRequests).toBe(1); // A single peer pass remains in flight.
  } finally {
    release(Response.json(handshake));
    await local;
    await stopSessionNotificationObserver();
    globalThis.fetch = previousFetch;
    __setTestBackend(previousBackend);
    removeSubscription(endpoint);
    if (previousConfig) writeFileSync(CONFIG_PATH, previousConfig); else unlinkSync(CONFIG_PATH);
    if (previousStatus === undefined) delete process.env.WOLFPACK_TAILSCALE_STATUS_JSON; else process.env.WOLFPACK_TAILSCALE_STATUS_JSON = previousStatus;
  }
});
