import { expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { VolatileRelayGateway } from "../../src/task-relay/volatile-gateway.ts";
import { RESTART_SAFE_RELAY_TIMING } from "../../src/task-relay/memory-store.ts";

const source = process.env.WOLFPACK_PI_TASKS_SOURCE;
async function fixture(beforeInspect?: (selector: string) => Promise<void>) {
  const { createConfiguredTaskCore } = await import(pathToFileURL(join(source!, "src/configured-task-core.ts")).href);
  const root = mkdtempSync("/tmp/relay-fresh-generation-"), ids = { a: randomUUID(), b: randomUUID() };
  let now = Date.now();
  const clock = { get now() { return now; }, set now(value: number) { now = value; setSystemTime(value); } };
  setSystemTime(now);
  const requests: any[] = [], cores: any[] = [];
  const gateway = new VolatileRelayGateway({ root, storage: "sqlite", now: () => clock.now,
    inspectSession: async selector => {
      await beforeInspect?.(selector);
      return { ok: true, sessionId: ids[selector as keyof typeof ids] ?? selector,
        session: selector, alive: true, projectPath: root, harness: "pi" };
    } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json(); requests.push(body);
    return Response.json(await gateway.request(body));
  } });
  const open = async (name: "a" | "b") => {
    const core = await createConfiguredTaskCore({ sessionName: name, baseUrl: server.url.origin });
    cores.push(core); return core;
  };
  const bound = (name: string, endpoint: unknown) => ({ profile: "volatile-v1", epoch: gateway.epoch, callerSession: name, endpoint });
  return { clock, requests, gateway, open, bound, async close() {
    await Promise.all(cores.map(core => core.close())); await server.stop(true); await gateway.close();
    rmSync(root, { recursive: true, force: true }); setSystemTime();
  } };
}

test.skipIf(!source)("configured fresh generation replaces an empty predecessor; same generation and stale endpoint authority stay isolated", async () => {
  const f = await fixture();
  try {
    const first = await f.open("a"), old = first.endpoint;
    const next = await f.open("a"); expect(next.endpoint).not.toEqual(old);
    f.clock.now += 61_000;
    await next.connect(); expect(next.endpoint).not.toEqual(old);
    const current = next.endpoint;
    await next.connect(); expect(next.endpoint).toEqual(current);
    for (const operation of ["send", "receive", "acknowledge"]) {
      const envelope = { envelopeId: randomUUID(), protocolVersion: 2, source: old, target: current,
        createdAt: new Date(f.clock.now).toISOString(), payload: "stale endpoint must not act" };
      const extra = operation === "send" ? { envelope } : operation === "receive" ? { cursor: "0" } : { envelopeId: envelope.envelopeId };
      expect(await f.gateway.request({ ...f.bound("a", old), operation, ...extra })).toMatchObject({ ok: false, error: { code: "REGISTRATION_EXPIRED" } });
    }
    await next.receive();
    expect(f.requests.filter(item => item.operation === "receive").at(-1).cursor).toBe("0");
    expect(next.listTasks()).toHaveLength(0);
    // No predecessor tombstone exists in this zero-reference case. A normal
    // delayed g1 renewal must not replace g2 with another fresh endpoint.
    expect(await first.connect().then(() => undefined, (error: unknown) => error)).toMatchObject({ code: "RELAY_RESET" });
    await next.connect(); expect(next.endpoint).toEqual(current);
    expect(await f.gateway.request({ ...f.bound("a", current), operation: "health" })).toMatchObject({ ok: true });
  } finally { await f.close(); }
});

for (const retained of [false, true]) test.skipIf(!source)(`a delayed target inspection cannot resurrect a replaced generation (retained=${retained})`, async () => {
  let delay = false, entered!: () => void, release!: () => void;
  const observed = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async selector => { if (delay && selector !== "a" && selector !== "b") { entered(); await gate; } });
  try {
    const a = await f.open("a"), b = await f.open("b"), old = a.endpoint;
    if (retained) {
      const completed = { envelopeId: randomUUID(), protocolVersion: 2, source: b.endpoint, target: old,
        createdAt: new Date(f.clock.now).toISOString(), payload: "already transport-ACKed" };
      expect(await f.gateway.request({ ...f.bound("b", b.endpoint), operation: "send", envelope: completed })).toMatchObject({ ok: true });
      expect(await f.gateway.request({ ...f.bound("a", old), operation: "acknowledge", envelopeId: completed.envelopeId })).toMatchObject({ ok: true });
    }
    delay = true;
    const envelope = { envelopeId: randomUUID(), protocolVersion: 2, source: b.endpoint, target: old,
      createdAt: new Date(f.clock.now).toISOString(), payload: "late send must not revive predecessor" };
    const pending = f.gateway.request({ ...f.bound("b", b.endpoint), operation: "send", envelope });
    await observed; const next = await f.open("a"); release();
    expect(await pending).toMatchObject({ ok: false, error: { code: "TARGET_NOT_REGISTERED" } });
    await next.receive(); expect(next.listTasks()).toHaveLength(0);
    expect(await f.gateway.request({ ...f.bound("a", next.endpoint), operation: "health" })).toMatchObject({ ok: true });
  } finally { release(); await f.close(); }
});

test.skipIf(!source)("an exact retry remains confirmed when its mailbox becomes terminal and retained during broker inspection", async () => {
  let delay = false, entered!: () => void, release!: () => void;
  const observed = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async selector => { if (delay && selector !== "a" && selector !== "b") { entered(); await gate; } });
  try {
    const a = await f.open("a"), b = await f.open("b");
    const envelope = { envelopeId: randomUUID(), protocolVersion: 2, source: b.endpoint, target: a.endpoint,
      createdAt: new Date(f.clock.now).toISOString(), payload: "already accepted, concurrently ACKed" };
    const send = () => f.gateway.request({ ...f.bound("b", b.endpoint), operation: "send", envelope });
    const accepted = await send() as any; expect(accepted.ok).toBe(true);
    delay = true; const pending = send(); await observed;
    expect(await f.gateway.request({ ...f.bound("a", a.endpoint), operation: "acknowledge", envelopeId: envelope.envelopeId })).toMatchObject({ ok: true });
    const fresh = await f.open("a"); release();
    expect(await pending).toMatchObject({ ok: true, value: { duplicate: true, acceptanceId: accepted.value.acceptanceId } });
    await fresh.receive(); expect(fresh.listTasks()).toHaveLength(0);
  } finally { release(); await f.close(); }
});

test.skipIf(!source)("mail arriving during fresh-generation inspection prevents predecessor replacement", async () => {
  let delay = false, entered!: () => void, release!: () => void;
  const observed = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async selector => { if (delay && selector === "a") { entered(); await gate; } });
  try {
    const a = await f.open("a"), b = await f.open("b"); delay = true;
    const pending = f.open("a").then(() => undefined, error => error);
    await observed;
    const envelope = { envelopeId: randomUUID(), protocolVersion: 2, source: b.endpoint, target: a.endpoint,
      createdAt: new Date(f.clock.now).toISOString(), payload: "accepted during inspection" };
    expect(await f.gateway.request({ ...f.bound("b", b.endpoint), operation: "send", envelope })).toMatchObject({ ok: true });
    release(); expect(await pending).toMatchObject({ code: "RELAY_RESET" });
    expect(await f.gateway.request({ ...f.bound("a", a.endpoint), operation: "receive", cursor: "0" })).toMatchObject({ ok: true, value: { deliveries: [{ envelope }] } });
  } finally { release(); await f.close(); }
});

test.skipIf(!source)("completed transport receipts retain evidence without blocking a configured fresh client or reviving a stale client after pruning", async () => {
  const f = await fixture();
  try {
    const a = await f.open("a"), b = await f.open("b");
    const task = await a.createTask({ target: b.endpoint, task: "complete before reload", timeoutMs: 300_000 });
    const drain = async (core: any) => {
      for (const item of await core.receive()) if (item.kind === "relay") await core.acknowledgeRelayDelivery(item.delivery.cursor);
    };
    await drain(b); await b.submitIntent({ taskId: task.taskId, type: "task.completed", payload: { summary: "done" } });
    await drain(a); await a.acknowledgeParent(task.taskId); await drain(b); await drain(a); await drain(b);
    expect(a.getTask(task.taskId).status).toBe("completed");
    expect(b.getTask(task.taskId).events.some((event: any) => event.type === "task.parent_acknowledged")).toBe(true);
    const health = async () => await f.gateway.request({ ...f.bound("b", b.endpoint), operation: "health" }) as any;
    expect((await health()).value.store).toMatchObject({ activeItems: 0 });
    expect((await health()).value.store.receipts).toBeGreaterThan(0);
    const old = a.endpoint, completedAt = f.clock.now;
    f.clock.now += 61_000; await a.connect(); await b.connect(); await a.receive();
    expect(a.endpoint).toEqual(old);
    expect(BigInt(f.requests.filter(item => item.operation === "receive" && item.callerSession === "a").at(-1).cursor)).toBeGreaterThan(0n);
    const oldConnect = f.requests.filter(item => item.operation === "connect" && item.callerSession === "a").at(-1);
    const fresh = await f.open("a"); expect(fresh.endpoint).not.toEqual(old);
    expect(fresh.listTasks()).toHaveLength(0); await fresh.receive();
    expect(f.requests.filter(item => item.operation === "receive" && item.callerSession === "a").at(-1).cursor).toBe("0");
    expect((await health()).value.store).toMatchObject({ registrations: 3, sessions: 2, activeItems: 0 });
    expect(await f.gateway.request(oldConnect)).toMatchObject({ ok: false, error: { code: "RELAY_RESET" } });
    for (const operation of ["send", "receive", "acknowledge"]) {
      const envelope = { envelopeId: randomUUID(), protocolVersion: 2, source: old, target: fresh.endpoint,
        createdAt: new Date(f.clock.now).toISOString(), payload: "no predecessor authority" };
      const extra = operation === "send" ? { envelope } : operation === "receive" ? { cursor: "0" } : { envelopeId: envelope.envelopeId };
      expect(await f.gateway.request({ ...f.bound("a", old), operation, ...extra })).toMatchObject({ ok: false, error: { code: "REGISTRATION_EXPIRED" } });
    }
    const newTask = await fresh.createTask({ target: b.endpoint, task: "fresh tools work immediately", timeoutMs: 300_000 });
    await drain(b); expect(b.getTask(newTask.taskId).task).toBe("fresh tools work immediately");
    f.clock.now = completedAt + RESTART_SAFE_RELAY_TIMING.receiptMs + 1; f.gateway.maintenance();
    await fresh.connect(); await b.connect();
    expect((await health()).value.store).toMatchObject({ registrations: 2, sessions: 2 });
    // This still-live predecessor has not attempted reconnect since replacement.
    // Its normal epoch-bearing renewal must stay fenced after its tombstone is gone.
    const endpoint = fresh.endpoint;
    expect(await a.connect().then(() => undefined, (error: unknown) => error)).toMatchObject({ code: "RELAY_RESET" });
    await fresh.connect(); expect(fresh.endpoint).toEqual(endpoint);
    expect(fresh.getTask(newTask.taskId).task).toBe("fresh tools work immediately");
  } finally { await f.close(); }
});
