import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { issueJwt } from "../../src/cli/api.ts";
import { validateJwtHs256 } from "../../src/auth.ts";

const keys = ["WOLFPACK_JWT_SECRET", "WOLFPACK_JWT_ISSUER", "WOLFPACK_JWT_AUDIENCE", "NO_COLOR"] as const;
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe("JWT issuance", () => {
  test("issues a short-lived unique token accepted by the existing verifier", () => {
    const secret = "characterization-secret-with-at-least-32-characters";
    process.env.WOLFPACK_JWT_SECRET = secret;
    process.env.WOLFPACK_JWT_ISSUER = " wolfpack ";
    process.env.WOLFPACK_JWT_AUDIENCE = " owner ";
    const token = issueJwt()!;
    const result = validateJwtHs256(token, secret, { issuer: "wolfpack", audience: "owner" });
    expect(result.ok).toBe(true);
    expect(Number(result.payload?.exp) - Number(result.payload?.iat)).toBe(60);
    expect(result.payload?.jti).toMatch(/^[a-f0-9]{16}$/);
    expect(issueJwt()).not.toBe(token);
  });

  test("omits absent credentials and warns only once for a short secret", () => {
    delete process.env.WOLFPACK_JWT_SECRET;
    expect(issueJwt()).toBeNull();
    process.env.WOLFPACK_JWT_SECRET = "short";
    process.env.NO_COLOR = "1";
    const write = spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(issueJwt()).toBeNull();
      expect(issueJwt()).toBeNull();
      expect(write.mock.calls).toEqual([["  WOLFPACK_JWT_SECRET is set but only 5 chars; >=32 required. Sending unauthenticated; expect 401.\n"]]);
    } finally { write.mockRestore(); }
  });
});
