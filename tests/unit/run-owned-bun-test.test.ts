import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOwnedBunTest } from "./fixtures/run-owned-bun-test.ts";

const actor = join(import.meta.dir, "fixtures/owned-bun-test-actor.fixture.ts");
const nestedActor = join(import.meta.dir, "fixtures/owned-bun-test-nested.fixture.ts");
const roots: string[] = [];

function actorEnv(mode: string, marker?: string): NodeJS.ProcessEnv {
  return { ...process.env, OWNED_BUN_TEST_ACTOR: mode, ...(marker === undefined ? {} : { OWNED_BUN_TEST_MARKER: marker }) };
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: any) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("owned Bun test runner accepts a reaped normal root", async () => {
  await expect(runOwnedBunTest(actor, 1_000, actorEnv("normal"))).resolves.toMatchObject({ code: 0, signal: null });
}, 5_000);

test("owned Bun test runner preserves early-exit and signal failures after cleanup", async () => {
  await expect(runOwnedBunTest(actor, 1_000, actorEnv("early"))).rejects.toThrow("exit=23");
  await expect(runOwnedBunTest(actor, 1_000, actorEnv("signal"))).rejects.toThrow("signal=SIGTERM");
}, 5_000);

test("owned Bun test runner retains primary exit or signal status when group verification fails", async () => {
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
    if (pid < 0 && signal === 0) {
      const error = Object.assign(new Error("simulated group probe denial"), { code: "EACCES" });
      throw error;
    }
    return originalKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill;
  try {
    await expect(runOwnedBunTest(actor, 1_000, actorEnv("early"))).rejects.toThrow(/exit=23[\s\S]*EACCES/);
    await expect(runOwnedBunTest(actor, 1_000, actorEnv("signal"))).rejects.toThrow(/signal=SIGTERM[\s\S]*EACCES/);
  } finally {
    process.kill = originalKill;
  }
}, 5_000);

test("owned Bun test runner preserves a spawn error", async () => {
  const executable = process.execPath;
  process.execPath = "/definitely-not-an-owned-bun-executable";
  try {
    await expect(runOwnedBunTest(actor, 1_000, actorEnv("normal"))).rejects.toThrow("ENOENT");
  } finally {
    process.execPath = executable;
  }
}, 5_000);

test("ESRCH remains idempotent for owned group teardown and verification", async () => {
  const originalKill = process.kill;
  let killCalls = 0;
  process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
    if (pid < 0 && signal === "SIGKILL") {
      killCalls++;
      throw Object.assign(new Error("already absent"), { code: "ESRCH" });
    }
    if (pid < 0 && signal === 0) throw Object.assign(new Error("already absent"), { code: "ESRCH" });
    return originalKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill;
  try {
    await expect(runOwnedBunTest(actor, 1_000, actorEnv("normal"))).resolves.toMatchObject({ code: 0, signal: null, cleanupDiagnostics: [] });
  } finally {
    process.kill = originalKill;
  }
  expect(killCalls).toBe(1);
}, 5_000);

test("a kill failure remains fatal even if a later source probe observes ESRCH", async () => {
  const originalKill = process.kill;
  let sourceConfirmedAbsent = false;
  process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
    if (pid < 0 && signal === "SIGKILL") throw Object.assign(new Error("simulated group kill failure"), { code: "EACCES" });
    try {
      return originalKill(pid, signal as NodeJS.Signals);
    } catch (error: any) {
      if (pid < 0 && signal === 0 && error?.code === "ESRCH") sourceConfirmedAbsent = true;
      throw error;
    }
  }) as typeof process.kill;
  try {
    await expect(runOwnedBunTest(actor, 1_000, actorEnv("normal"))).rejects.toThrow("EACCES");
  } finally {
    process.kill = originalKill;
  }
  expect(sourceConfirmedAbsent).toBe(true);
}, 5_000);

test("owned Bun test runner bounds a stalled child and reaps its group", async () => {
  await expect(runOwnedBunTest(actor, 100, actorEnv("stall"))).rejects.toThrow("100ms lifecycle deadline");
}, 5_000);

test("owned Bun test runner rejects a root that exits before its deadline but finishes cleanup late", async () => {
  await expect(runOwnedBunTest(actor, 100, actorEnv("normal"), { cleanupDelayMsForTests: 250 })).rejects.toThrow("100ms success ceiling during cleanup");
}, 5_000);

test("monotonic deadline remains binding with a wall clock frozen before invocation", async () => {
  const wallClock = Date.now;
  Date.now = () => 0;
  try {
    // This is a frozen-clock control, not a simulated mid-flight rollback.
    // Startup still spends the same absolute monotonic budget, so a busy host
    // may validly reject at lifecycle rather than after the delayed cleanup.
    await expect(runOwnedBunTest(actor, 100, actorEnv("normal"), { cleanupDelayMsForTests: 250 })).rejects.toThrow(/100ms (?:lifecycle deadline|success ceiling during cleanup)/);
  } finally {
    Date.now = wallClock;
  }
}, 5_000);

test("owned Bun test runner reaps a surviving same-group grandchild after root success", async () => {
  const root = mkdtempSync(join(tmpdir(), "wp-owned-bun-test-"));
  roots.push(root);
  const marker = join(root, "grandchild.pid");
  await expect(runOwnedBunTest(actor, 1_000, actorEnv("grandchild", marker))).resolves.toMatchObject({ code: 0, signal: null });
  expect(existsSync(marker)).toBe(true);
  expect(isAlive(Number(readFileSync(marker, "utf8")))).toBe(false);
}, 5_000);

test("a recovered probe denial returns diagnostics after tearing down a known owned nested HTTP server", async () => {
  const root = mkdtempSync(join(tmpdir(), "wp-owned-bun-test-"));
  roots.push(root);
  const marker = join(root, "server.json");
  const originalKill = process.kill;
  const groupCalls: Array<number | NodeJS.Signals | undefined> = [];
  let denied = false;
  let sourceConfirmedAbsent = false;
  process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
    if (pid < 0) groupCalls.push(signal);
    if (pid < 0 && signal === 0 && !denied) {
      denied = true;
      throw Object.assign(new Error("simulated group probe denial"), { code: "EACCES" });
    }
    try {
      return originalKill(pid, signal as NodeJS.Signals);
    } catch (error: any) {
      if (pid < 0 && signal === 0 && error?.code === "ESRCH") sourceConfirmedAbsent = true;
      throw error;
    }
  }) as typeof process.kill;
  let result: Awaited<ReturnType<typeof runOwnedBunTest>>;
  try {
    result = await runOwnedBunTest(nestedActor, 1_000, actorEnv("server-grandchild", marker), {
      beforeGroupCleanupForTests: async () => {
        const { port } = JSON.parse(readFileSync(marker, "utf8")) as { port: number };
        expect((await fetch(`http://127.0.0.1:${port}/owned`, { signal: AbortSignal.timeout(50) })).status).toBe(200);
      },
    });
  } finally {
    process.kill = originalKill;
  }
  const { root: nestedRoot, child } = JSON.parse(readFileSync(marker, "utf8")) as { root: number; child: number };
  expect(result).toMatchObject({ code: 0, signal: null, cleanupDiagnostics: [{ phase: "group-probe", code: "EACCES" }] });
  expect(groupCalls.indexOf("SIGKILL")).toBeLessThan(groupCalls.indexOf(0));
  expect(denied).toBe(true);
  expect(sourceConfirmedAbsent).toBe(true);
  expect(isAlive(nestedRoot)).toBe(false);
  expect(isAlive(child)).toBe(false);
}, 5_000);

test("persistent probe denial remains fatal after tearing down a known owned nested HTTP server", async () => {
  const root = mkdtempSync(join(tmpdir(), "wp-owned-bun-test-"));
  roots.push(root);
  const marker = join(root, "persistent-server.json");
  const originalKill = process.kill;
  let killAttempted = false;
  process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
    if (pid < 0 && signal === "SIGKILL") killAttempted = true;
    if (pid < 0 && signal === 0) throw Object.assign(new Error("persistent group probe denial"), { code: "EACCES" });
    return originalKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill;
  try {
    await expect(runOwnedBunTest(nestedActor, 1_000, actorEnv("server-grandchild", marker))).rejects.toThrow("EACCES");
  } finally {
    process.kill = originalKill;
  }
  const { root: nestedRoot, child } = JSON.parse(readFileSync(marker, "utf8")) as { root: number; child: number };
  expect(killAttempted).toBe(true);
  expect(isAlive(nestedRoot)).toBe(false);
  expect(isAlive(child)).toBe(false);
}, 5_000);

async function expectPreCleanupHookFailure(hook: () => Promise<void>, expected: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "wp-owned-bun-test-"));
  roots.push(root);
  const marker = join(root, "hook-server.json");
  await expect(runOwnedBunTest(nestedActor, 1_000, actorEnv("server-grandchild", marker), { beforeGroupCleanupForTests: hook })).rejects.toThrow(expected);
  const { root: nestedRoot, child } = JSON.parse(readFileSync(marker, "utf8")) as { root: number; child: number };
  expect(isAlive(nestedRoot)).toBe(false);
  expect(isAlive(child)).toBe(false);
}

test("a failing pre-cleanup diagnostic cannot bypass owned HTTP-server teardown", async () => {
  await expectPreCleanupHookFailure(async () => { throw new Error("diagnostic assertion failed"); }, "diagnostic assertion failed");
}, 5_000);

test("a stalled pre-cleanup diagnostic cannot bypass owned HTTP-server teardown", async () => {
  await expectPreCleanupHookFailure(async () => await new Promise<void>(() => {}), "pre-cleanup test hook exceeded 100ms");
}, 5_000);

async function expectNestedDescendantsGone(mode: string, deadlineMs: number, extra: NodeJS.ProcessEnv = {}): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "wp-owned-bun-test-"));
  roots.push(root);
  const marker = join(root, "nested.json");
  const result = runOwnedBunTest(nestedActor, deadlineMs, { ...actorEnv(mode, marker), ...extra });
  if (extra.OWNED_NESTED_VERIFIER_SIGNAL === "1") await expect(result).rejects.toThrow(/signal=SIGTERM|exit=1/);
  else if (mode === "stall-grandchild") await expect(result).rejects.toThrow(`${deadlineMs}ms lifecycle deadline`);
  else await expect(result).resolves.toMatchObject({ code: 0, signal: null });
  expect(existsSync(marker)).toBe(true);
  const { root: nestedRoot, child } = JSON.parse(readFileSync(marker, "utf8")) as { root: number; child: number };
  expect(isAlive(nestedRoot)).toBe(false);
  expect(isAlive(child)).toBe(false);
}

test("outer success reaps inherited nested descendants after verifier exit", async () => {
  await expectNestedDescendantsGone("inherited-grandchild", 1_000);
}, 5_000);

test("outer success does not wait for inherited descendant stdio before reaping it", async () => {
  await expectNestedDescendantsGone("inherited-stdio-grandchild", 1_000);
}, 5_000);

test("outer timeout reaps an inherited nested group and its descendant", async () => {
  await expectNestedDescendantsGone("stall-grandchild", 1_000);
}, 5_000);

test("outer reaps inherited descendants when the verifier receives SIGTERM", async () => {
  await expectNestedDescendantsGone("stall-grandchild", 1_000, { OWNED_NESTED_VERIFIER_SIGNAL: "1" });
}, 5_000);
