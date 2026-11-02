import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { compileStaticDocumentSchema, ExtensionDocumentStore, readExtensionDocumentRecord } from "../../src/extensions/document-contract.ts";
import { canonicalJson } from "../../src/canonical-json.ts";
import { TASK_LEDGER_ROLE, TaskStore } from "../../src/tasks/store.ts";
import type { StorageCapacity } from "../../src/cli/storage-capacity.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "wp-capacity-")); roots.push(home);
  return { home, root: join(home, "state") };
}
function cli(home: string, root: string, flags: string[] = [], json = true) {
  const child = Bun.spawnSync([process.execPath, "--no-install", "src/cli/index.ts", "doctor", "--storage", ...(json ? ["--json"] : []), ...flags], {
    cwd: process.cwd(), env: { ...process.env, HOME: home, WOLFPACK_DIR: root, WOLFPACK_TEST: "1", WOLFPACK_SERVICE: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe",
  });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}
function report(f: ReturnType<typeof fixture>) {
  const result = cli(f.home, f.root);
  const parsed = JSON.parse(result.stdout) as { checks: Array<{ status: string; detail: string; capacity: StorageCapacity }> };
  expect(parsed.checks).toHaveLength(2);
  return { ...result, checks: parsed.checks, docs: parsed.checks[0]!.capacity, tasks: parsed.checks[1]!.capacity };
}
function snapshot(root: string): unknown[] {
  if (!existsSync(root)) return [];
  const rows: unknown[] = [];
  const walk = (path: string) => {
    const stat = lstatSync(path);
    let content: string | undefined;
    if (stat.isFile() && stat.size < 1024 * 1024) {
      try { content = createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { content = "unreadable"; }
    }
    rows.push([relative(root, path), stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs, content]);
    if (stat.isDirectory()) { try { for (const entry of readdirSync(path).sort()) walk(join(path, entry)); } catch { /* permission fixture: never chmod to inspect */ } }
  };
  walk(root); return rows;
}
async function publish(f: ReturnType<typeof fixture>, count: number, start = 0) {
  const store = new ExtensionDocumentStore({ root: join(f.root, "extensions") });
  const validator = compileStaticDocumentSchema({ type: "object" });
  for (let index = start; index < start + count; index++) await store.publish({
    key: { installationId: "00000000-0000-4000-8000-000000000001", scopeSessionId: randomUUID(), extensionId: index < 231 ? "alpha" : "beta", documentId: "state" },
    document: { marker: "PRIVATE_DOCUMENT_CONTENT" }, ifRevision: 0, requestId: randomUUID(), schemaVersion: 1,
  }, validator);
}

test("doctor storage-only mode reports absent stores with limits without creating state or probing host services", () => {
  const f = fixture(), result = cli(f.home, f.root);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.checks).toHaveLength(2);
  expect(parsed.checks[0]).toMatchObject({ group: "Storage capacity", capacity: { state: "absent", count: 0, bytes: 0, countLimit: 256, byteLimit: 16 * 1024 * 1024, scope: "host-global-extension-documents" } });
  expect(parsed.checks[1]).toMatchObject({ capacity: { state: "absent", count: 0, bytes: 0, countLimit: null, byteLimit: null } });
  expect(existsSync(f.root)).toBe(false);
  expect(readdirSync(f.home)).toEqual([]);
});

test("existing empty directories are observed as empty, with readable text and no fixes or mutations", () => {
  const f = fixture();
  mkdirSync(join(f.root, "extensions/documents"), { recursive: true, mode: 0o700 });
  mkdirSync(join(f.root, "tasks/ledgers/sender"), { recursive: true, mode: 0o700 });
  const before = snapshot(f.root), result = report(f);
  expect(result.docs).toMatchObject({ state: "ok", count: 0, bytes: 0, perExtension: [] });
  expect(result.tasks).toMatchObject({ state: "ok", count: 0, bytes: 0, countLimit: null });
  expect(cli(f.home, f.root, [], false).stdout).toContain("Storage capacity");
  const refused = cli(f.home, f.root, ["--fix"]);
  expect(refused.code).toBe(1); expect(refused.stderr).toContain("read-only");
  expect(snapshot(f.root)).toEqual(before);
});

test("warns before shared count exhaustion, attributes usage without inventing per-extension quotas, and reports full", async () => {
  const f = fixture();
  await publish(f, 230);
  expect(report(f).docs.state).toBe("ok");
  await publish(f, 1, 230);
  const near = report(f);
  expect(near.code).toBe(0);
  expect(near.checks[0]!.status).toBe("warn");
  expect(near.docs).toMatchObject({ state: "near-full", count: 231, scope: "host-global-extension-documents", measurement: "coherent-record-observation" });
  await publish(f, 25, 231);
  const before = snapshot(f.root), full = report(f);
  expect(full.code).toBe(1); expect(full.docs.state).toBe("full"); expect(full.docs.count).toBe(256);
  expect(full.docs.perExtension?.map(row => [row.extensionId, row.count])).toEqual([["alpha", 231], ["beta", 25]]);
  const bytes = readdirSync(join(f.root, "extensions/documents")).reduce((n, file) => n + lstatSync(join(f.root, "extensions/documents", file)).size, 0);
  expect(full.docs.bytes).toBe(bytes);
  expect(full.docs.perExtension?.reduce((sum, row) => sum + row.bytes, 0)).toBe(bytes);
  await expect(publish(f, 1, 256)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  expect(full.stdout).not.toContain("PRIVATE_DOCUMENT_CONTENT");
  expect(snapshot(f.root)).toEqual(before);
});

test("serialized receipt bytes warn before count exhaustion with coherent bounded records", async () => {
  const f = fixture(), root = join(f.root, "extensions"), store = new ExtensionDocumentStore({ root });
  const key = { installationId: "00000000-0000-4000-8000-000000000001", scopeSessionId: randomUUID(), extensionId: "alpha", documentId: "state" };
  const validator = compileStaticDocumentSchema({ type: "object" });
  for (let revision = 0; revision < 128; revision++) await store.publish({ key, document: { rows: Array(4).fill("x".repeat(16300)) }, ifRevision: revision, requestId: randomUUID(), schemaVersion: 1 }, validator);
  const dir = join(root, "documents"), path = join(dir, readdirSync(dir)[0]!);
  const record = readExtensionDocumentRecord(path), size = lstatSync(path).size;
  const count = Math.ceil(16 * 1024 * 1024 * 0.9 / size);
  expect(count).toBeLessThan(231);
  // Replicate a real, receipt-bearing record for other exited scopes. Identity
  // hashing is the production canonical JSON function; the CLI validates all.
  for (let n = 1; n < count; n++) {
    const scopeSessionId = randomUUID();
    const copy = { ...record, key: { ...record.key, scopeSessionId }, receipts: record.receipts.map(receipt => ({ ...receipt, scopeSessionId })) };
    const name = createHash("sha256").update(canonicalJson(copy.key)).digest("hex");
    writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(copy, null, 2)}\n`, { mode: 0o600 });
  }
  const before = snapshot(f.root), result = report(f);
  expect(result.docs).toMatchObject({ state: "near-full", count, bytes: count * size, measurement: "coherent-record-observation" });
  expect(result.docs.bytes).toBeGreaterThanOrEqual(16 * 1024 * 1024 * 0.9);
  expect(snapshot(f.root)).toEqual(before);
}, 10000);

test("byte exhaustion is visible from metadata without reading oversized records or pretending attribution is validated", () => {
  const f = fixture(), dir = join(f.root, "extensions/documents");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${"a".repeat(64)}.json`);
  writeFileSync(path, "PRIVATE_OVERSIZED_CONTENT", { mode: 0o600 }); truncateSync(path, 16 * 1024 * 1024 + 1);
  const before = snapshot(f.root), result = report(f);
  expect(result.code).toBe(1);
  expect(result.docs).toMatchObject({ state: "full", count: 1, bytes: 16777217, measurement: "filesystem-metadata-observation", perExtension: null });
  expect(snapshot(f.root)).toEqual(before);
});

for (const kind of ["corrupt", "wrong-key", "temporary", "symlink", "hardlink"] as const) test(`document ${kind} reports unknown and preserves all evidence`, async () => {
  const f = fixture(); await publish(f, 1);
  const dir = join(f.root, "extensions/documents"), name = readdirSync(dir)[0]!, path = join(dir, name);
  if (kind === "corrupt") writeFileSync(path, "PRIVATE_CORRUPT_SECRET");
  if (kind === "wrong-key") { const record = JSON.parse(readFileSync(path, "utf8")); record.key.extensionId = "other"; writeFileSync(path, JSON.stringify(record)); }
  if (kind === "temporary") writeFileSync(`${path}.tmp-123-abcdef012345`, "PRIVATE_CRASH_TEMP_SECRET", { mode: 0o600 });
  if (kind === "symlink") symlinkSync(path, join(dir, `${"b".repeat(64)}.json`));
  if (kind === "hardlink") linkSync(path, join(f.home, "outside-record"));
  const before = snapshot(f.root), result = report(f);
  expect(result.docs).toMatchObject({ state: "unknown", count: null, bytes: null, perExtension: null, countLimit: 256 });
  expect(result.stdout).not.toContain("PRIVATE_");
  expect(snapshot(f.root)).toEqual(before);
});

for (const kind of ["document-file", "document-directory", "task-directory"] as const) test.skipIf(process.geteuid?.() === 0)(`permission failure at ${kind} is unavailable, never zero or chmod recovery`, async () => {
  const f = fixture(); await publish(f, 1);
  const docs = join(f.root, "extensions/documents"), task = join(f.root, "tasks/ledgers/sender");
  mkdirSync(task, { recursive: true, mode: 0o700 });
  const path = kind === "document-file" ? join(docs, readdirSync(docs)[0]!) : kind === "document-directory" ? docs : task;
  chmodSync(path, 0);
  try {
    const before = snapshot(f.root), result = report(f), capacity = kind === "task-directory" ? result.tasks : result.docs;
    expect(capacity).toMatchObject({ state: "unavailable", count: null, bytes: null });
    expect(snapshot(f.root)).toEqual(before);
  } finally { chmodSync(path, kind === "document-file" ? 0o600 : 0o700); }
});

test("retained historical tasks use metadata only, including unreadable/corrupt/quarantined evidence, without replay, sweep or cache writes", async () => {
  const f = fixture(), taskRoot = join(f.root, "tasks"), store = new TaskStore({ root: taskRoot });
  const parent = { machine: "a", sessionId: "parent" }, receiver = { machine: "b", sessionId: "receiver" };
  for (const role of Object.values(TASK_LEDGER_ROLE)) await store.createLedger({ role, participants: { parent, receiver, sender: parent }, assignment: {
    taskId: "historical", source: parent, target: receiver, task: "PRIVATE_TASK_ASSIGNMENT", createdAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-01T01:00:00.000Z",
    context: undefined, role: undefined, metadata: undefined, onCompletePrompt: undefined,
  } });
  const quarantine = join(taskRoot, "quarantine"); mkdirSync(quarantine, { mode: 0o700 });
  const quarantined = join(quarantine, "sender-corrupt.jsonl"), corrupt = join(taskRoot, "ledgers/sender/broken.jsonl");
  writeFileSync(quarantined, "PRIVATE_QUARANTINED_EVIDENCE"); writeFileSync(corrupt, "PRIVATE_BROKEN_LEDGER");
  const receiverPath = join(taskRoot, "ledgers/receiver", readdirSync(join(taskRoot, "ledgers/receiver"))[0]!);
  const bytes = [join(taskRoot, "ledgers/sender", readdirSync(join(taskRoot, "ledgers/sender")).find(name => name !== "broken.jsonl")!), receiverPath, quarantined, corrupt].reduce((sum, path) => sum + lstatSync(path).size, 0);
  utimesSync(receiverPath, new Date(0), new Date(0)); chmodSync(receiverPath, 0);
  try {
    const before = snapshot(f.root), result = report(f);
    expect(result.tasks).toMatchObject({ state: "ok", count: 4, bytes, countLimit: null, byteLimit: null, measurement: "filesystem-metadata-observation" });
    expect(result.checks[1]!.detail).toContain("not unique tasks");
    expect(result.checks[1]!.detail).toContain("unacknowledged subset unknown");
    expect(result.stdout).not.toContain("PRIVATE_");
    expect(snapshot(f.root)).toEqual(before);
  } finally { chmodSync(receiverPath, 0o600); }
});

test("damaged roots and linked task directories are unknown rather than an empty store", () => {
  const f = fixture(); mkdirSync(f.root, { mode: 0o700 });
  writeFileSync(join(f.root, "extensions"), "not a directory");
  symlinkSync(f.home, join(f.root, "tasks"));
  const before = snapshot(f.root), result = report(f);
  expect(result.docs.state).toBe("unknown"); expect(result.tasks.state).toBe("unknown");
  expect(result.docs.count).toBeNull(); expect(result.tasks.bytes).toBeNull();
  expect(snapshot(f.root)).toEqual(before);
});

test("oversized task inventories stop at the bounded scan and report unknown, never an exact zero", () => {
  const f = fixture(), dir = join(f.root, "tasks/ledgers/sender"); mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let n = 0; n < 4097; n++) writeFileSync(join(dir, `${n}.jsonl`), "");
  const result = report(f);
  expect(result.tasks).toMatchObject({ state: "unknown", count: null, bytes: null });
  expect(result.checks[1]!.detail).toContain("scan budget");
  expect(readdirSync(dir)).toHaveLength(4097);
});
