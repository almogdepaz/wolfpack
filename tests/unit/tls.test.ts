import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureSelfSignedCert } from "../../src/tls.ts";

describe("ensureSelfSignedCert", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wolfpack-tls-test-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("generates cert and key files", () => {
    const result = ensureSelfSignedCert(dir);
    expect(result).not.toBeNull();
    expect(result!.cert.length).toBeGreaterThan(0);
    expect(result!.key.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "cert.pem"))).toBe(true);
    expect(existsSync(join(dir, "key.pem"))).toBe(true);
  });

  test("reuses existing cert on second call", () => {
    const first = ensureSelfSignedCert(dir);
    const second = ensureSelfSignedCert(dir);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Same cert content — not regenerated
    expect(first!.cert.toString()).toBe(second!.cert.toString());
    expect(first!.key.toString()).toBe(second!.key.toString());
  });

  test("returns null when openssl is unavailable", () => {
    // Point to a nonexistent dir with no write perms to force failure
    const badDir = "/nonexistent/path/that/cannot/be/created";
    const result = ensureSelfSignedCert(badDir);
    expect(result).toBeNull();
  });
});
