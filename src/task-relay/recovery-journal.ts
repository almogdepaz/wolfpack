import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

export interface RecoveryRow { readonly bucket: string; readonly key: string; readonly value: string; }
const FORMAT = "wolfpack-relay/restart-safe-v1";
const digest = (row: RecoveryRow) => createHash("sha256").update(JSON.stringify([row.bucket, row.key, row.value])).digest("hex");
function privatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || (!directory && stat.nlink !== 1)) throw new Error("relay storage requires owner-private regular paths");
}
/** Worker-exclusive native SQLite journal; no legacy file is read, migrated or deleted. */
export class RelayRecoveryJournal {
  readonly #db: Database;
  readonly #rows = new Map<string, RecoveryRow>();
  #poisoned = false;
  constructor(root: string, origin?: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 }); privatePath(root, true);
    const path = join(root, "restart-safe-v1.sqlite");
    let created = false;
    try { const fd = openSync(path, "wx", 0o600); closeSync(fd); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    privatePath(path, false);
    this.#db = new Database(path, { create: false, strict: true });
    const db = this.#db;
    try {
      db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=65536; BEGIN EXCLUSIVE;");
      if (created) {
        db.exec("CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), format TEXT NOT NULL, origin TEXT NOT NULL); CREATE TABLE cells (bucket TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(bucket,key)); PRAGMA user_version=1;");
        db.query("INSERT INTO metadata VALUES (1,?,?)").run(FORMAT, origin ?? "");
      } else {
        const version = db.query("PRAGMA user_version").get() as { user_version: number };
        const meta = db.query("SELECT * FROM metadata WHERE id=1").get() as { format?: string; origin?: string } | null;
        if (version.user_version !== 1 || meta?.format !== FORMAT || meta.origin !== (origin ?? "")) throw new Error("unsupported relay storage format or origin mismatch");
        const check = db.query("PRAGMA integrity_check").all();
        if (check.length !== 1 || Object.values(check[0] as object)[0] !== "ok") throw new Error("relay storage integrity check failed");
      }
      db.exec("COMMIT");
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
  assertHealthy(): void { if (this.#poisoned) throw new Error("relay commit uncertain; worker must reopen storage"); }
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
    } catch (error) { this.#poisoned = true; try { db.exec("ROLLBACK"); } catch {} throw error; }
  }
  close(): void { this.#poisoned = true; this.#db.close(); }
}
