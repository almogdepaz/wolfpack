import { Database } from "bun:sqlite";
import { RelayOwnerFailure } from "./owner-failure.ts";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RecoveryRow { readonly bucket: string; readonly key: string; readonly value: string; }
const FORMAT = "wolfpack-relay/restart-safe-v1";
const digest = (row: RecoveryRow) => createHash("sha256").update(JSON.stringify([row.bucket, row.key, row.value])).digest("hex");
function privatePath(path: string, directory: boolean, links = 1): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || (!directory && stat.nlink !== links)) throw new Error("relay storage requires owner-private regular paths");
}
function syncDirectory(path: string): void {
  const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function openDatabase(path: string, origin: string | undefined, initializing: boolean, links = 1): Database {
  privatePath(path, false, links);
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try {
      privatePath(path + suffix, false);
      if (suffix !== "-journal") throw new Error("unsupported relay SQLite journal mode");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const db = new Database(path, { create: false, strict: true });
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE;");
    if ((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode !== "delete") throw new Error("unsupported relay SQLite journal mode");
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=65536; BEGIN EXCLUSIVE;");
    const version = db.query("PRAGMA user_version").get() as { user_version: number };
    // Only the reserved, unpublished slot may be virgin after a creation crash.
    if (initializing && version.user_version === 0 && db.query("SELECT name FROM sqlite_schema").all().length === 0) {
      db.exec("CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), format TEXT NOT NULL, origin TEXT NOT NULL); CREATE TABLE cells (bucket TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(bucket,key)); PRAGMA user_version=1;");
      db.query("INSERT INTO metadata VALUES (1,?,?)").run(FORMAT, origin ?? "");
    } else {
      const meta = db.query("SELECT * FROM metadata WHERE id=1").get() as { format?: string; origin?: string } | null;
      if (version.user_version !== 1 || meta?.format !== FORMAT || meta.origin !== (origin ?? "")) throw new Error("unsupported relay storage format or origin mismatch");
      const check = db.query("PRAGMA integrity_check").all();
      if (check.length !== 1 || Object.values(check[0] as object)[0] !== "ok") throw new Error("relay storage integrity check failed");
    }
    if (initializing && (db.query("SELECT COUNT(*) AS count FROM cells").get() as { count: number }).count !== 0) throw new Error("non-virgin relay initialization slot");
    db.exec("COMMIT");
    return db;
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} db.close(); throw error; }
}
function publicationPair(path: string, staging: string): boolean {
  const final = lstatSync(path);
  if (final.nlink !== 2) { privatePath(path, false); return false; }
  privatePath(path, false, 2);
  try { privatePath(staging, false, 2); }
  catch { throw new Error("unverifiable relay initialization publication"); }
  const pending = lstatSync(staging);
  if (final.dev !== pending.dev || final.ino !== pending.ino) throw new Error("unverifiable relay initialization publication");
  return true;
}
function openJournal(root: string, origin: string | undefined): Database {
  const path = join(root, "restart-safe-v1.sqlite"), staging = path + ".initializing";
  const openFinal = () => {
    const linked = publicationPair(path, staging);
    const db = openDatabase(path, origin, false, linked ? 2 : 1);
    try {
      // The exact two-link publication cut is recoverable only after format,
      // origin and native exclusive ownership have all been established.
      if (linked) {
        if ((db.query("SELECT COUNT(*) AS count FROM cells").get() as { count: number }).count !== 0) throw new Error("non-virgin relay initialization publication");
        publicationPair(path, staging); unlinkSync(staging); syncDirectory(root);
      }
    } catch (error) { db.close(); throw error; }
    // Reopen after changing the native file's link count: macOS SQLite may
    // otherwise reject the first write with SQLITE_IOERR_VNODE.
    if (linked) { db.close(); return openDatabase(path, origin, false); }
    return db;
  };
  let present = true;
  try { lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; present = false; }
  if (present) return openFinal();
  try { const fd = openSync(staging, "wx", 0o600); closeSync(fd); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  // A concurrent initializer may have published between the absence check and open.
  if (lstatSync(staging).nlink === 2) return openFinal();
  const db = openDatabase(staging, origin, true);
  try {
    // Atomic no-replace publication; the initialization SQLite lock stays held
    // through link/unlink/fsync, so another initializer cannot overwrite a live owner.
    try { linkSync(staging, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; return openFinal(); }
    unlinkSync(staging); syncDirectory(root);
  } finally { db.close(); }
  return openFinal();
}
/** Worker-exclusive native SQLite journal; no legacy file is read, migrated or deleted. */
export class RelayRecoveryJournal {
  readonly #db: Database;
  readonly #rows = new Map<string, RecoveryRow>();
  #poisoned = false;
  #closed = false;
  constructor(root: string, origin?: string) {
    const firstCreated = mkdirSync(root, { recursive: true, mode: 0o700 });
    if (firstCreated) for (let directory = root;; directory = dirname(directory)) {
      syncDirectory(directory);
      if (directory === dirname(firstCreated)) break;
    }
    privatePath(root, true);
    this.#db = openJournal(root, origin);
    const db = this.#db;
    try {
      const rows = db.query("SELECT * FROM cells").all() as (RecoveryRow & { digest: string })[];
      if (rows.length > 110_000) throw new Error("relay storage row limit exceeded");
      let size = 0;
      for (const row of rows) {
        if (typeof row.bucket !== "string" || typeof row.key !== "string" || typeof row.value !== "string" || (size += Buffer.byteLength(row.value)) > 128 * 1024 * 1024 || row.digest !== digest(row)) throw new Error("corrupt relay storage cell");
        this.#rows.set(JSON.stringify([row.bucket, row.key]), row);
      }
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} db.close(); throw error; }
  }
  load(): readonly RecoveryRow[] { this.assertHealthy(); return [...this.#rows.values()]; }
  assertHealthy(): void { if (this.#poisoned) throw new RelayOwnerFailure("RELAY_STORAGE_UNCERTAIN"); }
  commit(rows: readonly RecoveryRow[]): void {
    this.assertHealthy();
    const next = new Map(rows.map(row => [JSON.stringify([row.bucket, row.key]), row]));
    const changed = rows.filter(row => this.#rows.get(JSON.stringify([row.bucket, row.key]))?.value !== row.value);
    const removed = [...this.#rows].filter(([id]) => !next.has(id)).map(([, row]) => row);
    if (!changed.length && !removed.length) return;
    const db = this.#db;
    try {
      db.exec("BEGIN EXCLUSIVE");
      const put = db.query("INSERT INTO cells VALUES (?,?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET value=excluded.value,digest=excluded.digest");
      const remove = db.query("DELETE FROM cells WHERE bucket=? AND key=?");
      for (const row of changed) put.run(row.bucket, row.key, row.value, digest(row));
      for (const row of removed) remove.run(row.bucket, row.key);
      db.exec("COMMIT");
      this.#rows.clear(); for (const [id, row] of next) this.#rows.set(id, row);
    } catch (error) { this.#poisoned = true; try { db.exec("ROLLBACK"); } catch {} throw new RelayOwnerFailure("RELAY_STORAGE_UNCERTAIN", error); }
  }
  close(): void { if (!this.#closed) { this.#closed = true; this.#poisoned = true; this.#db.close(); } }
}
