import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer } from "../e2e/helpers";
import {
  createOwnedTestServerHome,
  removeOwnedTestServerHome,
} from "../e2e/test-server-home";

const ROOT = join(import.meta.dirname, "..", "..");

function isolatedServerHomes(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith("wolfpack-e2e-server-")));
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupExists(processId: number): boolean {
  if (process.platform === "win32") return processExists(processId);
  try {
    process.kill(-processId, 0);
    return true;
  } catch {
    return false;
  }
}

describe("e2e test server lifecycle", () => {
  test("close waits for the server child and removes its temporary home", async () => {
    const homesBefore = isolatedServerHomes();
    const server = await startTestServer();

    await server.close();

    const newHomes = [...isolatedServerHomes()].filter((home) => !homesBefore.has(home));
    expect(newHomes).toEqual([]);
    expect(processExists(server.processId)).toBe(false);
    expect(processGroupExists(server.processId)).toBe(false);
  });

  test("close escalates and returns when the server ignores SIGTERM", async () => {
    const homesBefore = isolatedServerHomes();
    const server = await startTestServer({ ignoreSigterm: true });
    const startedClosingAt = Date.now();

    await server.close();

    expect(Date.now() - startedClosingAt).toBeLessThan(3_000);
    expect(processExists(server.processId)).toBe(false);
    expect(processGroupExists(server.processId)).toBe(false);
    const newHomes = [...isolatedServerHomes()].filter((home) => !homesBefore.has(home));
    expect(newHomes).toEqual([]);
  });

  test("owned-home bootstrap rejects an unowned path without deleting it", async () => {
    const unownedHome = mkdtempSync(join(tmpdir(), "wolfpack-unowned-home-"));
    const child = spawn("bun", [
      join(ROOT, "tests", "e2e", "test-server.ts"),
      "--bootstrap-owned-isolated-e2e-home",
      unownedHome,
      "invalid-ownership-token",
    ], {
      cwd: ROOT,
      env: { ...process.env, HOME: unownedHome, WOLFPACK_TEST: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      child.stdin?.end();
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      expect(exitCode).not.toBe(0);
      expect(existsSync(unownedHome)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      rmSync(unownedHome, { recursive: true, force: true });
    }
  });

  test("the isolated server removes its own home when parent stdin closes", async () => {
    const isolatedHome = createOwnedTestServerHome();
    const child = spawn("bun", [
      join(ROOT, "tests", "e2e", "test-server.ts"),
      "--bootstrap-owned-isolated-e2e-home",
      isolatedHome.path,
      isolatedHome.token,
    ], {
      cwd: ROOT,
      env: { ...process.env, HOME: isolatedHome.path, WOLFPACK_TEST: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("isolated test server did not become ready")), 10_000);
        child.once("error", reject);
        child.stdout?.on("data", (chunk: Buffer) => {
          if (!chunk.toString().includes("READY:")) return;
          clearTimeout(timeout);
          resolve();
        });
      });
      child.stdin?.end();
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => resolve());
      });
      expect(existsSync(isolatedHome.path)).toBe(false);
    } finally {
      child.kill("SIGTERM");
      removeOwnedTestServerHome(isolatedHome);
    }
  });
});
