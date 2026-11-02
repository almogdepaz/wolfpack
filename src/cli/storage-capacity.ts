import { lstatSync, opendirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { DOCUMENT_RECORD_FILE, EXTENSION_DOCUMENT_LIMITS, readExtensionDocumentRecord } from "../extensions/document-contract.ts";
import { TASK_LEDGER_ROLE } from "../tasks/store.ts";
import type { CheckResult } from "./doctor.ts";

/** An on-demand observation, never quota/writer authority or an atomic snapshot. */
export interface StorageCapacity {
  readonly scope: "host-global-extension-documents" | "durable-task-ledger-files";
  readonly state: "absent" | "ok" | "near-full" | "full" | "unknown" | "unavailable";
  readonly count: number | null;
  readonly bytes: number | null;
  readonly countLimit: number | null;
  readonly byteLimit: number | null;
  readonly measurement: "coherent-record-observation" | "filesystem-metadata-observation" | "unknown";
  readonly perExtension: readonly { readonly extensionId: string; readonly count: number; readonly bytes: number }[] | null;
}
const WARNING_FRACTION = 0.9;
/** Bounds directory work even if a store is damaged or has years of history. */
export const STORAGE_CAPACITY_SCAN_ENTRIES = 4096;
class UnknownCapacity extends Error {}
function code(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
function directory(path: string): Stats | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) throw new UnknownCapacity("store contains a linked or non-directory path");
    return stat;
  } catch (error) { if (code(error) === "ENOENT") return undefined; throw error; }
}
function scanFiles(path: string, budget: { entries: number }, accept: (name: string) => boolean, visit: (path: string, stat: Stats) => void): boolean {
  const before = directory(path);
  if (!before) return false;
  const entries = opendirSync(path);
  try {
    for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
      if (++budget.entries > STORAGE_CAPACITY_SCAN_ENTRIES) throw new UnknownCapacity("directory scan budget exceeded; usage unknown, inspect an offline copy");
      if (!accept(entry.name)) continue;
      const file = join(path, entry.name), stat = lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1) throw new UnknownCapacity("store contains linked or non-regular records");
      if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new UnknownCapacity("record byte size exceeds safe diagnostic precision");
      visit(file, stat);
    }
    const after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new UnknownCapacity("store changed during observation; retry when writes are quiet");
    }
    return true;
  } finally { entries.closeSync(); }
}
function result(name: string, capacity: StorageCapacity, detail: string): CheckResult {
  return { name, group: "Storage capacity", status: capacity.state === "full" ? "fail" : capacity.state === "unknown" || capacity.state === "unavailable" || capacity.state === "near-full" ? "warn" : "pass", detail, capacity };
}
function failed(name: string, base: StorageCapacity, error: unknown): CheckResult {
  const unavailable = ["EACCES", "EPERM", "EIO", "EMFILE", "ENFILE"].includes(code(error) ?? "");
  // Never print raw errors, filenames, document bodies, assignments or receipts.
  const reason = error instanceof UnknownCapacity ? error.message : "records unreadable, incoherent, or changed during observation";
  return result(name, { ...base, state: unavailable ? "unavailable" : "unknown", count: null, bytes: null, measurement: "unknown", perExtension: null }, `${unavailable ? "unavailable" : "unknown"}: ${reason}; no recovery or cleanup attempted`);
}
function documents(root: string): CheckResult {
  const countLimit = EXTENSION_DOCUMENT_LIMITS.maxDocumentsPerInstallation, byteLimit = EXTENSION_DOCUMENT_LIMITS.maxBytesPerInstallation;
  const base: StorageCapacity = { scope: "host-global-extension-documents", state: "absent", count: 0, bytes: 0, countLimit, byteLimit, measurement: "filesystem-metadata-observation", perExtension: null };
  try {
    if (!directory(root) || !directory(join(root, "extensions"))) return result("extension documents", base, `absent: 0/${countLimit} records, 0/${byteLimit} bytes; shared host-global quota, not per-extension`);
    let count = 0, bytes = 0;
    const records: Array<{ path: string; stat: Stats }> = [];
    const present = scanFiles(join(root, "extensions", "documents"), { entries: 0 }, name => {
      if (!DOCUMENT_RECORD_FILE.test(name)) throw new UnknownCapacity("unexpected document entry or crash temporary; explicit recovery requires operator review");
      return true;
    }, (path, stat) => { count++; bytes += stat.size; if (!Number.isSafeInteger(bytes)) throw new UnknownCapacity("total bytes exceed safe diagnostic precision"); records.push({ path, stat }); });
    const full = count >= countLimit || bytes >= byteLimit;
    const near = count >= countLimit * WARNING_FRACTION || bytes >= byteLimit * WARNING_FRACTION;
    const boundedRecords = count <= countLimit && bytes <= byteLimit;
    const attribution = new Map<string, { extensionId: string; count: number; bytes: number }>();
    if (boundedRecords) for (const { path, stat } of records) {
      const record = readExtensionDocumentRecord(path);
      const after = lstatSync(path);
      if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new UnknownCapacity("document changed during observation; retry when writes are quiet");
      const entry = attribution.get(record.key.extensionId) ?? { extensionId: record.key.extensionId, count: 0, bytes: 0 };
      entry.count++; entry.bytes += stat.size; attribution.set(entry.extensionId, entry);
    }
    const capacity: StorageCapacity = { ...base, state: !present ? "absent" : full ? "full" : near ? "near-full" : "ok", count, bytes,
      measurement: boundedRecords ? "coherent-record-observation" : "filesystem-metadata-observation",
      perExtension: boundedRecords ? [...attribution.values()].sort((a, b) => a.extensionId.localeCompare(b.extensionId)) : null };
    return result("extension documents", capacity, `${capacity.state}: ${count}/${base.countLimit} records, ${bytes}/${base.byteLimit} bytes; shared host-global quota; ${boundedRecords ? "per-extension attribution is observational, not separate quotas" : "above quota; contents/attribution not validated"}; at 90% warn; preserve receipts and plan explicit archival before new keys exhaust capacity`);
  } catch (error) { return failed("extension documents", base, error); }
}
function tasks(root: string): CheckResult {
  const base: StorageCapacity = { scope: "durable-task-ledger-files", state: "absent", count: 0, bytes: 0, countLimit: null, byteLimit: null, measurement: "filesystem-metadata-observation", perExtension: null };
  try {
    if (!directory(root) || !directory(join(root, "tasks"))) return result("durable task ledgers", base, "absent: 0 retained ledger files, 0 bytes; no aggregate task count/byte quota configured");
    const taskRoot = join(root, "tasks"), ledgerRoot = join(taskRoot, "ledgers");
    let count = 0, bytes = 0;
    const budget = { entries: 0 };
    const visit = (_path: string, stat: Stats) => { count++; bytes += stat.size; if (!Number.isSafeInteger(bytes)) throw new UnknownCapacity("total bytes exceed safe diagnostic precision"); };
    if (directory(ledgerRoot)) for (const role of Object.values(TASK_LEDGER_ROLE)) scanFiles(join(ledgerRoot, role), budget, name => name.endsWith(".jsonl"), visit);
    scanFiles(join(taskRoot, "quarantine"), budget, name => name.endsWith(".jsonl"), visit);
    return result("durable task ledgers", { ...base, state: "ok", count, bytes }, `${count} retained ledger files, ${bytes} bytes (sender/receiver/quarantine, not unique tasks); no aggregate count/byte quota configured; content validity and unacknowledged subset unknown (no history replay); excludes caches/tombstones/other files; preserve unresolved evidence`);
  } catch (error) { return failed("durable task ledgers", base, error); }
}

/** No store constructors, runtime registry, recovery visitors, writes or network. */
export function checkStorageCapacity(root: string): CheckResult[] { return [documents(root), tasks(root)]; }
