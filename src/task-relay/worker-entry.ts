import { parentPort, workerData } from "node:worker_threads";
import { TaskRelayGateway } from "./gateway.ts";
import {
  RELAY_WORKER_LIMITS as LIMIT, RELAY_WORKER_METHODS, captureRelayWire,
  type WorkerOptions, type WorkerRequest, type ParentMessage, type CallbackValue,
} from "./worker-protocol.ts";
import type { SessionInspectionResult } from "../session-status-contract.ts";

if (!parentPort) throw new Error("relay worker entry requires a parent port");
const port = parentPort;
const options = workerData as WorkerOptions;
const callbacks = new Map<number, { resolve(value: CallbackValue): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
let callbackId = 0;
function callback(request: { kind: "inspect"; selector: string } | { kind: "peer-fetch"; url: string; body: string }): Promise<CallbackValue> {
  if (callbacks.size >= 8) return Promise.reject(new Error("relay host callback budget exceeded"));
  const id = callbackId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { callbacks.delete(id); reject(new Error("relay host callback timed out")); }, request.kind === "peer-fetch" ? 5_000 : 15_000);
    callbacks.set(id, { resolve, reject, timer });
    port.postMessage({ ...request, id });
  });
}
const gateway = new TaskRelayGateway({
  ...options,
  inspectSession: async selector => await callback({ kind: "inspect", selector }) as SessionInspectionResult,
  ...(options.proxyPeerFetch && { peerFetch: async (url: RequestInfo | URL, init?: RequestInit) => {
    const reply = await callback({ kind: "peer-fetch", url: String(url), body: String(init?.body) }) as { status: number; body: string };
    return new Response(reply.body, { status: reply.status });
  } }),
});
const regular: WorkerRequest[] = [], peers: WorkerRequest[] = [];
const requests = new Map<number, { peer: boolean; bytes: number }>();
let activeRegular = 0, activePeer = 0;
const methods = new Set<string>(RELAY_WORKER_METHODS);
function pump(): void {
  for (const peer of [true, false]) {
    const queue = peer ? peers : regular;
    while (queue.length && (peer ? activePeer < LIMIT.activePeer : activeRegular < LIMIT.activeRegular)) {
      const request = queue.shift()!;
      if (peer) activePeer++; else activeRegular++;
      void (async () => {
        try {
          const method = gateway[request.method] as (...args: unknown[]) => Promise<unknown>;
          const value = await method.apply(gateway, request.args);
          const captured = captureRelayWire(value, LIMIT.responseBytes, true);
          port.postMessage({ kind: "result", id: request.id, value: captured.value });
        } catch {
          // The parent returns STORE_UNAVAILABLE, not a fabricated acceptance or leaked file path.
          port.postMessage({ kind: "result", id: request.id, error: "relay operation unavailable" });
        } finally {
          requests.delete(request.id);
          if (peer) activePeer--; else activeRegular--;
          pump();
        }
      })();
    }
  }
}
port.on("message", (message: ParentMessage) => {
  if (!message || typeof message !== "object") throw new Error("invalid relay parent message");
  if (message.kind === "callback") {
    const pending = callbacks.get(message.id);
    if (!pending) return; // timed-out host work may finish later; it has no current authority
    callbacks.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error("relay host callback unavailable")); else pending.resolve(message.value!);
    return;
  }
  if (message.kind !== "request" || !Number.isSafeInteger(message.id) || message.id < 0
    || !methods.has(message.method) || !Array.isArray(message.args) || requests.has(message.id)) throw new Error("invalid relay worker request");
  const peer = message.method === "receivePeer";
  const existing = [...requests.values()].filter(item => item.peer === peer);
  const captured = captureRelayWire(message.args, LIMIT.requestBytes);
  let args = captured.value;
  if (message.method === "cleanup") {
    const [beforeMs] = args;
    const before = typeof beforeMs === "number" ? new Date(beforeMs) : undefined;
    if (args.length !== 1 || !Number.isFinite(beforeMs) || before === undefined || Number.isNaN(before.getTime())) {
      throw new Error("invalid relay cleanup cutoff");
    }
    args = [before];
  }
  const bytes = captured.bytes;
  if (bytes > LIMIT.requestBytes || existing.length >= (peer ? LIMIT.peerRequests : LIMIT.regularRequests)
    || existing.reduce((sum, item) => sum + item.bytes, bytes) > (peer ? LIMIT.peerBytes : LIMIT.regularBytes)) throw new Error("relay worker admission budget exceeded");
  requests.set(message.id, { peer, bytes });
  (peer ? peers : regular).push({ ...message, args });
  pump();
});
port.on("close", () => gateway.close());
port.postMessage({ kind: "ready" });
