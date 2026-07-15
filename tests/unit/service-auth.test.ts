import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyServiceAuthFile,
  prepareServiceAuthFile,
} from "../../src/cli/service-auth.ts";

let fixtureDir = "";

function credentialPath(): string {
  fixtureDir = mkdtempSync(join(tmpdir(), "wolfpack-service-auth-"));
  return join(fixtureDir, "service-auth.json");
}

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = "";
});

describe("service JWT credential persistence", () => {
  test("persists all effective auth settings privately and restores them in a clean service environment", () => {
    const path = credentialPath();
    const secret = "service-secret-with-at-least-32-characters";

    expect(prepareServiceAuthFile(path, {
      WOLFPACK_JWT_SECRET: secret,
      WOLFPACK_JWT_ISSUER: "wolfpack-issuer",
      WOLFPACK_JWT_AUDIENCE: "wolfpack-audience",
      WOLFPACK_JWT_CLOCK_TOLERANCE_SEC: "45",
    })).toBe("written");
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const serviceEnv: NodeJS.ProcessEnv = {};
    expect(applyServiceAuthFile(path, serviceEnv)).toBe(true);
    expect(serviceEnv).toEqual({
      WOLFPACK_JWT_SECRET: secret,
      WOLFPACK_JWT_ISSUER: "wolfpack-issuer",
      WOLFPACK_JWT_AUDIENCE: "wolfpack-audience",
      WOLFPACK_JWT_CLOCK_TOLERANCE_SEC: "45",
    });
  });

  test("reinstall without shell credentials preserves an existing valid service credential", () => {
    const path = credentialPath();
    const secret = "service-secret-with-at-least-32-characters";
    prepareServiceAuthFile(path, { WOLFPACK_JWT_SECRET: secret });
    const before = readFileSync(path, "utf-8");

    expect(prepareServiceAuthFile(path, {})).toBe("preserved");
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  test("rejects a short configured secret without replacing an existing credential", () => {
    const path = credentialPath();
    const secret = "service-secret-with-at-least-32-characters";
    prepareServiceAuthFile(path, { WOLFPACK_JWT_SECRET: secret });
    const before = readFileSync(path, "utf-8");

    expect(() => prepareServiceAuthFile(path, { WOLFPACK_JWT_SECRET: "too-short" })).toThrow(
      "too short",
    );
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  test("fails closed when a configured credential file is missing", () => {
    const path = credentialPath();

    expect(() => applyServiceAuthFile(path, {})).toThrow("not found");
  });

  test("refuses to load a credential file readable by other users", () => {
    const path = credentialPath();
    writeFileSync(path, JSON.stringify({
      WOLFPACK_JWT_SECRET: "service-secret-with-at-least-32-characters",
    }));
    chmodSync(path, 0o644);

    expect(() => applyServiceAuthFile(path, {})).toThrow("permissions");
  });
});
