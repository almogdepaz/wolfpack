import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writePrivateJsonFile } from "../persistence.ts";
import { readBoundedRegularFile } from "./bounded-file.ts";

interface OwnerRecord { pid: number; startTime: string }
const MAX_OWNER_BYTES = 1024;

export class RegistryLockError extends Error {}

export function readProcessStartTime(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
      return start && /^\d+$/.test(start) ? start : undefined;
    }
    if (process.platform === "darwin") {
      return execFileSync("/usr/bin/env", ["LC_ALL=C", "ps", "-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined;
    }
  } catch { /* An unavailable process identity must not authorize recovery. */ }
  return undefined;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(lock: string): OwnerRecord | undefined {
  try {
    const stat = lstatSync(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    const value: unknown = JSON.parse(readBoundedRegularFile(join(lock, "owner.json"), MAX_OWNER_BYTES).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid)
      || record.pid <= 0 || typeof record.startTime !== "string" || !record.startTime.trim()) return undefined;
    return { pid: record.pid, startTime: record.startTime };
  } catch { /* Missing, malformed, or unreadable ownership fails closed. */ }
  return undefined;
}

function sameOwner(left: OwnerRecord | undefined, right: OwnerRecord): boolean {
  return left?.pid === right.pid && left.startTime === right.startTime;
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new RegistryLockError(`cannot inspect extension registry lock ${path}: ${String(error)}`);
  }
}

function createLock(lock: string, owner: OwnerRecord): (() => void) | undefined {
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return undefined;
    throw new RegistryLockError(`cannot acquire extension registry lock ${lock}: ${code ?? "unknown error"}`);
  }
  try { writePrivateJsonFile(join(lock, "owner.json"), owner); }
  catch (error) {
    throw new RegistryLockError(`extension registry lock ${lock} owner publication failed; if no wolfpack process is installing extensions, remove it manually: ${String(error)}`);
  }
  return () => {
    if (sameOwner(readOwner(lock), owner)) rmSync(lock, { recursive: true, force: true });
    else console.warn(`extension registry lock ownership changed; leaving ${lock}`);
  };
}

function deadOwner(lock: string): OwnerRecord {
  const owner = readOwner(lock);
  if (!owner) {
    throw new RegistryLockError(`extension registry lock ${lock} has no owner record; if no wolfpack process is installing extensions, remove it manually`);
  }
  if (processAlive(owner.pid)) {
    const currentStart = readProcessStartTime(owner.pid);
    if (currentStart === undefined || currentStart === owner.startTime) {
      throw new RegistryLockError(`extension registry has an active or unverifiable transaction (pid ${owner.pid}, lock ${lock})`);
    }
  }
  return owner;
}

function recoveryBusy(lock: string, recovery: string): RegistryLockError {
  return new RegistryLockError(`extension registry lock ${lock} has a recovery lock ${recovery}; if no wolfpack process is installing extensions, remove it manually`);
}

export function acquireRegistryLock(root: string): () => void {
  const lock = join(root, ".registry-lock");
  const recovery = `${lock}.recovery`;
  const startTime = readProcessStartTime(process.pid);
  if (!startTime) throw new RegistryLockError(`cannot establish process identity for extension registry lock ${lock}`);
  const ours = { pid: process.pid, startTime };
  for (let attempt = 0; attempt < 2; attempt++) {
    // Never infer that a stranded recovery guard is safe to clear.
    if (pathExists(recovery)) throw recoveryBusy(lock, recovery);
    const release = createLock(lock, ours);
    if (release) return release;
    deadOwner(lock);
    if (attempt !== 0) throw new RegistryLockError(`extension registry lock ${lock} changed during recovery; retry later`);
    let releaseRecovery: (() => void) | undefined;
    try { releaseRecovery = createLock(recovery, ours); }
    catch (error) {
      throw new RegistryLockError(`${recoveryBusy(lock, recovery).message}: ${String(error)}`);
    }
    if (!releaseRecovery) throw recoveryBusy(lock, recovery);
    try {
      // A competing recoverer may have finished before we acquired the guard.
      // Only this fresh observation, under the guard, authorizes retirement.
      if (!pathExists(lock)) continue;
      const owner = deadOwner(lock);
      const stale = `${lock}.stale-${owner.pid}-${randomBytes(6).toString("hex")}`;
      try { renameSync(lock, stale); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new RegistryLockError(`cannot retire extension registry lock ${lock}: ${String(error)}`);
      }
      if (!sameOwner(readOwner(stale), owner)) {
        if (!pathExists(lock)) {
          try { renameSync(stale, lock); }
          catch (error) {
            throw new RegistryLockError(`extension registry lock owner changed; restore failed between ${stale} and ${lock}: ${String(error)}`);
          }
        }
        throw new RegistryLockError(`extension registry lock owner changed between ${lock} and ${stale}; recovery refused`);
      }
      rmSync(stale, { recursive: true, force: true });
      console.warn(`cleared dead extension registry owner pid ${owner.pid} at ${lock}`);
    } finally {
      releaseRecovery();
    }
  }
  throw new RegistryLockError(`extension registry lock ${lock} changed during recovery; retry later`);
}
