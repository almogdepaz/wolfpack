import { describe, expect, test } from "bun:test";
import { resolveSessionSelector } from "../../src/server/session-selector.ts";
import type { PublicSessionIdentity } from "../../src/server/session-identity.ts";

function identity(name: string, id: string): PublicSessionIdentity {
  return {
    wolfpackSessionId: id,
    wolfpackSessionName: name,
    projectPath: `/dev/${name}`,
    agentKind: "pi",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

const identities = {
  alpha: identity("alpha", "id-alpha"),
  beta: identity("beta", "id-beta"),
};

describe("session selector resolution", () => {
  test("resolves active names and opaque ids to canonical identity", () => {
    expect(resolveSessionSelector("alpha", ["alpha", "beta"], identities)).toEqual({
      ok: true,
      name: "alpha",
      identity: identities.alpha,
    });
    expect(resolveSessionSelector("id-beta", ["alpha", "beta"], identities)).toEqual({
      ok: true,
      name: "beta",
      identity: identities.beta,
    });
  });

  test("rejects unknown and ambiguous selectors", () => {
    expect(resolveSessionSelector("missing", ["alpha", "beta"], identities)).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    const ambiguous = {
      ...identities,
      "id-beta": identity("id-beta", "id-other"),
    };
    expect(resolveSessionSelector("id-beta", ["id-beta", "beta"], ambiguous)).toEqual({
      ok: false,
      code: "AMBIGUOUS",
    });
  });
});
