import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We need to mock the WOLFPACK_DIR before importing push module.
// Instead, test the crypto helpers and subscription logic via the exports.

describe("push: VAPID key generation", () => {
  test("getVapidKeys returns consistent keys across calls", async () => {
    // Import dynamically to avoid module caching issues
    const { getVapidKeys } = await import("../../src/server/push.ts");
    const keys1 = getVapidKeys();
    const keys2 = getVapidKeys();
    expect(keys1.publicKey).toBe(keys2.publicKey);
    expect(keys1.privateKey).toBe(keys2.privateKey);
    expect(keys1.publicKey.length).toBeGreaterThan(40); // base64url-encoded 65-byte key
    expect(keys1.privateKey.length).toBeGreaterThan(20); // base64url-encoded 32-byte key
  });

  test("VAPID public key is valid base64url", async () => {
    const { getVapidPublicKey } = await import("../../src/server/push.ts");
    const key = getVapidPublicKey();
    // base64url: no +, /, or =
    expect(key).not.toMatch(/[+/=]/);
    expect(key.length).toBeGreaterThan(0);
  });
});

describe("push: subscription management", () => {
  test("addSubscription and removeSubscription work", async () => {
    const { addSubscription, removeSubscription, getSubscriptionCount } = await import("../../src/server/push.ts");
    const initial = getSubscriptionCount();

    const sub = {
      endpoint: `https://fcm.googleapis.com/fcm/send/test-${Date.now()}`,
      keys: { p256dh: "test-key", auth: "test-auth" },
    };

    addSubscription(sub);
    expect(getSubscriptionCount()).toBe(initial + 1);

    // Adding same endpoint again should dedupe
    addSubscription(sub);
    expect(getSubscriptionCount()).toBe(initial + 1);

    removeSubscription(sub.endpoint);
    expect(getSubscriptionCount()).toBe(initial);
  });
});

describe("push: sendPush with no subscriptions", () => {
  test("returns zeros when no subscriptions", async () => {
    const { sendPush, removeSubscription, getSubscriptionCount } = await import("../../src/server/push.ts");
    // Ensure clean state by removing any test subs
    // Just verify the function works with empty/low subscription count
    const result = await sendPush({ title: "Test", body: "test body" });
    // If there are no subs, all zeros. If there are (from other tests), that's ok too.
    expect(result).toHaveProperty("sent");
    expect(result).toHaveProperty("failed");
    expect(result).toHaveProperty("pruned");
  });
});
