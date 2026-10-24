import { canonicalTailnetOrigin } from "../src/tailnet-machine-contract.ts";
import { isStableMachineIdentity } from "../src/tailnet-peer-registry.ts";
import type { ExtensionCatalogEnvelope } from "../src/extensions/runtime-contract.ts";
import type { SelectedExtensionScope } from "./extension-host.ts";
import { browserAuthFetch, getBrowserAuthToken, setBrowserAuthToken } from "./browser-auth.ts";
import { showAppDialog } from "./app-dialog.ts";

import { EXTENSION_PEER_AUTH_HEADER, EXTENSION_PEER_ERROR, EXTENSION_PEER_LIMITS, extensionProxySuffix, selectedExtensionUrl } from "../src/extensions/selected-host-contract.ts";
export { EXTENSION_PEER_AUTH_HEADER, extensionProxySuffix } from "../src/extensions/selected-host-contract.ts";
export interface ExtensionReadyPeer {
  readonly identity: string | undefined;
  readonly status: string;
  readonly origin: string | undefined;
  readonly displayName: string;
}
export interface ExtensionTransportOptions {
  readonly resolvePeer: (machine: string) => ExtensionReadyPeer | undefined;
  readonly authFetch?: typeof browserAuthFetch;
  /** Extension-only host presentation; app uses passive scope-bound prompts. */
  readonly prompt?: typeof showAppDialog;
  /** May reduce, never enlarge, the complete remote-response deadline. */
  readonly timeoutMs?: number;
}
const { timeoutMs: REMOTE_REQUEST_TIMEOUT_MS, catalog: CATALOG_MAX_BYTES, asset: ASSET_MAX_BYTES, blob: BLOB_MAX_BYTES, document: DOCUMENT_MAX_BYTES, project: PROJECT_MAX_BYTES, error: ERROR_MAX_BYTES } = EXTENSION_PEER_LIMITS;

/** Deadline covers headers AND body; hostile cancellation is never awaited. */
async function boundedProxyResponse(authFetch: typeof browserAuthFetch, proxy: string, suffix: string, init: RequestInit, timeoutMs: number | undefined): Promise<Response> {
  const requested = timeoutMs ?? REMOTE_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requested) || requested < 1) throw new Error("invalid selected host deadline");
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
  let rejectAbort!: (reason: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort(new Error("selected host request cancelled or timed out"));
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.min(requested, REMOTE_REQUEST_TIMEOUT_MS));
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  const cancelResponse = (value: Response): void => { if (value.body && !value.body.locked) void value.body.cancel().catch(() => undefined); };
  try {
    if (signal.aborted) throw new Error("selected host request cancelled");
    response = await Promise.race([authFetch(proxy, { ...init, signal }).then(value => { if (signal.aborted) cancelResponse(value); return value; }), aborted]);
    if (response.redirected || (response.url && response.url !== new URL(proxy, location.href).href)) throw new Error("selected host response redirected");
    const maximum = !response.ok ? ERROR_MAX_BYTES : suffix.startsWith("assets/") ? ASSET_MAX_BYTES : suffix.startsWith("blobs/") ? BLOB_MAX_BYTES : suffix.startsWith("documents/") ? DOCUMENT_MAX_BYTES : suffix.startsWith("project/") ? PROJECT_MAX_BYTES : CATALOG_MAX_BYTES;
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d{1,16}$/.test(declared) || Number(declared) > maximum)) throw new Error("selected host response exceeds limit");
    let size = 0;
    // Bound acquisition on a native clone, then return the ORIGINAL response.
    // Its URL/redirect provenance must remain visible to the verifying loader.
    reader = response.clone().body?.getReader();
    if (reader) for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      if (chunk.value.byteLength > maximum - size) throw new Error("selected host response exceeds limit");
      size += chunk.value.byteLength;
    }
    if (signal.aborted) throw new Error("selected host request cancelled");
    complete = true;
    return response;
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", onAbort);
    if (!complete) {
      controller.abort();
      if (reader) void reader.cancel().catch(() => undefined);
      if (response) cancelResponse(response);
    }
    reader?.releaseLock();
  }
}

const CONSENT_STORAGE_KEY = "wp-extension-code-consent:v1";
const MAX_CONSENTS = 16;

/** Current-origin proxy traffic; remote credentials are never local authorization. */
export class SelectedHostExtensionTransport {
  private readonly consent = new Map<string, string>();
  constructor(private readonly options: ExtensionTransportOptions) {
    try {
      const raw = localStorage.getItem(CONSENT_STORAGE_KEY);
      if (!raw || raw.length > MAX_CONSENTS * CATALOG_MAX_BYTES) return;
      const entries: unknown = JSON.parse(raw);
      if (!Array.isArray(entries) || entries.length > MAX_CONSENTS) return;
      const stored = new Map<string, string>();
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || !isStableMachineIdentity(entry[0])
          || typeof entry[1] !== "string" || !entry[1].length || entry[1].length > CATALOG_MAX_BYTES || stored.has(entry[0])) return;
        stored.set(entry[0], entry[1]);
      }
      // If persistence is unavailable, use this instance's memory only.
      localStorage.setItem(CONSENT_STORAGE_KEY, raw);
      this.consent = stored;
    } catch { /* Storage denial or malformed data leaves consent memory-only. */ }
  }

  private persistConsent(): void {
    try {
      if (this.consent.size) localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify([...this.consent]));
      else localStorage.removeItem(CONSENT_STORAGE_KEY);
    } catch {
      // A failed write must not leave an older inventory grant when removable.
      try { localStorage.removeItem(CONSENT_STORAGE_KEY); }
      catch { try { localStorage.setItem(CONSENT_STORAGE_KEY, "[]"); } catch { /* Memory-only if storage is unavailable. */ } }
    }
  }

  /** Retire grants when the host observes invalidity without making a request. */
  invalidateConsent(machine: string): void {
    this.consent.delete(machine);
    this.persistConsent();
  }

  private peer(machine: string): ExtensionReadyPeer & { readonly origin: string } {
    const peer = this.options.resolvePeer(machine);
    if (!isStableMachineIdentity(machine) || peer?.identity !== machine || peer.status !== "ready" || !peer.origin
      || canonicalTailnetOrigin(peer.origin.slice("https://".length)) !== peer.origin) {
      this.invalidateConsent(machine);
      throw new Error("selected extension peer unavailable");
    }
    return { ...peer, origin: peer.origin };
  }

  url(scope: SelectedExtensionScope, path: string): string {
    if (!scope.machine) { extensionProxySuffix(path); return path; }
    return selectedExtensionUrl(scope.machine, path);
  }

  async request(scope: SelectedExtensionScope, path: string, init: RequestInit): Promise<Response> {
    const suffix = extensionProxySuffix(path);
    if (init.method && init.method !== "GET") throw new Error("extensions may only read selected host data");
    const authFetch = this.options.authFetch ?? browserAuthFetch;
    if (!scope.machine) return authFetch(path, init);
    const machine = scope.machine;
    const peer = this.peer(machine);
    const proxy = this.url(scope, path);
    const send = (): Promise<Response> => {
      if (init.signal?.aborted || this.peer(machine).origin !== peer.origin) throw new Error("stale extension peer");
      const headers = new Headers();
      const token = getBrowserAuthToken(peer.origin);
      if (token) headers.set(EXTENSION_PEER_AUTH_HEADER, `Bearer ${token}`);
      return boundedProxyResponse(authFetch, proxy, suffix, { ...init, headers, credentials: "same-origin", cache: "no-store", redirect: "error" }, this.options.timeoutMs).then(response => {
        if (init.signal?.aborted || this.peer(machine).origin !== peer.origin) throw new Error("stale extension peer");
        return response;
      });
    };
    let response = await send();
    // A local 401 is deliberately not an invitation to prompt for a peer token.
    if (response.status !== 401) return response;
    const failure: unknown = await response.clone().json();
    if (!failure || typeof failure !== "object" || !("error" in failure)) return response;
    const error = failure.error;
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== EXTENSION_PEER_ERROR.AUTH_REQUIRED) return response;
    const result = await (this.options.prompt ?? showAppDialog)({ title: "Selected machine authentication", message: `Enter the access token for ${peer.displayName} (${peer.origin}). It remains in this browser tab.`, fields: [{ name: "token", label: "Access token" }], confirmLabel: "Authenticate", ...(init.signal ? { signal: init.signal } : {}) });
    if (init.signal?.aborted || this.peer(machine).origin !== peer.origin) throw new Error("stale extension peer");
    if (!result?.token) return response;
    setBrowserAuthToken(peer.origin, result.token);
    response = await send(); // Exactly one peer retry; no local-401 prompt loop.
    return response;
  }

  async consentRemoteCode(scope: SelectedExtensionScope, catalog: ExtensionCatalogEnvelope, signal: AbortSignal): Promise<boolean> {
    if (!scope.machine) return true;
    const machine = scope.machine;
    const peer = this.peer(machine);
    const inventory = JSON.stringify(catalog.installations.filter(item => item.enabled && item.ui)
      .map(item => [item.installationId, item.extensionId, item.package.digest, item.ui!.path, item.ui!.digest]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    const key = `${peer.origin}|${inventory}`;
    if (this.consent.get(machine) === key) return !signal.aborted;
    this.invalidateConsent(machine);
    const result = await (this.options.prompt ?? showAppDialog)({ title: "Trust selected machine browser code?", message: `${peer.displayName} (${peer.origin}) offers ${catalog.installations.filter(item => item.enabled && item.ui).map(item => item.package.name).join(", ")}. This code runs in this page with the same browser authority as local extensions; it is NOT sandboxed. Trust only code you control.`, confirmLabel: "Trust this inventory", signal });
    if (signal.aborted || this.peer(machine).origin !== peer.origin || !result) return false;
    this.consent.set(machine, key);
    while (this.consent.size > MAX_CONSENTS) this.consent.delete(this.consent.keys().next().value!);
    this.persistConsent();
    return true;
  }
}
