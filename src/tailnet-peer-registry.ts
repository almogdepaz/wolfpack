import {
  TAILNET_NODE_ID_PATTERN,
  classifyMachineHandshake,
} from "./tailnet-machine-contract.ts";
import type {
  MachineHandshake,
  TailnetMachineCandidate,
} from "./tailnet-machine-contract.ts";

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const MAX_CONCURRENT_PROBES = 8;
const DEFAULT_MAX_CONCURRENT_PROBES = MAX_CONCURRENT_PROBES;
const MAX_MACHINE_HANDSHAKE_RESPONSE_BYTES = 32 * 1024;
const OVERSIZED_MACHINE_HANDSHAKE_DIAGNOSTIC = "machine handshake response exceeds 32 KiB";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TAILNET_NODE_ID_REGEXP = new RegExp(TAILNET_NODE_ID_PATTERN);
const SETTLED_OBSERVER_FAILURE_DIAGNOSTIC = "tailnet probe settlement observer failed";

class MachineHandshakeTimedOutError extends Error {}
class MachineHandshakeResponseTooLargeError extends Error {}
class MachineHandshakeBodyReadError extends Error {}

export const LOCAL_MACHINE_IDENTITY = "local";

export type TailnetPeerStatus = "ready" | "offline" | "non-wolfpack" | "malformed" | "incompatible" | "unavailable";

export interface TailnetPeerProbe {
  readonly candidate: TailnetMachineCandidate;
  readonly status: TailnetPeerStatus;
  readonly handshake?: MachineHandshake;
  readonly diagnostic?: string;
}

export interface TailnetPeerEntry {
  readonly tailnetNodeId: string;
  readonly identity: string | undefined;
  readonly status: TailnetPeerStatus;
  /** Present after a valid handshake; unavailable entries retain it only as non-routable stale metadata. */
  readonly origin: string | undefined;
  readonly hostname: string;
  readonly displayName: string;
  readonly version: string | undefined;
  readonly diagnostic: string | undefined;
}

export interface TailnetPeerIdentityReplacement {
  readonly tailnetNodeId: string;
  readonly oldIdentity: string;
  readonly newIdentity: string;
}

export type TailnetPeerRegistryApplyResult =
  | { readonly kind: "applied" }
  | { readonly kind: "identity-replaced"; readonly replacement: TailnetPeerIdentityReplacement };

export type TailnetProbeSettledCallback = (probe: TailnetPeerProbe) => void | Promise<void>;

export interface TailnetProbeOptions {
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
  /** Observes each completed probe without delaying its worker. */
  readonly onSettled?: TailnetProbeSettledCallback;
}

export type TailnetProbeFetch = (input: string, init: RequestInit) => Promise<Response>;

export function stableMachineIdentity(tailnetNodeId: string, installationId: string): string {
  if (!TAILNET_NODE_ID_REGEXP.test(tailnetNodeId) || !UUID_PATTERN.test(installationId)) {
    throw new Error("invalid tailnet machine identity");
  }
  return `${tailnetNodeId}:${installationId.toLowerCase()}`;
}

export function isStableMachineIdentity(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const separator = value.length - 37;
  return separator > 0
    && value[separator] === ":"
    && TAILNET_NODE_ID_REGEXP.test(value.slice(0, separator))
    && UUID_PATTERN.test(value.slice(separator + 1));
}

function boundedProbeOption(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isInteger(value) || value === undefined || value < 1) return fallback;
  return Math.min(value, maximum);
}

function probeTimeout(timeoutMs: number): {
  readonly signal: AbortSignal;
  readonly expired: Promise<never>;
  readonly didExpire: () => boolean;
  readonly abort: () => void;
  readonly cancel: () => void;
} {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let didExpire = false;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      didExpire = true;
      controller.abort();
      reject(new MachineHandshakeTimedOutError());
    }, timeoutMs);
  });
  return {
    signal: controller.signal,
    expired,
    didExpire: () => didExpire,
    abort: () => controller.abort(),
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function responseContentLengthExceedsLimit(response: Response): boolean {
  const contentLength = response.headers.get("content-length");
  return contentLength !== null && Number(contentLength) > MAX_MACHINE_HANDSHAKE_RESPONSE_BYTES;
}

function cancelReaderWithoutWaiting(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => undefined);
}

async function readBoundedMachineHandshakeBody(
  response: Response,
  timeout: Pick<ReturnType<typeof probeTimeout>, "expired" | "didExpire" | "abort">,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), timeout.expired]);
      if (chunk.done) break;
      const nextByteLength = byteLength + chunk.value.byteLength;
      if (nextByteLength > MAX_MACHINE_HANDSHAKE_RESPONSE_BYTES) {
        timeout.abort();
        cancelReaderWithoutWaiting(reader);
        throw new MachineHandshakeResponseTooLargeError();
      }
      chunks.push(chunk.value);
      byteLength = nextByteLength;
    }
  } catch (error) {
    if (error instanceof MachineHandshakeResponseTooLargeError) throw error;
    if (timeout.didExpire()) throw new MachineHandshakeTimedOutError();
    throw new MachineHandshakeBodyReadError();
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function probeCandidate(
  candidate: TailnetMachineCandidate,
  fetcher: TailnetProbeFetch,
  timeoutMs: number,
): Promise<TailnetPeerProbe> {
  if (!candidate.online) return { candidate, status: "offline", diagnostic: "tailnet reports this peer offline" };

  const timeout = probeTimeout(timeoutMs);
  try {
    const response = await Promise.race([
      fetcher(`${candidate.origin}/api/machine`, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: timeout.signal,
      }),
      timeout.expired,
    ]);
    if (!response.ok) {
      return {
        candidate,
        status: response.status === 404 ? "non-wolfpack" : "offline",
        diagnostic: `machine handshake returned HTTP ${response.status}`,
      };
    }
    if (responseContentLengthExceedsLimit(response)) {
      timeout.abort();
      return { candidate, status: "malformed", diagnostic: OVERSIZED_MACHINE_HANDSHAKE_DIAGNOSTIC };
    }
    let body: unknown;
    try {
      const bytes = await readBoundedMachineHandshakeBody(response, timeout);
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      if (error instanceof MachineHandshakeResponseTooLargeError) {
        return { candidate, status: "malformed", diagnostic: OVERSIZED_MACHINE_HANDSHAKE_DIAGNOSTIC };
      }
      if (error instanceof MachineHandshakeTimedOutError) throw error;
      return { candidate, status: "malformed", diagnostic: "machine handshake was not JSON" };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { candidate, status: "malformed", diagnostic: "machine handshake was not an object" };
    }
    const classification = classifyMachineHandshake(candidate, body);
    if (classification.kind === "ready") return { candidate, status: "ready", handshake: classification.handshake };
    return { candidate, status: classification.kind, diagnostic: `machine handshake is ${classification.kind}` };
  } catch {
    return { candidate, status: "offline", diagnostic: "machine handshake did not respond" };
  } finally {
    timeout.cancel();
  }
}

/** Direct browser probes, bounded per candidate and across the whole candidate set. */
export async function probeTailnetCandidates(
  candidates: readonly TailnetMachineCandidate[],
  fetcher: TailnetProbeFetch = fetch,
  options: TailnetProbeOptions = {},
): Promise<readonly TailnetPeerProbe[]> {
  const timeoutMs = boundedProbeOption(options.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 30_000);
  const maxConcurrent = boundedProbeOption(options.maxConcurrent, DEFAULT_MAX_CONCURRENT_PROBES, MAX_CONCURRENT_PROBES);
  const outcomes = new Array<TailnetPeerProbe>(candidates.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const candidate = candidates[index];
      if (!candidate) return;
      const outcome = await probeCandidate(candidate, fetcher, timeoutMs);
      outcomes[index] = outcome;
      if (options.onSettled) {
        queueMicrotask(() => {
          void Promise.resolve()
            .then(() => options.onSettled?.(outcome))
            .catch((error: unknown) => console.error(SETTLED_OBSERVER_FAILURE_DIAGNOSTIC, error));
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxConcurrent, candidates.length) }, () => worker()));
  return outcomes;
}

interface LegacyMachineDisplayMetadata {
  readonly url: unknown;
  readonly name: unknown;
}

function legacyDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const displayName = value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 128);
  return displayName || undefined;
}

/**
 * Holds candidate display diagnostics separately from the only routing authority:
 * a current valid machine handshake keyed by node id plus installation id.
 */
export class TailnetPeerRegistry {
  private readonly stableEntries = new Map<string, TailnetPeerEntry>();
  private readonly transientEntries = new Map<string, TailnetPeerEntry>();
  private readonly candidateOriginsByNode = new Map<string, string>();
  private readonly legacyNamesByNode = new Map<string, string>();

  /** Removes routing authority when the current local candidate enumeration no longer contains a peer. */
  reconcileCandidates(candidates: readonly TailnetMachineCandidate[]): void {
    const present = new Set(candidates.map((candidate) => candidate.tailnetNodeId));
    for (const [identity, entry] of this.stableEntries) {
      if (present.has(entry.tailnetNodeId)) continue;
      this.stableEntries.set(identity, {
        ...entry,
        status: "offline",
        diagnostic: "candidate is no longer present in local Tailnet status",
      });
    }
    for (const [nodeId, entry] of this.transientEntries) {
      if (present.has(nodeId)) continue;
      this.transientEntries.set(nodeId, {
        ...entry,
        status: "offline",
        diagnostic: "candidate is no longer present in local Tailnet status",
      });
    }
  }

  /**
   * Candidate enumeration failed, so every previously ready origin is stale
   * metadata until a later candidate plus handshake refresh verifies it again.
   */
  markCandidateEnumerationUnavailable(): void {
    for (const [identity, entry] of this.stableEntries) {
      this.stableEntries.set(identity, {
        ...entry,
        status: "unavailable",
        diagnostic: "tailnet candidate enumeration unavailable",
      });
    }
    for (const [nodeId, entry] of this.transientEntries) {
      this.transientEntries.set(nodeId, {
        ...entry,
        status: "unavailable",
        diagnostic: "tailnet candidate enumeration unavailable",
      });
    }
  }

  applyLegacyDisplayMetadata(entries: readonly LegacyMachineDisplayMetadata[]): void {
    for (const entry of entries) {
      const name = legacyDisplayName(entry.name);
      if (typeof entry.url !== "string" || !name) continue;
      const nodeId = [...this.candidateOriginsByNode.entries()]
        .find(([, origin]) => origin === entry.url)?.[0];
      if (!nodeId) continue;
      this.legacyNamesByNode.set(nodeId, name);
      const transient = this.transientEntries.get(nodeId);
      if (transient) this.transientEntries.set(nodeId, { ...transient, displayName: name });
    }
  }

  applyProbe(probe: TailnetPeerProbe): TailnetPeerRegistryApplyResult {
    const { candidate } = probe;
    this.candidateOriginsByNode.set(candidate.tailnetNodeId, candidate.origin);
    if (probe.status === "ready" && probe.handshake) {
      const identity = stableMachineIdentity(
        probe.handshake.machine.tailnetNodeId,
        probe.handshake.machine.installationId,
      );
      this.transientEntries.delete(candidate.tailnetNodeId);
      const replacedEntry = [...this.stableEntries.entries()]
        .find(([key, entry]) => entry.tailnetNodeId === candidate.tailnetNodeId && key !== identity);
      if (replacedEntry) this.stableEntries.delete(replacedEntry[0]);
      this.stableEntries.set(identity, {
        identity,
        tailnetNodeId: candidate.tailnetNodeId,
        status: "ready",
        origin: probe.handshake.machine.origin,
        hostname: candidate.hostname,
        displayName: probe.handshake.machine.displayName,
        version: probe.handshake.wolfpack.version,
        diagnostic: undefined,
      });
      return replacedEntry
        ? {
          kind: "identity-replaced",
          replacement: {
            tailnetNodeId: candidate.tailnetNodeId,
            oldIdentity: replacedEntry[0],
            newIdentity: identity,
          },
        }
        : { kind: "applied" };
    }

    const existing = [...this.stableEntries.values()].find(entry => entry.tailnetNodeId === candidate.tailnetNodeId);
    const legacyName = this.legacyNamesByNode.get(candidate.tailnetNodeId);
    const entry: TailnetPeerEntry = existing
      ? { ...existing, status: probe.status, hostname: candidate.hostname, diagnostic: probe.diagnostic }
      : {
        identity: undefined,
        tailnetNodeId: candidate.tailnetNodeId,
        status: probe.status,
        origin: undefined,
        hostname: candidate.hostname,
        displayName: legacyName ?? candidate.hostname,
        version: undefined,
        diagnostic: probe.diagnostic,
      };
    if (existing?.identity) this.stableEntries.set(existing.identity, entry);
    else this.transientEntries.set(candidate.tailnetNodeId, entry);
    return { kind: "applied" };
  }

  entries(): readonly TailnetPeerEntry[] {
    return [...this.stableEntries.values(), ...this.transientEntries.values()]
      .sort((left, right) => left.tailnetNodeId.localeCompare(right.tailnetNodeId));
  }

  resolveReadyOrigin(identity: string): string | undefined {
    const entry = this.stableEntries.get(identity);
    return entry?.status === "ready" ? entry.origin : undefined;
  }
}
