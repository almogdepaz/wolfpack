import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { ExtensionRuntime } from "../../../src/extensions/runtime.ts";
import { fixture } from "./extension-transaction-package.ts";

const repo = resolve(import.meta.dirname, "../../..");
const out = resolve(process.argv[2]!);
const preload = join(repo, "tests/unit/fixtures/fs-crash-preload.ts");
const child = join(repo, "tests/unit/fixtures/extension-registry-crash-child.ts");
const hostId = "11111111-1111-4111-8111-111111111111";
const operations = ["install-v1", "install-v2", "remove", "purge"];
const records: Array<{ op: string; k: number; killed: boolean; stranded: boolean; busy: boolean; publishedOwner: boolean; automatic: boolean; leftovers: object; faults: object[] }> = [];
const started = performance.now();
const save = () => writeFileSync(join(out, "results.json"), JSON.stringify({ seconds: (performance.now() - started) / 1000, records }, null, 2));
const errorInfo = (error: unknown): { name?: string; message: string; code?: string } => error instanceof Error ? { name: error.name, message: error.message, code: (error as { code?: string }).code } : { message: String(error) };
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "environment.json"), JSON.stringify({ cwd: repo, bun: process.execPath, version: Bun.version, HOME: process.env.HOME, ZDOTDIR: process.env.ZDOTDIR, WOLFPACK_DIR: process.env.WOLFPACK_DIR, WOLFPACK_TEST: process.env.WOLFPACK_TEST, PATH: process.env.PATH }, null, 2));

for (const op of operations) {
  let completed = false;
  for (let k = 1; k <= 500; k++) {
    const base = join(out, `${op}-${k}`);
    mkdirSync(base);
    const root = join(base, "runtime");
    const v1 = fixture(base);
    const v2 = fixture(base, "1.0.1");
    const source = op === "install-v2" || op === "purge" ? v2 : v1;
    const runtime = new ExtensionRuntime({ root, installationId: hostId });
    if (op !== "install-v1") await runtime.install({ source: v1, trustBrowserCode: true });
    if (op === "purge") await runtime.install({ source: v2, trustBrowserCode: true });
    const result = spawnSync(process.execPath, ["--preload", preload, child], {
      env: { ...process.env, WP_CRASH_AT: String(k), WP_CRASH_ROOT: root, WP_CRASH_SOURCE: source, WP_CRASH_OP: op, WP_CRASH_RECOVERY_STATE: undefined },
      encoding: "utf8", timeout: 10000,
    });
    writeFileSync(join(base, "child.json"), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2));
    const killed = result.signal === "SIGKILL" && result.status === null;
    assert(!result.error, result.error?.message);
    assert(killed || result.status === 0, `unexpected child failure: ${op}/${k}: ${result.stderr}`);
    if (existsSync(root)) cpSync(root, join(base, "before-recovery"), { recursive: true });
    const lock = join(root, ".registry-lock");
    const stranded = existsSync(lock);
    let busy = false;
    let publishedOwner = false;
    if (stranded) {
      try {
        const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
        publishedOwner = owner.pid === result.pid && typeof owner.startTime === "string" && owner.startTime.length > 0;
      } catch { /* Missing/partial records are the explicitly manual crash class. */ }
      if (!publishedOwner) {
        try { await runtime.install({ source, trustBrowserCode: true }); }
        catch (error) {
          const info = errorInfo(error);
          busy = info.code === "BUSY" && info.message.includes(lock) && info.message.includes("remove it manually");
        }
        assert(busy, "publication-gap lock did not fail closed with manual guidance");
        assert(existsSync(lock), "publication-gap lock was cleared automatically");
        rmSync(lock, { recursive: true, force: true });
      }
    }
    const faults: object[] = [];
    let registry: { installations: Array<{ extensionId: string; snapshot: string; previous?: { snapshot: string } }> } | undefined;
    const registryPath = join(root, "registry.json");
    if (existsSync(registryPath)) {
      try { registry = JSON.parse(readFileSync(registryPath, "utf8")); }
      catch (error) { faults.push({ check: "a", ...errorInfo(error) }); }
    }
    if (faults.length === 0) {
      try {
        const catalog = new ExtensionRuntime({ root, installationId: hostId }).catalog();
        for (const entry of registry?.installations ?? []) {
          if (catalog.installations.some(item => item.extensionId === entry.extensionId) && !existsSync(entry.snapshot)) {
            faults.push({ check: "d", snapshot: entry.snapshot });
          }
        }
      } catch (error) { faults.push({ check: "b", ...errorInfo(error) }); }
    }
    const referenced = new Set((registry?.installations ?? []).flatMap(entry => [entry.snapshot, ...(entry.previous ? [entry.previous.snapshot] : [])]));
    const snapshotRoot = join(root, "snapshots");
    const snapshots = existsSync(snapshotRoot) ? readdirSync(snapshotRoot) : [];
    const leftovers = {
      registryTemps: existsSync(root) ? readdirSync(root).filter(name => name.startsWith("registry.json.tmp-")).length : 0,
      stages: snapshots.filter(name => name.startsWith(".stage-")).length,
      unreferencedSnapshots: snapshots.filter(name => !name.startsWith(".stage-") && !referenced.has(join(snapshotRoot, name))).length,
      skills: "not exercised: shared fixture declares no skills",
    };
    if (faults.length === 0) {
      try { await new ExtensionRuntime({ root, installationId: hostId }).install({ source, trustBrowserCode: true }); }
      catch (error) { faults.push({ check: "c", ...errorInfo(error) }); }
    }
    const automatic = killed && publishedOwner && faults.length === 0;
    if (faults.length === 0) {
      assert(!existsSync(lock), "retry left the canonical lock");
      assert(!existsSync(`${lock}.recovery`), "retry left a recovery guard");
      assert(!readdirSync(root).some(name => name.startsWith(".registry-lock.stale-")), "retry left a retired lock");
    }
    records.push({ op, k, killed, stranded, busy, publishedOwner, automatic, leftovers, faults });
    save();
    if (faults.length) throw new Error(`STOP half-written ${op}/${k}: ${JSON.stringify(faults)}`);
    if (!killed) {
      completed = true;
      console.log(`${op}: K=1..${k - 1} killed; K=${k} exited normally`);
      break;
    }
  }
  assert(completed, `coverage incomplete: exceeded 500 calls for ${op}`);
}
assert(records.some(record => record.stranded), "STOP stranded lock not reproduced");
save();
console.log(`complete in ${((performance.now() - started) / 1000).toFixed(3)}s`);
