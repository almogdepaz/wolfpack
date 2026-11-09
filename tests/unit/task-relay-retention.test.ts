import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { VolatileRelayGateway } from "../../src/task-relay/volatile-gateway.ts";

for (const disposition of ["alive", "unavailable", "dead", "absent"] as const) test(`SQLite capacity retirement requires exact broker death/absence, not ${disposition}`, async () => {
  const root = mkdtempSync("/tmp/relay-retention-"), first = randomUUID(), next = randomUUID(), generation = randomUUID();
  let now = Date.now(), inspectRetained = false;
  const inspections: string[] = [];
  const gateway = new VolatileRelayGateway({ root, storage: "sqlite", limits: { registrations: 1 }, now: () => now,
    inspectSession: async selector => {
      inspections.push(selector);
      if (selector === first && inspectRetained) {
        if (disposition === "unavailable") throw new Error("broker unavailable");
        if (disposition === "absent") return { ok: false, code: "NOT_FOUND" };
        return { ok: true, session: "reused", sessionId: first, alive: disposition === "alive", projectPath: root, harness: "pi" };
      }
      return { ok: true, session: "reused", sessionId: selector, alive: true, projectPath: root, harness: "pi" };
    } });
  const connect = (session: string) => gateway.request({ operation: "connect", profile: "volatile-v1", callerSession: session, generation, protocolVersions: [2], leaseMs: 1 });
  try {
    const original = await connect(first); expect(original.ok).toBe(true);
    now += 10_000; gateway.maintenance(); inspectRetained = true;
    const replacement = await connect(next);
    if (disposition === "dead" || disposition === "absent") expect(replacement.ok).toBe(true);
    else {
      expect(replacement).toMatchObject({ ok: false, error: { code: "RELAY_CAPACITY" } });
      inspectRetained = false;
      const resumed = await connect(first);
      expect(resumed).toMatchObject({ ok: true, epoch: original.epoch, value: { endpoint: (original as any).value.endpoint } });
    }
    expect(inspections).toContain(first);
  } finally { await gateway.close(); rmSync(root, { recursive: true, force: true }); }
});

test("durable retirement retains accepted mail and dedup receipts through death, lease expiry and reopen", async () => {
  const root = mkdtempSync("/tmp/relay-retention-mail-"), a = randomUUID(), b = randomUUID(), c = randomUUID();
  let now = Date.now(), dead = false;
  const options = { root, storage: "sqlite" as const, limits: { registrations: 2 }, now: () => now,
    inspectSession: async (selector: string) => ({ ok: true as const, sessionId: selector, session: "fixture", alive: !dead || selector === c, projectPath: root, harness: "pi" }) };
  let gateway = new VolatileRelayGateway(options);
  const connect = async (session: string) => gateway.request({ operation: "connect", profile: "volatile-v1", callerSession: session, generation: session, protocolVersions: [2], leaseMs: 100 });
  try {
    const aa = await connect(a) as any, bb = await connect(b) as any;
    const bound = { profile: "volatile-v1", epoch: aa.epoch, callerSession: a, endpoint: aa.value.endpoint };
    const envelope = { envelopeId: randomUUID(), protocolVersion: 2, createdAt: new Date(now).toISOString(), source: aa.value.endpoint, target: bb.value.endpoint, payload: { opaque: true } };
    expect(await gateway.request({ ...bound, operation: "send", envelope })).toMatchObject({ ok: true });
    await gateway.close(); gateway = new VolatileRelayGateway(options);
    now += 1000; dead = true; gateway.maintenance();
    expect(await connect(c)).toMatchObject({ ok: false, error: { code: "RELAY_CAPACITY" } });
    dead = false;
    expect(await connect(b)).toMatchObject({ ok: true, value: { endpoint: bb.value.endpoint } });
    const target = { ...bound, callerSession: b, endpoint: bb.value.endpoint };
    expect(await gateway.request({ ...target, operation: "receive", cursor: "0" })).toMatchObject({ ok: true, value: { deliveries: [{ envelope }] } });
    expect(await gateway.request({ ...target, operation: "acknowledge", envelopeId: envelope.envelopeId })).toMatchObject({ ok: true });
    now += 1000; dead = true;
    expect(await connect(c)).toMatchObject({ ok: false, error: { code: "RELAY_CAPACITY" } });
    // Receipts remain obligations until the bounded dedup retention expires.
    now += 9 * 86_400_000; gateway.maintenance();
    expect(await connect(c)).toMatchObject({ ok: true });
  } finally { await gateway.close(); rmSync(root, { recursive: true, force: true }); }
});


test("a delayed authoritative death observation cannot retire a concurrently renewed registration", async () => {
  const root = mkdtempSync("/tmp/relay-retention-race-"), first = randomUUID(), next = randomUUID();
  let now = Date.now(), probe = false, observed!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { observed = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const gateway = new VolatileRelayGateway({ root, storage: "sqlite", limits: { registrations: 1 }, now: () => now,
    inspectSession: async selector => {
      if (probe && selector === first) { observed(); await gate; return { ok: true, sessionId: first, session: "fixture", alive: false, projectPath: root, harness: "pi" }; }
      return { ok: true, sessionId: selector, session: "fixture", alive: true, projectPath: root, harness: "pi" };
    } });
  const connect = (session: string) => gateway.request({ operation: "connect", profile: "volatile-v1", callerSession: session, generation: session, protocolVersions: [2], leaseMs: 100 });
  try {
    const original = await connect(first); now += 1000; probe = true;
    const pending = connect(next); await entered; probe = false;
    const renewed = await connect(first); expect(renewed).toMatchObject({ ok: true, value: { endpoint: (original as any).value.endpoint } });
    release(); expect(await pending).toMatchObject({ ok: false, error: { code: "RELAY_CAPACITY" } });
    expect(await connect(first)).toMatchObject({ ok: true, value: { endpoint: (original as any).value.endpoint } });
  } finally { release(); await gateway.close(); rmSync(root, { recursive: true, force: true }); }
});
