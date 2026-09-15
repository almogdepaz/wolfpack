import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../../src/canonical-json.ts";
import {
  compileStaticDocumentSchema, ExtensionDocumentError, ExtensionDocumentStore,
  validateDocumentKey, validateDocumentPayload,
  type StoredExtensionDocument, type ExtensionDocumentErrorCode,
} from "../../src/extensions/document-contract.ts";

const key = {
  installationId: "6b57a60c-059e-45cf-a861-92a9161a0e39",
  scopeSessionId: "0aba983a-fe91-4ca9-9616-1423ce8fae81",
  extensionId: "agent-context", documentId: "context",
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temp(): string { const root = mkdtempSync(join(tmpdir(), "wolfpack-document-integrity-")); roots.push(root); return root; }
function typedFailure(run: () => unknown, code: ExtensionDocumentErrorCode): void {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ExtensionDocumentError);
  expect((caught as ExtensionDocumentError).code).toBe(code);
}
const objectSchema = () => compileStaticDocumentSchema({ type: "object" });
async function stored() {
  const root = temp();
  const store = new ExtensionDocumentStore({ root });
  const request = { key, document: { goal: "saved" }, ifRevision: 0, schemaVersion: 1, requestId: randomUUID() };
  const receipt = await store.publish(request, objectSchema());
  const file = join(root, "documents", readdirSync(join(root, "documents"))[0]!);
  const original = readFileSync(file, "utf8");
  return { root, store, file, request, receipt, original };
}

describe("static schema positions and bounded JSON", () => {
  test.each([true, false])("supports standard boolean schema %s", (schema) => {
    expect(compileStaticDocumentSchema(schema).validate({ anything: 1 })).toBe(schema);
  });
  test("supports boolean subschemas in properties and applicators", () => {
    const schema = compileStaticDocumentSchema({ type: "object", properties: { allowed: true, denied: false }, allOf: [true] });
    expect(schema.validate({ allowed: "text" })).toBe(true);
    expect(schema.validate({ denied: "text" })).toBe(false);
  });
  test.each(["pattern", "$ref", "format"])("permits instance property named %s", (name) => {
    const schema = compileStaticDocumentSchema({ type: "object", properties: { [name]: { type: "string" } } });
    expect(schema.validate({ [name]: "data" })).toBe(true);
  });
  test.each(["const", "default", "examples", "enum"])("does not inspect %s literal objects as schemas", (keyword) => {
    const literal = { $ref: "data", pattern: "data", format: "data" };
    const value = keyword === "examples" || keyword === "enum" ? [literal] : literal;
    expect(compileStaticDocumentSchema({ type: "object", [keyword]: value }).validate(literal)).toBe(true);
  });
  test.each([
    { $defs: { unused: { $ref: "#/$defs/other" } } },
    { definitions: { unused: { pattern: "(a+)+$" } } },
    { type: "array", unevaluatedItems: { format: "date" } },
    { type: "string", contentSchema: { $ref: "https://example.invalid/schema" } },
    { type: "object", dependentSchemas: { field: { $ref: "#" } } },
    { type: "array", items: { $ref: "#" } },
    { anyOf: [{ $ref: "#" }] },
  ])("rejects forbidden keywords at every schema position: %j", (schema) => {
    typedFailure(() => compileStaticDocumentSchema(schema), "INVALID_DOCUMENT");
  });
  test.each([undefined, 1n, new Date(), NaN, { type: "not-a-type" }, { type: "object", default: () => 1 }])("invalid schema input is typed: %s", (value) => {
    typedFailure(() => compileStaticDocumentSchema(value), "INVALID_DOCUMENT");
  });
  test("rejects cycles before serialization", () => {
    const value: Record<string, unknown> = {}; value.default = value;
    typedFailure(() => compileStaticDocumentSchema(value), "INVALID_DOCUMENT");
  });
  test("rejects schema width/work before invoking AJV", () => {
    typedFailure(() => compileStaticDocumentSchema({ allOf: Array.from({ length: 300 }, () => ({ type: "object" })) }), "INVALID_DOCUMENT");
  });
  test("rejects async schemas rather than accepting a Promise as validation truth", () => {
    typedFailure(() => compileStaticDocumentSchema({ $async: true, type: "object" }), "INVALID_DOCUMENT");
  });
  test("admits validation work before potentially quadratic uniqueItems checks", () => {
    const schema = compileStaticDocumentSchema({ type: "array", uniqueItems: true, items: { type: "object" } });
    const document = Array.from({ length: 400 }, (_value, value) => ({ value }));
    typedFailure(() => validateDocumentPayload(document, schema), "INVALID_DOCUMENT");
  });
  test("rejects oversized literal schemas without compiling them", () => {
    typedFailure(() => compileStaticDocumentSchema({ const: "x".repeat(70 * 1024) }), "INVALID_DOCUMENT");
  });
  test.each([new Date(), new Map(), [undefined], { nested: undefined }].map((value) => [value]))("rejects non-JSON document values: %s", (value) => {
    typedFailure(() => validateDocumentPayload(value, { validate: () => true, errors: () => [] }), "INVALID_DOCUMENT");
  });
  test("does not execute accessors while inspecting JSON", () => {
    let calls = 0;
    const value = Object.defineProperty({}, "data", { enumerable: true, get() { calls++; return "value"; } });
    typedFailure(() => validateDocumentPayload(value, { validate: () => true, errors: () => [] }), "INVALID_DOCUMENT");
    expect(calls).toBe(0);
  });
  test.each([null, {}, { ...key, installationId: "not-uuid" }, { ...key, unexpected: true }])("malformed key produces typed error: %j", (value) => {
    typedFailure(() => validateDocumentKey(value as typeof key), "INVALID_KEY");
  });
});

type MutableRecord = { -readonly [P in keyof StoredExtensionDocument]: any };
const corruptions: [string, (record: MutableRecord) => void][] = [
  ["zero record revision", (record) => { record.revision = 0; }],
  ["negative receipt revision", (record) => { record.receipts[0].revision = -1; }],
  ["negative receipt base", (record) => { record.receipts[0].baseRevision = -1; }],
  ["negative schema version", (record) => { record.receipts[0].schemaVersion = -1; }],
  ["zero schema version", (record) => { record.receipts[0].schemaVersion = 0; }],
  ["receipt from another scope", (record) => { record.receipts[0].scopeSessionId = randomUUID(); }],
  ["receipt from another extension", (record) => { record.receipts[0].extensionId = "other"; }],
  ["receipt from another document", (record) => { record.receipts[0].documentId = "other"; }],
  ["receipt newer than record", (record) => { record.receipts[0].revision = 2; }],
  ["impossible receipt base", (record) => { record.receipts[0].baseRevision = 1; }],
  ["missing retained receipt", (record) => { record.receipts = []; }],
  ["excess receipts", (record) => { record.receipts = Array.from({ length: 129 }, () => ({ ...record.receipts[0] })); }],
  ["invalid timestamp", (record) => { record.receipts[0].acceptedAt = "not-a-date"; }],
  ["impossible calendar date", (record) => { record.receipts[0].acceptedAt = "2026-02-30T00:00:00.000Z"; }],
  ["oversized timestamp", (record) => { record.receipts[0].acceptedAt = "x".repeat(1024); }],
  ["payload changed without receipt digest", (record) => { record.document = { goal: "changed" }; }],
  ["forged latest digest", (record) => { record.receipts[0].payloadDigest = "0".repeat(64); }],
  ["oversized canonical payload", (record) => {
    record.document = { a: "x".repeat(16_000), b: "x".repeat(16_000), c: "x".repeat(16_000), d: "x".repeat(16_000), e: "x".repeat(16_000) };
    record.receipts[0].payloadDigest = createHash("sha256").update(canonicalJson(record.document)).digest("hex");
  }],
  ["extra stored key field", (record) => { record.key.extra = "not-part-of-authority"; }],
];

describe("persisted document authority", () => {
  test.each(corruptions)("rejects %s on read and duplicate retry", async (_name, mutate) => {
    const fixture = await stored();
    const record = JSON.parse(fixture.original);
    mutate(record);
    writeFileSync(fixture.file, JSON.stringify(record));
    typedFailure(() => fixture.store.read(key), "STORE_CORRUPT");
    await expect(fixture.store.publish(fixture.request, objectSchema())).rejects.toMatchObject({ code: "STORE_CORRUPT" });
  });
  test("rejects duplicate receipt IDs and gaps within retained history", async () => {
    const fixture = await stored();
    await fixture.store.publish({ ...fixture.request, requestId: randomUUID(), ifRevision: 1 }, objectSchema());
    const valid = JSON.parse(readFileSync(fixture.file, "utf8"));
    valid.receipts[1].requestId = valid.receipts[0].requestId;
    writeFileSync(fixture.file, JSON.stringify(valid));
    typedFailure(() => fixture.store.read(key), "STORE_CORRUPT");
  });
  test("refuses a symlink record without reading or modifying its target", async () => {
    const fixture = await stored();
    const target = join(fixture.root, "other.json");
    writeFileSync(target, fixture.original);
    rmSync(fixture.file); symlinkSync(target, fixture.file);
    typedFailure(() => fixture.store.read(key), "STORE_CORRUPT");
    expect(readFileSync(target, "utf8")).toBe(fixture.original);
  });
  test("rejects physically oversized records even when JSON payload is tiny", async () => {
    const fixture = await stored();
    writeFileSync(fixture.file, fixture.original + " ".repeat(2 * 1024 * 1024));
    typedFailure(() => fixture.store.read(key), "STORE_CORRUPT");
  });
  test("duplicate survives restart, ended scope and changed installed schema", async () => {
    const fixture = await stored();
    const restarted = new ExtensionDocumentStore({ root: fixture.root, assertWritableScope: () => { throw new Error("scope ended"); } });
    const newSchema = compileStaticDocumentSchema({ type: "object", required: ["newField"], properties: { newField: { type: "string" } } });
    await expect(restarted.publish(fixture.request, newSchema)).resolves.toEqual(fixture.receipt);
    await expect(restarted.publish({ ...fixture.request, schemaVersion: 2 }, newSchema)).rejects.toMatchObject({ code: "REQUEST_ID_REUSED" });
  });
  test("serializes concurrent CAS and retains an immutable request snapshot", async () => {
    const root = temp();
    const store = new ExtensionDocumentStore({ root });
    const mutableKey = { ...key };
    const document = { goal: "before" };
    const request = { key: mutableKey, document, requestId: randomUUID(), ifRevision: 0, schemaVersion: 1 };
    const first = store.publish(request, objectSchema());
    mutableKey.documentId = "other"; document.goal = "after";
    await first;
    expect(store.read(key)?.document).toEqual({ goal: "before" });
    expect(store.read({ ...key, documentId: "other" })).toBeNull();
    const next = { key, document: {}, ifRevision: 1, schemaVersion: 1 };
    const results = await Promise.allSettled([
      store.publish({ ...next, requestId: randomUUID() }, objectSchema()),
      store.publish({ ...next, requestId: randomUUID() }, objectSchema()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "CONFLICT" } });
  });
  test("rejects a bad clock before changing the persisted record", async () => {
    const fixture = await stored();
    const store = new ExtensionDocumentStore({ root: fixture.root, now: () => "invalid" });
    await expect(store.publish({ ...fixture.request, ifRevision: 1, requestId: randomUUID() }, objectSchema())).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
    expect(readFileSync(fixture.file, "utf8")).toBe(fixture.original);
  });
  test("waits for asynchronous writable-scope authority and preserves its rejection", async () => {
    const root = temp();
    let entered!: () => void;
    const checking = new Promise<void>((resolve) => { entered = resolve; });
    let deny!: (error: Error) => void;
    const decision = new Promise<void>((_resolve, reject) => { deny = reject; });
    const store = new ExtensionDocumentStore({ root, assertWritableScope: () => { entered(); return decision; } });
    const publishing = store.publish({ key, document: {}, requestId: randomUUID(), ifRevision: 0, schemaVersion: 1 }, objectSchema());
    // Bun's rejection matcher can drain the promise immediately. Attach only a
    // handler until the test has explicitly released the authority decision.
    void publishing.catch(() => {});
    await checking;
    expect(store.read(key)).toBeNull();
    deny(new ExtensionDocumentError("SCOPE_NOT_WRITABLE", "scope ended"));
    await expect(publishing).rejects.toMatchObject({ code: "SCOPE_NOT_WRITABLE" });
    expect(store.read(key)).toBeNull();
  });
  test("supports successful asynchronous writable-scope checks", async () => {
    const store = new ExtensionDocumentStore({ root: temp(), assertWritableScope: async () => {} });
    await expect(store.publish({ key, document: {}, requestId: randomUUID(), ifRevision: 0, schemaVersion: 1 }, objectSchema())).resolves.toMatchObject({ revision: 1 });
  });
  test("refuses revision overflow and preserves the last valid record", async () => {
    const fixture = await stored();
    const record = JSON.parse(fixture.original);
    record.revision = Number.MAX_SAFE_INTEGER;
    record.receipts = Array.from({ length: 128 }, (_value, index) => {
      const revision = Number.MAX_SAFE_INTEGER - 127 + index;
      return { ...fixture.receipt, revision, baseRevision: revision - 1, requestId: randomUUID() };
    });
    const original = JSON.stringify(record);
    writeFileSync(fixture.file, original);
    expect(fixture.store.read(key)?.revision).toBe(Number.MAX_SAFE_INTEGER);
    await expect(fixture.store.publish({ ...fixture.request, ifRevision: Number.MAX_SAFE_INTEGER, requestId: randomUUID() }, objectSchema())).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(readFileSync(fixture.file, "utf8")).toBe(original);
  });
  test("retains exactly 128 contiguous receipts and can retry the oldest retained one", async () => {
    const root = temp();
    const store = new ExtensionDocumentStore({ root });
    const schema = objectSchema();
    const requests = Array.from({ length: 129 }, (_value, ifRevision) => ({ key, document: { ifRevision }, ifRevision, schemaVersion: 1, requestId: randomUUID() }));
    for (const request of requests) await store.publish(request, schema);
    const record = new ExtensionDocumentStore({ root }).read(key)!;
    expect(record.receipts).toHaveLength(128);
    expect(record.receipts[0]?.revision).toBe(2);
    expect(record.receipts.at(-1)?.revision).toBe(129);
    await expect(store.publish(requests[1]!, schema)).resolves.toEqual(record.receipts[0]!);
    await expect(store.publish(requests[0]!, schema)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
