import { describe, expect, test } from "bun:test";
import { composeRouteFamilies, routeFamilyFor, splitRouteFamilies } from "../../src/server/route-families";
import { routeFamilies, routes } from "../../src/server/routes";

describe("server route families", () => {
  test("partitions authority and operability paths without dropping facade routes", () => {
    expect(routeFamilyFor("GET /metrics")).toBe("operability");
    expect(routeFamilyFor("POST /api/auth/ws-ticket")).toBe("authority");
    expect(routeFamilyFor("POST /api/session-control/send")).toBe("sessions");
    expect(Object.keys(composeRouteFamilies(routeFamilies)).sort()).toEqual(Object.keys(routes).sort());
  });
  test("rejects duplicate keys while composing families", () => {
    const families = splitRouteFamilies({ "GET /": 1 });
    families.sessions["GET /"] = 2;
    expect(() => composeRouteFamilies(families)).toThrow("duplicate route");
  });
});
