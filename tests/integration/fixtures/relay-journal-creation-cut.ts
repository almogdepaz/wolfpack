import { mock } from "bun:test";
import * as fs from "node:fs";
import * as sqlite from "bun:sqlite";
import { join } from "node:path";

const native = { ...fs }, nativeSqlite = { ...sqlite };
const [root, marker, cut] = process.argv.slice(2);
const final = join(root!, "restart-safe-v1.sqlite"), staging = final + ".initializing";
const stop = (path: string) => {
  native.writeFileSync(marker!, JSON.stringify({ cut, path, pid: process.pid }), { mode: 0o600 });
  process.kill(process.pid, "SIGSTOP");
};
// Inject at real filesystem/native boundaries only in this child process.
mock.module("node:fs", () => ({ ...native,
  openSync(path: fs.PathLike, flags: string | number, mode?: fs.Mode) {
    const fd = native.openSync(path, flags, mode);
    if (flags === "wx" && (path === final || path === staging)) {
      if (cut === "create") stop(String(path));
      if (cut === "create-eio") { native.closeSync(fd); throw Object.assign(new Error("injected creation I/O failure"), { code: "EIO" }); }
    }
    return fd;
  },
  linkSync(existing: fs.PathLike, next: fs.PathLike) {
    native.linkSync(existing, next);
    if (cut === "publish" && next === final) stop(final);
  },
  unlinkSync(path: fs.PathLike) {
    native.unlinkSync(path);
    if (cut === "unlink" && path === staging) stop(final);
  },
}));
mock.module("bun:sqlite", () => ({ ...nativeSqlite, Database: class extends nativeSqlite.Database {
  override exec(query: string) {
    const result = super.exec(query);
    if (cut === "commit" && query === "COMMIT") stop(staging);
    return result;
  }
} }));
const { createRecoveryStore } = await import("../../../src/task-relay/recovery-store.ts");
const owner = createRecoveryStore({ root: root! }); owner.close();
throw new Error(`creation cut ${cut} was not reached`);
