/**
 * Regression tests for the JWT auth startup contract (issues.md CRITICAL —
 * "JWT auth fails open when secret is absent or short").
 *
 * Contract:
 *   - WOLFPACK_JWT_SECRET set, ≥32 chars  →  enforce auth ("ok")
 *   - WOLFPACK_JWT_SECRET set, <32 chars  →  refuse to start ("invalid")
 *   - WOLFPACK_JWT_SECRET unset           →  log ERROR, continue ("missing")
 *
 * The "invalid" case is the dangerous one — without this check, a typo
 * (e.g. setting the var to something short) silently disables all auth.
 */
import { describe, expect, test } from "bun:test";
import { getJwtAuthConfig, verifyJwtAuthAtStartup } from "../../src/auth.ts";

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
