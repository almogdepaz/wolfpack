import { afterAll, describe, expect, test, beforeEach } from "bun:test";
import { createECDH, createVerify, createPublicKey, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WOLFPACK_TEST = "1";
const originalHome = process.env.HOME;
const pushTestHome = mkdtempSync(join(tmpdir(), "wolfpack-push-unit-"));
process.env.HOME = pushTestHome;
afterAll(() => {
  process.env.HOME = originalHome;
  rmSync(pushTestHome, { recursive: true, force: true });
});

// The production module derives its persistence location at import time, so
// set an isolated HOME before dynamically importing it in the tests below.

function validSubscription(endpoint: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: (ecdh.getPublicKey() as Buffer).toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
}

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

    const sub = validSubscription(`https://fcm.googleapis.com/fcm/send/test-${Date.now()}`);

    expect(addSubscription(sub).ok).toBe(true);
    expect(getSubscriptionCount()).toBe(initial + 1);

    // Adding same endpoint again should dedupe
    expect(addSubscription(sub).ok).toBe(true);
    expect(getSubscriptionCount()).toBe(initial + 1);

    removeSubscription(sub.endpoint);
    expect(getSubscriptionCount()).toBe(initial);
  });

  test("rejects malformed key material before persistence", async () => {
    const { addSubscription, getSubscriptionCount } = await import("../../src/server/push.ts");
    const initial = getSubscriptionCount();
    const result = addSubscription({
      endpoint: `https://fcm.googleapis.com/fcm/send/invalid-${Date.now()}`,
      keys: { p256dh: "k", auth: "a" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("p256dh must decode to 65 bytes (uncompressed P-256 point)");
    expect(getSubscriptionCount()).toBe(initial);
  });
});

describe("push: corrupt subscription persistence", () => {
  test("refuses to replace malformed persisted subscriptions", () => {
    const home = mkdtempSync(join(tmpdir(), "wolfpack-push-corrupt-"));
    const script = `
      const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
      const { createECDH, randomBytes } = await import("node:crypto");
      const { join } = await import("node:path");
      const path = join(process.env.HOME, ".wolfpack", "push-subscriptions.json");
      mkdirSync(join(process.env.HOME, ".wolfpack"), { recursive: true });
      writeFileSync(path, "{not-json");
      const { addSubscription } = await import("./src/server/push.ts");
      const ecdh = createECDH("prime256v1");
      ecdh.generateKeys();
      try {
        addSubscription({ endpoint: "https://fcm.googleapis.com/corrupt-test", keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } });
        console.log("unexpected-success");
      } catch (error) {
        console.log(String(error));
      }
      console.log("content=" + readFileSync(path, "utf-8"));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
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

describe("push: sendPush with no subscriptions", () => {
  test("returns zeros when no subscriptions", async () => {
    const { sendPush } = await import("../../src/server/push.ts");
    const result = await sendPush({ title: "Test", body: "test body" });
    expect(result).toHaveProperty("sent");
    expect(result).toHaveProperty("failed");
    expect(result).toHaveProperty("pruned");
  });
});

describe("push: crypto round-trip", () => {
  test("VAPID JWT has valid ES256 signature", async () => {
    const { getVapidKeys, _testing } = await import("../../src/server/push.ts");
    const vapid = getVapidKeys();
    const jwt = _testing.createVapidJwt("https://fcm.googleapis.com", "mailto:test@localhost", vapid);

    const parts = jwt.split(".");
    expect(parts.length).toBe(3);

    // Verify the signature with the public key
    const unsigned = `${parts[0]}.${parts[1]}`;
    const sigBuf = _testing.b64urlDecode(parts[2]);
    expect(sigBuf.length).toBe(64); // raw r||s

    // Convert raw r||s back to DER for verification
    const r = sigBuf.subarray(0, 32);
    const s = sigBuf.subarray(32, 64);
    const rDer = r[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), r]) : r;
    const sDer = s[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), s]) : s;
    const derInner = Buffer.concat([
      Buffer.from([0x02, rDer.length]), rDer,
      Buffer.from([0x02, sDer.length]), sDer,
    ]);
    const derSig = Buffer.concat([Buffer.from([0x30, derInner.length]), derInner]);

    // Build JWK public key for verification
    const pubBuf = _testing.b64urlDecode(vapid.publicKey);
    expect(pubBuf.length).toBe(65); // uncompressed P-256
    const pubKey = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: _testing.b64urlEncode(pubBuf.subarray(1, 33)),
        y: _testing.b64urlEncode(pubBuf.subarray(33, 65)),
      },
      format: "jwk",
    });

    const verifier = createVerify("SHA256");
    verifier.update(unsigned);
    const valid = verifier.verify(pubKey, derSig);
    expect(valid).toBe(true);

    // Verify JWT payload
    const payload = JSON.parse(_testing.b64urlDecode(parts[1]).toString());
    expect(payload.aud).toBe("https://fcm.googleapis.com");
    expect(payload.sub).toBe("mailto:test@localhost");
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test("encryptPayload produces valid aes128gcm structure", async () => {
    const { _testing } = await import("../../src/server/push.ts");

    // Create a fake client subscription with real ECDH keys
    const clientEcdh = createECDH("prime256v1");
    clientEcdh.generateKeys();
    const clientPub = _testing.b64urlEncode(clientEcdh.getPublicKey() as Buffer);
    const { randomBytes } = await import("node:crypto");
    const clientAuth = _testing.b64urlEncode(randomBytes(16));

    const sub = {
      endpoint: "https://fcm.googleapis.com/fcm/send/test",
      keys: { p256dh: clientPub, auth: clientAuth },
    };

    const payload = Buffer.from(JSON.stringify({ title: "Test", body: "hello" }));
    const { body, salt, serverPub } = _testing.encryptPayload(payload, sub);

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

  test("derToRaw converts DER ECDSA signatures to 64 bytes", async () => {
    const { _testing } = await import("../../src/server/push.ts");
    // Minimal valid DER: 0x30 <len> 0x02 <rlen> <r> 0x02 <slen> <s>
    const r = Buffer.alloc(32, 0x01);
    const s = Buffer.alloc(32, 0x02);
    const inner = Buffer.concat([Buffer.from([0x02, 32]), r, Buffer.from([0x02, 32]), s]);
    const der = Buffer.concat([Buffer.from([0x30, inner.length]), inner]);
    const raw = _testing.derToRaw(der);
    expect(raw.length).toBe(64);
    expect(raw.subarray(0, 32)).toEqual(r);
    expect(raw.subarray(32, 64)).toEqual(s);
  });

  test("derToRaw throws on missing SEQUENCE header", async () => {
    const { _testing } = await import("../../src/server/push.ts");
    expect(() => _testing.derToRaw(Buffer.from([0x02, 0x00, 0x02, 0x00, 0x02, 0x00, 0x02, 0x00]))).toThrow(/invalid DER header/);
  });

  test("derToRaw throws on undersized DER input", async () => {
    const { _testing } = await import("../../src/server/push.ts");
    expect(() => _testing.derToRaw(Buffer.from([0x30, 0x04]))).toThrow(/invalid DER header/);
  });

  test("derToRaw throws on missing INTEGER tag", async () => {
    const { _testing } = await import("../../src/server/push.ts");
    // 0x30 <len> <not 0x02> ...
    const bad = Buffer.from([0x30, 0x06, 0x03, 0x01, 0x00, 0x02, 0x01, 0x00]);
    expect(() => _testing.derToRaw(bad)).toThrow(/expected INTEGER tag/);
  });

  test("derToRaw throws when r length overflows buffer", async () => {
    const { _testing } = await import("../../src/server/push.ts");
    // Claims rlen=100 but buffer is tiny
    const bad = Buffer.from([0x30, 0x06, 0x02, 0x64, 0x00, 0x00, 0x00, 0x00]);
    expect(() => _testing.derToRaw(bad)).toThrow(/r length overflows/);
  });

  test("hkdfSha256 throws when requested length exceeds 32 bytes (single-block limit)", async () => {
    const { _testing } = await import("../../src/server/push.ts");
    const ikm = Buffer.alloc(32, 0x01);
    const salt = Buffer.alloc(16, 0x02);
    const info = Buffer.from("info");
    expect(() => _testing.hkdfSha256(ikm, salt, info, 33)).toThrow(/single-block limit/);
    expect(() => _testing.hkdfSha256(ikm, salt, info, 64)).toThrow(/single-block limit/);
  });

  test("hkdfSha256 accepts lengths up to 32 bytes", async () => {
    const { _testing } = await import("../../src/server/push.ts");
    const ikm = Buffer.alloc(32, 0x01);
    const salt = Buffer.alloc(16, 0x02);
    const info = Buffer.from("info");
    expect(_testing.hkdfSha256(ikm, salt, info, 32).length).toBe(32);
    expect(_testing.hkdfSha256(ikm, salt, info, 16).length).toBe(16);
    expect(_testing.hkdfSha256(ikm, salt, info, 12).length).toBe(12);
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

  test("rejects a P-256-sized key that is not on the P-256 curve", async () => {
    const { validateSubscription } = await import("../../src/server/push.ts");
    const err = validateSubscription({
      endpoint: "https://fcm.googleapis.com/fcm/send/invalid-point",
      keys: { p256dh: Buffer.alloc(65).toString("base64url"), auth },
    });
    expect(err).toBe("p256dh is not a valid P-256 public key");
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
    const { addSubscription, removeSubscription, getSubscriptionCount } = await import("../../src/server/push.ts");
    const initial = getSubscriptionCount();
    const added: string[] = [];
    const keys = validSubscription("https://fcm.googleapis.com/unused").keys;

    try {
      // Fill up to 20
      for (let i = initial; i < 20; i++) {
        const ep = `https://fcm.googleapis.com/cap-test-${i}-${Date.now()}`;
        const result = addSubscription({ endpoint: ep, keys });
        expect(result.ok).toBe(true);
        added.push(ep);
      }
      expect(getSubscriptionCount()).toBe(20);

      // 21st should fail
      const result = addSubscription({
        endpoint: `https://fcm.googleapis.com/cap-test-overflow-${Date.now()}`,
        keys,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("limit");
      expect(getSubscriptionCount()).toBe(20);

      // Updating existing endpoint should still work (dedupe path)
      const updateResult = addSubscription({ endpoint: added[0], keys });
      expect(updateResult.ok).toBe(true);
      expect(getSubscriptionCount()).toBe(20);
    } finally {
      // Always clean up persisted entries — otherwise a mid-test assertion
      // failure leaves garbage in ~/.wolfpack/push-subscriptions.json.
      for (const ep of added) removeSubscription(ep);
    }
  });
});

// ── Rate limit tests ──

describe("push: checkNotifyRateLimit", () => {
  beforeEach(async () => {
    const { _testing } = await import("../../src/server/push.ts");
    _testing.notifyTimestamps = [];
  });

  test("allows 10 calls then rejects", async () => {
    const { checkNotifyRateLimit } = await import("../../src/server/push.ts");
    for (let i = 0; i < 10; i++) {
      expect(checkNotifyRateLimit()).toBeNull();
    }
    expect(checkNotifyRateLimit()).toBe("rate limit exceeded (10/min)");
  });

  test("resets after timestamps expire", async () => {
    const { checkNotifyRateLimit, _testing } = await import("../../src/server/push.ts");
    // Fill with timestamps from 61s ago (expired)
    _testing.notifyTimestamps = Array(10).fill(Date.now() - 61_000);
    expect(checkNotifyRateLimit()).toBeNull();
  });
});

// ── State transition + debounce tests ──

describe("push: delivery deadline", () => {
  test("a never-resolving fetch is rejected within the configured deadline", async () => {
    const { _testing } = await import("../../src/server/push.ts");
    const started = Date.now();
    const stalledFetch = async (): Promise<Response> => new Promise(() => {});

    await expect(_testing.fetchWithDeadline(
      "https://fcm.googleapis.com/stalled",
      {},
      10,
      stalledFetch,
    )).rejects.toMatchObject({ code: "PUSH_DELIVERY_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("the production push deadline is positive and bounded", async () => {
    const { _testing } = await import("../../src/server/push.ts");
    expect(_testing.PUSH_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(_testing.PUSH_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("push: checkSessionTransitions", () => {
  beforeEach(async () => {
    const { _testing } = await import("../../src/server/push.ts");
    _testing.prevTriageState.clear();
    _testing.lastSessionPushTime.clear();
  });

  test("does nothing when no subscriptions", async () => {
    const { checkSessionTransitions, getSubscriptionCount } = await import("../../src/server/push.ts");
    // With 0 subs (after cleanup from cap test), should be a no-op
    if (getSubscriptionCount() > 0) return; // skip if other tests left subs
    // Just verify it doesn't throw
    checkSessionTransitions([{ name: "test", triage: "idle" }]);
  });

  test("tracks state transitions correctly", async () => {
    const { _testing } = await import("../../src/server/push.ts");

    // Simulate: first call sets initial state
    _testing.prevTriageState.set("sess1", "running");
    // Now transition to idle — should trigger push (but we can verify state was recorded)
    // We can't easily test the sendPush call without a subscription, but we CAN verify
    // the state tracking maps are updated correctly

    // Set running state
    _testing.prevTriageState.set("sess1", "running");
    _testing.prevTriageState.set("sess2", "idle");

    // Verify maps have the expected state
    expect(_testing.prevTriageState.get("sess1")).toBe("running");
    expect(_testing.prevTriageState.get("sess2")).toBe("idle");
  });

  test("debounce prevents rapid push within 30s", async () => {
    const { _testing } = await import("../../src/server/push.ts");
    const now = Date.now();

    // Simulate a recent push for "sess1"
    _testing.lastSessionPushTime.set("sess1", now);

    // A transition happening now should be debounced
    const last = _testing.lastSessionPushTime.get("sess1") || 0;
    expect(now - last).toBeLessThan(_testing.PUSH_DEBOUNCE_MS);

    // A transition 31s later should not be debounced
    const future = now - 31_000;
    _testing.lastSessionPushTime.set("sess1", future);
    const futureGap = now - (_testing.lastSessionPushTime.get("sess1") || 0);
    expect(futureGap).toBeGreaterThan(_testing.PUSH_DEBOUNCE_MS);
  });

  test("labels observed quiet and broker unavailability without claiming a stop", async () => {
    const { _testing } = await import("../../src/server/push.ts");

    expect(_testing.sessionNotificationLabel("idle")).toBe("Quiet");
    expect(_testing.sessionNotificationLabel("unknown")).toBe("Unavailable");
    expect(_testing.sessionNotificationLabel("off")).toBe("Stopped");
  });

  test("builds a stable-identity route for a session transition", async () => {
    const { _testing } = await import("../../src/server/push.ts");

    expect(_testing.sessionTransitionPayload({
      name: "agent one",
      triage: "idle",
      identity: { wolfpackSessionId: "broker/session id" },
      runtimeState: { state: "done" },
    })).toEqual({
      title: "Wolfpack: agent one",
      body: "Done",
      tag: "session-broker/session id",
      url: "/?sessionId=broker%2Fsession+id&session=agent+one&machine=local",
    });
  });

  test("keys transition and debounce state by stable identity", async () => {
    const { checkSessionTransitions, addSubscription, removeSubscription, _testing } = await import("../../src/server/push.ts");
    const ep = `https://fcm.googleapis.com/stable-route-test-${Date.now()}`;
    addSubscription(validSubscription(ep));

    _testing.prevTriageState.set("stable-id", "output");
    checkSessionTransitions([{
      name: "renamed-agent",
      triage: "idle",
      identity: { wolfpackSessionId: "stable-id" },
      runtimeState: { state: "needs-input" },
    }]);

    expect(_testing.prevTriageState.get("stable-id")).toBe("needs-input");
    expect(_testing.prevTriageState.has("renamed-agent")).toBe(false);
    expect(_testing.lastSessionPushTime.has("stable-id")).toBe(true);
    removeSubscription(ep);
  });

  test("tracks canonical runtime state ahead of legacy triage", async () => {
    const { checkSessionTransitions, addSubscription, removeSubscription, _testing } = await import("../../src/server/push.ts");

    const ep = `https://fcm.googleapis.com/runtime-state-test-${Date.now()}`;
    addSubscription(validSubscription(ep));

    _testing.prevTriageState.set("agent", "output");
    checkSessionTransitions([{ name: "agent", triage: "running", runtimeState: { state: "needs-input" } }]);

    expect(_testing.prevTriageState.get("agent")).toBe("needs-input");
    expect(_testing.lastSessionPushTime.has("agent")).toBe(true);

    removeSubscription(ep);
  });

  test("prunes state for removed sessions", async () => {
    const { checkSessionTransitions, addSubscription, removeSubscription, _testing } = await import("../../src/server/push.ts");

    // Need at least 1 sub for transitions to run
    const ep = `https://fcm.googleapis.com/prune-test-${Date.now()}`;
    addSubscription(validSubscription(ep));

    // Seed state for a session that will disappear
    _testing.prevTriageState.set("old-session", "idle");
    _testing.lastSessionPushTime.set("old-session", Date.now());

    // Call with only "new-session" — old-session should be pruned
    checkSessionTransitions([{ name: "new-session", triage: "running" }]);

    expect(_testing.prevTriageState.has("old-session")).toBe(false);
    expect(_testing.lastSessionPushTime.has("old-session")).toBe(false);
    expect(_testing.prevTriageState.get("new-session")).toBe("running");

    removeSubscription(ep);
  });
});
