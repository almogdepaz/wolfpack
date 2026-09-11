import { isOpaqueRelayId } from "./domain.ts";
import type { RelayPeerTopology } from "./peer-topology.ts";
import { VOLATILE_PEER_PATH, VOLATILE_GATEWAY_LIMITS } from "./volatile-protocol.ts";
import { readPeerResponse, withPeerAbort } from "./peer-response.ts";

export class RelayPeerPolicyError extends Error {
  constructor(readonly code: "PEER_POLICY_REQUIRED" | "PEER_UNREACHABLE" | "RELAY_CAPACITY") { super(code); }
}
interface Options {
  readonly topology: () => Promise<RelayPeerTopology>;
  readonly epoch: () => Promise<string | undefined>;
  readonly fetch?: typeof fetch;
  /** Optional existing owner-API auth, not a task-protocol prerequisite. */
  readonly jwt?: () => string | null;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const denied = (): never => { throw new RelayPeerPolicyError("PEER_POLICY_REQUIRED"); };

/** Honest Tailnet peers; no signatures, key discovery or persisted peer state.
 * Local topology limits routing; canonical TLS and Tailnet ACLs are the boundary. */
export class RelayPeerTransport {
  #active = 0;
  constructor(private readonly options: Options) {}
  async #bounded<T>(operation: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
    if (this.#active >= 8) throw new RelayPeerPolicyError("RELAY_CAPACITY");
    this.#active++;
    const controller = new AbortController(), abort = () => controller.abort();
    caller?.addEventListener("abort", abort, { once: true });
    if (caller?.aborted) abort();
    const timer = setTimeout(abort, 4000);
    try { return await withPeerAbort(controller.signal, () => operation(controller.signal)); }
    finally { clearTimeout(timer); caller?.removeEventListener("abort", abort); controller.abort(); this.#active--; }
  }
  async #topology(): Promise<RelayPeerTopology> {
    try { return await this.options.topology(); } catch { return denied(); }
  }
  #headers(): Headers {
    const headers = new Headers({ "content-type": "application/json" }), jwt = this.options.jwt?.();
    if (jwt) headers.set("authorization", `Bearer ${jwt}`);
    return headers;
  }
  async #peer(origin: string, signal: AbortSignal): Promise<{ origin: string; epoch: string }> {
    const topology = await this.#topology(), node = topology.peers.get(origin);
    if (signal.aborted || !node) return denied(); // Before any caller-selected request.
    const response = await (this.options.fetch ?? fetch)(origin + "/api/task-relay/profile", { headers: this.#headers(), redirect: "error", cache: "no-store", signal });
    const text = await readPeerResponse(response, signal, VOLATILE_GATEWAY_LIMITS.replyBytes);
    const body: unknown = JSON.parse(text);
    if (!response.ok || !record(body) || body.ok !== true || body.profile !== "volatile-v1" || !isOpaqueRelayId(body.epoch)) return denied();
    const current = await this.#topology();
    if (signal.aborted || current.origin !== topology.origin || current.nodeId !== topology.nodeId || current.peers.get(origin) !== node) return denied();
    return { origin, epoch: body.epoch };
  }
  peer(origin: string): Promise<{ origin: string; epoch: string }> { return this.#bounded(signal => this.#peer(origin, signal)); }
  verify(raw: string): Promise<void> {
    return this.#bounded(async signal => {
      if (Buffer.byteLength(raw) > 64 * 1024) return denied();
      const body: unknown = JSON.parse(raw);
      if (!record(body) || body.operation !== "receivePeer" || body.profile !== "volatile-v1" || typeof body.origin !== "string") return denied();
      const epoch = await this.options.epoch();
      if (!epoch || body.epoch !== epoch) return denied();
      const source = await this.#peer(body.origin, signal);
      if (signal.aborted || body.sourceEpoch !== source.epoch || await this.options.epoch() !== epoch) return denied();
    });
  }
  forward(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.#bounded(async signal => {
      const url = new URL(String(input));
      if (url.pathname !== VOLATILE_PEER_PATH || url.search || url.hash || url.username || url.password || init?.method !== "POST" || typeof init.body !== "string" || Buffer.byteLength(init.body) > 64 * 1024) return denied();
      const body: unknown = JSON.parse(init.body), own = await this.#topology(), epoch = await this.options.epoch();
      if (!record(body) || body.operation !== "receivePeer" || body.profile !== "volatile-v1" || body.origin !== own.origin || !epoch || body.sourceEpoch !== epoch) return denied();
      const peer = await this.#peer(url.origin, signal), current = await this.#topology();
      if (signal.aborted || body.epoch !== peer.epoch || await this.options.epoch() !== epoch || current.origin !== own.origin || current.nodeId !== own.nodeId || current.peers.get(url.origin) !== own.peers.get(url.origin)) return denied();
      const response = await (this.options.fetch ?? fetch)(url.href, { method: "POST", body: init.body, headers: this.#headers(), redirect: "error", signal });
      const reply = await readPeerResponse(response, signal, VOLATILE_GATEWAY_LIMITS.replyBytes);
      return new Response(reply || null, { status: response.status });
    }, init?.signal ?? undefined);
  }
}
