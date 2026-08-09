import { describe, expect, test } from "bun:test";
import { sameOriginPushUrl } from "../../src/push-subscription-origin.ts";

describe("per-origin push enrollment", () => {
  test("builds service-worker and subscription URLs only for the visited origin", () => {
    expect(sameOriginPushUrl("https://phone.example.ts.net", "/sw.js")).toBe("https://phone.example.ts.net/sw.js");
    expect(sameOriginPushUrl("https://phone.example.ts.net", "/api/push/subscribe")).toBe("https://phone.example.ts.net/api/push/subscribe");
  });

  test("rejects a peer origin so one host cannot enroll another host subscription", () => {
    expect(() => sameOriginPushUrl(
      "https://phone.example.ts.net",
      "https://laptop.example.ts.net/api/push/subscribe",
    )).toThrow("same origin");
  });
});
