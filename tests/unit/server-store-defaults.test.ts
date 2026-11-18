import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("production store paths, modes, and constructor capture preserve their precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-store-defaults-"));
  const identityModule = new URL("../../src/server/session-identity.ts", import.meta.url).href;
  const runtimeModule = new URL("../../src/server/agent-status.ts", import.meta.url).href;
  const env: NodeJS.ProcessEnv = { ...process.env, WOLFPACK_DEV_DIR: join(root, "dev"), WOLFPACK_DIR: join(root, "state") };
  delete env.WOLFPACK_TEST;
  delete env.WOLFPACK_SESSION_IDENTITY_PATH;
  delete env.WOLFPACK_SESSION_IDENTITY_MODE;
  delete env.WOLFPACK_AGENT_RUNTIME_STATE_PATH;
  try {
    const child = Bun.spawnSync([process.execPath, "--eval", `
      const { SessionIdentityStore } = await import(${JSON.stringify(identityModule)});
      const { AgentRuntimeStateStore } = await import(${JSON.stringify(runtimeModule)});
      const root = ${JSON.stringify(root)};
      const defaults = new SessionIdentityStore();
      const runtime = new AgentRuntimeStateStore();
      process.env.WOLFPACK_SESSION_IDENTITY_PATH = root + "/override.json";
      process.env.WOLFPACK_SESSION_IDENTITY_MODE = "memory";
      process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH = root + "/runtime.json";
      const overridden = new SessionIdentityStore();
      const explicit = new SessionIdentityStore(root + "/explicit", "private");
      console.log(JSON.stringify({
        defaults: { path: defaults.path, mode: defaults.mode },
        overridden: { path: overridden.path, mode: overridden.mode },
        explicit: { path: explicit.path, mode: explicit.mode },
        runtime: runtime.path,
        runtimeOverride: new AgentRuntimeStateStore().path,
        runtimeExplicit: new AgentRuntimeStateStore(root + "/explicit-runtime.json").path,
      }));
    `], { env, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      defaults: { path: join(root, "dev/.wolfpack/session-identities.json"), mode: "private" },
      overridden: { path: join(root, "override.json"), mode: "memory" },
      explicit: { path: join(root, "explicit/.wolfpack/session-identities.json"), mode: "private" },
      runtime: join(root, "state/agent-runtime-state.json"),
      runtimeOverride: join(root, "runtime.json"),
      runtimeExplicit: join(root, "explicit-runtime.json"),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
