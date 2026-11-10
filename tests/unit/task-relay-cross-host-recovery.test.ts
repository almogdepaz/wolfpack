import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { VolatileRelayGateway } from "../../src/task-relay/volatile-gateway.ts";

const profile = "volatile-v1";
test("cross-host accepted-before-confirmation survives both journals reopening and retries the original envelope", async () => {
  const root = mkdtempSync(join(tmpdir(), "cross-host-recovery-")), sourceId = randomUUID(), targetId = randomUUID(), generation = randomUUID();
  let now = Date.now(), lose = true, deliveries = 0;
  let source: VolatileRelayGateway, destination: VolatileRelayGateway;
  const inspectSession = async (selector: string) => ({ ok: true as const, session: "reusable-name", sessionId: selector, projectPath: root, harness: "pi", alive: true });
  const boot = () => {
    destination = new VolatileRelayGateway({ root: join(root, "b"), storage: "sqlite", peerOrigin: "https://b.tail123.ts.net", inspectSession, now: () => now });
    source = new VolatileRelayGateway({ root: join(root, "a"), storage: "sqlite", peerOrigin: "https://a.tail123.ts.net", inspectSession, now: () => now,
      peerFetch: async (_url, init) => { deliveries++; const result = await destination.peer(JSON.parse(String(init?.body))); if (lose) { lose = false; throw new Error("accepted response lost"); } return Response.json(result); },
    });
  };
  boot();
  const connect = async (gateway: VolatileRelayGateway, session: string) => {
    const reply = await gateway.request({ operation: "connect", profile, callerSession: session, generation, protocolVersions: [2] });
    if (!reply.ok || reply.value.kind !== "connected") throw new Error(JSON.stringify(reply));
    return { profile, epoch: reply.epoch, callerSession: session, endpoint: reply.value.endpoint };
  };
  try {
    const a = await connect(source!, sourceId), b = await connect(destination!, targetId);
    const route = await source!.topology({ ...a, operation: "resolvePeer", origin: "https://b.tail123.ts.net", peerEpoch: b.epoch, target: b.endpoint });
    if (!route.ok || route.value.kind !== "resolved") throw new Error("route failed");
    const envelope = { envelopeId: randomUUID(), protocolVersion: 2, source: a.endpoint, target: route.value.endpoint, createdAt: new Date(now).toISOString(), payload: { task: "one assignment" } };
    expect(await source!.request({ ...a, operation: "send", envelope })).toMatchObject({ ok: false, error: { code: "PEER_UNREACHABLE", mayHaveBeenDelivered: true } });
    const before = await destination!.request({ ...b, operation: "receive", cursor: "0" });
    expect(before.ok && before.value.kind === "page" && before.value.deliveries).toHaveLength(1);
    await source!.close(); await destination!.close(); boot(); now += 1001;
    expect(await connect(source!, sourceId)).toEqual(a); expect(await connect(destination!, targetId)).toEqual(b);
    const confirmed = await source!.request({ ...a, operation: "send", envelope });
    expect(confirmed).toMatchObject({ ok: true, value: { kind: "accepted", duplicate: true } });
    expect(deliveries).toBe(2);
    expect(await destination!.request({ ...b, operation: "receive", cursor: "0" })).toEqual(before);
  } finally { await source!.close(); await destination!.close(); rmSync(root, { recursive: true, force: true }); }
});

test("same-name replacement registers separately and cannot receive the old authoritative UUID's state", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-name-reuse-")), original = randomUUID(), replacement = randomUUID();
  let nameOwner = original;
  const gateway = new VolatileRelayGateway({ root, storage: "sqlite", inspectSession: async selector => ({ ok: true, session: "same-name", sessionId: selector === "same-name" ? nameOwner : selector, projectPath: root, harness: "pi", alive: true }) });
  try {
    const generation = randomUUID();
    const registered = await gateway.request({ operation: "connect", profile, callerSession: original, generation, protocolVersions: [2] });
    expect(registered.ok).toBe(true); if (!registered.ok || registered.value.kind !== "connected") throw new Error("connect failed");
    nameOwner = replacement;
    const fresh = await gateway.request({ operation: "connect", profile, callerSession: "same-name", generation, protocolVersions: [2] });
    expect(fresh.ok).toBe(true);
    if (fresh.ok && fresh.value.kind === "connected") expect(fresh.value.endpoint).not.toEqual(registered.value.endpoint);
    expect(await gateway.request({ operation: "receive", profile, epoch: registered.epoch, callerSession: replacement, endpoint: registered.value.endpoint, cursor: "0" })).toMatchObject({ ok: false, error: { code: "SOURCE_MISMATCH" } });
  } finally { await gateway.close(); rmSync(root, { recursive: true, force: true }); }
});
