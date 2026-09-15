import { browserAuthFetch } from "./browser-auth";

export const EXTENSION_BUNDLE_MAX_BYTES = 1024 * 1024;
export const EXTENSION_BUNDLE_PATH_PREFIX = "/api/extensions/";
export class ExtensionBundleLoadError extends Error {
  constructor(readonly code: "SAFE_MODE" | "INVALID_URL" | "FETCH_FAILED" | "RESPONSE_INVALID" | "RESPONSE_TOO_LARGE" | "INTEGRITY_MISMATCH" | "IMPORT_FAILED", message: string) { super(message); this.name = "ExtensionBundleLoadError"; }
}
function hex(bytes: ArrayBuffer): string { return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function authority(url: string): URL {
  const parsed = new URL(url, location.href);
  if (parsed.origin !== location.origin || !parsed.pathname.startsWith(EXTENSION_BUNDLE_PATH_PREFIX) || parsed.search || parsed.hash) throw new ExtensionBundleLoadError("INVALID_URL", "extension bundle URL must be a same-origin /api/extensions/ asset without query or fragment");
  return parsed;
}
async function boundedBytes(response: Response, maximum: number): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared < 0 || declared > maximum) throw new ExtensionBundleLoadError("RESPONSE_TOO_LARGE", "extension bundle exceeds byte limit");
  if (!response.body) throw new ExtensionBundleLoadError("RESPONSE_INVALID", "extension bundle response has no body");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > maximum) { await reader.cancel(); throw new ExtensionBundleLoadError("RESPONSE_TOO_LARGE", "extension bundle exceeds byte limit"); } chunks.push(next.value); } }
  finally { reader.releaseLock(); }
  const output = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; } return output.buffer;
}
/** Trusted-code loader only: URL/integrity/resource bounds are compatibility controls, never a sandbox. */
export async function loadAuthenticatedExtensionBundle<T>(url: string, expectedSha256: string, options: { readonly safeMode: boolean; readonly timeoutMs?: number; readonly maxBytes?: number; readonly fetchImpl?: typeof browserAuthFetch } ): Promise<T> {
  if (options.safeMode) throw new ExtensionBundleLoadError("SAFE_MODE", "safe mode prevents extension fetch and import before load");
  const target = authority(url); if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new ExtensionBundleLoadError("INTEGRITY_MISMATCH", "extension bundle digest is invalid");
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  let response: Response;
  try { response = await (options.fetchImpl ?? browserAuthFetch)(target, { cache: "no-store", redirect: "error", signal: controller.signal }); }
  catch (error) { throw new ExtensionBundleLoadError("FETCH_FAILED", `extension bundle request failed: ${(error as Error).name}`); }
  finally { clearTimeout(timer); }
  if (!response.ok) throw new ExtensionBundleLoadError("FETCH_FAILED", `extension bundle request failed with ${response.status}`);
  if (response.redirected || !/^text\/javascript(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new ExtensionBundleLoadError("RESPONSE_INVALID", "extension bundle response must be a non-redirected JavaScript asset");
  const source = await boundedBytes(response, options.maxBytes ?? EXTENSION_BUNDLE_MAX_BYTES);
  if (hex(await crypto.subtle.digest("SHA-256", source)) !== expectedSha256.toLowerCase()) throw new ExtensionBundleLoadError("INTEGRITY_MISMATCH", "extension bundle digest did not match installed inventory");
  const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try { return await import(/* @vite-ignore */ blobUrl) as T; } catch (error) { throw new ExtensionBundleLoadError("IMPORT_FAILED", `extension bundle could not load: ${(error as Error).message}`); } finally { URL.revokeObjectURL(blobUrl); }
}
