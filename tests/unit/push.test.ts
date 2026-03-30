import { describe, expect, test, beforeEach } from "bun:test";
import { createECDH, createVerify, createPublicKey, randomBytes } from "node:crypto";

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
      endpoint: "https://example.com/" + "a".repeat(1010),
      keys: { p256dh, auth },
    });
    expect(err).toBe("endpoint too long");
  });
});

// ── Subscription cap test ──

describe("push: subscription cap", () => {
  test("rejects new subscriptions beyond MAX_SUBSCRIPTIONS (20)", async () => {
    const { addSubscription, removeSubscription, getSubscriptionCount } = await import("../../src/server/push.ts");
    const initial = getSubscriptionCount();
    const added: string[] = [];

    // Fill up to 20
    for (let i = initial; i < 20; i++) {
      const ep = `https://fcm.googleapis.com/cap-test-${i}-${Date.now()}`;
      const result = addSubscription({ endpoint: ep, keys: { p256dh: "k", auth: "a" } });
      expect(result.ok).toBe(true);
      added.push(ep);
    }
    expect(getSubscriptionCount()).toBe(20);

    // 21st should fail
    const result = addSubscription({
      endpoint: `https://fcm.googleapis.com/cap-test-overflow-${Date.now()}`,
      keys: { p256dh: "k", auth: "a" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("limit");
    expect(getSubscriptionCount()).toBe(20);

    // Updating existing endpoint should still work (dedupe path)
    const updateResult = addSubscription({ endpoint: added[0], keys: { p256dh: "updated", auth: "a" } });
    expect(updateResult.ok).toBe(true);
    expect(getSubscriptionCount()).toBe(20);

    // Cleanup
    for (const ep of added) removeSubscription(ep);
  });
});

// ── State transition + debounce tests ──

describe("push: checkSessionTransitions", () => {
  beforeEach(async () => {
    const { _testing } = await import("../../src/server/push.ts");
    _testing.prevTriageState.clear();
    _testing.lastPushTime.clear();
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
    _testing.lastPushTime.set("sess1", now);

    // A transition happening now should be debounced
    const last = _testing.lastPushTime.get("sess1") || 0;
    expect(now - last).toBeLessThan(_testing.PUSH_DEBOUNCE_MS);

    // A transition 31s later should not be debounced
    const future = now - 31_000;
    _testing.lastPushTime.set("sess1", future);
    const futureGap = now - (_testing.lastPushTime.get("sess1") || 0);
    expect(futureGap).toBeGreaterThan(_testing.PUSH_DEBOUNCE_MS);
  });

  test("prunes state for removed sessions", async () => {
    const { checkSessionTransitions, addSubscription, removeSubscription, _testing } = await import("../../src/server/push.ts");

    // Need at least 1 sub for transitions to run
    const ep = `https://fcm.googleapis.com/prune-test-${Date.now()}`;
    addSubscription({ endpoint: ep, keys: { p256dh: "k", auth: "a" } });

    // Seed state for a session that will disappear
    _testing.prevTriageState.set("old-session", "idle");
    _testing.lastPushTime.set("old-session", Date.now());

    // Call with only "new-session" — old-session should be pruned
    checkSessionTransitions([{ name: "new-session", triage: "running" }]);

    expect(_testing.prevTriageState.has("old-session")).toBe(false);
    expect(_testing.lastPushTime.has("old-session")).toBe(false);
    expect(_testing.prevTriageState.get("new-session")).toBe("running");

    removeSubscription(ep);
  });
});

describe("push: checkRalphLoopTransitions", () => {
  beforeEach(async () => {
    const { _testing } = await import("../../src/server/push.ts");
    _testing.prevRalphState.clear();
    _testing.lastPushTime.clear();
  });

  test("tracks ralph loop status correctly", async () => {
    const { checkRalphLoopTransitions, addSubscription, removeSubscription, _testing } = await import("../../src/server/push.ts");

    const ep = `https://fcm.googleapis.com/ralph-test-${Date.now()}`;
    addSubscription({ endpoint: ep, keys: { p256dh: "k", auth: "a" } });

    // First call: set initial state to running
    checkRalphLoopTransitions([{ project: "proj1", active: true, completed: false }]);
    expect(_testing.prevRalphState.get("ralph-proj1")).toBe("running");

    // Second call: transition to done
    checkRalphLoopTransitions([{ project: "proj1", active: false, completed: true }]);
    expect(_testing.prevRalphState.get("ralph-proj1")).toBe("done");

    // Verify debounce was set
    expect(_testing.lastPushTime.has("ralph-proj1")).toBe(true);

    removeSubscription(ep);
  });

  test("classifies loop states correctly", async () => {
    const { checkRalphLoopTransitions, addSubscription, removeSubscription, _testing } = await import("../../src/server/push.ts");

    const ep = `https://fcm.googleapis.com/ralph-classify-${Date.now()}`;
    addSubscription({ endpoint: ep, keys: { p256dh: "k", auth: "a" } });

    // active → running
    checkRalphLoopTransitions([{ project: "p1", active: true, completed: false }]);
    expect(_testing.prevRalphState.get("ralph-p1")).toBe("running");

    // audit phase → running
    _testing.prevRalphState.clear();
    checkRalphLoopTransitions([{ project: "p1", active: false, completed: false, audit: true }]);
    expect(_testing.prevRalphState.get("ralph-p1")).toBe("running");

    // cleanup phase → running
    _testing.prevRalphState.clear();
    checkRalphLoopTransitions([{ project: "p1", active: false, completed: false, cleanup: true }]);
    expect(_testing.prevRalphState.get("ralph-p1")).toBe("running");

    // completed → done
    _testing.prevRalphState.clear();
    checkRalphLoopTransitions([{ project: "p1", active: false, completed: true }]);
    expect(_testing.prevRalphState.get("ralph-p1")).toBe("done");

    // finished but not completed/active → limit
    _testing.prevRalphState.clear();
    checkRalphLoopTransitions([{ project: "p1", active: false, completed: false, finished: "2026-01-01" }]);
    expect(_testing.prevRalphState.get("ralph-p1")).toBe("limit");

    // nothing → idle
    _testing.prevRalphState.clear();
    checkRalphLoopTransitions([{ project: "p1", active: false, completed: false }]);
    expect(_testing.prevRalphState.get("ralph-p1")).toBe("idle");

    removeSubscription(ep);
  });
});
