import { browserAuthFetch } from "./browser-auth";

export class ExtensionBundleLoadError extends Error {
  constructor(readonly code: "FETCH_FAILED" | "INTEGRITY_MISMATCH" | "INVALID_BUNDLE" | "IMPORT_FAILED", message: string) {
    super(message);
    this.name = "ExtensionBundleLoadError";
  }
}

function hex(bytes: ArrayBuffer): string { return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

/**
 * Authenticated bundles cannot use native URL import because import() cannot add
 * Wolfpack's bearer header. Phase 2 will call this only after an authenticated
 * allowlisted asset response; this helper neither discovers packages nor falls
 * back to unauthenticated URLs. The serving CSP must explicitly include blob:.
 */
export async function loadAuthenticatedExtensionBundle<T>(url: string, expectedSha256: string, fetchImpl: typeof browserAuthFetch = browserAuthFetch): Promise<T> {
  const response = await fetchImpl(url, { cache: "no-store" });
  if (!response.ok) throw new ExtensionBundleLoadError("FETCH_FAILED", `extension bundle request failed with ${response.status}`);
  const source = await response.arrayBuffer();
  const actual = hex(await crypto.subtle.digest("SHA-256", source));
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256) || actual !== expectedSha256.toLowerCase()) throw new ExtensionBundleLoadError("INTEGRITY_MISMATCH", "extension bundle digest did not match its installed manifest");
  const text = new TextDecoder().decode(source);
  // A self-contained bundle must not retain unresolved bare/remote imports.
  if (/\bfrom\s*["'](?:https?:|\/\/)|\bimport\s*\(\s*["'](?:https?:|\/\/)/.test(text) || /\bfrom\s*["'][^./][^"']*["']/.test(text)) {
    throw new ExtensionBundleLoadError("INVALID_BUNDLE", "extension bundle contains a remote or bare module import");
  }
  const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try { return await import(/* @vite-ignore */ blobUrl) as T; }
  catch (error) { throw new ExtensionBundleLoadError("IMPORT_FAILED", `extension bundle could not load: ${(error as Error).message}`); }
  finally { URL.revokeObjectURL(blobUrl); }
}
