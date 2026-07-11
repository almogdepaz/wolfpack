import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SessionIdentityStore,
  extractExternalAgentFromEnv,
  identityEnvVars,
  redactExternalAgentId,
  sessionIdentityStorePath,
  toPublicSessionIdentity,
} from "../../src/server/session-identity";

process.env.WOLFPACK_TEST = "1";

function tmpDevDir(): string {
  const root = join(process.cwd(), ".wolfpack", "test-session-identity");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "dev-"));
}

describe("session identity metadata", () => {
  test("captures identity separately from liveness/status fields", () => {
    const devDir = tmpDevDir();
    const store = new SessionIdentityStore(devDir);
    const identity = store.capture({
      wolfpackSessionId: "broker-1",
      wolfpackSessionName: "alpha",
      projectPath: join(devDir, "alpha"),
      agentKind: "codex",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(identity).not.toHaveProperty("alive");
    expect(identity).not.toHaveProperty("triage");
    expect(identity).not.toHaveProperty("lastLine");
    expect(identity.agentKind).toBe("codex");
  });

  test("redacts external agent ids in public views", () => {
    const devDir = tmpDevDir();
    const store = new SessionIdentityStore(devDir);
    const identity = store.capture({
      wolfpackSessionId: "broker-1",
      wolfpackSessionName: "alpha",
      projectPath: join(devDir, "alpha"),
      agentKind: "claude",
      externalAgent: { provider: "claude", id: "conv_abcdefghijklmnopqrstuvwxyz", source: "broker_env" },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const raw = readFileSync(sessionIdentityStorePath(devDir), "utf-8");
    expect(raw).toContain("conv_abcdefghijklmnopqrstuvwxyz");
    const publicIdentity = toPublicSessionIdentity(identity);
    expect(publicIdentity.externalAgent?.redactedId).toBe(redactExternalAgentId("conv_abcdefghijklmnopqrstuvwxyz"));
    expect(JSON.stringify(publicIdentity)).not.toContain("conv_abcdefghijklmnopqrstuvwxyz");
  });

  test("restores idempotently and prunes stale sessions", () => {
    const devDir = tmpDevDir();
    const store = new SessionIdentityStore(devDir);
    store.capture({
      wolfpackSessionId: "broker-1",
      wolfpackSessionName: "alpha",
      projectPath: join(devDir, "alpha"),
      agentKind: "codex",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    store.capture({
      wolfpackSessionId: "broker-stale",
      wolfpackSessionName: "stale",
      projectPath: join(devDir, "stale"),
      agentKind: "claude",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const active = [{
      wolfpackSessionId: "broker-1",
      wolfpackSessionName: "alpha",
      projectPath: join(devDir, "alpha"),
      agentKind: "codex",
    }];
    const first = store.restore(active, new Date("2026-01-02T00:00:00.000Z"));
    const second = store.restore(active, new Date("2026-01-03T00:00:00.000Z"));

    expect(first).toEqual(second);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].wolfpackSessionName).toBe("alpha");
  });

  test("extracts external ids only from structured env", () => {
    const env = [
      ["WOLFPACK_AGENT_KIND", "codex"],
      ["WOLFPACK_EXTERNAL_AGENT_ID", "conv_structured"],
    ] satisfies Array<[string, string]>;
    expect(extractExternalAgentFromEnv(env, "broker_env")).toEqual({
      provider: "codex",
      id: "conv_structured",
      source: "broker_env",
    });
  });

  test("documents public project path exposure", () => {
    const docs = readFileSync(join(process.cwd(), "docs/session-identity.md"), "utf-8");

    expect(docs).toContain("Public session APIs intentionally expose `projectPath`");
  });

  test("exposes context env vars for launched agents", () => {
    const vars = new Map(identityEnvVars({
      wolfpackSessionName: "alpha",
      projectPath: "/repo/alpha",
      agentKind: "codex",
    }));
    expect(vars.get("WOLFPACK_SESSION_NAME")).toBe("alpha");
    expect(vars.get("WOLFPACK_PROJECT_DIR")).toBe("/repo/alpha");
    expect(vars.get("WOLFPACK_AGENT_KIND")).toBe("codex");
    expect(vars.get("WOLFPACK_EXTERNAL_AGENT_ID_FILE")).toBe("/repo/alpha/.wolfpack/external-agent-id");
  });
});
