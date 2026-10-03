import { browserAuthFetch } from "./browser-auth";

export const EXTENSION_BUNDLE_MAX_BYTES = 1024 * 1024;
export const EXTENSION_BUNDLE_TIMEOUT_MS = 5_000;
export const EXTENSION_BUNDLE_PATH_PREFIX = "/api/extensions/";

export type ExtensionBundleLoadErrorCode =
  | "SAFE_MODE"
  | "INVALID_URL"
  | "FETCH_FAILED"
  | "RESPONSE_INVALID"
  | "RESPONSE_TOO_LARGE"
  | "INTEGRITY_MISMATCH"
  | "IMPORT_FAILED";

export class ExtensionBundleLoadError extends Error {
  constructor(readonly code: ExtensionBundleLoadErrorCode, message: string) {
    super(message);
    this.name = "ExtensionBundleLoadError";
  }
}

export interface ExtensionBundleLoadOptions {
  readonly safeMode: boolean;
  /** Test/host overrides may lower these hard bounds, never raise them. */
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly fetchImpl?: typeof browserAuthFetch;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function authority(url: string): URL {
  try {
    const parsed = new URL(url, location.href);
    if (
      typeof url === "string" &&
      parsed.origin === location.origin &&
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.pathname.startsWith(EXTENSION_BUNDLE_PATH_PREFIX) &&
      !parsed.username && !parsed.password && !parsed.search && !parsed.hash
    ) return parsed;
  } catch { /* URL parsing failures are the same typed, non-secret boundary. */ }
  throw new ExtensionBundleLoadError("INVALID_URL", "extension bundle must be a same-origin /api/extensions/ asset without credentials, query or fragment");
}

function lowerBound(value: number | undefined, maximum: number, code: ExtensionBundleLoadErrorCode): number {
  const requested = value ?? maximum;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new ExtensionBundleLoadError(code, "extension resource limit must be a positive safe integer");
  }
  return Math.min(requested, maximum);
}

function cancelBody(response: Response | undefined): void {
  if (response?.body && !response.body.locked) {
    // Cancellation is best effort and must not extend the request's deadline.
    void response.body.cancel().catch(() => {});
  }
}

type BeforeDeadline = <T>(operation: Promise<T>) => Promise<T>;

async function boundedBytes(response: Response, maximum: number, beforeDeadline: BeforeDeadline): Promise<ArrayBuffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d{1,16}$/.test(declared) || Number(declared) > maximum)) {
    throw new ExtensionBundleLoadError("RESPONSE_TOO_LARGE", "extension bundle has an invalid or excessive declared byte length");
  }
  if (!response.body) throw new ExtensionBundleLoadError("RESPONSE_INVALID", "extension bundle response has no body");

  const reader = response.body.getReader();
  // Preallocation also bounds overhead from many tiny (or empty) chunks.
  const output = new Uint8Array(maximum);
  let length = 0;
  let complete = false;
  try {
    while (true) {
      const next = await beforeDeadline(reader.read());
      if (next.done) {
        complete = true;
        break;
      }
      if (next.value.byteLength > maximum - length) {
        throw new ExtensionBundleLoadError("RESPONSE_TOO_LARGE", "extension bundle exceeds the host byte limit");
      }
      output.set(next.value, length);
      length += next.value.byteLength;
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  // At most two hard-cap buffers; no unbounded arrayBuffer()/text() call or
  // Content-Length trust is involved.
  return output.buffer.slice(0, length);
}

async function verifiedBytes(target: URL, expectedSha256: string, options: ExtensionBundleLoadOptions): Promise<ArrayBuffer> {
  const maximum = lowerBound(options.maxBytes, EXTENSION_BUNDLE_MAX_BYTES, "RESPONSE_TOO_LARGE");
  const timeoutMs = lowerBound(options.timeoutMs, EXTENSION_BUNDLE_TIMEOUT_MS, "FETCH_FAILED");
  const controller = new AbortController();
  let rejectDeadline!: (reason: ExtensionBundleLoadError) => void;
  const expired = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const onAbort = () => rejectDeadline(new ExtensionBundleLoadError("FETCH_FAILED", "extension bundle acquisition timed out"));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const beforeDeadline: BeforeDeadline = (operation) => Promise.race([operation, expired]);
  let response: Response | undefined;

  try {
    const fetched = (options.fetchImpl ?? browserAuthFetch)(target, {
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    }).then((value) => {
      // An injected transport may ignore AbortSignal and resolve after the
      // deadline. Dispose that response even though the caller has settled.
      if (controller.signal.aborted) cancelBody(value);
      return value;
    });
    response = await beforeDeadline(fetched);
    if (!response.ok) throw new ExtensionBundleLoadError("FETCH_FAILED", `extension bundle request failed with ${response.status}`);
    if (
      response.redirected ||
      (response.url && response.url !== target.href) ||
      !/^text\/javascript(?:;|$)/i.test(response.headers.get("content-type") ?? "")
    ) throw new ExtensionBundleLoadError("RESPONSE_INVALID", "extension bundle must be a non-redirected JavaScript asset");

    const source = await boundedBytes(response, maximum, beforeDeadline);
    const digest = await beforeDeadline(crypto.subtle.digest("SHA-256", source));
    if (hex(digest) !== expectedSha256.toLowerCase()) {
      throw new ExtensionBundleLoadError("INTEGRITY_MISMATCH", "extension bundle digest did not match installed inventory");
    }
    return source;
  } catch (error) {
    if (error instanceof ExtensionBundleLoadError) throw error;
    // Transport error text may contain authenticated URLs or other secrets.
    throw new ExtensionBundleLoadError("FETCH_FAILED", "extension bundle acquisition failed");
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
    cancelBody(response);
  }
}

/**
 * Trusted-code loader, NOT a sandbox. The deadline bounds acquisition and
 * digest verification; JavaScript evaluation cannot be forcibly cancelled.
 * A self-contained ESM bundle is an installed-package compatibility requirement.
 */
export async function loadAuthenticatedExtensionBundle<T>(
  url: string,
  expectedSha256: string,
  options: ExtensionBundleLoadOptions,
): Promise<T> {
  if (options.safeMode !== false) throw new ExtensionBundleLoadError("SAFE_MODE", "safe mode prevents extension fetch and import before load");
  const target = authority(url);
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new ExtensionBundleLoadError("INTEGRITY_MISMATCH", "extension bundle digest is invalid");
  }
  const source = await verifiedBytes(target, expectedSha256, options);
  const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    return await import(/* @vite-ignore */ blobUrl) as T;
  } catch {
    throw new ExtensionBundleLoadError("IMPORT_FAILED", "extension bundle evaluation failed");
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
