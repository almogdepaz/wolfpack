import { types as utilTypes } from "node:util";
import type { TaskRelayGateway } from "./gateway.ts";
import type { SessionInspectionResult } from "../session-status-contract.ts";
import type { VolatileResult } from "./volatile-protocol.ts";

export type RelayGateway = Pick<TaskRelayGateway, keyof TaskRelayGateway>;

/** Wire arguments differ from the public gateway only for the cleanup Date cutoff. */
export interface RelayWorkerGateway extends Omit<RelayGateway, "cleanup"> {
  cleanup(beforeMs: number): Promise<number>;
  volatileEpoch(): Promise<string | undefined>;
  volatile(input: unknown): Promise<VolatileResult>;
  volatilePeer(input: unknown): Promise<VolatileResult>;
  volatileTopology(input: unknown): Promise<VolatileResult>;
}

export const RELAY_WORKER_METHODS = [
  "initialize", "peerRelay", "resolvePeerEndpoint", "connect", "endpointForSession", "endpointsForSessions", "registrationsForSessions",
  "disconnect", "resolve", "send", "receive", "acknowledgeDelivery", "receivePeer", "flushPeerOutbox", "cleanup", "volatileEpoch", "volatile", "volatilePeer", "volatileTopology",
] as const satisfies readonly (keyof RelayWorkerGateway)[];
export type RelayWorkerMethod = typeof RELAY_WORKER_METHODS[number];
export const RELAY_WORKER_LIMITS = {
  regularRequests: 28, peerRequests: 4, regularBytes: 3 * 1024 * 1024, peerBytes: 1024 * 1024,
  requestBytes: 256 * 1024, responseBytes: 1024 * 1024,
  activeRegular: 4, activePeer: 2, startupMs: 30_000, requestMs: 60_000,
} as const;

export interface WorkerOptions {
  root: string;
  profile?: "volatile-v1";
  peerOrigin?: string;
  retryIntervalMs?: number;
  retentionMs?: number;
  cleanupIntervalMs?: number;
  proxyPeerFetch: boolean;
}
export type WorkerRequest = { kind: "request"; id: number; method: RelayWorkerMethod; args: unknown[] };
export type CallbackRequest = { kind: "inspect"; id: number; selector: string }
  | { kind: "peer-fetch"; id: number; url: string; body: string };
export type CallbackValue = SessionInspectionResult | { status: number; body: string };
export type ParentMessage = WorkerRequest | { kind: "callback"; id: number; value?: CallbackValue; error?: string };
export type WorkerMessage = { kind: "ready" } | CallbackRequest
  | { kind: "result"; id: number; value?: unknown; error?: string };

export class RelayWireBudgetError extends Error {}

/**
 * Capture only inert data, BEFORE postMessage can clone it. JSON projection alone
 * is not a bound on structured-clone values (e.g. ArrayBuffer projects to {}).
 * Budgets count JSON UTF-8 bytes, with 9 bytes for undefined and a tagged Map
 * representation. They do not describe JS heap/structured-clone allocator bytes.
 * No getters, toJSON, custom iterators or caller-owned graphs reach postMessage.
 */
export function captureRelayWire<T>(input: T, limit: number, allowMaps = false): { value: T; bytes: number } {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError("invalid relay wire budget");
  let bytes = 0;
  const ancestors = new Set<object>();
  const invalid = (): never => { throw new TypeError("unsupported relay wire value"); };
  const charge = (size: number) => {
    if (size > limit - bytes) throw new RelayWireBudgetError("relay wire byte budget exceeded");
    bytes += size;
  };
  const string = (value: string) => {
    // UTF-8 JSON is never shorter than the original UTF-16 code-unit count.
    // Avoid first allocating an unbounded escaped serialization just to reject it.
    if (value.length + 2 > limit - bytes) throw new RelayWireBudgetError("relay wire byte budget exceeded");
    charge(Buffer.byteLength(JSON.stringify(value)));
  };
  const visit = (value: unknown): unknown => {
    if (value === null) { charge(4); return null; }
    switch (typeof value) {
      case "undefined": charge(9); return undefined;
      case "string": string(value); return value;
      case "boolean": charge(value ? 4 : 5); return value;
      case "number":
        if (!Number.isFinite(value)) return invalid();
        charge(Object.is(value, -0) ? 2 : String(value).length); return value;
      case "object": break;
      default: return invalid();
    }
    // Proxy reflection traps are executable and could re-enter admission mid-capture.
    if (utilTypes.isProxy(value) || ancestors.has(value)) return invalid();
    ancestors.add(value);
    try {
      const prototype = Object.getPrototypeOf(value);
      const array = Array.isArray(value);
      const map = allowMaps && prototype === Map.prototype;
      // Reject exotic prototypes before enumerating (a typed array can have millions of keys).
      if (!map && (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)) return invalid();
      const keys = Reflect.ownKeys(value);
      if (map) {
        if (keys.length) return invalid();
        charge(11); // {"$map":[]} (internal accounting only; value stays a Map)
        const copy = new Map<string, unknown>();
        for (const [key, item] of Map.prototype.entries.call(value) as MapIterator<[unknown, unknown]>) {
          if (typeof key !== "string") return invalid();
          if (copy.size) charge(1);
          charge(3); string(key); // [key,value]
          copy.set(key, visit(item));
        }
        return copy;
      }
      charge(2); // brackets/braces
      if (array) {
        const length = Object.getOwnPropertyDescriptor(value, "length")!.value as number;
        // Reject sparse arrays/custom properties instead of normalizing or omitting them.
        if (keys.length !== length + 1) return invalid();
        if (length > limit - bytes) throw new RelayWireBudgetError("relay wire byte budget exceeded");
        for (const key of keys) {
          if (key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)) return invalid();
        }
        const copy: unknown[] = [];
        for (let i = 0; i < length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
          if (i) charge(1);
          copy.push(visit(descriptor.value));
        }
        return copy;
      }
      const copy = Object.create(null) as Record<string, unknown>;
      let count = 0;
      for (const key of keys) {
        if (typeof key !== "string") return invalid();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
        if (count++) charge(1);
        string(key); charge(1);
        copy[key] = visit(descriptor.value);
      }
      return copy;
    } finally { ancestors.delete(value); }
  };
  return { value: visit(input) as T, bytes };
}

export function relayWireBytes(value: unknown): number {
  return captureRelayWire(value, RELAY_WORKER_LIMITS.responseBytes, true).bytes;
}
