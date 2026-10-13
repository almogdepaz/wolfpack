import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { start, BROKER_BIN } from "../e2e/broker-helpers.ts";
import type { BrokerTestOwnership } from "../e2e/broker-helpers.ts";
import { createOwnedTestServerHome, removeOwnedTestServerHome } from "../e2e/test-server-home.ts";

test.each(["exit", "never-ready"] as const)("new native fixture retains exact startup ownership when server is %s", async mode => {
  if (!BROKER_BIN) throw new Error("existing approved broker binary required; no download/skip");
  const home = createOwnedTestServerHome(), entry = join(home.path, "failed-ready.ts");
  writeFileSync(entry, mode === "exit" ? "process.exit(7);" : "process.stdin.resume();");
  const environment = { HOME: home.path, ZDOTDIR: home.path, TMPDIR: home.path, XDG_CONFIG_HOME: join(home.path, "config"), XDG_DATA_HOME: join(home.path, "data"), WOLFPACK_TASK_ROOT: join(home.path, "tasks"), WOLFPACK_TASK_RELAY_ROOT: join(home.path, "relay") };
  const ownership: BrokerTestOwnership[] = [];
  let cleaned = false;
  try {
    const started = performance.now();
    await expect(start({ serverEntry: entry, readyTimeoutMs: 200, envOverrides: environment, brokerEnvOverrides: environment, onOwnership: owner => ownership.push(owner) })).rejects.toThrow();
    expect(ownership).toHaveLength(1);
    const owner = ownership[0];
    if (!owner) throw new Error("owned startup registration missing");
    expect(owner.childrenExited()).toBe(false);
    await owner.teardown(); cleaned = true;
    expect(owner.childrenExited()).toBe(true);
    expect(existsSync(owner.socketPath)).toBe(false); expect(existsSync(dirname(owner.socketPath))).toBe(false);
    expect(performance.now() - started).toBeLessThan(7000);
  } finally {
    if (!cleaned) for (const owner of ownership) await owner.teardown();
    removeOwnedTestServerHome(home);
  }
});
