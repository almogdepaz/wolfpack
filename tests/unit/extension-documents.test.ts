import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileStaticDocumentSchema, ExtensionDocumentError, ExtensionDocumentStore,
  EXTENSION_DOCUMENT_ERROR, validateDocumentPayload,
} from "../../src/extensions/document-contract.ts";

const key = { installationId: "local-install", scopeSessionId: "c0a80123-1234-4234-9234-123456789abc", extensionId: "agent-context", documentId: "context" } as const;
const schema = compileStaticDocumentSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, required: ["schemaVersion", "goal"], properties: { schemaVersion: { const: 1 }, goal: { type: "string", maxLength: 200 } } });
function root(): string { return mkdtempSync(join(tmpdir(), "wolfpack-extension-documents-")); }

describe("extension document contract", () => {
  test("validates bounded static JSON schemas without refs", () => {
    expect(validateDocumentPayload({ schemaVersion: 1, goal: "data only" }, schema).digest).toMatch(/^[a-f0-9]{64}$/);
    expect(() => compileStaticDocumentSchema({ $ref: "https://example.invalid/schema" })).toThrow(ExtensionDocumentError);
    expect(() => validateDocumentPayload({ schemaVersion: 1, goal: 3 }, schema)).toThrow(ExtensionDocumentError);
  });
  test("persists CAS and retained idempotency receipts atomically", async () => {
    const directory = root();
    try {
      const store = new ExtensionDocumentStore({ root: directory, now: () => "2026-09-01T00:00:00.000Z" });
      const first = await store.publish({ key, document: { schemaVersion: 1, goal: "first" }, ifRevision: 0, requestId: "11111111-1111-4111-8111-111111111111" }, schema);
      expect(first).toMatchObject({ revision: 1, scopeSessionId: key.scopeSessionId });
      await expect(store.publish({ key, document: { schemaVersion: 1, goal: "second" }, ifRevision: 0, requestId: "22222222-2222-4222-8222-222222222222" }, schema)).rejects.toMatchObject({ code: EXTENSION_DOCUMENT_ERROR.CONFLICT, currentRevision: 1 });
      await expect(store.publish({ key, document: { schemaVersion: 1, goal: "first" }, ifRevision: 0, requestId: first.requestId }, schema)).resolves.toEqual(first);
      await expect(store.publish({ key, document: { schemaVersion: 1, goal: "changed" }, ifRevision: 0, requestId: first.requestId }, schema)).rejects.toMatchObject({ code: EXTENSION_DOCUMENT_ERROR.REQUEST_ID_REUSED });
      expect(new ExtensionDocumentStore({ root: directory }).read(key)).toMatchObject({ revision: 1, document: { goal: "first" } });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  test("surfaces corruption and refuses scopes that the authoritative backend rejects", async () => {
    const directory = root();
    try {
      const blocked = new ExtensionDocumentStore({ root: directory, assertWritableScope: () => { throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.SCOPE_NOT_WRITABLE, "session ended"); } });
      await expect(blocked.publish({ key, document: { schemaVersion: 1, goal: "no" }, ifRevision: 0, requestId: "33333333-3333-4333-8333-333333333333" }, schema)).rejects.toMatchObject({ code: EXTENSION_DOCUMENT_ERROR.SCOPE_NOT_WRITABLE });
      const store = new ExtensionDocumentStore({ root: directory });
      await store.publish({ key, document: { schemaVersion: 1, goal: "saved" }, ifRevision: 0, requestId: "44444444-4444-4444-8444-444444444444" }, schema);
      writeFileSync(join(directory, "documents", readdirSync(join(directory, "documents"))[0]!), "not JSON");
      expect(() => store.read(key)).toThrow(ExtensionDocumentError);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
