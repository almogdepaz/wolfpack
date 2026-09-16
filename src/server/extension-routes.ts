import type { IncomingMessage, ServerResponse } from "node:http";
import { ExtensionDocumentError, ExtensionDocumentStore, type ExtensionDocumentKey } from "../extensions/document-contract.ts";
import { ExtensionRuntime, ExtensionRuntimeError, getExtensionRuntime } from "../extensions/runtime.ts";
import { EXTENSION_API_ERROR, type ExtensionApiErrorCode } from "../extensions/runtime-contract.ts";
import type { SessionBackend } from "./backend-contract.ts";
import { getBackend } from "./backend.ts";
import { json, parseObjectBody } from "./http.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function noStore(res: ServerResponse) { res.setHeader("Cache-Control", "no-store"); }
function error(res: ServerResponse, code: ExtensionApiErrorCode, message: string, status: number, currentRevision?: number) { noStore(res); json(res, { error: { code, message, ...(currentRevision === undefined ? {} : { currentRevision }) } }, status); }
function documentError(res: ServerResponse, value: unknown) {
  if (value instanceof ExtensionRuntimeError) return error(res, value.code === "DISABLED" ? EXTENSION_API_ERROR.DISABLED : value.code === "NOT_INSTALLED" ? EXTENSION_API_ERROR.NOT_INSTALLED : EXTENSION_API_ERROR.INVALID_REQUEST, value.message, value.code === "NOT_INSTALLED" ? 404 : 409);
  if (!(value instanceof ExtensionDocumentError)) return error(res, EXTENSION_API_ERROR.STORE_UNAVAILABLE, "extension document service unavailable", 503);
  const map: Record<string, [ExtensionApiErrorCode, number]> = { INVALID_KEY: [EXTENSION_API_ERROR.INVALID_REQUEST, 400], INVALID_DOCUMENT: [EXTENSION_API_ERROR.INVALID_REQUEST, 400], SCHEMA_INVALID: [EXTENSION_API_ERROR.SCHEMA_INVALID, 422], CONFLICT: [EXTENSION_API_ERROR.CONFLICT, 409], REQUEST_ID_REUSED: [EXTENSION_API_ERROR.CONFLICT, 409], QUOTA_EXCEEDED: [EXTENSION_API_ERROR.QUOTA_EXCEEDED, 413], STORE_CORRUPT: [EXTENSION_API_ERROR.STORE_CORRUPT, 503], STORE_UNAVAILABLE: [EXTENSION_API_ERROR.STORE_UNAVAILABLE, 503], SCOPE_NOT_WRITABLE: [EXTENSION_API_ERROR.SCOPE_NOT_WRITABLE, 409] };
  const [code, status] = map[value.code] ?? [EXTENSION_API_ERROR.STORE_UNAVAILABLE, 503]; return error(res, code, value.message, status, value.currentRevision);
}
function ids(pathname: string, prefix: string): { extensionId: string; documentId: string } | null { const parts = pathname.slice(prefix.length).split("/"); return parts.length === 2 && /^[a-z][a-z0-9-]{0,63}$/.test(parts[0]!) && /^[a-z][a-z0-9-]{0,63}$/.test(parts[1]!) ? { extensionId: parts[0]!, documentId: parts[1]! } : null; }

export interface ExtensionRouteServiceOptions { readonly runtime?: ExtensionRuntime; readonly backend?: SessionBackend; readonly safeMode?: () => boolean; }
/** Server-owned service binds document persistence to installed schemas and broker UUID liveness. */
export class ExtensionRouteService {
  private readonly runtime: ExtensionRuntime; private readonly backend: SessionBackend; private readonly safeMode: () => boolean; private readonly store: ExtensionDocumentStore;
  constructor(options: ExtensionRouteServiceOptions = {}) { this.runtime = options.runtime ?? getExtensionRuntime(); this.backend = options.backend ?? getBackend(); this.safeMode = options.safeMode ?? (() => false); this.store = new ExtensionDocumentStore({ root: this.runtime.root, assertWritableScope: async (key) => { const facts = await this.backend.listSessionFacts(); const live = facts.some((fact) => fact.alive && fact.identity?.wolfpackSessionId === key.scopeSessionId); if (!live) throw new ExtensionDocumentError("SCOPE_NOT_WRITABLE", "new documents require a live exact scope session UUID"); this.runtime.schema(key); } }); }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (req.method === "GET" && url.pathname === "/api/extensions") { noStore(res); json(res, this.runtime.catalog(this.safeMode())); return true; }
    const assetPrefix = "/api/extensions/assets/";
    if (req.method === "GET" && url.pathname.startsWith(assetPrefix)) { const rest = url.pathname.slice(assetPrefix.length).split("/"); const assetPath = rest.slice(1).join("/"); if (rest.length < 2 || !UUID.test(rest[0]!) || !assetPath.endsWith(".js")) { error(res, EXTENSION_API_ERROR.ASSET_NOT_FOUND, "extension asset is not allowlisted", 404); return true; } try { if (this.safeMode()) throw new ExtensionRuntimeError("DISABLED", "safe mode prevents extension asset delivery"); const asset = this.runtime.asset(rest[0]!, assetPath); noStore(res); res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "X-Wolfpack-Extension-Digest": asset.digest }); res.end(asset.bytes); } catch (value) { documentError(res, value); } return true; }
    const path = ids(url.pathname, "/api/extensions/documents/"); if (!path) return false;
    const sessionId = req.method === "GET" ? url.searchParams.get("session") : undefined;
    if (req.method === "GET") { if (!sessionId || !UUID.test(sessionId)) { error(res, EXTENSION_API_ERROR.INVALID_REQUEST, "session must be an exact canonical UUID", 400); return true; } try { const installation = this.runtime.get(path.extensionId); const key: ExtensionDocumentKey = { installationId: installation.installationId, scopeSessionId: sessionId, extensionId: path.extensionId, documentId: path.documentId }; const saved = this.store.read(key); noStore(res); json(res, { installationId: installation.installationId, scopeSessionId: sessionId, extensionId: path.extensionId, documentId: path.documentId, revision: saved?.revision ?? 0, document: saved?.document ?? null }); } catch (value) { documentError(res, value); } return true; }
    if (req.method !== "POST") return false;
    const body = await parseObjectBody(req, res, { maxBytes: 72 * 1024, invalidResponse: { envelope: { error: { code: EXTENSION_API_ERROR.INVALID_REQUEST, message: "body must be a JSON object" } }, status: 400 }, tooLargeResponse: { envelope: { error: { code: EXTENSION_API_ERROR.QUOTA_EXCEEDED, message: "document request exceeds limit" } }, status: 413 }, respondOnTooLarge: true }); if (!body) return true;
    if (!Object.keys(body).every((key) => ["sessionId", "document", "ifRevision", "requestId", "schemaVersion"].includes(key)) || !UUID.test(String(body.sessionId ?? ""))) { error(res, EXTENSION_API_ERROR.INVALID_REQUEST, "publish requires exact sessionId, document, ifRevision, requestId and schemaVersion", 400); return true; }
    try { const installation = this.runtime.get(path.extensionId); const key: ExtensionDocumentKey = { installationId: installation.installationId, scopeSessionId: body.sessionId as string, extensionId: path.extensionId, documentId: path.documentId }; const receipt = await this.store.publish({ key, document: body.document, ifRevision: body.ifRevision as number, requestId: body.requestId as string, schemaVersion: body.schemaVersion as number }, this.runtime.schema(key)); noStore(res); json(res, { receipt }); } catch (value) { documentError(res, value); } return true;
  }
}
let service: ExtensionRouteService | undefined;
export function getExtensionRouteService(): ExtensionRouteService { return service ??= new ExtensionRouteService(); }
export function __setExtensionRouteServiceForTests(value: ExtensionRouteService | undefined): void { if (!process.env.WOLFPACK_TEST) throw new Error("test-only extension route override"); service = value; }
