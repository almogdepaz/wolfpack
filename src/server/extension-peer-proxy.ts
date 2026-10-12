import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { canonicalTailnetOrigin, classifyMachineHandshake, type TailnetMachineCandidate } from "../tailnet-machine-contract.ts";
import { parseExtensionCatalog } from "../extensions/catalog-contract.ts";
import { parseProjectGitStatus } from "../extensions/git-status-contract.ts";
import { EXTENSION_API_ERROR, type ExtensionCatalogEnvelope, type ExtensionCatalogInstallation } from "../extensions/runtime-contract.ts";
import { EXTENSION_PEER_AUTH_HEADER, EXTENSION_PEER_ERROR, EXTENSION_PEER_LIMITS, parseExtensionPeerRead, type ExtensionPeerErrorCode, type ExtensionPeerRead } from "../extensions/selected-host-contract.ts";
import { enumerateLocalTailnetCandidates, json } from "./http.ts";

export type ExtensionPeerFetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
export interface ExtensionPeerProxyOptions {
  readonly fetchImpl?: ExtensionPeerFetch;
  readonly candidates?: typeof enumerateLocalTailnetCandidates;
  readonly timeoutMs?: number;
  readonly maxActive?: number;
}
class ProxyFailure extends Error {
  constructor(readonly code: ExtensionPeerErrorCode, readonly status: number, message: string) { super(message); }
}
const MAX_ACQUISITION_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const MIN_RETRY_DELAY_MS = 100;
class PeerRateLimit extends ProxyFailure {
  constructor(readonly delayMs: number) { super(EXTENSION_PEER_ERROR.BUSY, 503, "selected peer is busy"); }
}
function retryDelay(headers: Headers): number {
  const value = headers.get("retry-after");
  if (value === null) return DEFAULT_RETRY_DELAY_MS;
  if (/^\d{1,10}$/.test(value)) return Math.max(MIN_RETRY_DELAY_MS, Number(value) * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date) && new Date(date).toUTCString() === value) return Math.max(MIN_RETRY_DELAY_MS, date - Date.now());
  throw new ProxyFailure(EXTENSION_PEER_ERROR.BUSY, 503, "selected peer is busy");
}
function failure(res: ServerResponse, value: unknown): void {
  const error = value instanceof ProxyFailure ? value : new ProxyFailure(EXTENSION_PEER_ERROR.UNAVAILABLE, 503, "selected extension host unavailable");
  if (!res.destroyed && !res.writableEnded) { res.setHeader("Cache-Control", "no-store"); json(res, { error: { code: error.code, message: error.message } }, error.status); }
}
function invalidResponse(): never { throw new ProxyFailure(EXTENSION_PEER_ERROR.RESPONSE_INVALID, 503, "selected host response is invalid or exceeds limits"); }
function cancelBody(response: Response): void { if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined); }
function parseJson(bytes: Uint8Array): unknown { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; } catch { return invalidResponse(); } }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** One total acquisition budget, shared by topology, both handshakes, policy and response bodies. */
class RequestBudget {
  readonly controller = new AbortController();
  readonly expired: Promise<never>;
  private readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onAbort: () => void;
  constructor(timeoutMs: number) {
    this.deadline = performance.now() + timeoutMs;
    let reject!: (error: ProxyFailure) => void;
    this.expired = new Promise((_resolve, fail) => { reject = fail; });
    this.onAbort = () => reject(new ProxyFailure(EXTENSION_PEER_ERROR.TIMEOUT, 503, "selected host request cancelled or timed out"));
    this.controller.signal.addEventListener("abort", this.onAbort, { once: true });
    this.timer = setTimeout(() => this.controller.abort(), timeoutMs);
  }
  check(): void { if (this.controller.signal.aborted || performance.now() >= this.deadline) throw new ProxyFailure(EXTENSION_PEER_ERROR.TIMEOUT, 503, "selected host request cancelled or timed out"); }
  async wait<T>(pending: Promise<T>): Promise<T> { this.check(); return Promise.race([pending, this.expired]); }
  async backoff(error: PeerRateLimit): Promise<void> {
    this.check();
    if (error.delayMs >= this.deadline - performance.now()) throw error;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await this.wait(new Promise<void>(resolve => { timer = setTimeout(resolve, error.delayMs); })); }
    finally { clearTimeout(timer); }
  }
  close(): void { clearTimeout(this.timer); this.controller.signal.removeEventListener("abort", this.onAbort); this.controller.abort(); }
}
async function boundedBytes(response: Response, maximum: number, budget: RequestBudget): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d{1,16}$/.test(declared) || Number(declared) > maximum)) { cancelBody(response); return invalidResponse(); }
  const reader = response.body?.getReader();
  if (!reader) return invalidResponse();
  const bytes = new Uint8Array(maximum); let size = 0;
  try {
    for (;;) {
      const value = await budget.wait(reader.read());
      if (value.done) break;
      if (value.value.byteLength > maximum - size) return invalidResponse();
      bytes.set(value.value, size); size += value.value.byteLength;
    }
    budget.check(); return bytes.slice(0, size);
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function requireSuccess(status: number): void {
  if (status === 200) return;
  const errors: Partial<Record<number, readonly [ExtensionPeerErrorCode, number, string]>> = {
    401: [EXTENSION_PEER_ERROR.AUTH_REQUIRED, 401, "selected peer authentication required"],
    403: [EXTENSION_PEER_ERROR.FORBIDDEN, 403, "selected peer denied extension access"],
    404: [EXTENSION_PEER_ERROR.FORBIDDEN, 404, "selected peer capability unavailable"],
    409: [EXTENSION_PEER_ERROR.FORBIDDEN, 409, "selected peer extension scope unavailable"],
  };
  const value = errors[status];
  if (value) throw new ProxyFailure(...value);
  throw new ProxyFailure(EXTENSION_PEER_ERROR.UNAVAILABLE, 503, "selected peer extension capability unavailable");
}
function authorize(catalog: ExtensionCatalogEnvelope, read: Exclude<ExtensionPeerRead, { readonly kind: "catalog" }>): ExtensionCatalogInstallation {
  const item = catalog.installations.find(value => value.extensionId === read.extensionId);
  if (catalog.safeMode || !item?.enabled || (read.kind === "asset" && item.ui?.url !== read.path) || (read.kind === "document" && !item.documents.some(value => value.id === read.documentId))) {
    throw new ProxyFailure(EXTENSION_PEER_ERROR.FORBIDDEN, 403, "selected peer extension read is not enabled or declared");
  }
  return item;
}
function ownedData(bytes: Uint8Array, read: Exclude<ExtensionPeerRead, { readonly kind: "catalog" | "asset" }>, installationId: string): unknown {
  const value = parseJson(bytes);
  if (!record(value) || value.installationId !== installationId || value.scopeSessionId !== read.sessionId || value.extensionId !== read.extensionId) return invalidResponse();
  if (read.kind === "project") {
    try { return { installationId, scopeSessionId: read.sessionId, extensionId: read.extensionId, status: parseProjectGitStatus(value.status) }; }
    catch { return invalidResponse(); }
  }
  if (value.documentId !== read.documentId || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !("document" in value)) return invalidResponse();
  return { installationId, scopeSessionId: read.sessionId, extensionId: read.extensionId, documentId: read.documentId, revision: value.revision, document: value.document };
}

/** Narrow authenticated read proxy. Credentials and topology are host-owned, never extension-owned. */
export class ExtensionPeerProxy {
  private active = 0;
  private readonly timeoutMs: number;
  private readonly maxActive: number;
  constructor(private readonly options: ExtensionPeerProxyOptions = {}, private readonly safeMode: () => boolean = () => false) {
    const timeout = options.timeoutMs ?? EXTENSION_PEER_LIMITS.timeoutMs, active = options.maxActive ?? EXTENSION_PEER_LIMITS.active;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || !Number.isSafeInteger(active) || active < 1) throw new Error("invalid selected-host proxy limits");
    this.timeoutMs = Math.min(timeout, EXTENSION_PEER_LIMITS.timeoutMs); this.maxActive = Math.min(active, EXTENSION_PEER_LIMITS.active);
  }
  private async candidate(nodeId: string, budget: RequestBudget): Promise<TailnetMachineCandidate> {
    const values = await budget.wait((this.options.candidates ?? enumerateLocalTailnetCandidates)());
    const candidates = values.candidates.filter(value => value.tailnetNodeId === nodeId && value.online && canonicalTailnetOrigin(value.hostname) === value.origin);
    if (values.error || candidates.length !== 1) throw new ProxyFailure(EXTENSION_PEER_ERROR.UNAVAILABLE, 503, "selected peer is not a current online canonical Tailnet candidate");
    return candidates[0]!;
  }
  private async readRemote(origin: string, path: string, maximum: number, budget: RequestBudget, authorization?: string): Promise<Uint8Array> {
    budget.check();
    const headers = new Headers({ Accept: path.includes("/assets/") ? "text/javascript" : "application/json" });
    if (authorization) headers.set("Authorization", authorization);
    const response = await budget.wait((this.options.fetchImpl ?? fetch)(`${origin}${path}`, { method: "GET", headers, signal: budget.controller.signal, redirect: "error", cache: "no-store", credentials: "omit" }).then(value => { if (budget.controller.signal.aborted) cancelBody(value); return value; }));
    if (response.redirected || (response.status >= 300 && response.status < 400)) { cancelBody(response); return invalidResponse(); }
    const bytes = await boundedBytes(response, response.ok ? maximum : EXTENSION_PEER_LIMITS.error, budget);
    if (response.status === 429) throw new PeerRateLimit(retryDelay(response.headers));
    requireSuccess(response.status);
    const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (path.includes("/assets/") ? mime !== "text/javascript" && mime !== "application/javascript" : mime !== "application/json") return invalidResponse();
    return bytes;
  }
  private async verify(nodeId: string, installationId: string, budget: RequestBudget, expectedOrigin?: string): Promise<string> {
    const candidate = await this.candidate(nodeId, budget);
    if (expectedOrigin && candidate.origin !== expectedOrigin) throw new ProxyFailure(EXTENSION_PEER_ERROR.INCOMPATIBLE, 409, "selected peer routing authority changed");
    // /api/machine is public: do not disclose the stored peer credential before identity verification.
    const classified = classifyMachineHandshake(candidate, parseJson(await this.readRemote(candidate.origin, "/api/machine", EXTENSION_PEER_LIMITS.handshake, budget)));
    if (classified.kind !== "ready" || classified.handshake.machine.installationId !== installationId) throw new ProxyFailure(EXTENSION_PEER_ERROR.INCOMPATIBLE, 409, "selected peer identity or machine protocol changed");
    if ((await this.candidate(nodeId, budget)).origin !== candidate.origin) throw new ProxyFailure(EXTENSION_PEER_ERROR.INCOMPATIBLE, 409, "selected peer routing authority changed");
    return candidate.origin;
  }
  private async catalog(origin: string, installationId: string, authorization: string | undefined, budget: RequestBudget): Promise<ExtensionCatalogEnvelope> {
    let catalog: ExtensionCatalogEnvelope;
    try { catalog = parseExtensionCatalog(parseJson(await this.readRemote(origin, "/api/extensions", EXTENSION_PEER_LIMITS.catalog, budget, authorization))); }
    catch (error) { if (error instanceof ProxyFailure) throw error; return invalidResponse(); }
    if (catalog.installations.some(item => item.installationId !== installationId)) return invalidResponse();
    return catalog;
  }
  private async confirm(target: ReturnType<typeof parseExtensionPeerRead>, origin: string, budget: RequestBudget): Promise<void> {
    await this.verify(target.nodeId, target.installationId, budget, origin);
    if (this.safeMode()) throw new ProxyFailure(EXTENSION_PEER_ERROR.FORBIDDEN, 403, "extension safe mode is active");
    budget.check();
  }
  private async deliver(target: ReturnType<typeof parseExtensionPeerRead>, authorization: string | undefined, budget: RequestBudget, res: ServerResponse, expectedOrigin: string): Promise<void> {
    const origin = await this.verify(target.nodeId, target.installationId, budget, expectedOrigin);
    const catalog = await this.catalog(origin, target.installationId, authorization, budget);
    const read = target.read;
    if (read.kind === "catalog") { await this.confirm(target, origin, budget); json(res, catalog); return; }
    const item = authorize(catalog, read);
    const bytes = await this.readRemote(origin, read.path, read.maxBytes, budget, authorization);
    const current = authorize(await this.catalog(origin, target.installationId, authorization, budget), read);
    if (current.package.digest !== item.package.digest || current.ui?.digest !== item.ui?.digest) throw new ProxyFailure(EXTENSION_PEER_ERROR.FORBIDDEN, 409, "selected extension inventory changed");
    await this.confirm(target, origin, budget);
    if (read.kind === "asset") {
      if (!item.ui || createHash("sha256").update(bytes).digest("hex") !== item.ui.digest) return invalidResponse();
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "X-Wolfpack-Extension-Digest": item.ui.digest }); res.end(bytes); return;
    }
    json(res, ownedData(bytes, read, target.installationId));
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    let target: ReturnType<typeof parseExtensionPeerRead>;
    try { if (req.url !== url.pathname + url.search) throw new Error("noncanonical request URL"); target = parseExtensionPeerRead(req.url); }
    catch { json(res, { error: { code: EXTENSION_API_ERROR.INVALID_REQUEST, message: "invalid selected extension read" } }, 400); return; }
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); json(res, { error: { code: EXTENSION_API_ERROR.INVALID_REQUEST, message: "selected extension capabilities are read-only" } }, 405); return; }
    if (this.safeMode()) {
      if (target.read.kind === "catalog") json(res, { safeMode: true, installations: [] });
      else failure(res, new ProxyFailure(EXTENSION_PEER_ERROR.FORBIDDEN, 403, "extension safe mode is active"));
      return;
    }
    const authorization = req.headers[EXTENSION_PEER_AUTH_HEADER.toLowerCase()];
    if (authorization !== undefined && (typeof authorization !== "string" || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization))) { json(res, { error: { code: EXTENSION_API_ERROR.INVALID_REQUEST, message: "invalid selected peer credential channel" } }, 400); return; }
    if (this.active >= this.maxActive) { failure(res, new ProxyFailure(EXTENSION_PEER_ERROR.BUSY, 503, "selected-host requests are busy")); return; }
    if (req.aborted || res.destroyed) return;
    this.active++;
    const budget = new RequestBudget(this.timeoutMs), abort = () => budget.controller.abort();
    req.once("aborted", abort); res.once("close", abort);
    try {
      const origin = (await this.candidate(target.nodeId, budget)).origin;
      for (let attempt = 1; ; attempt++) {
        if (this.safeMode()) throw new ProxyFailure(EXTENSION_PEER_ERROR.FORBIDDEN, 403, "extension safe mode is active");
        try { await this.deliver(target, authorization, budget, res, origin); break; }
        catch (error) {
          if (!(error instanceof PeerRateLimit) || attempt >= MAX_ACQUISITION_ATTEMPTS) throw error;
          // Restart the ENTIRE read: no partial payload, policy or public identity is reused.
          await budget.backoff(error);
        }
      }
    }
    catch (error) { failure(res, error); }
    finally { req.removeListener("aborted", abort); res.removeListener("close", abort); budget.close(); this.active--; }
  }
}
