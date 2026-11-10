import { expect, test } from "bun:test";
import { existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRecoveryStore } from "../../src/task-relay/recovery-store.ts";

for (const phase of ["create", "commit", "publish", "unlink"] as const) test(`SIGKILL at real virgin journal ${phase} boundary safely resumes publication`, async () => {
  const root = mkdtempSync("/tmp/relay-creation-cut-"), marker = join(root, "cut.json"), journal = join(root, "state");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/relay-journal-creation-cut.ts"), journal, marker, phase], {
    env: { PATH: process.env.PATH, HOME: root, WOLFPACK_DIR: join(root, "unused-config"), WOLFPACK_TEST: "1" }, stdout: "ignore", stderr: "pipe",
  });
  const errors = new Response(child.stderr as ReadableStream<Uint8Array>).text();
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(marker) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(5);
    if (!existsSync(marker)) throw new Error(`creation cut not reached: ${await errors}`);
    const cut = JSON.parse(readFileSync(marker, "utf8"));
    expect(cut).toMatchObject({ cut: phase, pid: child.pid });
    if (phase === "create") expect(lstatSync(cut.path).size).toBe(0);
    else {
      expect(lstatSync(cut.path).size).toBeGreaterThan(0);
      expect(() => createRecoveryStore({ root: journal })).toThrow("RELAY_STORAGE_BUSY");
    }
    child.kill("SIGKILL"); expect(await child.exited).not.toBe(0);
    if (phase === "publish") {
      expect(lstatSync(cut.path).nlink).toBe(2);
      expect(() => createRecoveryStore({ root: journal, peerOrigin: "wrong-origin" })).toThrow("RELAY_STORAGE_INVALID");
      expect(lstatSync(cut.path).nlink).toBe(2);
    }
    const owner = createRecoveryStore({ root: journal });
    try {
      expect(owner.store.epoch).toBeString(); expect(owner.store.stats().receipts).toBe(0);
      expect(lstatSync(join(journal, "restart-safe-v1.sqlite")).nlink).toBe(1);
      expect(existsSync(join(journal, "restart-safe-v1.sqlite.initializing"))).toBe(false);
    }
    finally { owner.close(); }
  } finally { child.kill("SIGKILL"); await child.exited; rmSync(root, { recursive: true, force: true }); }
}, 10_000);

test("transient I/O failure after slot creation can reopen without reclassifying the final path as virgin", async () => {
  const root = mkdtempSync("/tmp/relay-creation-io-"), journal = join(root, "state");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/relay-journal-creation-cut.ts"), journal, join(root, "cut.json"), "create-eio"], {
    env: { PATH: process.env.PATH, HOME: root, WOLFPACK_DIR: join(root, "unused-config"), WOLFPACK_TEST: "1" }, stdout: "ignore", stderr: "pipe",
  });
  const errors = new Response(child.stderr as ReadableStream<Uint8Array>).text();
  try {
    expect(await child.exited).not.toBe(0); expect(await errors).toContain("RELAY_STORAGE_UNAVAILABLE");
    expect(existsSync(join(journal, "restart-safe-v1.sqlite"))).toBe(false);
    const owner = createRecoveryStore({ root: journal }); owner.close();
    expect(existsSync(join(journal, "restart-safe-v1.sqlite"))).toBe(true);
  } finally { child.kill("SIGKILL"); await child.exited; rmSync(root, { recursive: true, force: true }); }
});

test("a non-virgin final journal with the staging hardlink is not mistaken for interrupted initialization", () => {
  const root = mkdtempSync("/tmp/relay-creation-hardlink-"), path = join(root, "restart-safe-v1.sqlite");
  const owner = createRecoveryStore({ root }); owner.close();
  linkSync(path, path + ".initializing"); const before = readFileSync(path);
  try {
    expect(() => createRecoveryStore({ root })).toThrow("RELAY_STORAGE_INVALID");
    expect(lstatSync(path).nlink).toBe(2); expect(readFileSync(path)).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("corrupt unpublished storage is refused without deletion or publication", () => {
  const root = mkdtempSync("/tmp/relay-creation-corrupt-"), path = join(root, "restart-safe-v1.sqlite");
  writeFileSync(path + ".initializing", "not a SQLite database", { mode: 0o600 });
  try {
    expect(() => createRecoveryStore({ root })).toThrow("RELAY_STORAGE_INVALID");
    expect(readFileSync(path + ".initializing", "utf8")).toBe("not a SQLite database"); expect(existsSync(path)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an arbitrary pre-existing empty final journal remains invalid and unchanged", () => {
  const root = mkdtempSync("/tmp/relay-creation-untrusted-");
  const path = join(root, "restart-safe-v1.sqlite"); writeFileSync(path, "", { mode: 0o600 });
  try {
    expect(() => createRecoveryStore({ root })).toThrow("RELAY_STORAGE_INVALID");
    expect(readFileSync(path).length).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
