import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { createECDH, createVerify, createPublicKey, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServerContext } from "../../src/server/context.ts";
import { MockBackend } from "../../src/server/mock-backend.ts";
import { createPushFixture } from "./fixtures/push-service-fixture.ts";
import * as pushCrypto from "../../src/server/push.ts";
const pushFixture = createPushFixture();
beforeEach(() => pushFixture.reset());
afterAll(() => pushFixture.close());
process.env.WOLFPACK_TEST = "1";



// Exercise real crypto and storage with an independently owned push service.

test("push services isolate storage, rate limits and delivery; closing one preserves the other", async () => {
  const first = createPushFixture(), second = createPushFixture();
  const a = createServerContext({ backend: new MockBackend(), push: first.service });
  const b = createServerContext({ backend: new MockBackend(), push: second.service });
  let now = 1_000_000;
  first.dependencies.now = second.dependencies.now = () => now;
  const sends: string[] = [];
  first.dependencies.sender = async () => { sends.push("first"); return { sent: 1, failed: 0, pruned: 0 }; };
  second.dependencies.sender = async () => { sends.push("second"); return { sent: 1, failed: 0, pruned: 0 }; };
  const endpoint = "https://fcm.googleapis.com/owned-service";
  const fact = { name: "agent", identity: { wolfpackSessionId: "same-id" },
    quietAlert: { kind: "quiet" as const, sessionId: "same-id", episodeId: "same-episode", eligibleAtMs: now, observedAtMs: now } };
  try {
    a.push.addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    expect(a.push.getSubscriptionCount()).toBe(1);
    expect(b.push.getSubscriptionCount()).toBe(0);
    expect(a.push.getVapidPublicKey()).not.toBe(b.push.getVapidPublicKey());
    for (let i = 0; i < 10; i++) expect(a.push.checkNotifyRateLimit()).toBeNull();
    expect(a.push.checkNotifyRateLimit()).toBe("rate limit exceeded (10/min)");
    expect(b.push.checkNotifyRateLimit()).toBeNull();
    now += 60_000;
    expect(a.push.checkNotifyRateLimit()).toBeNull();
    a.push.recordQuietAlertEmission("same-id", "same-episode");
    await a.push.checkSessionTransitions([fact]);
    await a.push.checkSessionTransitions([fact]);
    expect(sends).toEqual(["first"]);
    await a.close();
    b.push.addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    b.push.recordQuietAlertEmission("same-id", "same-episode");
    await b.push.checkSessionTransitions([fact]);
    expect(sends).toEqual(["first", "second"]);
    expect(b.push.getSubscriptionCount()).toBe(1);
  } finally { await a.close(); await b.close(); first.close(); second.close(); }
});

describe("push: VAPID key generation", () => {
  test("getVapidKeys returns consistent keys across calls", async () => {
    // Import dynamically to avoid module caching issues

    const keys1 = pushFixture.service.getVapidKeys();
    const keys2 = pushFixture.service.getVapidKeys();
    expect(keys1.publicKey).toBe(keys2.publicKey);
    expect(keys1.privateKey).toBe(keys2.privateKey);
    expect(keys1.publicKey.length).toBeGreaterThan(40); // base64url-encoded 65-byte key
    expect(keys1.privateKey.length).toBeGreaterThan(20); // base64url-encoded 32-byte key
  });

  test("VAPID public key is valid base64url", async () => {

    const key = pushFixture.service.getVapidPublicKey();
    // base64url: no +, /, or =
    expect(key).not.toMatch(/[+/=]/);
    expect(key.length).toBeGreaterThan(0);
  });
});

describe("push: subscription management", () => {
  test("addSubscription and removeSubscription work", async () => {

    const initial = pushFixture.service.getSubscriptionCount();

    const sub = {
      endpoint: `https://fcm.googleapis.com/fcm/send/test-${Date.now()}`,
      keys: { p256dh: "test-key", auth: "test-auth" },
    };

    pushFixture.service.addSubscription(sub);
    expect(pushFixture.service.getSubscriptionCount()).toBe(initial + 1);

    // Adding same endpoint again should dedupe
    pushFixture.service.addSubscription(sub);
    expect(pushFixture.service.getSubscriptionCount()).toBe(initial + 1);

    pushFixture.service.removeSubscription(sub.endpoint);
    expect(pushFixture.service.getSubscriptionCount()).toBe(initial);
  });
});

describe("push: subscription persistence initialization", () => {
  test("creates the private Wolfpack directory on the first subscription", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-push-first-subscription-"));
    const script = `
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const pushFixture = { service: (await import("./src/server/push.ts")).createPushService() };
      pushFixture.service.addSubscription({ endpoint: "https://fcm.googleapis.com/first-subscription", keys: { p256dh: "key", auth: "auth" } });
      console.log(readFileSync(join(process.env.HOME, ".wolfpack", "push-subscriptions.json"), "utf-8"));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, WOLFPACK_DIR: join(home, ".wolfpack") },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toContain("first-subscription");
  });
});

describe("push: corrupt subscription persistence", () => {
  test("refuses to replace malformed persisted subscriptions", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-push-corrupt-"));
    const script = `
      const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const path = join(process.env.HOME, ".wolfpack", "push-subscriptions.json");
      mkdirSync(join(process.env.HOME, ".wolfpack"), { recursive: true });
      writeFileSync(path, "{not-json");
      const pushFixture = { service: (await import("./src/server/push.ts")).createPushService() };
      try {
        pushFixture.service.addSubscription({ endpoint: "https://fcm.googleapis.com/corrupt-test", keys: { p256dh: "key", auth: "auth" } });
        console.log("unexpected-success");
      } catch (error) {
        console.log(String(error));
      }
      console.log("content=" + readFileSync(path, "utf-8"));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, WOLFPACK_DIR: join(home, ".wolfpack") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = child.stdout.toString();
    expect(child.exitCode).toBe(0);
    expect(output).toContain("push subscription persistence");
    expect(output).toContain("content={not-json");
    expect(output).not.toContain("unexpected-success");
  });
});

describe("push: notification payload routing", () => {
  test("routes an explicit notification to a bounded stable session target", async () => {
    const { buildAgentNotificationPayload } = await import("../../src/server/push.ts");

    expect(buildAgentNotificationPayload("ready for review", {
      sessionId: "stable-parent-id",
      sessionName: "parent-agent",
    })).toEqual({
      title: "Wolfpack",
      body: "ready for review",
      tag: "wolfpack-notify",
      url: "/?sessionId=stable-parent-id&session=parent-agent&machine=local",
    });
  });
});

describe("push: sendPush with no subscriptions", () => {
  test("returns zeros when no subscriptions", async () => {

    const result = await pushFixture.service.sendPush({ title: "Test", body: "test body" });
    expect(result).toHaveProperty("sent");
    expect(result).toHaveProperty("failed");
    expect(result).toHaveProperty("pruned");
  });
});

describe("push: crypto round-trip", () => {
  test("VAPID JWT has valid ES256 signature", async () => {

    const vapid = pushFixture.service.getVapidKeys();
    const jwt = pushCrypto.createVapidJwt("https://fcm.googleapis.com", "mailto:test@localhost", vapid);

    const parts = jwt.split(".");
    expect(parts.length).toBe(3);

    // Verify the signature with the public key
    const unsigned = `${parts[0]}.${parts[1]}`;
    const sigBuf = pushCrypto.b64urlDecode(parts[2]);
    expect(sigBuf.length).toBe(64); // raw r||s

    // Convert raw r||s back to DER for verification
    // DER INTEGERs are minimal: drop leading zero bytes, then re-add one if the high bit is set.
    const derInteger = (raw: Buffer): Buffer => {
      let start = 0;
      while (start < raw.length - 1 && raw[start] === 0) start++;
      const trimmed = raw.subarray(start);
      return trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0x00]), trimmed]) : trimmed;
    };
    const rDer = derInteger(sigBuf.subarray(0, 32));
    const sDer = derInteger(sigBuf.subarray(32, 64));
    const derInner = Buffer.concat([
      Buffer.from([0x02, rDer.length]), rDer,
      Buffer.from([0x02, sDer.length]), sDer,
    ]);
    const derSig = Buffer.concat([Buffer.from([0x30, derInner.length]), derInner]);

    // Build JWK public key for verification
    const pubBuf = pushCrypto.b64urlDecode(vapid.publicKey);
    expect(pubBuf.length).toBe(65); // uncompressed P-256
    const pubKey = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: pushCrypto.b64urlEncode(pubBuf.subarray(1, 33)),
        y: pushCrypto.b64urlEncode(pubBuf.subarray(33, 65)),
      },
      format: "jwk",
    });

    const verifier = createVerify("SHA256");
    verifier.update(unsigned);
    const valid = verifier.verify(pubKey, derSig);
    expect(valid).toBe(true);

    // Verify JWT payload
    const payload = JSON.parse(pushCrypto.b64urlDecode(parts[1]).toString());
    expect(payload.aud).toBe("https://fcm.googleapis.com");
    expect(payload.sub).toBe("mailto:test@localhost");
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test("encryptPayload produces valid aes128gcm structure", async () => {


    // Create a fake client subscription with real ECDH keys
    const clientEcdh = createECDH("prime256v1");
    clientEcdh.generateKeys();
    const clientPub = pushCrypto.b64urlEncode(clientEcdh.getPublicKey() as Buffer);
    const { randomBytes } = await import("node:crypto");
    const clientAuth = pushCrypto.b64urlEncode(randomBytes(16));

    const sub = {
      endpoint: "https://fcm.googleapis.com/fcm/send/test",
      keys: { p256dh: clientPub, auth: clientAuth },
    };

    const payload = Buffer.from(JSON.stringify({ title: "Test", body: "hello" }));
    const { body, salt, serverPub } = pushCrypto.encryptPayload(payload, sub);

    // Verify aes128gcm header structure: salt(16) + rs(4) + idlen(1) + keyid(65)
    expect(salt.length).toBe(16);
    expect(serverPub.length).toBe(65);

    // Parse header from body
    const headerSalt = body.subarray(0, 16);
    expect(Buffer.compare(headerSalt, salt)).toBe(0);

    const rs = body.readUInt32BE(16);
    expect(rs).toBe(4096);

    const idlen = body[20];
    expect(idlen).toBe(65);

    const keyid = body.subarray(21, 21 + 65);
    expect(Buffer.compare(keyid, serverPub)).toBe(0);

    // Ciphertext follows the header (86 bytes)
    const ciphertext = body.subarray(86);
    expect(ciphertext.length).toBeGreaterThan(0);
  });

  test("encryptPayload reproduces the RFC 8291 Appendix A example body", async () => {

    // RFC 8291 section 5 and Appendix A (rfc-editor.org/rfc/rfc8291).
    const serverEcdh = createECDH("prime256v1");
    serverEcdh.setPrivateKey(pushCrypto.b64urlDecode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"));
    expect(pushCrypto.b64urlEncode(serverEcdh.getPublicKey() as Buffer))
      .toBe("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
    const sub = {
      endpoint: "https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV",
      keys: {
        p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        auth: "BTBZMqHH6r4Tts7J_aSIgg",
      },
    };

    const { body } = pushCrypto.encryptPayload(Buffer.from("When I grow up, I want to be a watermelon"), sub, {
      serverEcdh,
      salt: pushCrypto.b64urlDecode("DGv6ra1nlYgDCS1FRnbzlw"),
    });

    // 86-byte header + 42-byte padded plaintext + 16-byte tag. (The example's
    // Content-Length header says 145; its base64url body decodes to 144.)
    expect(body.length).toBe(144);
    expect(pushCrypto.b64urlEncode(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"
      + "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT"
      + "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });
});

// ── Validation tests ──

describe("push: validateSubscription", () => {
  // Generate valid keys once
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const p256dh = (ecdh.getPublicKey() as Buffer).toString("base64url");
  const auth = randomBytes(16).toString("base64url");

  test("rejects http:// endpoints (SSRF prevention)", async () => {
    const { validateSubscription } = await import("../../src/server/push.ts");
    const err = validateSubscription({
      endpoint: "http://localhost:8080/push",
      keys: { p256dh, auth },
    });
    expect(err).toBe("endpoint must use HTTPS");
  });

  test("rejects file:// endpoints", async () => {
    const { validateSubscription } = await import("../../src/server/push.ts");
    const err = validateSubscription({
      endpoint: "file:///etc/passwd",
      keys: { p256dh, auth },
    });
    expect(err).toBe("endpoint must use HTTPS");
  });

  test("accepts valid https:// endpoint", async () => {
    const { validateSubscription } = await import("../../src/server/push.ts");
    const err = validateSubscription({
      endpoint: "https://fcm.googleapis.com/fcm/send/valid",
      keys: { p256dh, auth },
    });
    expect(err).toBeNull();
  });

  test("rejects endpoint over 1024 chars", async () => {
    const { validateSubscription } = await import("../../src/server/push.ts");
    const err = validateSubscription({
      endpoint: "https://fcm.googleapis.com/" + "a".repeat(1010),
      keys: { p256dh, auth },
    });
    expect(err).toBe("endpoint too long");
  });

  test("rejects non-push-service host (SSRF prevention)", async () => {
    const { validateSubscription } = await import("../../src/server/push.ts");
    const err = validateSubscription({
      endpoint: "https://evil.com/push",
      keys: { p256dh, auth },
    });
    expect(err).toBe("endpoint host not recognized as a push service");
  });

  test("rejects subdomain of allowlisted push host (exact-match allowlist)", async () => {
    const { validateSubscription } = await import("../../src/server/push.ts");
    const err = validateSubscription({
      endpoint: "https://attacker.fcm.googleapis.com/push",
      keys: { p256dh, auth },
    });
    expect(err).toBe("endpoint host not recognized as a push service");
  });

  test("rejects suffix-match attack (attacker-fcm.googleapis.com)", async () => {
    const { validateSubscription } = await import("../../src/server/push.ts");
    const err = validateSubscription({
      endpoint: "https://attacker-fcm.googleapis.com/push",
      keys: { p256dh, auth },
    });
    expect(err).toBe("endpoint host not recognized as a push service");
  });
});

// ── Subscription cap test ──

describe("push: subscription cap", () => {
  test("rejects new subscriptions beyond MAX_SUBSCRIPTIONS (20)", async () => {

    const initial = pushFixture.service.getSubscriptionCount();
    const added: string[] = [];

    try {
      // Fill up to 20
      for (let i = initial; i < 20; i++) {
        const ep = `https://fcm.googleapis.com/cap-test-${i}-${Date.now()}`;
        const result = pushFixture.service.addSubscription({ endpoint: ep, keys: { p256dh: "k", auth: "a" } });
        expect(result.ok).toBe(true);
        added.push(ep);
      }
      expect(pushFixture.service.getSubscriptionCount()).toBe(20);

      // 21st should fail
      const result = pushFixture.service.addSubscription({
        endpoint: `https://fcm.googleapis.com/cap-test-overflow-${Date.now()}`,
        keys: { p256dh: "k", auth: "a" },
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("limit");
      expect(pushFixture.service.getSubscriptionCount()).toBe(20);

      // Updating existing endpoint should still work (dedupe path)
      const updateResult = pushFixture.service.addSubscription({ endpoint: added[0], keys: { p256dh: "updated", auth: "a" } });
      expect(updateResult.ok).toBe(true);
      expect(pushFixture.service.getSubscriptionCount()).toBe(20);
    } finally {
      // Always clean up persisted entries — otherwise a mid-test assertion
      // failure leaves garbage in ~/.wolfpack/push-subscriptions.json.
      for (const ep of added) pushFixture.service.removeSubscription(ep);
    }
  });
});

// ── Rate limit tests ──

describe("push: checkNotifyRateLimit", () => {
  beforeEach(async () => {

    pushFixture.reset();
  });

  test("allows 10 calls then rejects", async () => {

    for (let i = 0; i < 10; i++) {
      expect(pushFixture.service.checkNotifyRateLimit()).toBeNull();
    }
    expect(pushFixture.service.checkNotifyRateLimit()).toBe("rate limit exceeded (10/min)");
  });

  test("resets after timestamps expire", async () => {

    // Fill with timestamps from 61s ago (expired)
    const now = Date.now();
    pushFixture.dependencies.now = () => now - 61_000;
    for (let i = 0; i < 10; i++) expect(pushFixture.service.checkNotifyRateLimit()).toBeNull();
    pushFixture.dependencies.now = () => now;
    expect(pushFixture.service.checkNotifyRateLimit()).toBeNull();
  });
});

// ── State transition + debounce tests ──

describe("push: delivery deadline", () => {
  test("retries a transient delivery failure without redelivering after success", async () => {

    const statuses = [503, 201];
    const client = createECDH("prime256v1");
    client.generateKeys();
    let calls = 0;
    const fetcher = async (): Promise<Response> => {
      calls++;
      return new Response(null, { status: statuses.shift() ?? 500 });
    };

    const status = await pushCrypto.sendSubscriptionWithRetry(
      {
        endpoint: "https://fcm.googleapis.com/retry-test",
        keys: {
          p256dh: pushCrypto.b64urlEncode(client.getPublicKey() as Buffer),
          auth: pushCrypto.b64urlEncode(Buffer.alloc(16, 2)),
        },
      },
      Buffer.from("payload"),
      pushFixture.service.getVapidKeys(),
      fetcher,
      async () => {},
    );

    expect(status).toBe(201);
    expect(calls).toBe(2);
  });

  test("a never-resolving fetch is rejected within the configured deadline", async () => {

    const started = Date.now();
    const stalledFetch = async (): Promise<Response> => new Promise(() => {});

    await expect(pushCrypto.fetchWithDeadline(
      "https://fcm.googleapis.com/stalled",
      {},
      10,
      stalledFetch,
    )).rejects.toMatchObject({ code: "PUSH_DELIVERY_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("the production push deadline is positive and bounded", async () => {

    expect(pushCrypto.PUSH_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(pushCrypto.PUSH_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("push: checkSessionTransitions", () => {
  const sessionId = "stable-id";
  const quietAlert = (episodeId = "episode-one") => {
    const eligibleAtMs = Date.now() + 1;
    return {
      kind: "quiet" as const,
      sessionId,
      episodeId,
      eligibleAtMs,
      observedAtMs: eligibleAtMs,
    };
  };
  const session = (episodeId?: string) => {
    const alert = quietAlert(episodeId);
    pushFixture.service.recordQuietAlertEmission(sessionId, alert.episodeId);
    return [{
      name: "agent",
      identity: { wolfpackSessionId: sessionId },
      quietAlert: alert,
    }];
  };

  beforeEach(async () => {

    pushFixture.reset();
  });

  test("does nothing when no subscriptions", async () => {

    if (pushFixture.service.getSubscriptionCount() > 0) return;
    await pushFixture.service.checkSessionTransitions(session());
  });

  test("fails closed without a stable identity or a matching quiet-alert session id", async () => {

    const endpoint = `https://fcm.googleapis.com/untrusted-quiet-${Date.now()}`;
    pushFixture.service.addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    const payloads: unknown[] = [];
    pushFixture.dependencies.sender = async (payload) => {
      payloads.push(payload);
      return { sent: 1, failed: 0, pruned: 0 };
    };
    try {
      await pushFixture.service.checkSessionTransitions([{ name: "same-name", quietAlert: quietAlert() }]);
      await pushFixture.service.checkSessionTransitions([{
        name: "agent",
        identity: { wolfpackSessionId: sessionId },
        quietAlert: { ...quietAlert(), sessionId: "other-session" },
      }]);
      expect(payloads).toEqual([]);
    } finally {
      pushFixture.dependencies.sender = null;
      pushFixture.service.removeSubscription(endpoint);
    }
  });

  test("retries only failed original endpoints and never redelivers successes", async () => {

    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    const first = `https://fcm.googleapis.com/quiet-first-${now}`;
    const second = `https://fcm.googleapis.com/quiet-second-${now}`;
    const later = `https://fcm.googleapis.com/quiet-later-${now}`;
    pushFixture.service.addSubscription({ endpoint: first, keys: { p256dh: "key", auth: "auth" } });
    pushFixture.service.addSubscription({ endpoint: second, keys: { p256dh: "key", auth: "auth" } });
    const targets: string[][] = [];
    const attemptTimes: number[] = [];
    pushFixture.dependencies.sender = async (_payload, endpoints) => {
      targets.push([...endpoints].sort());
      attemptTimes.push(Date.now());
      return targets.length === 1
        ? { sent: 1, failed: 1, pruned: 0, successfulEndpoints: [first], failedEndpoints: [second] }
        : { sent: 1, failed: 0, pruned: 0, successfulEndpoints: [second], failedEndpoints: [] };
    };
    try {
      await pushFixture.service.checkSessionTransitions(session());
      pushFixture.service.addSubscription({ endpoint: later, keys: { p256dh: "key", auth: "auth" } });
      now += pushCrypto.PUSH_DEBOUNCE_MS;
      await pushFixture.service.checkSessionTransitions(session());
      await pushFixture.service.checkSessionTransitions(session());

      expect(targets).toEqual([[first, second].sort(), [second]]);
      expect(attemptTimes[1] - attemptTimes[0]).toBeGreaterThanOrEqual(pushCrypto.PUSH_DEBOUNCE_MS);
    } finally {
      Date.now = originalNow;
      pushFixture.dependencies.sender = null;
      pushFixture.service.removeSubscription(first);
      pushFixture.service.removeSubscription(second);
      pushFixture.service.removeSubscription(later);
    }
  });

  test("stops retrying after three failed attempts", async () => {

    const originalNow = Date.now;
    let now = 2_000_000;
    Date.now = () => now;
    const endpoint = `https://fcm.googleapis.com/quiet-exhaustion-${now}`;
    pushFixture.service.addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    const targets: string[][] = [];
    pushFixture.dependencies.sender = async (_payload, endpoints) => {
      targets.push([...endpoints]);
      return { sent: 0, failed: 1, pruned: 0, successfulEndpoints: [], failedEndpoints: [endpoint] };
    };
    try {
      await pushFixture.service.checkSessionTransitions(session());
      now += pushCrypto.PUSH_DEBOUNCE_MS;
      await pushFixture.service.checkSessionTransitions(session());
      now += pushCrypto.PUSH_DEBOUNCE_MS;
      await pushFixture.service.checkSessionTransitions(session());
      now += pushCrypto.PUSH_DEBOUNCE_MS;
      await pushFixture.service.checkSessionTransitions(session());

      expect(targets).toEqual([[endpoint], [endpoint], [endpoint]]);
    } finally {
      Date.now = originalNow;
      pushFixture.dependencies.sender = null;
      pushFixture.service.removeSubscription(endpoint);
    }
  });

  test("limits automatic quiet delivery to three physical posts at least 30 seconds apart", async () => {

    const originalNow = Date.now;
    const originalFetch = globalThis.fetch;
    let now = 4_000_000;
    Date.now = () => now;
    const client = createECDH("prime256v1");
    client.generateKeys();
    const endpoint = `https://fcm.googleapis.com/quiet-physical-attempts-${now}`;
    const postTimes: number[] = [];
    const failingFetch = Object.assign(
      async (..._args: Parameters<typeof fetch>): Promise<Response> => {
        postTimes.push(Date.now());
        return new Response(null, { status: 503 });
      },
      { preconnect: originalFetch.preconnect },
    );
    globalThis.fetch = failingFetch;
    pushFixture.service.addSubscription({
      endpoint,
      keys: {
        p256dh: pushCrypto.b64urlEncode(client.getPublicKey() as Buffer),
        auth: pushCrypto.b64urlEncode(Buffer.alloc(16, 7)),
      },
    });
    try {
      await pushFixture.service.checkSessionTransitions(session("physical-attempts"));
      now += 30_000;
      await pushFixture.service.checkSessionTransitions(session("physical-attempts"));
      now += 30_000;
      await pushFixture.service.checkSessionTransitions(session("physical-attempts"));

      expect(postTimes).toHaveLength(3);
      expect(postTimes.slice(1).every((time, index) => time - postTimes[index] >= 30_000)).toBe(true);
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
      pushFixture.service.removeSubscription(endpoint);
    }
  });

  test("retires a transport-pruned endpoint registration lifetime after 410", async () => {

    const originalFetch = globalThis.fetch;
    const endpoint = `https://fcm.googleapis.com/quiet-pruned-lifetime-${Date.now()}`;
    const client = createECDH("prime256v1");
    client.generateKeys();
    pushFixture.service.addSubscription({
      endpoint,
      keys: {
        p256dh: pushCrypto.b64urlEncode(client.getPublicKey() as Buffer),
        auth: pushCrypto.b64urlEncode(Buffer.alloc(16, 11)),
      },
    });
    const oldEpisode = "transport-pruned-episode";
    pushFixture.service.recordQuietAlertEmission(sessionId, oldEpisode);
    globalThis.fetch = Object.assign(
      async (..._args: Parameters<typeof fetch>): Promise<Response> => new Response(null, { status: 410 }),
      { preconnect: originalFetch.preconnect },
    );
    try {
      await pushFixture.service.sendPush({ title: "Test", body: "transport prune" });

      pushFixture.service.addSubscription({
        endpoint,
        keys: {
          p256dh: pushCrypto.b64urlEncode(client.getPublicKey() as Buffer),
          auth: pushCrypto.b64urlEncode(Buffer.alloc(16, 11)),
        },
      });
      const targets: string[][] = [];
      pushFixture.dependencies.sender = async (_payload, endpoints) => {
        targets.push([...endpoints]);
        return { sent: endpoints.size, failed: 0, pruned: 0, successfulEndpoints: [...endpoints], failedEndpoints: [] };
      };
      await pushFixture.service.checkSessionTransitions([{
        name: "agent",
        identity: { wolfpackSessionId: sessionId },
        quietAlert: quietAlert(oldEpisode),
      }]);
      expect(targets).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      pushFixture.dependencies.sender = null;
      pushFixture.service.removeSubscription(endpoint);
    }
  });

  test("does not let a stale 410 remove replacement or concurrent registrations", async () => {

    const originalFetch = globalThis.fetch;
    const suffix = Date.now();
    const firstEndpoint = `https://fcm.googleapis.com/quiet-stale-first-${suffix}`;
    const secondEndpoint = `https://fcm.googleapis.com/quiet-stale-second-${suffix}`;
    const client = createECDH("prime256v1");
    client.generateKeys();
    const keys = {
      p256dh: pushCrypto.b64urlEncode(client.getPublicKey() as Buffer),
      auth: pushCrypto.b64urlEncode(Buffer.alloc(16, 13)),
    };
    pushFixture.service.addSubscription({ endpoint: firstEndpoint, keys });
    const oldEpisode = "stale-transport-episode";
    pushFixture.service.recordQuietAlertEmission(sessionId, oldEpisode);
    let releaseFetch: (() => void) | undefined;
    const fetchReleased = new Promise<void>((resolve) => { releaseFetch = resolve; });
    let fetchStarted: (() => void) | undefined;
    const fetchStartedPromise = new Promise<void>((resolve) => { fetchStarted = resolve; });
    globalThis.fetch = Object.assign(
      async (..._args: Parameters<typeof fetch>): Promise<Response> => {
        fetchStarted?.();
        await fetchReleased;
        return new Response(null, { status: 410 });
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      const staleSend = pushFixture.service.sendPush({ title: "Test", body: "held stale transport" });
      await fetchStartedPromise;
      pushFixture.service.removeSubscription(firstEndpoint);
      pushFixture.service.addSubscription({ endpoint: firstEndpoint, keys });
      pushFixture.service.addSubscription({ endpoint: secondEndpoint, keys });

      releaseFetch?.();
      await staleSend;
      expect(pushFixture.service.getSubscriptionCount()).toBe(2);

      const targets: string[][] = [];
      pushFixture.dependencies.sender = async (_payload, endpoints) => {
        targets.push([...endpoints]);
        return { sent: endpoints.size, failed: 0, pruned: 0, successfulEndpoints: [...endpoints], failedEndpoints: [] };
      };
      await pushFixture.service.checkSessionTransitions([{
        name: "agent",
        identity: { wolfpackSessionId: sessionId },
        quietAlert: quietAlert(oldEpisode),
      }]);
      expect(targets).toEqual([]);
    } finally {
      releaseFetch?.();
      globalThis.fetch = originalFetch;
      pushFixture.dependencies.sender = null;
      pushFixture.service.removeSubscription(firstEndpoint);
      pushFixture.service.removeSubscription(secondEndpoint);
    }
  });

  test("retires a failed endpoint that is unregistered before its retry", async () => {

    const originalNow = Date.now;
    let now = 3_000_000;
    Date.now = () => now;
    const successful = `https://fcm.googleapis.com/quiet-registered-${now}`;
    const failed = `https://fcm.googleapis.com/quiet-removed-${now}`;
    pushFixture.service.addSubscription({ endpoint: successful, keys: { p256dh: "key", auth: "auth" } });
    pushFixture.service.addSubscription({ endpoint: failed, keys: { p256dh: "key", auth: "auth" } });
    const targets: string[][] = [];
    pushFixture.dependencies.sender = async (_payload, endpoints) => {
      targets.push([...endpoints].sort());
      return { sent: 1, failed: 1, pruned: 0, successfulEndpoints: [successful], failedEndpoints: [failed] };
    };
    try {
      await pushFixture.service.checkSessionTransitions(session());
      pushFixture.service.removeSubscription(failed);
      now += pushCrypto.PUSH_DEBOUNCE_MS;
      await pushFixture.service.checkSessionTransitions(session());

      expect(targets).toEqual([[failed, successful].sort()]);
    } finally {
      Date.now = originalNow;
      pushFixture.dependencies.sender = null;
      pushFixture.service.removeSubscription(successful);
      pushFixture.service.removeSubscription(failed);
    }
  });

  test("keeps in-flight completion from consuming a replacement episode", async () => {

    const endpoint = `https://fcm.googleapis.com/inflight-quiet-${Date.now()}`;
    pushFixture.service.addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    let releaseFirst: (() => void) | undefined;
    const firstDelivery = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    pushFixture.dependencies.sender = async () => {
      calls += 1;
      if (calls === 1) {
        await firstDelivery;
        return { sent: 1, failed: 0, pruned: 0, successfulEndpoints: [endpoint], failedEndpoints: [] };
      }
      return { sent: 0, failed: 1, pruned: 0, successfulEndpoints: [], failedEndpoints: [endpoint] };
    };
    try {
      const inFlight = pushFixture.service.checkSessionTransitions(session("episode-one"));
      await Promise.resolve();
      await pushFixture.service.checkSessionTransitions(session("episode-two"));
      releaseFirst?.();
      await inFlight;

      pushFixture.dependencies.now = () => Date.now() + pushCrypto.PUSH_DEBOUNCE_MS;
      await pushFixture.service.checkSessionTransitions(session("episode-two"));
      expect(calls).toBe(3);
    } finally {
      pushFixture.dependencies.sender = null;
      pushFixture.service.removeSubscription(endpoint);
    }
  });

  test("does not start a later stale delivery after invalidation during an earlier send", async () => {

    const { invalidateQuietAlertPolicy } = await import("../../src/quiet-alert-policy-invalidation.ts");
    const endpoint = `https://fcm.googleapis.com/invalidate-batch-${Date.now()}`;
    pushFixture.service.addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    let releaseFirst: (() => void) | undefined;
    const firstDelivery = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const deliveredSessions: string[] = [];
    pushFixture.dependencies.sender = async (payload) => {
      deliveredSessions.push(payload.title);
      if (deliveredSessions.length === 1) await firstDelivery;
      return { sent: 1, failed: 0, pruned: 0, successfulEndpoints: [endpoint], failedEndpoints: [] };
    };
    try {
      const firstAlert = { ...quietAlert("invalidate-episode-first"), sessionId: "invalidate-first" };
      const secondAlert = { ...quietAlert("invalidate-episode-second"), sessionId: "invalidate-second" };
      pushFixture.service.recordQuietAlertEmission("invalidate-first", firstAlert.episodeId);
      pushFixture.service.recordQuietAlertEmission("invalidate-second", secondAlert.episodeId);
      const inFlight = pushFixture.service.checkSessionTransitions([
        { name: "first", identity: { wolfpackSessionId: "invalidate-first" }, quietAlert: firstAlert },
        { name: "second", identity: { wolfpackSessionId: "invalidate-second" }, quietAlert: secondAlert },
      ]);
      await Promise.resolve();
      invalidateQuietAlertPolicy();
      releaseFirst?.();
      await inFlight;

      expect(deliveredSessions).toEqual(["Wolfpack: first"]);
    } finally {
      pushFixture.dependencies.sender = null;
      pushFixture.service.removeSubscription(endpoint);
    }
  });

  test("does not start a later delivery after observation authority changes during the first send", async () => {

    const endpoint = `https://fcm.googleapis.com/observation-authority-${Date.now()}`;
    pushFixture.service.addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    const firstSessionId = "observation-authority-first";
    const secondSessionId = "observation-authority-second";
    const firstAlert = { ...quietAlert("observation-authority-first-episode"), sessionId: firstSessionId };
    const secondAlert = { ...quietAlert("observation-authority-second-episode"), sessionId: secondSessionId };
    pushFixture.service.recordQuietAlertEmission(firstSessionId, firstAlert.episodeId);
    pushFixture.service.recordQuietAlertEmission(secondSessionId, secondAlert.episodeId);
    let currentAuthority = true;
    let releaseFirst: (() => void) | undefined;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted: (() => void) | undefined;
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
    const deliveredSessions: string[] = [];
    pushFixture.dependencies.sender = async (payload) => {
      deliveredSessions.push(payload.title);
      if (deliveredSessions.length === 1) {
        firstStarted?.();
        await firstReleased;
      }
      return { sent: 1, failed: 0, pruned: 0, successfulEndpoints: [endpoint], failedEndpoints: [] };
    };
    try {
      const delivery = pushFixture.service.checkSessionTransitions([
        { name: "first", identity: { wolfpackSessionId: firstSessionId }, quietAlert: firstAlert },
        { name: "second", identity: { wolfpackSessionId: secondSessionId }, quietAlert: secondAlert },
      ], undefined, () => currentAuthority);
      await firstStartedPromise;
      currentAuthority = false;
      releaseFirst?.();
      await delivery;

      expect(deliveredSessions).toEqual(["Wolfpack: first"]);
    } finally {
      pushFixture.dependencies.sender = null;
      pushFixture.service.removeSubscription(endpoint);
    }
  });

  test("builds a stable-identity route for an observed quiet episode", async () => {

    const alert = { sessionId: "broker/session id", episodeId: "e", eligibleAtMs: 0, observedAtMs: 0 };
    expect(pushCrypto.quietAlertPayload({ name: "agent one" }, "broker/session id", { ...alert, kind: "quiet" })).toEqual({
      title: "Wolfpack: agent one",
      body: "Idle",
      tag: "session-broker/session id",
      url: "/?sessionId=broker%2Fsession+id&session=agent+one&machine=local",
    });
    const needsInput = pushCrypto.quietAlertPayload({ name: "agent one" }, "broker/session id", { ...alert, kind: "needs-input", inputKind: "question" });
    expect(needsInput).toMatchObject({ title: "Wolfpack: agent one", tag: "session-broker/session id", body: "Needs input (question)" });
    expect(pushCrypto.quietAlertPayload({ name: "agent one" }, "broker/session id", { ...alert, kind: "needs-input" }).body).toBe("Needs input");
  });

  test("relays a new-default needs-input episode through peer validation to push delivery", async () => {
    const { DEFAULT_QUIET_ALERT_POLICY, reduceQuietAlertPolicy } = await import("../../src/quiet-alert-policy.ts");
    const { observePeerNotifications } = await import("../../src/server/peer-notifications.ts");
    const { buildMachineHandshake } = await import("../../src/tailnet-machine-contract.ts");

    expect(DEFAULT_QUIET_ALERT_POLICY.mode).toBe("needs-input-only");
    const endpoint = `https://fcm.googleapis.com/new-default-peer-${Date.now()}`;
    pushFixture.service.addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    const payloads: string[] = [];
    pushFixture.dependencies.sender = async payload => { payloads.push(payload.body); return { sent: 1, failed: 0, pruned: 0 }; };
    try {
      const now = Date.now();
      const base = { sessionId: "new-default-peer", continuity: "fresh" as const, policy: undefined };
      const active = reduceQuietAlertPolicy(undefined, { ...base, observedAtMs: now - 30_000,
        renderedActivityAt: now - 30_000, episodeId: "new-default-episode" });
      const due = reduceQuietAlertPolicy(active.state, { ...base, observedAtMs: now,
        renderedActivityAt: undefined, episodeId: undefined, alert: { kind: "needs-input", inputKind: "permission" } });
      const origin = "https://peer.test.ts.net";
      const handshake = buildMachineHandshake({ tailscaleHostname: "peer.test.ts.net", tailscaleNodeId: "n123",
        installationId: "12345678-1234-4234-8234-123456789abc", displayName: "peer", version: "1.0.0" });
      const peers = await observePeerNotifications({ topology: async () => ({ origin: "https://home.test.ts.net", nodeId: "home", peers: new Map([[origin, "n123"]]) }),
        fetch: async input => Response.json(input.endsWith("/api/machine") ? handshake : {
          sessions: [{ name: "agent", identity: { wolfpackSessionId: base.sessionId }, quietAlert: due.fact }] }) });
      expect(peers).toHaveLength(1);
      for (const peer of peers) {
        await pushFixture.service.checkSessionTransitions(peer.sessions, undefined, undefined, peer.machine);
        await pushFixture.service.checkSessionTransitions(peer.sessions, undefined, undefined, peer.machine);
      }
      expect(payloads).toEqual(["Needs input (permission)"]);
    } finally { pushFixture.dependencies.sender = null; pushFixture.service.removeSubscription(endpoint); }
  });

  test("delivers a relayed peer needs-input fact with its own text", async () => {

    const endpoint = `https://fcm.googleapis.com/peer-needs-input-${Date.now()}`;
    pushFixture.service.addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    const payloads: Array<{ readonly title: string; readonly body: string }> = [];
    pushFixture.dependencies.sender = async (payload) => {
      payloads.push({ title: payload.title, body: payload.body });
      return { sent: 1, failed: 0, pruned: 0 };
    };
    try {
      await pushFixture.service.checkSessionTransitions([{
        name: "agent",
        identity: { wolfpackSessionId: "peer-needs-input" },
        quietAlert: { ...quietAlert("peer-needs-input-episode"), sessionId: "peer-needs-input", kind: "needs-input", inputKind: "permission" },
      }], undefined, undefined, { identity: "n123:12345678-1234-4234-8234-123456789abc", name: "peer" });
      expect(payloads).toEqual([{ title: "Wolfpack: peer: agent", body: "Needs input (permission)" }]);
    } finally {
      pushFixture.dependencies.sender = null;
      pushFixture.service.removeSubscription(endpoint);
    }
  });

  test("delivers a peer episode released after a long child-wait suppression", async () => {
    const { reduceQuietAlertPolicy } = await import("../../src/quiet-alert-policy.ts");

    const endpoint = `https://fcm.googleapis.com/peer-released-${Date.now()}`;
    pushFixture.service.addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    const payloads: string[] = [];
    pushFixture.dependencies.sender = async (payload) => {
      payloads.push(payload.body);
      return { sent: 1, failed: 0, pruned: 0 };
    };
    const activityAtMs = Date.now() - 300_000;
    const base = { sessionId: "peer-released", continuity: "fresh" as const, policy: { mode: "quiet-after-activity" as const, quietAfterSeconds: 30 } };
    const active = reduceQuietAlertPolicy(undefined, { ...base, observedAtMs: activityAtMs, renderedActivityAt: activityAtMs, episodeId: "released-episode" });
    const withheld = reduceQuietAlertPolicy(active.state, { ...base, observedAtMs: activityAtMs + 30_000, renderedActivityAt: undefined, episodeId: undefined, suppressed: true });
    const released = reduceQuietAlertPolicy(withheld.state, { ...base, observedAtMs: Date.now(), renderedActivityAt: undefined, episodeId: undefined });
    try {
      await pushFixture.service.checkSessionTransitions([{
        name: "agent",
        identity: { wolfpackSessionId: "peer-released" },
        quietAlert: released.fact,
      }], undefined, undefined, { identity: "n123:12345678-1234-4234-8234-123456789abc", name: "peer" });
      expect(payloads).toEqual(["Idle"]);
    } finally {
      pushFixture.dependencies.sender = null;
      pushFixture.service.removeSubscription(endpoint);
    }
  });

  test("prunes delivery and debounce state for removed sessions", async () => {
    const endpoint = "https://fcm.googleapis.com/prune-quiet";
    pushFixture.service.addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    let sends = 0;
    pushFixture.dependencies.sender = async () => { sends++; return { sent: 1, failed: 0, pruned: 0 }; };
    try {
      await pushFixture.service.checkSessionTransitions(session());
      await pushFixture.service.checkSessionTransitions(session());
      expect(sends).toBe(1);
      await pushFixture.service.checkSessionTransitions([]);
      await pushFixture.service.checkSessionTransitions(session());
      expect(sends).toBe(2);
    } finally {
      pushFixture.service.removeSubscription(endpoint);
    }
  });
});
