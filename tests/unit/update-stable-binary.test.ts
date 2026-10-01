import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";

const home = mkdtempSync(join(tmpdir(), "wolfpack-stable-binary-update-"));
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function compileNativeExecutable(path: string, source: string): void {
  const sourcePath = `${path}.c`;
  writeFileSync(sourcePath, source);
  execFileSync("cc", [sourcePath, "-o", path]);
  rmSync(sourcePath);
  chmodSync(path, 0o755);
}

function runStableBinaryUpdate(testHome: string, candidate: string): { readonly updated: boolean; readonly output: string } {
  const runner = join(testHome, "update.ts");
  const resultPath = join(testHome, "update-result.json");
  writeFileSync(runner, `import { writeFileSync } from "node:fs";\nimport { updateStableBinary } from ${JSON.stringify(join(process.cwd(), "src/cli/service.ts"))};\nwriteFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ updated: updateStableBinary() }));\n`);
  const output = execFileSync(candidate, [runner], {
    encoding: "utf-8",
    env: { ...process.env, HOME: testHome },
  });
  const parsed: unknown = JSON.parse(readFileSync(resultPath, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("updater produced an invalid result");
  }
  const result = parsed as Record<string, unknown>;
  if (typeof result.updated !== "boolean") throw new Error("updater result omitted updated");
  return { updated: result.updated, output };
}

test("updateStableBinary atomically replaces an active native executable", async () => {
  const bin = join(home, ".wolfpack", "bin");
  const stable = join(bin, "wolfpack");
  const candidate = join(home, "candidate");
  const predecessor = join(home, "predecessor");
  const ready = join(home, "ready.json");
  const stagedReady = join(home, "ready.staged");
  mkdirSync(bin, { recursive: true });
  compileNativeExecutable(stable, `#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  int fd = open(argv[2], O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) return 3;
  if (dprintf(fd, "{\\\"status\\\":\\\"ready\\\",\\\"pid\\\":%d}\\n", getpid()) < 0) return 4;
  if (close(fd) != 0) return 5;
  if (rename(argv[2], argv[1]) != 0) return 6;
  for (;;) pause();
}
`);
  copyFileSync(process.execPath, candidate);
  chmodSync(candidate, 0o755);
  const oldBytes = readFileSync(stable);
  const oldInode = statSync(stable).ino;
  linkSync(stable, predecessor);
  const child = spawn(stable, [ready, stagedReady], { stdio: "ignore" });
  let stopping = false;
  let childFailure: Error | undefined;
  const childCompletion = new Promise<void>(resolve => {
    child.once("error", error => {
      childFailure = error;
      resolve();
    });
    child.once("exit", (code, signal) => {
      if (!stopping) childFailure = new Error(`native fixture exited before replacement (code=${code}, signal=${signal})`);
      resolve();
    });
  });
  try {
    const childPid = child.pid;
    if (childPid === undefined) {
      await childCompletion;
      throw childFailure ?? new Error("native fixture did not start");
    }
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++) {
      if (childFailure) throw childFailure;
      await Bun.sleep(10);
    }
    if (childFailure) throw childFailure;
    expect(existsSync(ready)).toBe(true);
    expect(JSON.parse(readFileSync(ready, "utf-8"))).toEqual({ status: "ready", pid: childPid });

    const update = runStableBinaryUpdate(home, candidate);
    expect(update.updated, update.output).toBe(true);
    expect(readFileSync(stable)).toEqual(readFileSync(candidate));
    expect(statSync(stable).mode & 0o777).toBe(0o755);
    expect(statSync(stable).ino).not.toBe(oldInode);
    expect(readFileSync(predecessor)).toEqual(oldBytes);
    expect(readdirSync(bin)).toEqual(["wolfpack"]);
    process.kill(childPid, 0);
  } finally {
    stopping = true;
    if (child.exitCode === null) child.kill("SIGTERM");
    await childCompletion;
  }
});

test("updateStableBinary preserves an identical stable binary", () => {
  const testHome = join(home, "no-op");
  const bin = join(testHome, ".wolfpack", "bin");
  const stable = join(bin, "wolfpack");
  const candidate = join(testHome, "candidate");
  mkdirSync(bin, { recursive: true });
  copyFileSync(process.execPath, candidate);
  copyFileSync(candidate, stable);
  chmodSync(candidate, 0o755);
  chmodSync(stable, 0o755);
  const inode = statSync(stable).ino;

  const update = runStableBinaryUpdate(testHome, candidate);

  expect(update.updated, update.output).toBe(false);
  expect(statSync(stable).ino).toBe(inode);
  expect(readFileSync(stable)).toEqual(readFileSync(candidate));
});

test("updateStableBinary installs a missing stable binary", () => {
  const testHome = join(home, "initial");
  const bin = join(testHome, ".wolfpack", "bin");
  const stable = join(bin, "wolfpack");
  const candidate = join(testHome, "candidate");
  mkdirSync(testHome, { recursive: true });
  copyFileSync(process.execPath, candidate);
  chmodSync(candidate, 0o755);

  const update = runStableBinaryUpdate(testHome, candidate);

  expect(update.updated, update.output).toBe(true);
  expect(readFileSync(stable)).toEqual(readFileSync(candidate));
  expect(statSync(stable).mode & 0o777).toBe(0o755);
  expect(readdirSync(bin)).toEqual(["wolfpack"]);
});

test.skipIf(process.getuid?.() === 0)("updateStableBinary keeps the existing binary when staging cannot be created", () => {
  const testHome = join(home, "staging-failure");
  const bin = join(testHome, ".wolfpack", "bin");
  const stable = join(bin, "wolfpack");
  const candidate = join(testHome, "candidate");
  mkdirSync(bin, { recursive: true });
  copyFileSync(process.execPath, candidate);
  writeFileSync(stable, "previous executable");
  chmodSync(candidate, 0o755);
  chmodSync(stable, 0o755);
  const oldBytes = readFileSync(stable);
  chmodSync(bin, 0o500);

  try {
    const update = runStableBinaryUpdate(testHome, candidate);
    expect(update.updated, update.output).toBe(false);
    expect(update.output).toContain("failed to update stable binary");
  } finally {
    chmodSync(bin, 0o755);
  }

  expect(readFileSync(stable)).toEqual(oldBytes);
  expect(readdirSync(bin)).toEqual(["wolfpack"]);
});
