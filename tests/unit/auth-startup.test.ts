/**
 * Regression tests for the JWT auth startup contract — must not fail open
 * when the secret is absent or too short.
 *
 * Contract:
 *   - WOLFPACK_JWT_SECRET set, ≥32 chars  →  enforce auth ("ok")
 *   - WOLFPACK_JWT_SECRET set, <32 chars  →  refuse to start ("invalid")
 *   - WOLFPACK_JWT_SECRET unset           →  log an informational security notice and continue ("missing")
 *
 * The "invalid" case is the dangerous one — without this check, a typo
 * (e.g. setting the var to something short) silently disables all auth.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { getJwtAuthConfig, verifyJwtAuthAtStartup } from "../../src/auth.ts";

describe("server startup JWT notice", () => {
  test("logs an informational notice when JWT is intentionally unset", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-no-jwt-"));
    try {
      const result = spawnSync(process.execPath, ["-e", `
        const { startServer, server } = await import("${join(process.cwd(), "src/server/index.ts")}");
        await startServer(0);
        await new Promise((resolve) => server.once("listening", resolve));
        await new Promise((resolve) => server.close(resolve));
      `], {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          WOLFPACK_TEST: "1",
          WOLFPACK_LOG_LEVEL: "info",
          WOLFPACK_JWT_SECRET: "",
        },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("WOLFPACK_JWT_SECRET is not set");
      expect(result.stdout).toContain('"level":"info"');
      expect(result.stdout).toContain("WOLFPACK_JWT_SECRET is not set");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("getJwtAuthConfig — present/enabled distinction", () => {
  test("missing secret: present=false, enabled=false", () => {
    const cfg = getJwtAuthConfig({});
    expect(cfg.present).toBe(false);
    expect(cfg.enabled).toBe(false);
    expect(cfg.invalidReason).toBeUndefined();
  });

  test("empty-string secret behaves like missing", () => {
    const cfg = getJwtAuthConfig({ WOLFPACK_JWT_SECRET: "" });
    expect(cfg.present).toBe(false);
    expect(cfg.enabled).toBe(false);
  });

  test("whitespace-only secret behaves like missing", () => {
    const cfg = getJwtAuthConfig({ WOLFPACK_JWT_SECRET: "    " });
    expect(cfg.present).toBe(false);
    expect(cfg.enabled).toBe(false);
  });

  test("short secret: present=true, enabled=false, invalidReason set", () => {
    const cfg = getJwtAuthConfig({ WOLFPACK_JWT_SECRET: "tooshort" });
    expect(cfg.present).toBe(true);
    expect(cfg.enabled).toBe(false);
    expect(cfg.invalidReason).toContain("too short");
  });

  test("31-char secret: still rejected (boundary -1)", () => {
    const cfg = getJwtAuthConfig({ WOLFPACK_JWT_SECRET: "a".repeat(31) });
    expect(cfg.enabled).toBe(false);
    expect(cfg.invalidReason).toBeDefined();
  });

  test("32-char secret: accepted (boundary)", () => {
    const cfg = getJwtAuthConfig({ WOLFPACK_JWT_SECRET: "a".repeat(32) });
    expect(cfg.enabled).toBe(true);
    expect(cfg.present).toBe(true);
    expect(cfg.invalidReason).toBeUndefined();
  });

  test("long secret: accepted", () => {
    const cfg = getJwtAuthConfig({
      WOLFPACK_JWT_SECRET: "wolfpack-test-secret-long-enough-for-validation",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.present).toBe(true);
  });
});

describe("verifyJwtAuthAtStartup — startup classifier", () => {
  test("returns 'invalid' when secret is set but too short", () => {
    const cfg = getJwtAuthConfig({ WOLFPACK_JWT_SECRET: "x" });
    expect(verifyJwtAuthAtStartup(cfg)).toBe("invalid");
  });

  test("returns 'missing' when secret is unset", () => {
    const cfg = getJwtAuthConfig({});
    expect(verifyJwtAuthAtStartup(cfg)).toBe("missing");
  });

  test("returns 'ok' when secret is valid", () => {
    const cfg = getJwtAuthConfig({ WOLFPACK_JWT_SECRET: "a".repeat(32) });
    expect(verifyJwtAuthAtStartup(cfg)).toBe("ok");
  });

  test("CRITICAL invariant: 'invalid' must NEVER coincide with enabled=true", () => {
    // The whole point of the fail-hard check: if startup says "invalid",
    // there's no way auth is silently enforcing nothing.
    for (const secret of ["", "x", "short", "a".repeat(31)]) {
      const cfg = getJwtAuthConfig({ WOLFPACK_JWT_SECRET: secret });
      const status = verifyJwtAuthAtStartup(cfg);
      if (status === "invalid") {
        expect(cfg.enabled).toBe(false);
      }
    }
  });
});
