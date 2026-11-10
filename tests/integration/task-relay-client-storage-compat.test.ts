import { beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const client = process.env.WOLFPACK_PI_TASKS_SOURCE, clientRevision = process.env.WOLFPACK_PI_TASKS_REVISION;
const serverSource = process.env.PI_TASKS_WOLFPACK_SOURCE ?? join(import.meta.dir, "../..");
const serverRevision = process.env.PI_TASKS_WOLFPACK_REVISION;
const baselineClient = clientRevision === "015a0311add9c853d0d93c912546ca61e483a51f";
const baselineServer = serverRevision === "370fde0f481a067baa76a878fe8a0b3d49096eba";
beforeAll(() => {
  if (!client) return;
  for (const [source, revision] of [[client, clientRevision], [serverSource, serverRevision]] as const) {
    expect(revision).toMatch(/^[0-9a-f]{40}$/);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim()).toBe(revision!);
    expect(execFileSync("git", ["status", "--porcelain", "--untracked-files=no", "--", "src"], { cwd: source, encoding: "utf8" }).trim()).toBe("");
  }
});
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, error => error);
type Fault = "typed" | "unknown" | "broker" | "native";
async function fixture() {
  const { createTaskRelayGateway } = await import(pathToFileURL(join(serverSource, "src/task-relay/gateway.ts")).href);
  const { createTaskStore } = await import(pathToFileURL(join(client!, "src/task-store.ts")).href);
  const { createVolatileTaskSession } = await import(pathToFileURL(join(client!, "src/volatile-task-session.ts")).href);
  const { deliverTaskInbox } = await import(pathToFileURL(join(client!, "src/task-inbox.ts")).href);
  const root = mkdtempSync("/tmp/relay-storage-compat-"), ids = { a: randomUUID(), b: randomUUID() };
  let brokerFailure = false, fault: { operation: string; kind: Fault } | undefined;
  const calls: any[] = [], results: any[] = [], entries: any[] = [], dispatched: any[] = [];
  const host = {
    sendMessage(message: any, options: any) { entries.push({ type: "custom_message", ...message }); dispatched.push({ message, options }); },
    appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
  };
  const context = { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getEntries: () => entries } };
  const makeGateway = () => createTaskRelayGateway({ root, ...(!baselineServer && { storage: "sqlite" }), inspectSession: async (selector: string) => {
    if (brokerFailure) throw new Error("injected unavailable broker, not authoritative absence");
    return { ok: true, sessionId: ids[selector as keyof typeof ids] ?? selector, session: selector, alive: true, projectPath: root, harness: "pi" };
  } });
  let gateway = makeGateway();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as any; calls.push(body);
    const injected = fault?.operation === body.operation ? fault : undefined;
    if (injected) fault = undefined;
    if (injected?.kind === "broker") brokerFailure = true;
    if (injected?.kind === "native") {
      // Reopen the worker while these same client objects remain alive. An
      // existing exclusive SQLite owner can retain an already-open journal FD.
      await gateway.close(); chmodSync(root, 0o500); gateway = makeGateway();
    }
    let result: any;
    try { result = await gateway.volatile(body); results.push({ body, result }); }
    finally { brokerFailure = false; if (injected?.kind === "native") chmodSync(root, 0o700); }
    // Explicit response-fault injection AFTER real worker acceptance/ACK. This
    // does not claim the baseline memory server has native storage failures.
    if (result.ok && (injected?.kind === "typed" || injected?.kind === "unknown")) return Response.json({
      ok: false, profile: "volatile-v1", error: { code: injected.kind === "typed" ? "RELAY_STORAGE_UNCERTAIN" : "RELAY_STORAGE_FUTURE",
        ownerFatal: true, retryable: true, mayHaveBeenDelivered: true },
    }, { status: 503 });
    return Response.json(result, { status: result.ok ? 200 : 503 });
  } });
  const stores = [createTaskStore(), createTaskStore()];
  const sessions = ["a", "b"].map((callerSession, index) => createVolatileTaskSession({
    callerSession, store: stores[index], url: new URL("/api/task-relay/volatile-v1", server.url).href,
  }));
  const cores = await Promise.all(sessions.map(session => session.connect()));
  return { calls, results, stores, sessions, cores, dispatched, dispatch: (core: any) => deliverTaskInbox(host, core, context),
    inject(operation: string, kind: Fault) { fault = { operation, kind }; }, async close() {
    sessions.forEach(session => session.close()); stores.forEach((store: any) => store.close());
    await server.stop(true); await gateway.close(); rmSync(root, { recursive: true, force: true });
  } };
}

for (const kind of ["typed", "unknown", "broker", "native"] as const) test.skipIf(!client || (kind === "native" && baselineServer))(`live selected client preserves RAM after ${kind} send failure and retries only its original envelope`, async () => {
  const f = await fixture();
  try {
    const [a, b] = f.cores, binding = f.stores[0].getRelayTransportBinding();
    f.inject("send", kind);
    const error = await failure(a.createTask({ target: b.endpoint, task: "no replayed assignment effect", timeoutMs: 60_000 }));
    expect(error).toMatchObject({ code: kind === "broker" ? "RELAY_UNAVAILABLE" : kind === "unknown" || baselineClient ? "INVALID_RESPONSE" : "RELAY_STORAGE_UNCERTAIN" });
    const pending = f.stores[0].outbox("pending"); expect(pending).toHaveLength(1);
    const taskId = pending[0].envelope.taskId, tasks = a.listTasks();
    expect(f.stores[0].getRelayTransportBinding()).toEqual(binding);
    expect(f.sessions[0].status()).toEqual({ state: "ready", binding });
    expect(f.stores[0].getReceiveCursor()).toBe("0"); expect(f.stores[0].quarantinedOutbox()).toEqual([]);
    await Bun.sleep(20);
    expect(f.calls.filter(call => call.operation === "send")).toHaveLength(1);
    expect(a.listTasks()).toEqual(tasks); expect(f.stores[0].outbox("pending")).toEqual(pending);
    if (kind === "native") {
      const result = f.results.at(-1).result;
      expect(result).toMatchObject({ ok: false, error: { code: "RELAY_STORAGE_UNCERTAIN", ownerFatal: true } });
      await Bun.sleep((result.error.retryAfterMs ?? 1000) + 20);
    }
    await a.flushOutbox(); await a.flushOutbox();
    const sends = f.calls.filter(call => call.operation === "send"); expect(sends).toHaveLength(2); expect(sends[1]).toEqual(sends[0]);
    if (kind === "typed" || kind === "unknown") {
      const accepted = f.results.filter(item => item.body.operation === "send").map(item => item.result.value);
      expect(accepted[1]).toMatchObject({ acceptanceId: accepted[0].acceptanceId, duplicate: true });
    }
    await f.dispatch(b); await f.dispatch(b);
    expect(f.dispatched.filter(item => item.options.triggerTurn)).toHaveLength(1);
    expect(f.dispatched.filter(item => item.message.details.event?.type === "task.created")).toHaveLength(1);
    expect(b.getTask(taskId).events.filter((event: any) => event.type === "task.created")).toHaveLength(1);
    expect(f.stores[0].getRelayTransportBinding()).toEqual(binding);
    expect(f.stores[0].outbox("pending")).toHaveLength(0);
  } finally { await f.close(); }
});

for (const kind of ["typed", "unknown"] as const) test.skipIf(!client)(`live selected client preserves assignment and cursor across a committed ACK followed by ${kind} error`, async () => {
  const f = await fixture();
  try {
    const [a, b] = f.cores;
    const task = await a.createTask({ target: b.endpoint, task: "ACK must not replay assignment", timeoutMs: 60_000 });
    const delivery = (await b.receive()).find((item: any) => item.kind === "relay").delivery;
    const binding = f.stores[1].getRelayTransportBinding(), taskState = b.getTask(task.taskId);
    f.inject("acknowledge", kind);
    expect(await failure(b.acknowledgeRelayDelivery(delivery.cursor))).toMatchObject({ code: kind === "typed" && !baselineClient ? "RELAY_STORAGE_UNCERTAIN" : "INVALID_RESPONSE" });
    expect(f.stores[1].getReceiveCursor()).toBe("0"); expect(f.stores[1].getRelayTransportBinding()).toEqual(binding);
    expect(f.sessions[1].status()).toEqual({ state: "ready", binding }); expect(b.getTask(task.taskId)).toEqual(taskState);
    expect(f.stores[1].quarantinedOutbox()).toEqual([]);
    await b.repairAcknowledgements();
    const acks = f.calls.filter(call => call.operation === "acknowledge"); expect(acks).toHaveLength(2); expect(acks[1]).toEqual(acks[0]);
    expect(f.results.filter(item => item.body.operation === "acknowledge").at(-1).result).toMatchObject({ ok: true, value: { duplicate: true } });
    expect(f.stores[1].getReceiveCursor()).toBe(delivery.cursor);
    await b.receive(); expect(b.getTask(task.taskId).events.filter((event: any) => event.type === "task.created")).toHaveLength(1);
  } finally { await f.close(); }
});
