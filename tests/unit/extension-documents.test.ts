import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileStaticDocumentSchema, ExtensionDocumentError, ExtensionDocumentStore,
  EXTENSION_DOCUMENT_ERROR, validateDocumentPayload,
} from "../../src/extensions/document-contract.ts";

const key = { installationId: "a0a80123-1234-4234-9234-123456789abc", scopeSessionId: "c0a80123-1234-4234-9234-123456789abc", extensionId: "agent-context", documentId: "context" } as const;
const schema = compileStaticDocumentSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, required: ["schemaVersion", "goal"], properties: { schemaVersion: { const: 1 }, goal: { type: "string", maxLength: 200 } } });
function root(): string { return mkdtempSync(join(tmpdir(), "wolfpack-extension-documents-")); }

describe("extension document contract", () => {
  test("validates bounded static JSON schemas without refs", () => {
    expect(validateDocumentPayload({ schemaVersion: 1, goal: "data only" }, schema).digest).toMatch(/^[a-f0-9]{64}$/);
    expect(() => compileStaticDocumentSchema({ $ref: "https://example.invalid/schema" })).toThrow(ExtensionDocumentError);
    expect(() => compileStaticDocumentSchema({ type: "object", properties: { goal: { $ref: "#/$defs/text" } } })).toThrow(ExtensionDocumentError);
    expect(() => compileStaticDocumentSchema({ type: "string", pattern: "^(a+)+$" })).toThrow(ExtensionDocumentError);
    expect(() => validateDocumentPayload({ schemaVersion: 1, goal: 3 }, schema)).toThrow(ExtensionDocumentError);
  });
  test("persists CAS and retained idempotency receipts atomically", async () => {
    const directory = root();
    try {
      const store = new ExtensionDocumentStore({ root: directory, now: () => "2026-09-01T00:00:00.000Z" });
      const first = await store.publish({ key, document: { schemaVersion: 1, goal: "first" }, ifRevision: 0, schemaVersion: 1, requestId: "11111111-1111-4111-8111-111111111111" }, schema);
      expect(first).toMatchObject({ revision: 1, scopeSessionId: key.scopeSessionId });
      await expect(store.publish({ key, document: { schemaVersion: 1, goal: "second" }, ifRevision: 0, schemaVersion: 1, requestId: "22222222-2222-4222-8222-222222222222" }, schema)).rejects.toMatchObject({ code: EXTENSION_DOCUMENT_ERROR.CONFLICT, currentRevision: 1 });
      await expect(store.publish({ key, document: { schemaVersion: 1, goal: "first" }, ifRevision: 0, schemaVersion: 1, requestId: first.requestId }, schema)).resolves.toEqual(first);
      await expect(store.publish({ key, document: { schemaVersion: 1, goal: "changed" }, ifRevision: 0, schemaVersion: 1, requestId: first.requestId }, schema)).rejects.toMatchObject({ code: EXTENSION_DOCUMENT_ERROR.REQUEST_ID_REUSED });
      expect(new ExtensionDocumentStore({ root: directory }).read(key)).toMatchObject({ revision: 1, document: { goal: "first" } });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  test("recovers interrupted before-rename writes after restart without promoting uncommitted content or losing receipts", async () => {
    const directory = root();
    try {
      const first = { key, document: { schemaVersion: 1, goal: "committed" }, ifRevision: 0, schemaVersion: 1, requestId: "11111111-1111-4111-8111-111111111111" };
      const store = new ExtensionDocumentStore({ root: directory });
      const receipt = await store.publish(first, schema);
      const interrupted = { ...first, document: { schemaVersion: 1, goal: "uncommitted" }, ifRevision: 1, requestId: "22222222-2222-4222-8222-222222222222" };
      // Exit after fsync/close but before rename: finally cleanup cannot run.
      const child = Bun.spawnSync([process.execPath, "-e", `
        import * as fs from "node:fs";
        import { spyOn } from "bun:test";
        import { ExtensionDocumentStore, compileStaticDocumentSchema } from ${JSON.stringify(new URL("../../src/extensions/document-contract.ts", import.meta.url).pathname)};
        spyOn(fs, "renameSync").mockImplementation(() => process.exit(73));
        await new ExtensionDocumentStore({ root: ${JSON.stringify(directory)} }).publish(${JSON.stringify(interrupted)}, compileStaticDocumentSchema(true));
      `]);
      expect(child.exitCode).toBe(73);
      const docs = join(directory, "documents");
      expect(readdirSync(docs).some((name) => /\.json\.tmp-\d+-[a-f0-9]{12}$/.test(name))).toBe(true);
      const record = readdirSync(docs).find((name) => name.endsWith(".json"))!;
      writeFileSync(join(docs, `${record}.tmp-123-abcdef012345`), "{partial", { mode: 0o600 });
      const restarted = new ExtensionDocumentStore({ root: directory });
      expect(restarted.read(key)?.document).toEqual(first.document);
      expect(await restarted.publish(first, schema)).toEqual(receipt);
      const next = await restarted.publish({ ...interrupted, document: { schemaVersion: 1, goal: "new operation" } }, schema);
      expect(next.revision).toBe(2);
      expect(restarted.read(key)?.receipts).toEqual([receipt, next]);
      expect(readdirSync(docs)).toEqual([record]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  for (const kind of ["symlink", "hardlink", "directory", "public-file", "public-directory", "unexpected-name", "short-suffix"] as const) {
    test(`crash recovery fails closed for ${kind} and preserves the entry`, async () => {
      const directory = root();
      try {
        const store = new ExtensionDocumentStore({ root: directory });
        const first = { key, document: { schemaVersion: 1, goal: "saved" }, ifRevision: 0, schemaVersion: 1, requestId: "11111111-1111-4111-8111-111111111111" };
        await store.publish(first, schema);
        const docs = join(directory, "documents"), record = readdirSync(docs)[0]!;
        const name = kind === "unexpected-name" ? "foreign" : `${record}.tmp-123-${kind === "short-suffix" ? "abcdef" : "abcdef012345"}`;
        const path = join(docs, name), sentinel = join(directory, "sentinel");
        writeFileSync(sentinel, "preserve", { mode: 0o600 });
        if (kind === "symlink") symlinkSync(sentinel, path);
        else if (kind === "hardlink") linkSync(sentinel, path);
        else if (kind === "directory") mkdirSync(path, { mode: 0o700 });
        else writeFileSync(path, "partial", { mode: kind === "public-file" ? 0o644 : 0o600 });
        if (kind === "public-file") {
          // Creation modes are masked by umask; establish the hostile fixture explicitly.
          chmodSync(path, 0o644);
          expect(statSync(path).mode & 0o777).toBe(0o644);
        }
        if (kind === "public-directory") chmodSync(docs, 0o755);
        await expect(store.publish({ ...first, ifRevision: 1, requestId: "22222222-2222-4222-8222-222222222222" }, schema)).rejects.toMatchObject({ code: EXTENSION_DOCUMENT_ERROR.STORE_CORRUPT });
        expect(existsSync(path)).toBe(true);
        expect(store.read(key)?.revision).toBe(1);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
  }

  test("surfaces corruption and refuses scopes that the authoritative backend rejects", async () => {
    const directory = root();
    try {
      const blocked = new ExtensionDocumentStore({ root: directory, assertWritableScope: () => { throw new ExtensionDocumentError(EXTENSION_DOCUMENT_ERROR.SCOPE_NOT_WRITABLE, "session ended"); } });
      await expect(blocked.publish({ key, document: { schemaVersion: 1, goal: "no" }, ifRevision: 0, schemaVersion: 1, requestId: "33333333-3333-4333-8333-333333333333" }, schema)).rejects.toMatchObject({ code: EXTENSION_DOCUMENT_ERROR.SCOPE_NOT_WRITABLE });
      const store = new ExtensionDocumentStore({ root: directory });
      await store.publish({ key, document: { schemaVersion: 1, goal: "saved" }, ifRevision: 0, schemaVersion: 1, requestId: "44444444-4444-4444-8444-444444444444" }, schema);
      writeFileSync(join(directory, "documents", readdirSync(join(directory, "documents"))[0]!), "not JSON");
      expect(() => store.read(key)).toThrow(ExtensionDocumentError);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
