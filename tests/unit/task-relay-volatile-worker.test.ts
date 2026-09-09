import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkerRelayGateway } from "../../src/task-relay/worker-client.ts";
import { MEMORY_RELAY_PROFILE as profile } from "../../src/task-relay/memory-store.ts";
import { RELAY_ID } from "../../src/task-relay/domain.ts";
import { RELAY_WORKER_LIMITS } from "../../src/task-relay/worker-protocol.ts";

const inspection = (selector: string) => ({ ok: true as const, session: selector, sessionId: selector, projectPath: "/fixture", harness: "pi", alive: true });

test("profile bootstrap remains data-only and rejects irrelevant legacy lifecycle options", async () => {
  const root = mkdtempSync(join(tmpdir(), "volatile-options-")); let calls = 0;
  try {
    expect(() => new WorkerRelayGateway({ root, get profile(): "volatile-v1" { calls++; return profile; } })).toThrow("data properties");
    expect(calls).toBe(0);
    expect(() => new WorkerRelayGateway({ root, profile, retentionMs: 1000 })).toThrow("do not apply");
    const gateway = new WorkerRelayGateway({ root, profile, inspectSession: async selector => inspection(selector) });
    try { await gateway.initialize(); } finally { await gateway.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worker profiles cannot silently cross over or parse the other profile's ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), "volatile-exclusive-"));
  const ledger = join(root, "relay-state.json"), historical = "invalid historical ledger"; writeFileSync(ledger, historical);
  const legacy = new WorkerRelayGateway({ root, inspectSession: async selector => inspection(selector) });
  try { expect(await legacy.volatile({ operation: "connect", profile, callerSession: "a", generation: "g", protocolVersions: [2] })).toMatchObject({ ok: false, error: { code: "RELAY_PROFILE_REQUIRED" } }); }
  finally { await legacy.close(); }
  const gateway = new WorkerRelayGateway({ root, profile, inspectSession: async selector => inspection(selector) });
  try {
    await gateway.initialize();
    expect(await gateway.connect({ callerSession: "a", generation: "g", protocolVersions: [2] })).toMatchObject({ ok: false, error: { code: "INCOMPATIBLE_PROTOCOL" } });
    expect(await gateway.volatile({ operation: "connect", profile, callerSession: "a", generation: "g", protocolVersions: [2] })).toMatchObject({ ok: true, value: { kind: "connected" } });
    expect(readFileSync(ledger, "utf8")).toBe(historical);
  } finally { await gateway.close(); rmSync(root, { recursive: true, force: true }); }
  expect(await gateway.volatile({})).toMatchObject({ ok: false, error: { code: "RELAY_RESET", retryable: false, mayHaveBeenDelivered: true } });
});

test("volatile peer ingress retains the reserved lane while ordinary inspection slots are occupied", async () => {
  const root = mkdtempSync(join(tmpdir(), "volatile-peer-lane-"));
  let blocked = false, active = 0, release!: () => void, allStarted!: () => void;
  const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { allStarted = r; });
  const gateway = new WorkerRelayGateway({ root, profile, inspectSession: async selector => {
    if (blocked && selector === "source") { if (++active === 4) allStarted(); await gate; }
    return inspection(selector);
  } });
  const pending: Promise<unknown>[] = []; let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const source = await gateway.volatile({ operation: "connect", profile, callerSession: "source", generation: "g", protocolVersions: [2] });
    const target = await gateway.volatile({ operation: "connect", profile, callerSession: "target", generation: "g", protocolVersions: [2] });
    if (!source.ok || source.value.kind !== "connected" || !target.ok || target.value.kind !== "connected") throw new Error("fixture registration failed");
    blocked = true;
    for (let i = 0; i < 4; i++) pending.push(gateway.volatile({ operation: "receive", profile, epoch: source.epoch, callerSession: "source", endpoint: source.value.endpoint, cursor: "0" }));
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("reserved volatile peer lane was starved")), 1000); });
    await Promise.race([started, deadline]);
    const peer = gateway.volatilePeer({ operation: "receivePeer", profile, epoch: target.epoch, sourceEpoch: randomUUID(), origin: "https://peer.tail123.ts.net",
      envelope: { envelopeId: randomUUID(), protocolVersion: 2, source: { relay: RELAY_ID, id: randomUUID() }, target: target.value.endpoint, createdAt: new Date().toISOString(), payload: { opaque: true } } });
    expect(await Promise.race([peer, deadline])).toMatchObject({ ok: true, value: { kind: "accepted" } });
  } finally {
    if (timer) clearTimeout(timer); release(); await Promise.all(pending); await gateway.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("transient metadata RPC pressure does not poison the lifetime's epoch cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "volatile-metadata-pressure-"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const gateway = new WorkerRelayGateway({ root, profile, inspectSession: async selector => { await gate; return inspection(selector); } });
  const pending = Array.from({ length: RELAY_WORKER_LIMITS.regularRequests }, () => gateway.volatile({ operation: "connect", profile, callerSession: "source", generation: "g", protocolVersions: [2] }));
  try {
    await expect(gateway.volatileEpoch()).rejects.toBeDefined();
    release();
    const results = await Promise.all(pending); expect(results.every(result => result.ok)).toBe(true);
    const epoch = await gateway.volatileEpoch(); expect(epoch).toBe(results[0]!.epoch);
    expect(await gateway.volatileEpoch()).toBe(epoch); expect(gateway.profile).toBe(profile);
  } finally { release(); await Promise.all(pending); await gateway.close(); rmSync(root, { recursive: true, force: true }); }
});
