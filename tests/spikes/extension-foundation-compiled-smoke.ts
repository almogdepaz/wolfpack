import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as tar from "tar";
import { compileStaticDocumentSchema, ExtensionDocumentStore, validateDocumentPayload } from "../../src/extensions/document-contract.ts";
import { extractVerifiedNpmTarball, inspectNpmTarball, parseExactNpmSpecifier } from "../../src/extensions/package-security.ts";
import { deployBundledPiSkills, removeBundledPiSkills } from "../../src/extensions/pi-skill-deployment.ts";

const root = mkdtempSync(join(tmpdir(), "wolfpack-compiled-foundations-"));
try {
  const validator = compileStaticDocumentSchema({ type: "object", required: ["goal"], properties: { goal: { type: "string" } } });
  assert.ok(validateDocumentPayload({ goal: "compiled validation" }, validator).digest);
  assert.equal(parseExactNpmSpecifier("npm:example@1.2.3+build.001").version, "1.2.3+build.001");
  const key = { installationId: randomUUID(), scopeSessionId: randomUUID(), extensionId: "example", documentId: "context" };
  const storeRoot = join(root, "store");
  const store = new ExtensionDocumentStore({ root: storeRoot });
  await store.publish({ key, document: { goal: "persisted" }, requestId: randomUUID(), ifRevision: 0, schemaVersion: 1 }, validator);
  assert.equal(new ExtensionDocumentStore({ root: storeRoot }).read(key)?.revision, 1);

  const skillsRoot = join(root, "skills");
  const skill = (body: string) => ({ name: "compiled-context", files: [{ path: "SKILL.md", content: `---\ndescription: >-\n  Publish structured context.\nname: compiled-context\n---\n${body}\n` }] });
  assert.equal(deployBundledPiSkills({ skillsRoot, extensionId: "example", skills: [skill("v1")] })[0]?.status, "installed");
  assert.equal(deployBundledPiSkills({ skillsRoot, extensionId: "example", skills: [skill("v2")] })[0]?.status, "installed");
  assert.equal(removeBundledPiSkills({ skillsRoot, extensionId: "example", names: ["compiled-context"] })[0]?.status, "removed");

  const source = join(root, "source");
  mkdirSync(join(source, "package"), { recursive: true });
  writeFileSync(join(source, "package", "package.json"), '{"name":"compiled-example","version":"1.0.0"}');
  writeFileSync(join(source, "package", "bundle.js"), "export const value = 'compiled';\n");
  const archive = join(root, "example.tgz");
  await tar.c({ cwd: source, gzip: true, file: archive }, ["package"]);
  assert.equal((await inspectNpmTarball(archive)).files, 2);
  await assert.rejects(inspectNpmTarball(archive, { limits: { maxFiles: 1 } }), { code: "UNSAFE_ARCHIVE" });
  const integrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
  const pending = extractVerifiedNpmTarball(archive, join(root, "extracted"), { integrity });
  writeFileSync(archive, "pathname replaced after snapshot capture");
  const extracted = await pending;
  assert.equal(readFileSync(join(extracted, "bundle.js"), "utf8"), "export const value = 'compiled';\n");
  console.log("compiled extension foundations: schema, document persistence, SemVer, YAML skill install/update/remove, tar inspect/extract OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
