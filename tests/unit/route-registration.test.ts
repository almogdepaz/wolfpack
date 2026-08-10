import { describe, expect, test } from "bun:test";
import * as routeModule from "../../src/server/routes";

describe("server route registration", () => {
  test("exposes one production route map with representative handlers", () => {
    expect(Object.keys(routeModule)).not.toContain("routeFamilies");

    for (const route of [
      "GET /",
      "GET /api/sessions",
      "GET /api/backend",
      "GET /api/tailnet/v1/candidates",
      "GET /api/health",
      "POST /api/auth/ws-ticket",
    ]) {
      expect(routeModule.routes[route], route).toBeFunction();
    }
  });
});
