import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync,
} from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalJson } from "../canonical-json.ts";
import { writePrivateJsonFile } from "../server/persistence.ts";
import { boundedCanonicalJson, isPlainJsonObject, type JsonBudget } from "./bounded-json.ts";

export const EXTENSION_DOCUMENT_STORE_VERSION = 1;
export const EXTENSION_DOCUMENT_LIMITS = {
  maxDocumentBytes: 64 * 1024,
  maxDepth: 16,
  maxStringBytes: 16 * 1024,
  maxArrayItems: 1_000,
  maxObjectKeys: 1_000,
  maxNodes: 16_384,
  maxRecordBytes: 1024 * 1024,
  maxDocumentsPerInstallation: 256,
  maxBytesPerInstallation: 16 * 1024 * 1024,
  maxRetainedReceipts: 128,
} as const;

export const EXTENSION_SCHEMA_LIMITS = {
  maxBytes: 64 * 1024,
  maxDepth: 48,
  maxStringBytes: 16 * 1024,
  maxArrayItems: 1_000,
  maxObjectKeys: 1_000,
  maxNodes: 4_096,
  maxSchemaNodes: 256,
  maxSchemaDepth: 16,
  maxCombinatorBranches: 16,
  maxValidationWork: 2_000_000,
} as const;

const DOCUMENT_BUDGET: JsonBudget = {
  ...EXTENSION_DOCUMENT_LIMITS,
  maxBytes: EXTENSION_DOCUMENT_LIMITS.maxDocumentBytes,
};
const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;

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

function invalid(message: string): never {
  throw new ExtensionDocumentError("INVALID_DOCUMENT", message);
}
function boundedJson(value: unknown, budget: JsonBudget = DOCUMENT_BUDGET) {
  try { return boundedCanonicalJson(value, budget); }
  catch (error) { return invalid(error instanceof Error ? error.message : "invalid bounded JSON"); }
}
function sha256(canonical: string): string { return createHash("sha256").update(canonical).digest("hex"); }

/** AJV owns JSON Schema semantics; this walk only enforces installed-schema resource policy. */
export function compileStaticDocumentSchema(schema: unknown): StaticSchemaValidator {
  const bounded = boundedJson(schema, EXTENSION_SCHEMA_LIMITS);
  // Detach from caller mutation, including annotation/default data.
  const snapshot: unknown = JSON.parse(bounded.canonical);
  const forbidden = new Set(["$ref", "$dynamicRef", "$recursiveRef", "$id", "$anchor", "$dynamicAnchor", "$async", "pattern", "patternProperties", "format"]);
  const singles = ["not", "if", "then", "else", "contains", "propertyNames", "additionalProperties", "unevaluatedProperties", "items", "unevaluatedItems", "contentSchema", "additionalItems"];
  const maps = ["properties", "$defs", "definitions", "dependentSchemas"];
  const arrays = ["allOf", "anyOf", "oneOf", "prefixItems"];
  let nodes = 0;
  let quadratic = false;
  const inspect = (value: unknown, depth: number): void => {
    if (++nodes > EXTENSION_SCHEMA_LIMITS.maxSchemaNodes || depth > EXTENSION_SCHEMA_LIMITS.maxSchemaDepth) invalid("schema exceeds node/depth work limit");
    if (typeof value === "boolean") return;
    if (!isPlainJsonObject(value)) invalid("subschema must be an object or boolean");
    for (const keyword of forbidden) if (Object.hasOwn(value, keyword)) invalid(`unsupported static schema keyword: ${keyword}`);
    if (value.$schema !== undefined && value.$schema !== "https://json-schema.org/draft/2020-12/schema") invalid("unsupported JSON Schema dialect");
    quadratic ||= value.uniqueItems === true;
    for (const keyword of singles) if (Object.hasOwn(value, keyword)) inspect(value[keyword], depth + 1);
    for (const keyword of maps) {
      const map = value[keyword];
      if (isPlainJsonObject(map)) for (const child of Object.values(map)) inspect(child, depth + 1);
    }
    for (const keyword of arrays) {
      const list = value[keyword];
      if (!Array.isArray(list)) continue; // AJV reports malformed keyword values.
      if (keyword !== "prefixItems" && list.length > EXTENSION_SCHEMA_LIMITS.maxCombinatorBranches) invalid("schema exceeds combinator branch limit");
      for (const child of list) inspect(child, depth + 1);
    }
    // AJV retains legacy dependencies support; array entries here are property
    // names, while object/boolean entries are subschemas. No generic recursion
    // through const/enum/default/examples (all are instance data).
    if (isPlainJsonObject(value.dependencies)) {
      for (const child of Object.values(value.dependencies)) if (!Array.isArray(child)) inspect(child, depth + 1);
    }
  };
  inspect(snapshot, 0);
  const ajv = new Ajv2020({ allErrors: false, strict: true, validateSchema: true });
  let validate: ReturnType<typeof ajv.compile>;
  try { validate = ajv.compile(snapshot as boolean | Record<string, unknown>); }
  catch { return invalid("installed schema is not valid supported draft-2020-12 JSON Schema"); }
  return {
    validate(document: unknown): boolean {
      const input = boundedJson(document);
      // Conservative work admission, including literal enum/const size and
      // quadratic uniqueItems comparisons. This is not a wall-clock sandbox.
      const work = input.nodes * bounded.nodes * (quadratic ? input.nodes : 1);
      if (work > EXTENSION_SCHEMA_LIMITS.maxValidationWork) invalid("document/schema pair exceeds validation work limit");
      return validate(document);
    },
    errors(): readonly string[] {
      return (validate.errors ?? []).slice(0, 4).map((error) => `${error.instancePath || "/"} ${error.message}`);
    },
  };
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((key) => Object.hasOwn(value, key));
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

export function validateDocumentKey(key: ExtensionDocumentKey): void {
  if (
    !isPlainJsonObject(key) || !exactFields(key, ["installationId", "scopeSessionId", "extensionId", "documentId"]) ||
    !matches(key.installationId, UUID) || !matches(key.scopeSessionId, UUID) ||
    !matches(key.extensionId, IDENTIFIER) || !matches(key.documentId, IDENTIFIER)
  ) throw new ExtensionDocumentError("INVALID_KEY", "document key requires canonical lowercase installation/session UUIDs and stable extension/document identifiers");
}

function payload(document: unknown): { canonical: string; digest: string } {
  const { canonical } = boundedJson(document);
  return { canonical, digest: sha256(canonical) };
}
function assertSchema(document: unknown, validator: StaticSchemaValidator): void {
  if (!validator.validate(document)) {
    throw new ExtensionDocumentError("SCHEMA_INVALID", `document does not satisfy installed schema: ${validator.errors().join("; ").slice(0, 1024)}`);
  }
}
export function validateDocumentPayload(document: unknown, validator: StaticSchemaValidator): { readonly canonical: string; readonly digest: string } {
  const result = payload(document);
  assertSchema(document, validator);
  return result;
}
function stableRecordKey(key: ExtensionDocumentKey): string { return sha256(canonicalJson(key)); }

function isRecord(value: unknown): value is StoredExtensionDocument {
  if (!isPlainJsonObject(value) || !exactFields(value, ["version", "key", "revision", "document", "receipts"]) || value.version !== 1 || !positiveInteger(value.revision) || !Array.isArray(value.receipts)) return false;
  try {
    const key = value.key as ExtensionDocumentKey;
    validateDocumentKey(key);
    const content = payload(value.document);
    if (value.receipts.length !== Math.min(value.revision, EXTENSION_DOCUMENT_LIMITS.maxRetainedReceipts)) return false;
    const seen = new Set<string>();
    for (let index = 0; index < value.receipts.length; index++) {
      const receipt: unknown = value.receipts[index];
      if (
        !isPlainJsonObject(receipt) || !exactFields(receipt, ["requestId", "scopeSessionId", "extensionId", "documentId", "revision", "acceptedAt", "payloadDigest", "baseRevision", "schemaVersion"]) ||
        !matches(receipt.requestId, UUID) || seen.has(receipt.requestId) ||
        receipt.scopeSessionId !== key.scopeSessionId || receipt.extensionId !== key.extensionId || receipt.documentId !== key.documentId ||
        !positiveInteger(receipt.revision) || receipt.revision !== value.revision - (value.receipts.length - 1 - index) ||
        receipt.baseRevision !== receipt.revision - 1 || !positiveInteger(receipt.schemaVersion) ||
        !matches(receipt.payloadDigest, DIGEST) || !timestamp(receipt.acceptedAt)
      ) return false;
      seen.add(receipt.requestId);
    }
    return value.receipts.at(-1).payloadDigest === content.digest;
  } catch { return false; }
}

export interface ExtensionDocumentStoreOptions {
  /** One owner-private root/instance per installation; no cross-process writer support. */
  readonly root: string;
  /** Await authoritative backend checks before entering the synchronous commit. */
  readonly assertWritableScope?: (key: ExtensionDocumentKey) => void | Promise<void>;
  readonly now?: () => string;
}

/** Owner-private atomic records; same-instance writes serialize and never await inside the commit. */
export class ExtensionDocumentStore {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly now: () => string;
  constructor(private readonly options: ExtensionDocumentStoreOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }
  private directory(): string { return join(this.options.root, "documents"); }
  private path(key: ExtensionDocumentKey): string { return join(this.directory(), `${stableRecordKey(key)}.json`); }
  private directoryExists(): boolean {
    try {
      if (!lstatSync(this.directory()).isDirectory()) throw new Error("document directory is not a regular directory");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  read(key: ExtensionDocumentKey): StoredExtensionDocument | null {
    validateDocumentKey(key);
    let fd: number | undefined;
    try {
      if (!this.directoryExists()) return null;
      try { fd = openSync(this.path(key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      const stat = fstatSync(fd);
      const maximum = EXTENSION_DOCUMENT_LIMITS.maxRecordBytes;
      if (!stat.isFile() || stat.size > maximum) throw new Error("record is not a bounded regular file");
      // Read the same descriptor under a hard cap even if a corrupt file grows
      // after fstat. Do not use a path-based, potentially unbounded readFile().
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length !== stat.size) throw new Error("record changed size while being read");
      const record: unknown = JSON.parse(buffer.subarray(0, length).toString("utf8"));
      if (!isRecord(record) || canonicalJson(record.key) !== canonicalJson(key)) throw new Error("record identity/content/receipts are incoherent");
      return record;
    } catch {
      throw new ExtensionDocumentError("STORE_CORRUPT", "extension document cannot be read as a coherent bounded record");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private totalUsage(): { documents: number; bytes: number } {
    if (!this.directoryExists()) return { documents: 0, bytes: 0 };
    let documents = 0;
    let bytes = 0;
    const directory = opendirSync(this.directory());
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
          throw new ExtensionDocumentError("STORE_CORRUPT", "document directory contains an unexpected entry; explicit recovery is required");
        }
        documents++;
        bytes += lstatSync(join(this.directory(), entry.name)).size;
        if (documents > EXTENSION_DOCUMENT_LIMITS.maxDocumentsPerInstallation || bytes > EXTENSION_DOCUMENT_LIMITS.maxBytesPerInstallation) {
          throw new ExtensionDocumentError("QUOTA_EXCEEDED", "extension document store already exceeds installation quota");
        }
      }
      return { documents, bytes };
    } finally { directory.closeSync(); }
  }
  async publish(input: PublishExtensionDocumentRequest, validator: StaticSchemaValidator): Promise<ExtensionDocumentReceipt> {
    if (!isPlainJsonObject(input)) invalid("publish request must be an object");
    validateDocumentKey(input.key);
    if (!matches(input.requestId, UUID) || !Number.isSafeInteger(input.ifRevision) || input.ifRevision < 0 || !positiveInteger(input.schemaVersion)) invalid("request requires a canonical UUID, nonnegative safe base revision and positive schema version");
    const content = payload(input.document);
    // Snapshot every operation field before the first await. The caller cannot
    // change lock identity, persisted bytes or receipt identity while queued.
    const request: PublishExtensionDocumentRequest = {
      key: Object.freeze({ ...input.key }),
      document: JSON.parse(content.canonical),
      ifRevision: input.ifRevision, requestId: input.requestId, schemaVersion: input.schemaVersion,
    };
    const key = stableRecordKey(request.key);
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      const existing = this.read(request.key);
      const duplicate = existing?.receipts.find((receipt) => receipt.requestId === request.requestId);
      if (duplicate) {
        if (duplicate.payloadDigest === content.digest && duplicate.baseRevision === request.ifRevision && duplicate.schemaVersion === request.schemaVersion) return duplicate;
        throw new ExtensionDocumentError("REQUEST_ID_REUSED", "request ID was retained for different operation input", existing!.revision);
      }
      // Retained acceptance survives scope exit or a later schema upgrade. Only
      // a genuinely new operation is checked against current writable policy.
      // Hold the per-document lock while awaiting authority. Installation quota
      // accounting and atomic replacement below contain no further await, so
      // different documents cannot race the same-instance quota commit.
      await this.options.assertWritableScope?.(request.key);
      assertSchema(request.document, validator);
      const revision = existing?.revision ?? 0;
      if (request.ifRevision !== revision) throw new ExtensionDocumentError("CONFLICT", "document revision conflict; read and reconcile before publishing", revision);
      if (revision === Number.MAX_SAFE_INTEGER) throw new ExtensionDocumentError("QUOTA_EXCEEDED", "document revision space is exhausted");
      const acceptedAt = this.now();
      if (!timestamp(acceptedAt)) throw new ExtensionDocumentError("STORE_UNAVAILABLE", "document clock did not produce a valid canonical timestamp");
      const receipt: ExtensionDocumentReceipt = {
        requestId: request.requestId, scopeSessionId: request.key.scopeSessionId,
        extensionId: request.key.extensionId, documentId: request.key.documentId,
        revision: revision + 1, acceptedAt, payloadDigest: content.digest,
        baseRevision: request.ifRevision, schemaVersion: request.schemaVersion,
      };
      const record: StoredExtensionDocument = {
        version: 1, key: request.key, revision: receipt.revision, document: request.document,
        receipts: [...(existing?.receipts ?? []), receipt].slice(-EXTENSION_DOCUMENT_LIMITS.maxRetainedReceipts),
      };
      const serializedBytes = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      if (serializedBytes > EXTENSION_DOCUMENT_LIMITS.maxRecordBytes) throw new ExtensionDocumentError("QUOTA_EXCEEDED", "formatted document record exceeds storage limit");
      const usage = this.totalUsage();
      const priorBytes = existing ? lstatSync(this.path(request.key)).size : 0;
      if ((!existing && usage.documents >= EXTENSION_DOCUMENT_LIMITS.maxDocumentsPerInstallation) || usage.bytes - priorBytes + serializedBytes > EXTENSION_DOCUMENT_LIMITS.maxBytesPerInstallation) {
        throw new ExtensionDocumentError("QUOTA_EXCEEDED", "extension document installation quota exceeded");
      }
      try {
        mkdirSync(this.directory(), { recursive: true, mode: 0o700 });
        writePrivateJsonFile(this.path(request.key), record);
      } catch {
        throw new ExtensionDocumentError("STORE_UNAVAILABLE", "extension document was not persisted");
      }
      return receipt;
    } catch (error) {
      if (error instanceof ExtensionDocumentError) throw error;
      throw new ExtensionDocumentError("STORE_UNAVAILABLE", "extension document operation could not complete");
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}

export function newExtensionDocumentRequestId(): string { return randomUUID(); }
