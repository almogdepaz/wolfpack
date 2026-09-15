import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalJson } from "../canonical-json.ts";
import { readValidatedJsonFile, writePrivateJsonFile } from "../server/persistence.ts";

export const EXTENSION_DOCUMENT_STORE_VERSION = 1;
export const EXTENSION_DOCUMENT_LIMITS = {
  maxDocumentBytes: 64 * 1024,
  maxDepth: 16,
  maxStringBytes: 16 * 1024,
  maxArrayItems: 1_000,
  maxObjectKeys: 1_000,
  maxDocumentsPerInstallation: 256,
  maxBytesPerInstallation: 16 * 1024 * 1024,
  maxRetainedReceipts: 128,
} as const;

const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ExtensionDocumentKey {
  readonly installationId: string;
  readonly scopeSessionId: string;
  readonly extensionId: string;
  readonly documentId: string;
}
export interface ExtensionDocumentReceipt {
  readonly requestId: string;
  readonly scopeSessionId: string;
  readonly extensionId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly acceptedAt: string;
  readonly payloadDigest: string;
  readonly baseRevision: number;
  readonly schemaVersion: number;
}
export interface StoredExtensionDocument {
  readonly version: typeof EXTENSION_DOCUMENT_STORE_VERSION;
  readonly key: ExtensionDocumentKey;
  readonly revision: number;
  readonly document: unknown;
  readonly receipts: readonly ExtensionDocumentReceipt[];
}
export interface PublishExtensionDocumentRequest {
  readonly key: ExtensionDocumentKey;
  readonly document: unknown;
  readonly ifRevision: number;
  readonly requestId: string;
  readonly schemaVersion: number;
}

export const EXTENSION_DOCUMENT_ERROR = {
  INVALID_KEY: "INVALID_KEY",
  INVALID_DOCUMENT: "INVALID_DOCUMENT",
  SCHEMA_INVALID: "SCHEMA_INVALID",
  CONFLICT: "CONFLICT",
  REQUEST_ID_REUSED: "REQUEST_ID_REUSED",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  STORE_CORRUPT: "STORE_CORRUPT",
  STORE_UNAVAILABLE: "STORE_UNAVAILABLE",
  SCOPE_NOT_WRITABLE: "SCOPE_NOT_WRITABLE",
} as const;
export type ExtensionDocumentErrorCode = (typeof EXTENSION_DOCUMENT_ERROR)[keyof typeof EXTENSION_DOCUMENT_ERROR];
export class ExtensionDocumentError extends Error {
  constructor(readonly code: ExtensionDocumentErrorCode, message: string, readonly currentRevision?: number) {
    super(message);
    this.name = "ExtensionDocumentError";
  }
}

export interface StaticSchemaValidator {
  readonly validate: (document: unknown) => boolean;
  readonly errors: () => readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Static installed schemas only: no remote/local $refs, dynamic anchors, or executable validators. */
export function compileStaticDocumentSchema(schema: unknown): StaticSchemaValidator {
  let nodes = 0;
  const inspect = (value: unknown, depth = 0): void => {
    if (depth > 16 || !isPlainObject(value) || ++nodes > 1_000) throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.INVALID_DOCUMENT, "schema exceeds bounded object graph");
    for (const key of Object.keys(value)) if (["$ref", "$dynamicRef", "$recursiveRef", "$id", "$anchor", "$dynamicAnchor", "pattern", "patternProperties", "format"].includes(key)) throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.INVALID_DOCUMENT, `unsupported static schema keyword: ${key}`);
    if (value.$schema !== undefined && value.$schema !== "https://json-schema.org/draft/2020-12/schema") throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.INVALID_DOCUMENT, "unsupported JSON Schema dialect");
    const single = ["not", "if", "then", "else", "contains", "propertyNames", "additionalProperties", "unevaluatedProperties"];
    for (const key of single) if (isPlainObject(value[key])) inspect(value[key], depth + 1);
    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) if (Array.isArray(value[key])) for (const child of value[key] as unknown[]) inspect(child, depth + 1);
    if (isPlainObject(value.properties)) for (const child of Object.values(value.properties)) inspect(child, depth + 1);
    if (isPlainObject(value.patternProperties)) for (const child of Object.values(value.patternProperties)) inspect(child, depth + 1);
    if (isPlainObject(value.dependentSchemas)) for (const child of Object.values(value.dependentSchemas)) inspect(child, depth + 1);
    if (isPlainObject(value.items)) inspect(value.items, depth + 1);
  };
  if (Buffer.byteLength(JSON.stringify(schema), "utf8") > 64 * 1024) throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.INVALID_DOCUMENT, "schema exceeds byte limit");
  inspect(schema);
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateSchema: true });
  const validate = ajv.compile(schema as Record<string, unknown>);
  return {
    validate(document: unknown): boolean { return validate(document); },
    errors(): readonly string[] { return (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`); },
  };
}

function jsonBounds(value: unknown, depth = 0): void {
  if (depth > EXTENSION_DOCUMENT_LIMITS.maxDepth) throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.INVALID_DOCUMENT, "document exceeds maximum JSON nesting depth");
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > EXTENSION_DOCUMENT_LIMITS.maxStringBytes) throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.INVALID_DOCUMENT, "document string exceeds byte limit");
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.INVALID_DOCUMENT, "document contains a non-finite number");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > EXTENSION_DOCUMENT_LIMITS.maxArrayItems) throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.INVALID_DOCUMENT, "document array exceeds item limit");
    for (const item of value) jsonBounds(item, depth + 1);
    return;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length > EXTENSION_DOCUMENT_LIMITS.maxObjectKeys) throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.INVALID_DOCUMENT, "document object exceeds key limit");
    for (const [key, item] of entries) { jsonBounds(key, depth + 1); jsonBounds(item, depth + 1); }
    return;
  }
  throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.INVALID_DOCUMENT, "document must contain JSON values only");
}

export function validateDocumentKey(key: ExtensionDocumentKey): void {
  if (!UUID.test(key.installationId) || !UUID.test(key.scopeSessionId) || !IDENTIFIER.test(key.extensionId) || !IDENTIFIER.test(key.documentId)) {
    throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.INVALID_KEY, "installation, extension and document IDs must be stable identifiers and scope must be an exact UUID");
  }
}

export function validateDocumentPayload(document: unknown, validator: StaticSchemaValidator): { readonly canonical: string; readonly digest: string } {
  jsonBounds(document);
  let canonical: string;
  try { canonical = canonicalJson(document); } catch (error) { throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.INVALID_DOCUMENT, "document is not canonical JSON"); }
  if (Buffer.byteLength(canonical, "utf8") > EXTENSION_DOCUMENT_LIMITS.maxDocumentBytes) throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.INVALID_DOCUMENT, "document exceeds maximum byte limit");
  if (!validator.validate(document)) throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.SCHEMA_INVALID, `document does not satisfy installed schema: ${validator.errors().join("; ")}`);
  return { canonical, digest: createHash("sha256").update(canonical).digest("hex") };
}

function stableRecordKey(key: ExtensionDocumentKey): string { return createHash("sha256").update(canonicalJson(key)).digest("hex"); }
function isRecord(value: unknown): value is StoredExtensionDocument {
  if (!isPlainObject(value) || value.version !== 1 || !isPlainObject(value.key) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.receipts)) return false;
  try { validateDocumentKey(value.key as unknown as ExtensionDocumentKey); jsonBounds(value.document); for (const receipt of value.receipts) { if (!isPlainObject(receipt) || !UUID.test(String(receipt.requestId)) || !UUID.test(String(receipt.scopeSessionId)) || !IDENTIFIER.test(String(receipt.extensionId)) || !IDENTIFIER.test(String(receipt.documentId)) || !Number.isSafeInteger(receipt.revision) || !Number.isSafeInteger(receipt.baseRevision) || !Number.isSafeInteger(receipt.schemaVersion) || !/^[a-f0-9]{64}$/.test(String(receipt.payloadDigest)) || typeof receipt.acceptedAt !== "string") return false; } return true; } catch { return false; }
}
function recordSize(record: StoredExtensionDocument): number { return Buffer.byteLength(JSON.stringify(record), "utf8"); }

export interface ExtensionDocumentStoreOptions {
  readonly root: string;
  /** Authoritative backend hook; a missing/ended scope must reject new writes. */
  readonly assertWritableScope?: (key: ExtensionDocumentKey) => void;
  readonly now?: () => string;
}

/** Owner-private atomic records. A single Wolfpack server owns one instance and serializes per-document writes. */
export class ExtensionDocumentStore {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly now: () => string;
  constructor(private readonly options: ExtensionDocumentStoreOptions) { this.now = options.now ?? (() => new Date().toISOString()); }
  private path(key: ExtensionDocumentKey): string { return join(this.options.root, "documents", `${stableRecordKey(key)}.json`); }
  read(key: ExtensionDocumentKey): StoredExtensionDocument | null {
    validateDocumentKey(key);
    try { const record = readValidatedJsonFile(this.path(key), "extension document", isRecord); if (record && canonicalJson(record.key) !== canonicalJson(key)) throw new Error("stored key mismatch"); return record; }
    catch (error) { throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.STORE_CORRUPT, `extension document cannot be read: ${(error as Error).message}`); }
  }
  private totalUsage(): { documents: number; bytes: number } {
    const directory = join(this.options.root, "documents");
    if (!existsSync(directory)) return { documents: 0, bytes: 0 };
    let documents = 0; let bytes = 0;
    for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)) { documents++; bytes += statSync(join(directory, entry.name)).size; }
    return { documents, bytes };
  }
  async publish(request: PublishExtensionDocumentRequest, validator: StaticSchemaValidator): Promise<ExtensionDocumentReceipt> {
    validateDocumentKey(request.key);
    if (!UUID.test(request.requestId) || !Number.isSafeInteger(request.ifRevision) || request.ifRevision < 0 || !Number.isSafeInteger(request.schemaVersion) || request.schemaVersion < 1) throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.INVALID_DOCUMENT, "request ID must be a UUID and ifRevision a non-negative integer");
    const key = stableRecordKey(request.key);
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      const payload = validateDocumentPayload(request.document, validator);
      const existing = this.read(request.key);
      if (existing && canonicalJson(existing.key) !== canonicalJson(request.key)) throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.STORE_CORRUPT, "stored document key does not match requested key");
      const duplicate = existing?.receipts.find((receipt) => receipt.requestId === request.requestId);
      if (duplicate && existing) {
        if (duplicate.payloadDigest === payload.digest && duplicate.baseRevision === request.ifRevision && duplicate.schemaVersion === request.schemaVersion) return duplicate;
        throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.REQUEST_ID_REUSED, "request ID was retained for different payload or base revision", existing.revision);
      }
      this.options.assertWritableScope?.(request.key);
      const currentRevision = existing?.revision ?? 0;
      if (request.ifRevision !== currentRevision) throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.CONFLICT, "document revision conflict; read and reconcile before publishing", currentRevision);
      const receipt: ExtensionDocumentReceipt = { requestId: request.requestId, scopeSessionId: request.key.scopeSessionId, extensionId: request.key.extensionId, documentId: request.key.documentId, revision: currentRevision + 1, acceptedAt: this.now(), payloadDigest: payload.digest, baseRevision: request.ifRevision, schemaVersion: request.schemaVersion };
      const record: StoredExtensionDocument = { version: 1, key: request.key, revision: receipt.revision, document: request.document, receipts: [...(existing?.receipts ?? []), receipt].slice(-EXTENSION_DOCUMENT_LIMITS.maxRetainedReceipts) };
      const usage = this.totalUsage();
      const nextBytes = usage.bytes - (existing ? recordSize(existing) : 0) + recordSize(record);
      if ((!existing && usage.documents >= EXTENSION_DOCUMENT_LIMITS.maxDocumentsPerInstallation) || nextBytes > EXTENSION_DOCUMENT_LIMITS.maxBytesPerInstallation) throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.QUOTA_EXCEEDED, "extension document quota exceeded; remove data or increase the installation quota");
      try { mkdirSync(join(this.options.root, "documents"), { recursive: true, mode: 0o700 }); writePrivateJsonFile(this.path(request.key), record); }
      catch (error) { throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.STORE_UNAVAILABLE, `extension document was not persisted: ${(error as Error).message}`); }
      return receipt;
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}

/** Convenience for clients that need a fresh idempotency key without inventing one from session text. */
export function newExtensionDocumentRequestId(): string { return randomUUID(); }
