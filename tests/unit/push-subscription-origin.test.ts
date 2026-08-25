import { describe, expect, test } from "bun:test";
import {
  PUSH_API_PATH,
  requestSameOriginPushApi,
  sameOriginPushUrl,
} from "../../src/push-subscription-origin.ts";

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

  test("routes push API requests through same-origin authenticated fetch with init preserved", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const request = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return new Response("ok");
    };
    const subscribeInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "endpoint" }),
    };
    const unsubscribeInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "endpoint" }),
    };

    await requestSameOriginPushApi(request, "https://phone.example.ts.net", PUSH_API_PATH.vapidKey);
    await requestSameOriginPushApi(request, "https://phone.example.ts.net", PUSH_API_PATH.subscribe, subscribeInit);
    await requestSameOriginPushApi(request, "https://phone.example.ts.net", PUSH_API_PATH.unsubscribe, unsubscribeInit);

    expect(calls).toEqual([
      { url: "https://phone.example.ts.net/api/push/vapid-key", init: undefined },
      { url: "https://phone.example.ts.net/api/push/subscribe", init: subscribeInit },
      { url: "https://phone.example.ts.net/api/push/unsubscribe", init: unsubscribeInit },
    ]);
  });
});
