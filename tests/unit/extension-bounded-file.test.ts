import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readBoundedRegularFile } from "../../src/extensions/bounded-file.ts";
import { ExtensionRuntime } from "../../src/extensions/runtime.ts";
import { ExtensionDocumentStore, compileStaticDocumentSchema } from "../../src/extensions/document-contract.ts";

const roots: string[] = [];
function root() { const path = fs.mkdtempSync(join(tmpdir(), "wp-bounded-reader-")); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) fs.rmSync(path, { recursive: true, force: true }); });

// Change the actual file after the real descriptor stat, not a mocked byte count.
function changeAfterStat(path: string, delta: number) {
  const inode = fs.statSync(path).ino;
  const original = fs.fstatSync;
  let changes = 0;
  const spy = spyOn(fs, "fstatSync").mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
    const stat = original(...args);
    if (stat.ino === inode && changes++ === 0) fs.truncateSync(path, Number(stat.size) + delta);
    return stat;
  }) as typeof fs.fstatSync);
  return { restore: () => spy.mockRestore(), changed: () => changes > 0 };
}

function expectCode(run: () => unknown, code: string) {
  let failure: unknown;
  try { run(); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code });
}

test("bounded reader rejects links, directories and oversized files, but permits exact bounds", () => {
  const dir = root(), file = join(dir, "file"), link = join(dir, "link");
  fs.writeFileSync(file, "abc"); fs.symlinkSync(file, link);
  expect(readBoundedRegularFile(file, 3).toString()).toBe("abc");
  expect(() => readBoundedRegularFile(file, 2)).toThrow("bounded regular file");
  expect(() => readBoundedRegularFile(link, 3)).toThrow();
  expect(() => readBoundedRegularFile(dir, 3)).toThrow();
});

test.each([-1, 1])("bounded reader rejects observed size change %i after descriptor stat", delta => {
  const file = join(root(), "file"); fs.writeFileSync(file, "abcd");
  const mutation = changeAfterStat(file, delta);
  try { expect(() => readBoundedRegularFile(file, 8)).toThrow("file size changed"); expect(mutation.changed()).toBe(true); }
  finally { mutation.restore(); }
});

test.each([-1, 1])("runtime maps bounded source size change %i to INVALID_SOURCE", async delta => {
  const dir = root(), source = join(dir, "source"); fs.mkdirSync(source);
  const file = join(source, "package.json");
  fs.writeFileSync(file, JSON.stringify({ name: "fixture-extension", version: "1.0.0", wolfpack: { manifestVersion: 1, apiVersion: 1, id: "fixture", skills: [], documents: [] } }));
  const runtime = new ExtensionRuntime({ root: join(dir, "runtime") });
  const mutation = changeAfterStat(file, delta);
  try { await expect(runtime.install({ source, trustBrowserCode: true })).rejects.toMatchObject({ code: "INVALID_SOURCE" }); expect(mutation.changed()).toBe(true); }
  finally { mutation.restore(); }
  expect(runtime.catalog().installations).toEqual([]);
});

test.each([-1, 1])("document store maps bounded record size change %i to STORE_CORRUPT", async delta => {
  const dir = root(), store = new ExtensionDocumentStore({ root: dir });
  const key = { installationId: randomUUID(), scopeSessionId: randomUUID(), extensionId: "fixture", documentId: "context" };
  expect(store.read(key)).toBeNull();
  await store.publish({ key, document: { goal: "saved" }, ifRevision: 0, schemaVersion: 1, requestId: randomUUID() }, compileStaticDocumentSchema({ type: "object" }));
  const file = join(dir, "documents", fs.readdirSync(join(dir, "documents"))[0]!);
  const mutation = changeAfterStat(file, delta);
  try { expectCode(() => store.read(key), "STORE_CORRUPT"); expect(mutation.changed()).toBe(true); }
  finally { mutation.restore(); }
});
