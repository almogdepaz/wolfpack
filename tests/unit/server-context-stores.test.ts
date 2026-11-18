import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerContext } from "../../src/server/context.ts";
import { AgentRuntimeStateStore } from "../../src/server/agent-status.ts";
import { MockBackend } from "../../src/server/mock-backend.ts";

test("cold context shutdown does not create stores; first access captures defaults lazily", async () => {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-context-stores-"));
  const prior = {
    WOLFPACK_AGENT_RUNTIME_STATE_PATH: process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH,
    WOLFPACK_SESSION_IDENTITY_PATH: process.env.WOLFPACK_SESSION_IDENTITY_PATH,
    WOLFPACK_SESSION_IDENTITY_MODE: process.env.WOLFPACK_SESSION_IDENTITY_MODE,
  };
  const ctx = createServerContext({ backend: new MockBackend(), config: null });
  const runtimePath = join(root, "runtime.json");
  const identityPath = join(root, "identity.json");
  try {
    process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH = runtimePath;
    process.env.WOLFPACK_SESSION_IDENTITY_PATH = identityPath;
    process.env.WOLFPACK_SESSION_IDENTITY_MODE = "memory";
    await ctx.flushRuntimeState();
    await ctx.close();
    expect(existsSync(runtimePath)).toBe(false);
    expect(existsSync(identityPath)).toBe(false);
    const runtime = ctx.agentRuntimeStateStore;
    const identity = ctx.sessionIdentityStore;
    expect(runtime.path).toBe(runtimePath);
    expect(identity.path).toBe(identityPath);
    expect(identity.mode).toBe("memory");
    process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH = join(root, "later-runtime.json");
    process.env.WOLFPACK_SESSION_IDENTITY_PATH = join(root, "later-identity.json");
    process.env.WOLFPACK_SESSION_IDENTITY_MODE = "private";
    expect(ctx.agentRuntimeStateStore).toBe(runtime);
    expect(ctx.sessionIdentityStore).toBe(identity);
    expect(identity.mode).toBe("memory");
  } finally {
    await ctx.close();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("owned runtime stores isolate acknowledgements and drain only their own pending state", async () => {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-context-runtime-"));
  const contexts = ["first", "second"].map(name => createServerContext({
    backend: new MockBackend(), config: null,
    agentRuntimeStateStore: new AgentRuntimeStateStore(join(root, name + ".json")),
  }));
  const [first, second] = contexts;
  const observedAt = "2026-01-01T00:00:00.000Z";
  try {
    for (const ctx of contexts) ctx.agentRuntimeStateStore.reduce({
      sessionKey: "same-id", broker: { state: "alive", observedAt }, sources: [],
      fallback: { rawOutputChanged: false, observedAt },
    });
    const state = first!.agentRuntimeStateStore.get("same-id")!;
    expect(first!.agentRuntimeStateStore.acknowledge("same-id", state.transitionSequence)?.unseen).toBe(false);
    expect(second!.agentRuntimeStateStore.get("same-id")?.unseen).toBe(true);
    await first!.close();
    expect(JSON.parse(readFileSync(first!.agentRuntimeStateStore.path, "utf8")).sessions["same-id"].unseen).toBe(false);
    expect(second!.agentRuntimeStateStore.get("same-id")?.unseen).toBe(true);
    await second!.close();
    expect(new AgentRuntimeStateStore(second!.agentRuntimeStateStore.path).get("same-id")?.unseen).toBe(true);
  } finally {
    await Promise.all(contexts.map(ctx => ctx.close()));
    rmSync(root, { recursive: true, force: true });
  }
});
