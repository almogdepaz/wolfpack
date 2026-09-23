import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dueSlots, errorCode, MAX_SENDS_IN_FLIGHT, number, POLL_MS, record, ROUTE, SEND_INTERVAL_MS, startSampling, text, trace } from "./measurement.ts";
import { createArchive } from "./archive.ts";

// Structural boundary for the explicitly pinned external package; no copied implementation.
interface Endpoint { readonly relay: string; readonly id: string }
interface Delivery { readonly cursor: string; readonly envelope: { readonly taskId: string; readonly envelopeId: string } }
export interface Core {
  readonly endpoint: Endpoint;
  createTask(input: { target: Endpoint; task: string; timeoutMs: number }): Promise<{ taskId: string }>;
  receive(): Promise<readonly Delivery[]>;
  acknowledgeRelayDelivery(cursor: string): Promise<void>;
  getTask(taskId: string): unknown;
  listTasks(): readonly unknown[];
  flushOutbox(): Promise<void>;
}
interface Session {
  connect(): Promise<Core>;
  status(): { binding: unknown };
  close(): void;
}
interface Store { close(): void; outbox(state: "pending" | "accepted"): readonly unknown[]; quarantinedOutbox(): readonly unknown[] }
interface AdapterModule {
  createTaskStore(): Store;
  createVolatileTaskSession(options: { callerSession: string; store: Store; url: string; fetch: typeof fetch }): Session;
}
interface SendSample {
  readonly sequence: number; readonly scheduled: number; readonly dispatched: number; readonly lateness: number;
  outcome: string; completed: number | null; taskId: string | null;
}
const root = text(process.argv[2]);
const config = record(JSON.parse(readFileSync(join(root, "adapter.json"), "utf8")));
const source = text(config.source), baseA = text(config.baseA), baseB = text(config.baseB);
for (const base of [baseA, baseB]) if (new URL(base).hostname !== "127.0.0.1") throw new Error("private ingress required");
const exports: unknown = await import(pathToFileURL(join(source, "src/index.ts")).href);
if (typeof record(exports).createTaskStore !== "function" || typeof record(exports).createVolatileTaskSession !== "function") throw new Error("adapter exports unavailable");
const adapter = exports as AdapterModule; // Source HEAD/cleanliness is checked by the controller before import.
const requests = trace(join(root, "requests.jsonl")), failures = trace(join(root, "failures.jsonl"));
const sends: SendSample[] = [], deliveries: unknown[] = [];
const authenticated = Object.assign(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  if (url.origin !== baseA && url.origin !== baseB) throw new Error("adapter external request denied");
  const body = record(JSON.parse(String(init?.body)));
  const started = Date.now(), headers = new Headers(init?.headers);
  headers.set("authorization", text(config.authorization));
  try {
    const response = await fetch(input, { ...init, headers });
    const failure = response.ok ? undefined : await response.clone().json();
    requests.push({ started, completed: Date.now(), operation: body.operation, caller: body.callerSession, status: response.status, ...(failure !== undefined && { failure }) });
    return response;
  } catch (error) {
    requests.push({ started, completed: Date.now(), operation: body.operation, caller: body.callerSession, error: errorCode(error) });
    throw error;
  }
}, { preconnect: fetch.preconnect });
const stores = [adapter.createTaskStore(), adapter.createTaskStore()];
const sessions = stores.map((store, index) => adapter.createVolatileTaskSession({
  callerSession: index ? "receiver" : "sender", store, url: (index ? baseB : baseA) + ROUTE, fetch: authenticated,
}));
const [sender, receiver] = await Promise.all(sessions.map(session => session.connect()));
if (!sender || !receiver) throw new Error("missing cores");
let target = receiver.endpoint;
if (baseA !== baseB) {
  const binding = record(sessions[0]!.status().binding);
  const response = await authenticated(baseA + ROUTE + "/resolve-peer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    profile: binding.profile, epoch: binding.epoch, endpoint: binding.endpoint, callerSession: "sender", origin: config.peerOrigin, target,
  }) });
  const reply = record(await response.json());
  if (!response.ok || reply.ok !== true) throw new Error(`peer qualification failed: ${JSON.stringify(reply)}`);
  const endpoint = record(record(reply.value).endpoint);
  target = { relay: text(endpoint.relay), id: text(endpoint.id) };
}
const archives = config.archiveEvents === undefined ? undefined : await Promise.all(["sender-history", "receiver-history"].map(name => createArchive(source, join(root, name), number(config.archiveEvents))));
if (archives && (sender.listTasks().length || receiver.listTasks().length)) throw new Error("archive restored operational tasks");
const seeded: string[] = [];
for (let index = 0; index < number(config.seedMailbox ?? 0); index++) {
  const created = await sender.createTask({ target, task: "seed".repeat(256), timeoutMs: 3_600_000 });
  seeded.push(created.taskId);
  await Bun.sleep(SEND_INTERVAL_MS); // Seed at the declared offered rate, not an unrelated startup burst.
}
async function health(session: Session, base: string, caller: string): Promise<unknown> {
  const binding = record(session.status().binding);
  const response = await authenticated(base + ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    profile: binding.profile, epoch: binding.epoch, endpoint: binding.endpoint, callerSession: caller, operation: "health",
  }) });
  return response.json();
}
if (config.fixedCohort === true) {
  for (let round = 0; round < 4; round++) {
    if (!archives) throw new Error("fixed cohort requires archive path");
    await archives[1]!.poll(receiver); await archives[0]!.poll(sender);
    if (round < 3) await Bun.sleep(POLL_MS);
  }
}
const state = (): unknown => ({ at: Date.now(), tasks: [sender.listTasks().length, receiver.listTasks().length],
  pending: stores.map(store => store.outbox("pending").length), quarantined: stores.map(store => store.quarantinedOutbox().length),
  entries: archives?.map(archive => archive.entries()) });
const initialState = state();
const initialHealth = await health(sessions[1]!, baseB, "receiver");
writeFileSync(join(root, "adapter-ready.json"), JSON.stringify({ pid: process.pid, nonce: config.nonce, target }), { mode: 0o600 });
let started = false;
process.on("message", (message: unknown) => {
  const input = record(message);
  if (input.kind !== "run" || started) throw new Error("unexpected adapter command");
  started = true;
  void run(number(input.start), number(input.duration), number(input.payloadBytes), input.load === true).catch(error => {
    writeFileSync(join(root, "adapter-fatal.json"), JSON.stringify({ code: errorCode(error), message: String(error) }));
    process.exitCode = 1;
    for (const session of sessions) session.close();
    for (const store of stores) store.close();
    process.disconnect?.();
  });
});
async function run(start: number, duration: number, payloadBytes: number, load: boolean): Promise<void> {
  const sampling = startSampling(join(root, "samples.jsonl"));
  const interval = number(config.sendIntervalMs ?? SEND_INTERVAL_MS);
  const loadDuration = Math.min(duration, number(config.loadDurationMs ?? duration));
  const count = load ? Math.floor(loadDuration / interval) : 0;
  const healthSamples = trace(join(root, "health.jsonl"));
  let next = 0, active = 0, nextPoll = start + POLL_MS, polling = false;
  const pending = new Set<Promise<void>>(), observed = new Set<string>();
  const dispatch = (sample: SendSample): void => {
    active++;
    const operation = (async () => {
      try {
        const created = await sender!.createTask({ target, task: "x".repeat(payloadBytes), timeoutMs: 3_600_000 });
        sample.taskId = created.taskId; sample.outcome = "accepted";
      } catch (error) {
        sample.outcome = errorCode(error);
        if (error && typeof error === "object" && "details" in error && error.details && typeof error.details === "object" && "taskId" in error.details && typeof error.details.taskId === "string") sample.taskId = error.details.taskId;
      }
      finally { sample.completed = Date.now(); active--; }
    })();
    pending.add(operation); void operation.finally(() => pending.delete(operation));
  };
  interface DeliverySample { taskId: string; envelopeId: string; incorporated: number; ackStart: number; acknowledged: number | null; duplicate: boolean }
  const byCursor = new Map<string, DeliverySample>();
  const instrumentedReceiver: Core = {
    ...receiver!,
    async receive() {
      const page = await receiver!.receive();
      const incorporated = Date.now();
      for (const delivery of page) {
        if (!receiver!.getTask(delivery.envelope.taskId)) throw new Error("delivery missing from endpoint state");
        const sample: DeliverySample = { taskId: delivery.envelope.taskId, envelopeId: delivery.envelope.envelopeId,
          incorporated, ackStart: 0, acknowledged: null, duplicate: observed.has(delivery.envelope.envelopeId) };
        observed.add(delivery.envelope.envelopeId); deliveries.push(sample); byCursor.set(delivery.cursor, sample);
      }
      return page;
    },
    async acknowledgeRelayDelivery(cursor) {
      const sample = byCursor.get(cursor);
      if (sample) sample.ackStart = Date.now();
      await receiver!.acknowledgeRelayDelivery(cursor);
      if (sample) sample.acknowledged = Date.now();
      byCursor.delete(cursor);
    },
  };
  const poll = async (): Promise<void> => {
    polling = true;
    const pollStarted = performance.now();
    try {
      if (archives) {
        await archives[1]!.poll(instrumentedReceiver); await archives[0]!.poll(sender!);
      } else {
        for (const delivery of await instrumentedReceiver.receive()) {
          try { await instrumentedReceiver.acknowledgeRelayDelivery(delivery.cursor); }
          catch (error) { failures.push({ at: Date.now(), operation: "acknowledge", code: errorCode(error), taskId: delivery.envelope.taskId }); }
        }
        // Native transport renews leases on operations; retain shipped 5s idle polling.
        await sender!.receive();
      }
    } catch (error) { failures.push({ at: Date.now(), operation: "receive", code: errorCode(error) }); }
    finally { polling = false; }
    healthSamples.push({ at: Date.now(), pollMs: performance.now() - pollStarted,
      sender: await health(sessions[0]!, baseA, "sender"), receiver: await health(sessions[1]!, baseB, "receiver"), state: state() });
  };
  const end = start + duration, drainEnd = end + 2 * POLL_MS + 1_000;
  while (Date.now() < drainEnd) {
    const now = Date.now();
    for (const slot of dueSlots(start, Math.min(now, end), interval, next, count)) {
      const sample: SendSample = { sequence: next++, ...slot, outcome: "in_flight", completed: null, taskId: null };
      sends.push(sample);
      if (active >= MAX_SENDS_IN_FLIGHT || now >= end) { sample.outcome = "controller_backpressure"; sample.completed = now; }
      else dispatch(sample);
    }
    if (now >= nextPoll && !polling) {
      nextPoll += Math.max(1, Math.floor((now - nextPoll) / POLL_MS) + 1) * POLL_MS;
      const operation = poll(); pending.add(operation); void operation.finally(() => pending.delete(operation));
    }
    await Bun.sleep(5);
  }
  await Promise.all(pending);
  const finalHealth = await health(sessions[1]!, baseB, "receiver");
  writeFileSync(join(root, "adapter-metrics.json"), JSON.stringify({ start, end, count, seeded, initialHealth, finalHealth, initialState, finalState: state(), healthSamples,
    archive: archives?.map(archive => ({ ...archive.info, finalEntries: archive.entries(), writes: archive.writes })),
    capturesUnacknowledgedIncorporation: true, sends, deliveries, requests, failures, ...sampling.stop() }), { mode: 0o600 });
  for (const session of sessions) session.close();
  for (const store of stores) store.close();
  process.disconnect?.();
}
