/** Isolated real-store workload. No live state, installs or service changes.
 * WOLFPACK_TEST=1 bun scripts/storage-performance.ts [task-append-count=500] [--blobs]
 * Counts include actual filesystem calls; timing is host-local, not a latency SLO. */
import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { CanonicalTaskEvent } from "../src/tasks/domain.ts";
import { AGENT_KIND } from "../src/agent-kind.ts";

const root = fs.mkdtempSync("/tmp/wp-storage-perf-");
process.env.WOLFPACK_TEST = "1";
process.env.WOLFPACK_DIR = join(root, "wolfpack");
const { TaskStore } = await import("../src/tasks/store.ts");
const { ExtensionRuntime } = await import("../src/extensions/runtime.ts");
const { ExtensionRouteService } = await import("../src/server/extension-routes.ts");
const count = Number(process.argv[2] ?? 500);
const blobMode = process.argv.includes("--blobs");
if (!Number.isSafeInteger(count) || count < 1 || count > 5000) throw new Error("append count must be 1..5000");
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function bytes(value: unknown): number {
  return typeof value === "string" ? Buffer.byteLength(value) : ArrayBuffer.isView(value) ? value.byteLength : 0;
}
function observeIo() {
  const writes = spyOn(fs, "writeFileSync"), appends = spyOn(fs, "appendFileSync");
  const renames = spyOn(fs, "renameSync"), syncs = spyOn(fs, "fsyncSync"), reads = spyOn(fs, "readSync");
  return {
    counts() {
      if (writes.mock.calls.length !== renames.mock.calls.length) throw new Error("unexpected non-atomic write in measured workload");
      const cache = { writes: 0, bytes: 0 }, inbox = { writes: 0, bytes: 0 }, other = { writes: 0, bytes: 0 };
      renames.mock.calls.forEach(([, destination], index) => {
        const path = String(destination);
        const bucket = path.endsWith("inbox-index.json") ? inbox : path.includes("/cache/") ? cache : other;
        bucket.writes++; bucket.bytes += bytes(writes.mock.calls[index]![1]);
      });
      return { ledgerAppends: appends.mock.calls.length, ledgerBytes: appends.mock.calls.reduce((n, call) => n + bytes(call[1]), 0),
        fsyncs: syncs.mock.calls.length, cache, inbox, otherAtomic: other,
        reads: reads.mock.calls.length, readBytes: reads.mock.results.reduce((n, result) => n + (result.type === "return" && typeof result.value === "number" ? result.value : 0), 0) };
    },
    reset() { for (const spy of [writes, appends, renames, syncs, reads]) spy.mockClear(); },
    restore() { for (const spy of [writes, appends, renames, syncs, reads]) spy.mockRestore(); },
  };
}
async function measure(label: string, operation: () => Promise<void>, io: ReturnType<typeof observeIo>) {
  await turn(); io.reset();
  const start = performance.now();
  const timer = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - start), 0));
  await operation();
  const burstMs = performance.now() - start, beforeYield = io.counts();
  const firstTimerDelayMs = await timer;
  await turn(); await turn(); // include any coalesced derived persistence
  console.log(JSON.stringify({ label, burstMs, firstTimerDelayMs, settledMs: performance.now() - start, beforeYield, settled: io.counts() }));
}

const parent = { machine: "source", sessionId: "parent" }, receiver = { machine: "target", sessionId: "receiver" };
const sender = { machine: "source", sessionId: "sender" }, participants = { parent, receiver, sender };
const time = "2026-09-01T00:00:00.000Z";
const store = new TaskStore({ root: join(root, "tasks") });
const ledgers = [];
for (let index = 0; index < 16; index++) {
  const taskId = `task-${index}`;
  const created = await store.createLedger({ role: "sender", participants, assignment: {
    taskId, source: parent, target: receiver, task: "isolated storage workload", createdAt: time, expiresAt: "2026-09-02T00:00:00.000Z",
    context: undefined, role: undefined, metadata: undefined, onCompletePrompt: undefined,
  } });
  if (created.kind !== "created") throw new Error("expected fresh ledger");
  ledgers.push(created.ledger);
}
const ledger = ledgers[0]!;
function event(id: string, sequence: number, type: "task.created" | "task.received" | "task.information"): CanonicalTaskEvent {
  const base = { id, taskId: ledger.key.taskId, sequence: String(sequence), occurredAt: time,
    replyToMessageId: undefined, payload: { kind: "none" as const }, completion: undefined };
  if (type === "task.received") return { ...base, type, actor: "receiver", source: receiver, destination: parent, message: undefined };
  if (type === "task.created") return { ...base, type, actor: "parent", source: parent, destination: receiver, message: undefined };
  return { ...base, type, actor: "parent", source: parent, destination: receiver, message: "representative immutable task message" };
}
await store.appendEvent(ledger, event("created", 1, "task.created"));
await store.appendEvent(ledger, event("received", 2, "task.received"));
await turn();
const io = observeIo();
try {
  console.log(JSON.stringify({ label: "workload", count, ledgers: ledgers.length, root }));
  await measure("task-diagnostics", async () => {
    for (let index = 0; index < count; index++) await store.appendDiagnostic(ledger, { id: `diagnostic-${index}`, code: "probe", message: "isolated diagnostic", occurredAt: time });
  }, io);
  await measure("task-canonical-events", async () => {
    for (let index = 0; index < count; index++) await store.appendEvent(ledger, event(`information-${index}`, index + 3, "task.information"));
  }, io);
  await measure("task-restart", async () => {
    const restarted = new TaskStore({ root: store.root });
    await restarted.initialize();
    if ((await restarted.getLedger(ledger.key))?.records.length !== count * 2 + 2) throw new Error("restart lost records");
  }, io);
} finally { io.restore(); }

const installationId = "a0a80123-1234-4234-9234-123456789abc", sessionId = "b0a80123-1234-4234-9234-123456789abc";
const runtime = new ExtensionRuntime({ root: join(root, "extensions"), installationId });
let inventoryBytes = 0;
for (let index = 0; index < 4; index++) {
  for (const version of ["1.0.0", "1.1.0"]) {
    const source = join(root, `package-${index}-${version}`);
    fs.mkdirSync(join(source, "data"), { recursive: true });
    fs.writeFileSync(join(source, "package.json"), JSON.stringify({ name: `fixture-${index}`, version, wolfpack: {
      manifestVersion: 1, apiVersion: 1, id: `fixture-${index}`, skills: [], documents: [{ id: "context", schemaVersion: 1, schema: "schema.json" }],
      ...(blobMode ? { blobs: { maxBlobBytes: 64 } } : {}),
    } }));
    fs.writeFileSync(join(source, "schema.json"), JSON.stringify({ type: "object", required: ["goal"], properties: { goal: { type: "string" } }, additionalProperties: false }));
    for (let file = 0; file < 16; file++) fs.writeFileSync(join(source, "data", `${file}.txt`), Buffer.alloc(64 * 1024, index + version.length));
    inventoryBytes += fs.statSync(join(source, "package.json")).size + fs.statSync(join(source, "schema.json")).size + 16 * 64 * 1024;
    await runtime.install({ source, trustBrowserCode: true });
  }
}
const service = new ExtensionRouteService({ runtime, backend: { async listSessionFacts() { return [{ name: "scope", alive: true, identity: { wolfpackSessionId: sessionId, wolfpackSessionName: "scope", projectPath: root, agentKind: AGENT_KIND.PI.id, createdAt: time, updatedAt: time } }]; } } });
const server = createServer((req, res) => { void service.handle(req, res, new URL(req.url!, "http://localhost")).then(handled => {
  if (!handled) { res.writeHead(404); res.end(); }
}, error => { res.writeHead(500); res.end(String(error)); }); });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const blobBytes = Buffer.from([0, 1, 255]), blobDigest = createHash("sha256").update(blobBytes).digest("hex");
if (blobMode) {
  const { ExtensionBlobStore } = await import("../src/extensions/blob-store.ts");
  new ExtensionBlobStore({ root: runtime.root }).put({ installationId, extensionId: "fixture-0" }, blobDigest, blobBytes, 64);
}
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/extensions/${blobMode ? `blobs/fixture-0/${blobDigest}` : "documents/fixture-0/context"}`;
const extensionIo = observeIo();
try {
  console.log(JSON.stringify({ label: "extension-workload", blobMode, packages: 4, snapshots: 8, inventoryBytes, requestsPerKind: 10 }));
  for (const kind of ["GET", blobMode ? "PUT" : "POST"] as const) {
    let maxTimerGapMs = 0, last = performance.now();
    const heartbeat = setInterval(() => { const now = performance.now(); maxTimerGapMs = Math.max(maxTimerGapMs, now - last); last = now; }, 1);
    try {
      await measure(`extension-${kind}`, async () => {
        for (let index = 0; index < 10; index++) {
          const target = kind === "GET" ? (blobMode ? url : `${url}?session=${sessionId}`) : (blobMode ? `${url}?session=${sessionId}` : url);
          const response = await fetch(target, kind === "GET" ? undefined : {
            method: kind, headers: { "Content-Type": blobMode ? "application/octet-stream" : "application/json" },
            body: blobMode ? blobBytes : JSON.stringify({ sessionId, document: { goal: `publish-${index}` }, ifRevision: index, requestId: randomUUID(), schemaVersion: 1 }),
          });
          const body = await response.text();
          if (response.status !== 200) throw new Error(`${response.status}: ${body}`);
        }
      }, extensionIo);
    } finally { clearInterval(heartbeat); }
    console.log(JSON.stringify({ label: `extension-${kind}-heartbeat`, maxTimerGapMs }));
  }
} finally {
  extensionIo.restore();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
}
