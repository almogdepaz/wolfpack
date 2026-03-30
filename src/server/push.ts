/**
 * Web Push notification support — VAPID signing + payload encryption (RFC 8291).
 * Zero external dependencies, uses node:crypto only.
 */
import { createECDH, createSign, createPrivateKey, createHmac, createCipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger, errMsg } from "../log.js";
import type { TriageStatus } from "../triage.js";

const log = createLogger("push");

const WOLFPACK_DIR = join(homedir(), ".wolfpack");
const VAPID_PATH = join(WOLFPACK_DIR, "vapid-keys.json");
const SUBS_PATH = join(WOLFPACK_DIR, "push-subscriptions.json");

// ── Types ──

export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string; // base64url-encoded client public key
    auth: string;   // base64url-encoded 16-byte auth secret
  };
}

interface VapidKeys {
  publicKey: string;  // base64url-encoded uncompressed EC point (65 bytes)
  privateKey: string; // base64url-encoded 32-byte scalar
}

// ── Base64url helpers ──

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Buffer {
  // Pad to multiple of 4
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// ── VAPID key management ──

function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: b64urlEncode(ecdh.getPublicKey() as Buffer),
    privateKey: b64urlEncode(ecdh.getPrivateKey() as Buffer),
  };
}

let _vapidKeys: VapidKeys | null = null;

/** Validate VAPID keys decode to correct lengths (65-byte public, 32-byte private). */
function isValidVapidKeys(keys: VapidKeys): boolean {
  try {
    if (!keys.publicKey || !keys.privateKey) return false;
    const pub = b64urlDecode(keys.publicKey);
    const priv = b64urlDecode(keys.privateKey);
    return pub.length === 65 && priv.length === 32;
  } catch { return false; }
}

export function getVapidKeys(): VapidKeys {
  if (_vapidKeys) return _vapidKeys;
  mkdirSync(WOLFPACK_DIR, { recursive: true, mode: 0o700 });

  if (existsSync(VAPID_PATH)) {
    try {
      const loaded = JSON.parse(readFileSync(VAPID_PATH, "utf-8")) as VapidKeys;
      if (isValidVapidKeys(loaded)) {
        _vapidKeys = loaded;
        return _vapidKeys;
      }
      log.warn("vapid-keys.json has invalid key lengths, regenerating");
    } catch (e) {
      log.warn("corrupt vapid-keys.json, regenerating", { error: errMsg(e) });
    }
  }

  _vapidKeys = generateVapidKeys();
  writeFileSync(VAPID_PATH, JSON.stringify(_vapidKeys, null, 2), { mode: 0o600 });
  log.info("generated new VAPID keypair");
  return _vapidKeys;
}

/** Returns the VAPID public key as a base64url string (for the frontend). */
export function getVapidPublicKey(): string {
  return getVapidKeys().publicKey;
}

// ── Subscription persistence ──

const MAX_SUBSCRIPTIONS = 20;
const MAX_ENDPOINT_LENGTH = 1024;

function loadSubscriptions(): PushSubscription[] {
  if (!existsSync(SUBS_PATH)) return [];
  try {
    const data = JSON.parse(readFileSync(SUBS_PATH, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveSubscriptions(subs: PushSubscription[]): void {
  writeFileSync(SUBS_PATH, JSON.stringify(subs, null, 2), { mode: 0o600 });
}

/** Validate subscription keys have correct decoded lengths. Returns error string or null. */
export function validateSubscription(sub: PushSubscription): string | null {
  if (!sub.endpoint || typeof sub.endpoint !== "string") return "missing endpoint";
  if (sub.endpoint.length > MAX_ENDPOINT_LENGTH) return "endpoint too long";
  try {
    const url = new URL(sub.endpoint);
    if (url.protocol !== "https:") return "endpoint must use HTTPS";
  } catch { return "invalid endpoint URL"; }
  if (!sub.keys?.p256dh || !sub.keys?.auth) return "missing keys";
  try {
    const p256dh = b64urlDecode(sub.keys.p256dh);
    if (p256dh.length !== 65) return "p256dh must decode to 65 bytes (uncompressed P-256 point)";
  } catch { return "p256dh is not valid base64url"; }
  try {
    const auth = b64urlDecode(sub.keys.auth);
    if (auth.length !== 16) return "auth must decode to 16 bytes";
  } catch { return "auth is not valid base64url"; }
  return null;
}

export function addSubscription(sub: PushSubscription): { ok: boolean; error?: string } {
  const subs = loadSubscriptions();
  // Dedupe by endpoint
  const idx = subs.findIndex((s) => s.endpoint === sub.endpoint);
  if (idx >= 0) {
    subs[idx] = sub;
  } else {
    if (subs.length >= MAX_SUBSCRIPTIONS) return { ok: false, error: "subscription limit reached (max " + MAX_SUBSCRIPTIONS + ")" };
    subs.push(sub);
  }
  saveSubscriptions(subs);
  log.info("push subscription added", { endpoint: sub.endpoint.slice(0, 60) });
  return { ok: true };
}

export function removeSubscription(endpoint: string): void {
  const subs = loadSubscriptions().filter((s) => s.endpoint !== endpoint);
  saveSubscriptions(subs);
  log.info("push subscription removed", { endpoint: endpoint.slice(0, 60) });
}

export function getSubscriptionCount(): number {
  return loadSubscriptions().length;
}

// ── VAPID JWT (RFC 8292) ──

/** Build a JWK-based private key object for ES256 signing. */
function buildSigningKey(vapid: VapidKeys) {
  const pubBuf = b64urlDecode(vapid.publicKey);
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: vapid.privateKey,
      x: b64urlEncode(pubBuf.subarray(1, 33)),
      y: b64urlEncode(pubBuf.subarray(33, 65)),
    },
    format: "jwk",
  });
}

function createVapidJwt(audience: string, subject: string, vapid: VapidKeys, expSeconds = 12 * 3600): string {
  const header = b64urlEncode(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64urlEncode(Buffer.from(JSON.stringify({
    aud: audience,
    exp: now + expSeconds,
    sub: subject,
  })));

  const unsigned = `${header}.${payload}`;
  const signer = createSign("SHA256");
  signer.update(unsigned);
  const sig = signer.sign(buildSigningKey(vapid));

  // Convert DER signature to raw r||s (each 32 bytes)
  const rawSig = derToRaw(sig);
  const sigB64 = b64urlEncode(rawSig);

  return `${unsigned}.${sigB64}`;
}

/** Convert DER ECDSA signature to raw 64-byte r||s. */
function derToRaw(der: Buffer): Buffer {
  // DER: 0x30 <len> 0x02 <rlen> <r> 0x02 <slen> <s>
  let offset = 2; // skip 0x30 + total length
  offset += 1; // skip 0x02
  const rLen = der[offset++];
  const r = der.subarray(offset, offset + rLen);
  offset += rLen;
  offset += 1; // skip 0x02
  const sLen = der[offset++];
  const s = der.subarray(offset, offset + sLen);

  // Pad/trim to 32 bytes each
  const raw = Buffer.alloc(64);
  r.copy(raw, 32 - Math.min(r.length, 32), Math.max(r.length - 32, 0));
  s.copy(raw, 64 - Math.min(s.length, 32), Math.max(s.length - 32, 0));
  return raw;
}

// ── Web Push Encryption (RFC 8291, aes128gcm) ──

/**
 * HKDF-SHA256 extract-then-expand (RFC 5869) — single iteration only.
 * Safe for output lengths <= 32 bytes (one HMAC block), which covers
 * AES-128-GCM key (16 bytes) and nonce (12 bytes) derivation.
 */
function hkdfSha256(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  const infoWithCounter = Buffer.concat([info, Buffer.from([1])]);
  const okm = createHmac("sha256", prk).update(infoWithCounter).digest();
  return okm.subarray(0, length);
}

function encryptPayload(
  payload: Buffer,
  sub: PushSubscription,
): { body: Buffer; salt: Buffer; serverPub: Buffer } {
  // Client public key and auth secret
  const clientPub = b64urlDecode(sub.keys.p256dh);
  const clientAuth = b64urlDecode(sub.keys.auth);

  // Generate ephemeral ECDH keypair
  const serverEcdh = createECDH("prime256v1");
  serverEcdh.generateKeys();
  const serverPub = serverEcdh.getPublicKey() as Buffer;

  // Shared secret via ECDH
  const sharedSecret = serverEcdh.computeSecret(clientPub);

  // Generate salt
  const salt = randomBytes(16);

  // IKM from auth secret
  const authInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    clientPub,
    serverPub,
  ]);
  const ikm = hkdfSha256(sharedSecret, clientAuth, authInfo, 32);

  // Derive content encryption key and nonce
  const cekInfo = Buffer.from("Content-Encoding: aes128gcm\0");
  const nonceInfo = Buffer.from("Content-Encoding: nonce\0");
  const cek = hkdfSha256(ikm, salt, cekInfo, 16);
  const nonce = hkdfSha256(ikm, salt, nonceInfo, 12);

  // Encrypt with AES-128-GCM
  // Pad payload with 0x02 delimiter (RFC 8291 §4)
  const padded = Buffer.concat([payload, Buffer.from([2])]);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  // Build aes128gcm content-coding header (RFC 8188)
  // salt (16) + rs (4, big-endian) + idlen (1) + keyid (65 = server pub)
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  const header = Buffer.concat([salt, rs, Buffer.from([serverPub.length]), serverPub]);
  const body = Buffer.concat([header, encrypted]);

  return { body, salt, serverPub };
}

// ── Send push notification ──

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

export async function sendPush(payload: PushPayload): Promise<{ sent: number; failed: number; pruned: number }> {
  const subs = loadSubscriptions();
  if (subs.length === 0) return { sent: 0, failed: 0, pruned: 0 };

  const vapid = getVapidKeys();
  const payloadBuf = Buffer.from(JSON.stringify(payload));

  // Filter out stored subscriptions with invalid endpoints (defense-in-depth for legacy data)
  const validSubs = subs.filter(sub => {
    try {
      const url = new URL(sub.endpoint);
      return url.protocol === "https:";
    } catch { return false; }
  });
  if (validSubs.length < subs.length) {
    saveSubscriptions(validSubs);
    log.warn("pruned invalid subscriptions on send", { count: subs.length - validSubs.length });
  }
  if (validSubs.length === 0) return { sent: 0, failed: 0, pruned: 0 };

  const results = await Promise.allSettled(validSubs.map(async (sub) => {
    const audience = new URL(sub.endpoint).origin;
    const jwt = createVapidJwt(audience, "mailto:noreply@wolfpack.local", vapid);

    const { body } = encryptPayload(payloadBuf, sub);

    const resp = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        TTL: "86400",
        Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
      },
      body,
    });

    return { endpoint: sub.endpoint, status: resp.status };
  }));

  let sent = 0;
  let failed = 0;
  const toRemove: string[] = [];

  for (const r of results) {
    if (r.status === "rejected") {
      log.warn("push send error", { error: errMsg(r.reason) });
      failed++;
    } else if (r.value.status === 200 || r.value.status === 201) {
      sent++;
    } else if (r.value.status === 404 || r.value.status === 410) {
      toRemove.push(r.value.endpoint);
    } else {
      log.warn("push delivery failed", { status: r.value.status, endpoint: r.value.endpoint.slice(0, 60) });
      failed++;
    }
  }

  // Prune dead subscriptions
  if (toRemove.length > 0) {
    const remaining = validSubs.filter((s) => !toRemove.includes(s.endpoint));
    saveSubscriptions(remaining);
    log.info("pruned expired push subscriptions", { count: toRemove.length });
  }

  return { sent, failed, pruned: toRemove.length };
}

// ── Push state tracking (transition-based notifications) ──

const prevTriageState = new Map<string, TriageStatus>();
const lastPushTime = new Map<string, number>();
const PUSH_DEBOUNCE_MS = 30_000;
const prevRalphState = new Map<string, string>();

/** Rate-limit timestamps for POST /api/notify (10/min). */
let notifyTimestamps: number[] = [];

function ralphLoopStatus(loop: { active: boolean; completed: boolean; audit?: boolean; cleanup?: boolean; finished?: string }): string {
  if (loop.audit || loop.cleanup || loop.active) return "running";
  if (loop.completed) return "done";
  if (!loop.active && !loop.completed && loop.finished) return "limit";
  return "idle";
}

/** Check session triage transitions and fire push notifications for running → idle. */
export function checkSessionTransitions(sessions: Array<{ name: string; triage: TriageStatus }>): void {
  if (getSubscriptionCount() === 0) return;
  const now = Date.now();
  const activeNames = new Set(sessions.map(s => s.name));
  for (const s of sessions) {
    const prev = prevTriageState.get(s.name);
    prevTriageState.set(s.name, s.triage);
    if (prev === "running" && s.triage === "idle") {
      const last = lastPushTime.get(s.name) || 0;
      if (now - last > PUSH_DEBOUNCE_MS) {
        lastPushTime.set(s.name, now);
        sendPush({ title: `Wolfpack: ${s.name}`, body: "Finished", tag: `session-${s.name}` }).catch(() => {});
      }
    }
  }
  // Prune state for removed sessions
  for (const key of prevTriageState.keys()) {
    if (!activeNames.has(key)) { prevTriageState.delete(key); lastPushTime.delete(key); }
  }
}

/** Check ralph loop transitions and fire push notifications for running → done/idle/limit. */
export function checkRalphLoopTransitions(loops: Array<{ project: string; active: boolean; completed: boolean; audit?: boolean; cleanup?: boolean; finished?: string }>): void {
  if (getSubscriptionCount() === 0) return;
  const now = Date.now();
  const activeKeys = new Set(loops.map(l => `ralph-${l.project}`));
  for (const loop of loops) {
    const key = `ralph-${loop.project}`;
    const prev = prevRalphState.get(key);
    const cur = ralphLoopStatus(loop);
    prevRalphState.set(key, cur);
    if (prev === "running" && (cur === "done" || cur === "idle" || cur === "limit")) {
      const last = lastPushTime.get(key) || 0;
      if (now - last > PUSH_DEBOUNCE_MS) {
        lastPushTime.set(key, now);
        const labels: Record<string, string> = { done: "All tasks complete", idle: "Stopped", limit: "Hit iteration limit" };
        sendPush({
          title: `Wolfpack: ralph`,
          body: `${loop.project}: ${labels[cur] || cur}`,
          tag: `ralph-${loop.project}`,
        }).catch(() => {});
      }
    }
  }
  // Prune state for removed projects
  for (const key of prevRalphState.keys()) {
    if (!activeKeys.has(key)) { prevRalphState.delete(key); lastPushTime.delete(key); }
  }
}

/** Check notify rate limit (10/min). Returns error string or null if ok. */
export function checkNotifyRateLimit(): string | null {
  const now = Date.now();
  notifyTimestamps = notifyTimestamps.filter(t => now - t < 60_000);
  if (notifyTimestamps.length >= 10) return "rate limit exceeded (10/min)";
  notifyTimestamps.push(now);
  return null;
}

// ── Test-only exports ──

export const _testing = {
  createVapidJwt,
  encryptPayload,
  derToRaw,
  b64urlEncode,
  b64urlDecode,
  prevTriageState,
  lastPushTime,
  prevRalphState,
  PUSH_DEBOUNCE_MS,
  get notifyTimestamps() { return notifyTimestamps; },
  set notifyTimestamps(v: number[]) { notifyTimestamps = v; },
};
