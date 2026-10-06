import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
const temp = mkdtempSync(join(tmpdir(), "wp-runtime-followup-"));
process.env.HOME = temp;
process.env.WOLFPACK_MACHINE_ID_PATH = join(temp, "machine-id");
const hostId = "11111111-1111-4111-8111-111111111111";
const { ExtensionRuntime } = await import("../../../src/extensions/runtime.ts");
const { ExtensionDocumentStore } = await import("../../../src/extensions/document-contract.ts");
afterAll(() => rmSync(temp, { recursive: true, force: true }));
function fixture(id: string, uiBytes?: number) {
  const source = mkdtempSync(join(temp, "source-"));
  mkdirSync(join(source, "dist")); mkdirSync(join(source, "schemas"));
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: id, version: "1.0.0", wolfpack: {
    manifestVersion: 1, apiVersion: 1, id, ui: "dist/ui.js", skills: [],
    documents: [{ id: "context", schemaVersion: 1, schema: "schemas/context.json" }],
  } }));
  writeFileSync(join(source, "dist/ui.js"), uiBytes ? "//" + "a".repeat(uiBytes - 2) : "export default () => {};\n");
  writeFileSync(join(source, "schemas/context.json"), JSON.stringify({ type: "object" }));
  return source;
}
function runtime() { return new ExtensionRuntime({ root: mkdtempSync(join(temp, "runtime-")), installationId: hostId }); }
async function install(r: InstanceType<typeof ExtensionRuntime>, id: string, uiBytes?: number) { return r.install({ source: fixture(id, uiBytes), trustBrowserCode: true }); }

test("R3: installer refuses a UI bundle beyond the fixed browser-loader cap", async () => {
  const r = runtime();
  let failure: unknown;
  try { await install(r, "alpha", 1024 * 1024 + 1); } catch (error) { failure = error; }
  expect(failure).toBeDefined();
});
test("R4: corrupt snapshot reference cannot make purging alpha destroy active beta", async () => {
  const r = runtime();
  await install(r, "alpha"); const beta = await install(r, "beta");
  const file = join(r.root, "registry.json");
  const registry = JSON.parse(readFileSync(file, "utf8"));
  registry.installations.find((entry: any) => entry.extensionId === "alpha").snapshot = beta.installation.snapshot;
  writeFileSync(file, JSON.stringify(registry));
  let failure: unknown;
  try { r.purge("alpha"); } catch (error) { failure = error; }
  expect({ rejected: failure !== undefined, betaIntact: existsSync(join(beta.installation.snapshot, "package.json")) }).toEqual({ rejected: true, betaIntact: true });
});
test.skipIf(process.getuid?.() === 0)("R4: purge must report failed document cleanup instead of successful erasure", async () => {
  const r = runtime(); await install(r, "alpha");
  const key = { installationId: hostId, scopeSessionId: "22222222-2222-4222-8222-222222222222", extensionId: "alpha", documentId: "context" };
  const store = new ExtensionDocumentStore({ root: r.root });
  await store.publish({ key, document: { goal: "must not claim erased" }, ifRevision: 0, requestId: randomUUID(), schemaVersion: 1 }, r.schema(key));
  const directory = join(r.root, "documents");
  const record = join(directory, readdirSync(directory)[0]!);
  expect(store.read(key)?.revision).toBe(1);
  let failure: unknown;
  chmodSync(directory, 0o500);
  try { r.purge("alpha"); } catch (error) { failure = error; }
  finally { chmodSync(directory, 0o700); }
  expect({ failureReported: failure !== undefined, erased: !existsSync(record) }).not.toEqual({ failureReported: false, erased: false });
});
