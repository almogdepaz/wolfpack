import { expect, test } from "bun:test";
import { mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AGENT_KIND } from "../../src/agent-kind.ts";
import { WorkerRelayGateway } from "../../src/task-relay/worker-client.ts";
import type { RelayEnvelope } from "../../src/task-relay/domain.ts";
import type { VolatileBinding } from "../../src/task-relay/volatile-protocol.ts";

const root = () => mkdtempSync(join(tmpdir(), "relay-worker-test-"));
const inspect = async (selector: string) => ({ ok: true as const, session: selector, sessionId: selector, projectPath: "/tmp", harness: AGENT_KIND.PI.id, alive: true });
const input = (callerSession: string) => ({ profile: "volatile-v1" as const, operation: "connect", callerSession, generation: "generation", protocolVersions: [2] });
async function connect(gateway: WorkerRelayGateway, callerSession: string): Promise<VolatileBinding> {
  const result = await gateway.volatile(input(callerSession));
  if (!result.ok || result.value.kind !== "connected") throw new Error(JSON.stringify(result));
  return { profile: "volatile-v1", epoch: result.epoch, callerSession, endpoint: result.value.endpoint };
}
const tick = () => new Promise(r => setTimeout(r, 10));
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await tick(); }
  throw new Error("test readiness timeout");
}

test("worker owns snapshots, dedup/conflicts, individual ACKs and loses all state on restart", async () => {
  const directory = root(); let g = new WorkerRelayGateway({ root: directory, inspectSession: inspect });
  try {
    const registration = input("sender");
    const pending = g.volatile(registration); registration.generation = "mutated";
    const first = await pending; if (!first.ok || first.value.kind !== "connected") throw new Error("connect failed");
    const source = await connect(g, "sender"), target = await connect(g, "receiver");
    expect(source.endpoint).toEqual(first.value.endpoint); // Original generation was captured before mutation.
    const original: RelayEnvelope = { envelopeId: randomUUID(), source: source.endpoint, target: target.endpoint, protocolVersion: 2, createdAt: new Date().toISOString(), payload: { text: "original" } };
    const submitted = structuredClone(original);
    const sent = g.volatile({ ...source, operation: "send", envelope: submitted });
    (submitted.payload as { text: string }).text = "mutated";
    expect(await sent).toMatchObject({ ok: true, value: { kind: "accepted", duplicate: false, forwarding: "local" } });
    expect(await g.volatile({ ...source, operation: "send", envelope: original })).toMatchObject({ ok: true, value: { duplicate: true } });
    expect(await g.volatile({ ...source, operation: "send", envelope: submitted })).toMatchObject({ ok: false, error: { code: "ENVELOPE_CONFLICT" } });
    expect(await g.volatile({ ...target, operation: "send", envelope: original })).toMatchObject({ ok: false, error: { code: "SOURCE_MISMATCH" } });
    expect(await g.volatile({ ...source, operation: "send", envelope: { ...original, payload: { value: NaN } } })).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    class NotJson { value = "must not become plain after cloning"; }
    const nonJson = { ...original, payload: new NotJson() as unknown as RelayEnvelope["payload"] };
    expect(await g.volatile({ ...source, operation: "send", envelope: nonJson })).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(await g.volatilePeer({ origin: "https://sender.example.ts.net", envelope: nonJson })).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    const page = await g.volatile({ ...target, operation: "receive", cursor: "0" });
    expect(page).toMatchObject({ ok: true, value: { kind: "page", deliveries: [{ cursor: "1", envelope: original }], nextCursor: "1" } });
    expect(await g.volatile({ ...target, operation: "acknowledge", envelopeId: original.envelopeId })).toMatchObject({ ok: true, value: { kind: "acknowledged", duplicate: false } });
    expect(await g.volatile({ ...target, operation: "acknowledge", envelopeId: original.envelopeId })).toMatchObject({ ok: true, value: { duplicate: true } });
    const endpoints = await g.endpointsForSessions(["sender", "receiver"]);
    expect(endpoints.get("sender")).toEqual(source.endpoint); (endpoints as Map<string, unknown>).clear();
    expect((await g.endpointsForSessions(["sender"])).get("sender")).toEqual(source.endpoint);
    expect(existsSync(join(directory, "relay-state.json"))).toBe(false);
    expect(readdirSync(directory)).toEqual([]); // No hidden default investigation/history spool either.
    await g.close();
    g = new WorkerRelayGateway({ root: directory, inspectSession: inspect }); await g.initialize();
    expect((await g.registrationsForSessions(["sender", "receiver"])).size).toBe(0);
    expect(await g.volatile({ ...source, operation: "send", envelope: original })).toMatchObject({ ok: false, error: { code: "RELAY_RESET" } });
    expect(await g.volatile({ ...target, operation: "acknowledge", envelopeId: original.envelopeId })).toMatchObject({ ok: false, error: { code: "RELAY_RESET" } });
    const fresh = await connect(g, "receiver");
    expect(fresh.endpoint).not.toEqual(target.endpoint);
    expect(await g.volatile({ ...fresh, operation: "receive", cursor: "0" })).toMatchObject({ ok: true, value: { deliveries: [] } });
  } finally { await g.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("dead/missing host inspection fails closed while obsolete disk state is never read", async () => {
  const directory = root(); let alive = true;
  writeFileSync(join(directory, "relay-state.json"), "malformed retired ledger");
  const g = new WorkerRelayGateway({ root: directory, inspectSession: async selector => selector === "missing"
    ? { ok: false as const, code: "NOT_FOUND" as const } : ({ ...await inspect(selector), alive }) });
  try {
    const source = await connect(g, "sender");
    expect(await g.volatile(input("missing"))).toMatchObject({ ok: false, error: { code: "CALLER_NOT_FOUND" } });
    alive = false;
    expect(await g.volatile(input("sender"))).toMatchObject({ ok: false, error: { code: "CALLER_DEAD" } });
    alive = true;
    expect((await connect(g, "sender")).endpoint).toEqual(source.endpoint);
  } finally { await g.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("deadline stops owner and late inspection cannot affect replacement state", async () => {
  const directory = root(); let release!: () => void, held = false;
  const gate = new Promise<void>(r => { release = r; });
  const g = new WorkerRelayGateway({ root: directory, requestTimeoutMs: 1000, inspectSession: async selector => { held = true; await gate; return inspect(selector); } });
  let replacement: WorkerRelayGateway | undefined;
  try {
    await g.endpointsForSessions([]);
    expect(() => new WorkerRelayGateway({ root: directory })).toThrow("already has a worker owner");
    const pending = g.volatile({ ...input("sender"), generation: "old" }); await until(() => held);
    expect(await pending).toMatchObject({ ok: false, error: { code: "RELAY_RESET", retryable: false } });
    expect(await g.volatile(input("sender"))).toMatchObject({ ok: false, error: { code: "RELAY_RESET" } });
    await g.close(); replacement = new WorkerRelayGateway({ root: directory, inspectSession: inspect });
    const fresh = await connect(replacement, "sender"); release(); await tick();
    expect((await replacement.registrationsForSessions(["sender"])).get("sender")?.endpoint).toEqual(fresh.endpoint);
  } finally { release(); await g.close(); await replacement?.close(); rmSync(directory, { recursive: true, force: true }); }
});
