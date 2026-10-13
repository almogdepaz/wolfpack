import { isStableMachineIdentity } from "../tailnet-peer-registry.ts";

export const EXTENSION_PEER_AUTH_HEADER = "X-Wolfpack-Extension-Peer-Authorization";
export const EXTENSION_PEER_PREFIX = "/api/extensions/peer/";
/** blob matches the blob-store hard ceiling; the proxy tightens it to the peer's declared maxBlobBytes. */
export const EXTENSION_PEER_LIMITS = { timeoutMs: 5_000, active: 8, handshake: 32 * 1024, catalog: 256 * 1024, asset: 1024 * 1024, blob: 1024 * 1024, document: 72 * 1024, project: 256 * 1024, error: 2048 } as const;
export const EXTENSION_PEER_ERROR = {
  AUTH_REQUIRED: "PEER_AUTH_REQUIRED", FORBIDDEN: "PEER_FORBIDDEN", UNAVAILABLE: "PEER_UNAVAILABLE",
  INCOMPATIBLE: "PEER_INCOMPATIBLE", RESPONSE_INVALID: "PEER_RESPONSE_INVALID", BUSY: "PEER_BUSY", TIMEOUT: "PEER_TIMEOUT",
} as const;
export type ExtensionPeerErrorCode = (typeof EXTENSION_PEER_ERROR)[keyof typeof EXTENSION_PEER_ERROR];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = "[a-z][a-z0-9-]{0,63}";

/** Canonical read capabilities only; never maps a supplied origin or filesystem path. */
export function extensionProxySuffix(path: string): string {
  if (path === "/api/extensions") return "catalog";
  const url = new URL(path, "http://extension.invalid");
  if (url.origin !== "http://extension.invalid" || path !== url.pathname + url.search || url.hash) throw new Error("invalid extension read path");
  const asset = new RegExp(`^/api/extensions/assets/${ID}/[a-f0-9]{64}/[A-Za-z0-9._@+/-]+\\.js$`);
  if (asset.test(path) && !path.slice("/api/extensions/assets/".length).split("/").some(part => !part || part === "." || part === "..")) return path.slice("/api/extensions/".length);
  if (new RegExp(`^/api/extensions/blobs/${ID}/[a-f0-9]{64}$`).test(path)) return path.slice("/api/extensions/".length);
  if (!new RegExp(`^/api/extensions/(?:documents/${ID}/${ID}|project/git-status/${ID})$`).test(url.pathname)) throw new Error("invalid extension read path");
  const session = url.searchParams.get("session");
  if (!session || !UUID.test(session) || url.search !== `?session=${session}`) throw new Error("invalid extension read selector");
  return path.slice("/api/extensions/".length);
}
export function selectedExtensionUrl(machine: string, path: string): string {
  if (!isStableMachineIdentity(machine)) throw new Error("invalid selected machine identity");
  return `${EXTENSION_PEER_PREFIX}${encodeURIComponent(machine)}/${extensionProxySuffix(path)}`;
}
export type ExtensionPeerRead =
  | { readonly kind: "catalog"; readonly path: string; readonly maxBytes: number }
  | { readonly kind: "asset"; readonly path: string; readonly maxBytes: number; readonly extensionId: string }
  | { readonly kind: "blob"; readonly path: string; readonly maxBytes: number; readonly extensionId: string; readonly digest: string }
  | { readonly kind: "document"; readonly path: string; readonly maxBytes: number; readonly extensionId: string; readonly documentId: string; readonly sessionId: string }
  | { readonly kind: "project"; readonly path: string; readonly maxBytes: number; readonly extensionId: string; readonly sessionId: string };

export function parseExtensionPeerRead(raw: string): { readonly machine: string; readonly nodeId: string; readonly installationId: string; readonly read: ExtensionPeerRead } {
  if (!raw.startsWith(EXTENSION_PEER_PREFIX) || raw.length > 2048) throw new Error("invalid selected extension route");
  const rest = raw.slice(EXTENSION_PEER_PREFIX.length), slash = rest.indexOf("/");
  if (slash < 0) throw new Error("invalid selected extension route");
  const encoded = rest.slice(0, slash), machine = decodeURIComponent(encoded);
  if (!isStableMachineIdentity(machine) || encodeURIComponent(machine) !== encoded) throw new Error("invalid selected machine identity");
  const suffix = rest.slice(slash + 1), path = suffix === "catalog" ? "/api/extensions" : `/api/extensions/${suffix}`;
  if (extensionProxySuffix(path) !== suffix) throw new Error("invalid selected extension capability");
  const identitySeparator = machine.lastIndexOf(":"), url = new URL(path, "http://extension.invalid"), parts = url.pathname.split("/");
  let read: ExtensionPeerRead;
  if (suffix === "catalog") read = { kind: "catalog", path, maxBytes: EXTENSION_PEER_LIMITS.catalog };
  else if (parts[3] === "assets") read = { kind: "asset", path, extensionId: parts[4]!, maxBytes: EXTENSION_PEER_LIMITS.asset };
  else if (parts[3] === "blobs") read = { kind: "blob", path, extensionId: parts[4]!, digest: parts[5]!, maxBytes: EXTENSION_PEER_LIMITS.blob };
  else if (parts[3] === "documents") read = { kind: "document", path, extensionId: parts[4]!, documentId: parts[5]!, sessionId: url.searchParams.get("session")!, maxBytes: EXTENSION_PEER_LIMITS.document };
  else read = { kind: "project", path, extensionId: parts[5]!, sessionId: url.searchParams.get("session")!, maxBytes: EXTENSION_PEER_LIMITS.project };
  return { machine, nodeId: machine.slice(0, identitySeparator), installationId: machine.slice(identitySeparator + 1), read };
}
