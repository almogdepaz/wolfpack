import type { TaskRelayGateway } from "./gateway.ts";
import type { SessionInspectionResult } from "../session-status-contract.ts";

export type RelayGateway = Pick<TaskRelayGateway, keyof TaskRelayGateway>;
export const RELAY_WORKER_METHODS = [
  "initialize", "peerRelay", "resolvePeerEndpoint", "connect", "endpointForSession", "endpointsForSessions",
  "disconnect", "resolve", "send", "receive", "acknowledgeDelivery", "receivePeer", "flushPeerOutbox", "cleanup",
] as const satisfies readonly (keyof RelayGateway)[];
export type RelayWorkerMethod = typeof RELAY_WORKER_METHODS[number];
export const RELAY_WORKER_LIMITS = {
  regularRequests: 28, peerRequests: 4, regularBytes: 3 * 1024 * 1024, peerBytes: 1024 * 1024,
  requestBytes: 256 * 1024, responseBytes: 1024 * 1024,
  activeRegular: 4, activePeer: 2, startupMs: 30_000, requestMs: 60_000,
} as const;

export interface WorkerOptions {
  root: string;
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

// Structured clone, not a JSON round-trip, preserves invalid values for the owning validator.
// Maps occur only in the internal session-list projection; count their entries too.
export function relayWireBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, (_key, item) => item instanceof Map ? [...item] : item) ?? "null");
}
