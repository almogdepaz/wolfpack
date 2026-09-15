import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as tar from "tar";
import { compileStaticDocumentSchema, ExtensionDocumentStore, validateDocumentPayload } from "../../src/extensions/document-contract.ts";
import { extractVerifiedNpmTarball, fetchExactNpmPackage, inspectNpmTarball, parseExactNpmSpecifier } from "../../src/extensions/package-security.ts";
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
  const scriptMarker = join(root, "package-script-ran");
  writeFileSync(join(source, "package", "package.json"), JSON.stringify({ name: "compiled-example", version: "1.0.0", scripts: {
    prepack: `touch ${JSON.stringify(scriptMarker)}`, install: `touch ${JSON.stringify(scriptMarker)}`,
  } }));
  writeFileSync(join(source, "package", "bundle.js"), "export const value = 'compiled';\n");
  const archive = join(root, "example.tgz");
  await tar.c({ cwd: source, gzip: true, file: archive }, ["package"]);
  assert.equal((await inspectNpmTarball(archive)).files, 2);
  await assert.rejects(inspectNpmTarball(archive, { limits: { maxFiles: 1 } }), { code: "UNSAFE_ARCHIVE" });
  const integrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
  // Real native Fetch + private disk acquisition against an offline registry.
  // A poisoned npm executable makes any accidental package-manager fallback fail.
  const poison = join(root, "poison-bin"); mkdirSync(poison);
  const npmMarker = join(root, "npm-ran");
  writeFileSync(join(poison, "npm"), `#!/bin/sh\nprintf invoked > ${JSON.stringify(npmMarker)}\nexit 99\n`, { mode: 0o700 });
  const previousPath = process.env.PATH; process.env.PATH = `${poison}:${previousPath ?? ""}`;
  const downloads = join(root, "downloads"); mkdirSync(downloads, { mode: 0o700 });
  const archiveBytes = new Uint8Array(readFileSync(archive));
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests++;
    const url = new URL(request.url);
    if (url.pathname === "/compiled-example/1.0.0") return Response.json({ name: "compiled-example", version: "1.0.0", dist: { tarball: `${url.origin}/package.tgz`, integrity } });
    if (url.pathname === "/package.tgz") return new Response(archiveBytes);
    return new Response("not found", { status: 404 });
  } });
  try {
    const registryUrl = `http://127.0.0.1:${server.port}/`;
    const fetched = await fetchExactNpmPackage("npm:compiled-example@1.0.0", downloads, { registryUrl });
    assert.equal(fetched.integrity, integrity);
    assert.deepEqual(readFileSync(fetched.tarball), Buffer.from(archiveBytes));
    const installed = await extractVerifiedNpmTarball(fetched.tarball, join(root, "download-extract"), { integrity: fetched.integrity });
    assert.equal(readFileSync(join(installed, "bundle.js"), "utf8"), "export const value = 'compiled';\n");
    const before = readdirSync(downloads);
    await assert.rejects(fetchExactNpmPackage("npm:compiled-example@1.0.0", downloads, { registryUrl, maxArchiveBytes: 8 }), { code: "NPM_FETCH_FAILED" });
    assert.deepEqual(readdirSync(downloads), before);
    assert.equal(requests, 4);
    assert.equal(existsSync(npmMarker), false); assert.equal(existsSync(scriptMarker), false);
  } finally {
    await server.stop(true);
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  }
  const pending = extractVerifiedNpmTarball(archive, join(root, "extracted"), { integrity });
  writeFileSync(archive, "pathname replaced after snapshot capture");
  const extracted = await pending;
  assert.equal(readFileSync(join(extracted, "bundle.js"), "utf8"), "export const value = 'compiled';\n");
  console.log("compiled extension foundations: schema, document persistence, SemVer, YAML skill install/update/remove, tar inspect/extract, offline native registry acquisition/limits/no scripts/no npm OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
