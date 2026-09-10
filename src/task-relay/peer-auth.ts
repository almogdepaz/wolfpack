import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { isOpaqueRelayId } from "./domain.ts";
import type { RelayPeerTopology } from "./peer-topology.ts";
import { VOLATILE_PEER_PATH } from "./volatile-protocol.ts";

export const RELAY_PEER_IDENTITY_PATH = "/api/task-relay/volatile-v1/identity";
export const RELAY_PEER_SIGNATURE_HEADER = "x-wolfpack-relay-signature";
export interface RelayPeerIdentity {
  readonly profile: "volatile-v1";
  readonly epoch: string;
  readonly origin: string;
  readonly nodeId: string;
  readonly publicKey: string;
}
export class RelayPeerPolicyError extends Error {
  constructor(readonly code: "PEER_POLICY_REQUIRED" | "PEER_UNREACHABLE" | "RELAY_CAPACITY") { super(code); }
}
interface Options {
  readonly topology: () => Promise<RelayPeerTopology>;
  readonly epoch: () => Promise<string | undefined>;
  readonly fetch?: typeof fetch;
  /** Existing configured JWT remains additive; never infer peer identity from it. */
  readonly jwt?: () => string | null;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const denied = (): never => { throw new RelayPeerPolicyError("PEER_POLICY_REQUIRED"); };
const signedBytes = (destination: string, raw: string) => Buffer.from(JSON.stringify(["wolfpack-relay-peer/v1", destination, raw]));

/** Host-only epoch keys. No signing endpoint, disk key, peer cache, or replay authority. */
export class RelayPeerAuth {
  readonly #options: Options;
  #keys: { epoch: string; pair: { publicKey: KeyObject; privateKey: KeyObject } } | undefined;
  #active = 0; #identities = 0;
  constructor(options: Options) { this.#options = options; }

  identity(): Promise<RelayPeerIdentity> { return this.#bounded(signal => this.#identity(signal), undefined, true); }

  async #identity(signal: AbortSignal): Promise<RelayPeerIdentity> {
    const topology = await this.#options.topology(), epoch = await this.#options.epoch();
    if (signal.aborted || !epoch || !isOpaqueRelayId(epoch)) return denied();
    if (this.#keys?.epoch !== epoch) this.#keys = { epoch, pair: generateKeyPairSync("ed25519") };
    const publicKey = this.#keys.pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    return { profile: "volatile-v1", epoch, origin: topology.origin, nodeId: topology.nodeId, publicKey };
  }

  async #bounded<T>(operation: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal, identity = false): Promise<T> {
    if (identity ? this.#identities >= 4 : this.#active >= 8) throw new RelayPeerPolicyError("RELAY_CAPACITY");
    if (identity) this.#identities++; else this.#active++;
    const controller = new AbortController(), abort = () => controller.abort();
    caller?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 4000);
    if (caller?.aborted) abort();
    let rejectAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new RelayPeerPolicyError("PEER_UNREACHABLE"));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    try { return await Promise.race([cancelled, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new RelayPeerPolicyError("PEER_UNREACHABLE");
      return operation(controller.signal);
    })]); }
    finally { clearTimeout(timer); caller?.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", rejectAbort); if (identity) this.#identities--; else this.#active--; }
  }

  #headers(): Headers {
    const headers = new Headers({ "content-type": "application/json" });
    const jwt = this.#options.jwt?.();
    if (jwt) headers.set("authorization", `Bearer ${jwt}`);
    return headers;
  }

  async #remote(origin: string, topology: RelayPeerTopology, signal: AbortSignal): Promise<RelayPeerIdentity> {
    const nodeId = topology.peers.get(origin);
    if (signal.aborted || !nodeId) return denied(); // Before any caller-selected network request.
    const response = await (this.#options.fetch ?? fetch)(origin + RELAY_PEER_IDENTITY_PATH, {
      headers: this.#headers(), redirect: "error", cache: "no-store", signal,
    });
    if (!response.ok || response.redirected || Number(response.headers.get("content-length")) > 4096) {
      void response.body?.cancel().catch(() => undefined); return denied();
    }
    const reader = response.body?.getReader();
    if (!reader) return denied();
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = []; let size = 0;
    let identity: unknown;
    try {
      if (signal.aborted) return denied();
      for (;;) {
        const part = await reader.read();
        if (signal.aborted) return denied();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 4096) return denied();
        chunks.push(part.value);
      }
      identity = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } finally { signal.removeEventListener("abort", cancel); cancel(); }
    if (!record(identity) || Object.keys(identity).sort().join(",") !== "epoch,nodeId,origin,profile,publicKey"
      || identity.profile !== "volatile-v1" || !isOpaqueRelayId(identity.epoch) || identity.origin !== origin || identity.nodeId !== nodeId
      || typeof identity.publicKey !== "string" || !/^[A-Za-z0-9_-]{59}$/.test(identity.publicKey)) return denied();
    const key = createPublicKey({ key: Buffer.from(identity.publicKey, "base64url"), type: "spki", format: "der" });
    if (key.asymmetricKeyType !== "ed25519") return denied();
    return identity as unknown as RelayPeerIdentity;
  }

  /** Fresh local topology + canonical TLS key discovery. Metadata is not task readiness. */
  peer(origin: string): Promise<RelayPeerIdentity> {
    return this.#bounded(async signal => {
      const topology = await this.#options.topology();
      const remote = await this.#remote(origin, topology, signal);
      const current = await this.#options.topology();
      if (signal.aborted || current.origin !== topology.origin || current.nodeId !== topology.nodeId || current.peers.get(origin) !== remote.nodeId) return denied();
      return remote;
    });
  }

  /** Verify raw bytes before the worker's reserved peer lane or any mailbox admission. */
  verify(raw: string, signature: unknown): Promise<void> {
    return this.#bounded(async signal => {
      if (Buffer.byteLength(raw) > 64 * 1024 || typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return denied();
      const body: unknown = JSON.parse(raw);
      if (!record(body) || body.operation !== "receivePeer" || body.profile !== "volatile-v1" || typeof body.origin !== "string") return denied();
      const topology = await this.#options.topology(), epoch = await this.#options.epoch();
      if (!epoch || body.epoch !== epoch) return denied();
      const remote = await this.#remote(body.origin, topology, signal);
      if (signal.aborted || remote.epoch !== body.sourceEpoch) return denied();
      const key = createPublicKey({ key: Buffer.from(remote.publicKey, "base64url"), type: "spki", format: "der" });
      if (!verify(null, signedBytes(topology.origin, raw), key, Buffer.from(signature, "base64url"))) return denied();
      // Recheck after I/O so topology/worker replacement cannot inherit authority.
      const current = await this.#options.topology();
      if (signal.aborted || await this.#options.epoch() !== epoch || current.origin !== topology.origin || current.nodeId !== topology.nodeId
        || current.peers.get(body.origin) !== remote.nodeId) return denied();
    });
  }

  /** Only worker-owned outbound frames are signed; never exposed to endpoint callers. */
  forward(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.#bounded(async signal => {
      const url = new URL(String(input));
      if (url.pathname !== VOLATILE_PEER_PATH || url.search || url.hash || url.username || url.password || init?.method !== "POST" || typeof init.body !== "string"
        || Buffer.byteLength(init.body) > 64 * 1024) return denied();
      const body: unknown = JSON.parse(init.body);
      const own = await this.#identity(signal), topology = await this.#options.topology();
      if (!record(body) || body.operation !== "receivePeer" || body.profile !== "volatile-v1" || body.origin !== own.origin || body.sourceEpoch !== own.epoch
        || !topology.peers.has(url.origin) || topology.origin !== own.origin || topology.nodeId !== own.nodeId) return denied();
      const remote = await this.#remote(url.origin, topology, signal);
      if (remote.epoch !== body.epoch || this.#keys?.epoch !== own.epoch || signal.aborted || await this.#options.epoch() !== own.epoch) return denied();
      const current = await this.#options.topology();
      if (signal.aborted || current.origin !== own.origin || current.nodeId !== own.nodeId || current.peers.get(url.origin) !== remote.nodeId) return denied();
      const headers = this.#headers();
      headers.set(RELAY_PEER_SIGNATURE_HEADER, sign(null, signedBytes(url.origin, init.body), this.#keys.pair.privateKey).toString("base64url"));
      return (this.#options.fetch ?? fetch)(url.href, { method: "POST", body: init.body, headers, redirect: "error", signal });
    }, init?.signal ?? undefined);
  }
}
