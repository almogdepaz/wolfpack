import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const SUITE_ROOT = mkdtempSync(join(tmpdir(), "wolfpack-session-identity-test-"));

afterAll(() => {
  rmSync(SUITE_ROOT, { recursive: true, force: true });
});

function tmpDevDir(): string {
  return mkdtempSync(join(SUITE_ROOT, "dev-"));
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

  test("persists and exposes structured parent session identity", () => {
    const devDir = tmpDevDir();
    const store = new SessionIdentityStore(devDir);
    const parentSession = {
      wolfpackSessionId: "broker-parent",
      wolfpackSessionName: "wolfpack",
    };
    const identity = store.capture({
      wolfpackSessionId: "broker-child",
      wolfpackSessionName: "wolfpack-sub-agent",
      projectPath: join(devDir, "wolfpack"),
      agentKind: "pi",
      parentSession,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(identity.parentSession).toEqual(parentSession);
    expect(toPublicSessionIdentity(identity).parentSession).toEqual(parentSession);
    expect(new SessionIdentityStore(devDir).getByName("wolfpack-sub-agent")?.parentSession)
      .toEqual(parentSession);
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

  test("refuses to overwrite malformed identity persistence", () => {
    const devDir = tmpDevDir();
    const path = sessionIdentityStorePath(devDir);
    mkdirSync(join(devDir, ".wolfpack"), { recursive: true });
    const malformed = "{not-json";
    writeFileSync(path, malformed);
    const store = new SessionIdentityStore(devDir);

    expect(() => store.capture({
      wolfpackSessionId: "broker-1",
      wolfpackSessionName: "alpha",
      projectPath: join(devDir, "alpha"),
      agentKind: "codex",
    })).toThrow("session identity persistence");
    expect(readFileSync(path, "utf-8")).toBe(malformed);
  });

  test("refuses to overwrite invalid identity persistence shapes", () => {
    const devDir = tmpDevDir();
    const path = sessionIdentityStorePath(devDir);
    mkdirSync(join(devDir, ".wolfpack"), { recursive: true });
    const invalid = JSON.stringify({ schemaVersion: 1, sessions: "not-an-array" });
    writeFileSync(path, invalid);
    const store = new SessionIdentityStore(devDir);

    expect(() => store.restore([])).toThrow("session identity persistence");
    expect(readFileSync(path, "utf-8")).toBe(invalid);
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

  test("supports tab-private memory mode without writing identity metadata", () => {
    const devDir = tmpDevDir();
    const store = new SessionIdentityStore(devDir, "memory");
    store.capture({
      wolfpackSessionId: "broker-memory",
      wolfpackSessionName: "private",
      projectPath: join(devDir, "private"),
      agentKind: "shell",
    });
    expect(store.getByName("private")?.wolfpackSessionId).toBe("broker-memory");
    expect(existsSync(sessionIdentityStorePath(devDir))).toBe(false);
  });

  test("writes durable identity files owner-only", () => {
    const devDir = tmpDevDir();
    const store = new SessionIdentityStore(devDir, "private");
    store.capture({
      wolfpackSessionId: "broker-private",
      wolfpackSessionName: "private",
      projectPath: join(devDir, "private"),
      agentKind: "shell",
    });
    expect(statSync(sessionIdentityStorePath(devDir)).mode & 0o777).toBe(0o600);
  });

  test("exposes context and parent env vars for launched agents", () => {
    const vars = new Map(identityEnvVars({
      wolfpackSessionName: "alpha-sub-agent",
      projectPath: "/repo/alpha",
      agentKind: "codex",
      parentSession: {
        wolfpackSessionId: "broker-parent",
        wolfpackSessionName: "alpha",
      },
    }));
    expect(vars.get("WOLFPACK_SESSION_NAME")).toBe("alpha-sub-agent");
    expect(vars.get("WOLFPACK_PROJECT_DIR")).toBe("/repo/alpha");
    expect(vars.get("WOLFPACK_AGENT_KIND")).toBe("codex");
    expect(vars.get("WOLFPACK_PARENT_SESSION_ID")).toBe("broker-parent");
    expect(vars.get("WOLFPACK_PARENT_SESSION_NAME")).toBe("alpha");
    expect(vars.get("WOLFPACK_EXTERNAL_AGENT_ID_FILE")).toBe("/repo/alpha/.wolfpack/external-agent-id");
  });
});
