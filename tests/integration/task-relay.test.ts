import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalTestMode = process.env.WOLFPACK_TEST;
process.env.WOLFPACK_TEST = "1";
const root = mkdtempSync(join(tmpdir(), "wolfpack-task-relay-http-"));
mkdirSync(join(root, "project"), { recursive: true });

const { __setTestBackend } = await import("../../src/server/backend.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");
const {
  TaskRelayGateway,
  __resetTaskRelayGatewayForTests,
  __setTaskRelayGatewayForTests,
  getTaskRelayGateway,
} = await import("../../src/task-relay/gateway.ts");
const { RELAY_ID, RELAY_PROTOCOL_VERSION } = await import("../../src/task-relay/domain.ts");
const { createServerInstance } = await import("../../src/server/index.ts");

class PiBackend extends MockBackend {
  override async listIdentities() {
    const now = new Date(0).toISOString();
    return {
      sender: { wolfpackSessionId: "sender-id", wolfpackSessionName: "sender", projectPath: join(root, "project"), agentKind: "pi", createdAt: now, updatedAt: now },
      receiver: { wolfpackSessionId: "receiver-id", wolfpackSessionName: "receiver", projectPath: join(root, "project"), agentKind: "pi", createdAt: now, updatedAt: now },
    };
  }
}

__setTestBackend(new PiBackend({ sessions: ["sender", "receiver"] }));
__setTaskRelayGatewayForTests(new TaskRelayGateway({
  root: join(root, "relay"),
  peerOrigin: "https://sender.example.ts.net",
  peerFetch: (input, init) => globalThis.fetch(input, init),
}));
const { server } = createServerInstance();
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => (server as Server).listen(0, "127.0.0.1", () => {
    base = `http://127.0.0.1:${((server as Server).address() as AddressInfo).port}`;
    resolve();
  }));
});

afterAll(async () => {
  try {
    await new Promise<void>((resolve, reject) => {
      (server as Server).close((error) => error ? reject(error) : resolve());
    });
  } finally {
    __resetTaskRelayGatewayForTests();
    rmSync(root, { recursive: true, force: true });
    if (originalTestMode === undefined) delete process.env.WOLFPACK_TEST;
    else process.env.WOLFPACK_TEST = originalTestMode;
  }
});

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("task relay v2 routes", () => {
  test("resolves a trusted peer topology through HTTP into a persisted opaque endpoint", async () => {
    const remoteEndpoint = { relay: RELAY_ID, id: "2af8af29-c4fe-44f9-9a99-9a0e35952d74" };
    const resolved = await post("/api/task-relay/v2/peer/resolve", {
      origin: "https://receiver.example.ts.net",
      endpoint: remoteEndpoint,
    });

    expect(resolved.status).toBe(200);
    const body = await resolved.json() as { readonly ok: boolean; readonly endpoint: { readonly relay: string; readonly id: string } };
    expect(body).toMatchObject({ ok: true, endpoint: { id: remoteEndpoint.id } });
    expect(body.endpoint.relay).toMatch(/^wolfpack-pi-tasks-v2:peer:[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toContain("receiver.example.ts.net");
    await expect(getTaskRelayGateway().resolve({ callerSession: "sender", target: body.endpoint, protocolVersion: RELAY_PROTOCOL_VERSION })).resolves.toMatchObject({
      ok: true,
      endpoint: body.endpoint,
    });
  });

  test("uses the production Tailnet origin for opaque remote forwarding", async () => {
    const systemFetch = globalThis.fetch;
    let outbound: Record<string, unknown> | undefined;
    const peerFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).startsWith("https://receiver.example.ts.net/api/task-relay/v2/peer/receive")) {
        outbound = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ ok: true });
      }
      return systemFetch(input, init);
    }) as unknown as typeof fetch;
    globalThis.fetch = peerFetch;
    try {
      const senderConnect = await post("/api/task-relay/v2/connect", { callerSession: "sender", generation: "production-process", protocolVersions: [RELAY_PROTOCOL_VERSION] });
      const sender = await senderConnect.json() as { readonly endpoint: { readonly relay: string; readonly id: string } };
      const relay = getTaskRelayGateway();
      const target = { relay: await relay.peerRelay("https://receiver.example.ts.net"), id: "2af8af29-c4fe-44f9-9a99-9a0e35952d74" };
      expect(target.relay).toMatch(/^wolfpack-pi-tasks-v2:peer:[0-9a-f-]{36}$/);

      const accepted = await post("/api/task-relay/v2/send", {
        callerSession: "sender",
        envelope: {
          envelopeId: "production-remote-envelope", protocolVersion: RELAY_PROTOCOL_VERSION, source: sender.endpoint, target,
          payload: { content: "opaque" }, createdAt: new Date(0).toISOString(),
        },
      });
      expect(await accepted.json()).toMatchObject({ ok: true, forwarding: "forwarded" });
      expect(outbound).toMatchObject({ source: { relay: RELAY_ID }, target: { relay: RELAY_ID } });
      expect(JSON.stringify(outbound)).not.toContain("sender.example.ts.net");
      expect(JSON.stringify(outbound)).not.toContain("receiver.example.ts.net");
    } finally {
      globalThis.fetch = systemFetch;
    }
  });

  test("registers opaque Pi endpoints through session inspection and routes an opaque durable mailbox", async () => {
    const senderConnect = await post("/api/task-relay/v2/connect", { callerSession: "sender", generation: "sender-process", protocolVersions: [RELAY_PROTOCOL_VERSION] });
    const receiverConnect = await post("/api/task-relay/v2/connect", { callerSession: "receiver", generation: "receiver-process", protocolVersions: [RELAY_PROTOCOL_VERSION] });
    expect(senderConnect.status).toBe(200);
    expect(receiverConnect.status).toBe(200);
    const sender = await senderConnect.json() as { readonly endpoint: { readonly relay: string; readonly id: string } };
    const receiver = await receiverConnect.json() as { readonly endpoint: { readonly relay: string; readonly id: string } };

    const sessionProjection = await fetch(`${base}/api/session-control/status?session=receiver`);
    expect(await sessionProjection.json()).toMatchObject({ taskEndpoint: receiver.endpoint });
    const accepted = await post("/api/task-relay/v2/send", {
      callerSession: "sender",
      envelope: {
        envelopeId: "route-envelope", protocolVersion: RELAY_PROTOCOL_VERSION, source: sender.endpoint, target: receiver.endpoint,
        payload: { event: "unknown to wolfpack", taskId: "not indexed" }, createdAt: new Date(0).toISOString(),
      },
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true, forwarding: "local" });
    const inbox = await fetch(`${base}/api/task-relay/v2/receive?callerSession=receiver&cursor=0`);
    expect(await inbox.json()).toMatchObject({ envelopes: [expect.objectContaining({ envelopeId: "route-envelope" })] });
    const acknowledgement = await post("/api/task-relay/v2/delivery-ack", { callerSession: "receiver", envelopeId: "route-envelope" });
    expect(acknowledgement.status).toBe(200);
  });
});
