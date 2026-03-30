/**
 * Web Push notification support — VAPID signing + payload encryption (RFC 8291).
 * Zero external dependencies, uses node:crypto only.
 */
import { createECDH, createSign, createHmac, createCipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger, errMsg } from "../log.js";

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

export function getVapidKeys(): VapidKeys {
  if (_vapidKeys) return _vapidKeys;
  mkdirSync(WOLFPACK_DIR, { recursive: true, mode: 0o700 });

  if (existsSync(VAPID_PATH)) {
    try {
      _vapidKeys = JSON.parse(readFileSync(VAPID_PATH, "utf-8"));
      return _vapidKeys!;
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

export function addSubscription(sub: PushSubscription): void {
  const subs = loadSubscriptions();
  // Dedupe by endpoint
  const idx = subs.findIndex((s) => s.endpoint === sub.endpoint);
  if (idx >= 0) subs[idx] = sub;
  else subs.push(sub);
  saveSubscriptions(subs);
  log.info("push subscription added", { endpoint: sub.endpoint.slice(0, 60) });
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

function createVapidJwt(audience: string, subject: string, vapid: VapidKeys, expSeconds = 12 * 3600): string {
  const header = b64urlEncode(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64urlEncode(Buffer.from(JSON.stringify({
    aud: audience,
    exp: now + expSeconds,
    sub: subject,
  })));

  const unsigned = `${header}.${payload}`;
  const sign = createSign("SHA256");
  sign.update(unsigned);

  // Build DER-encoded private key for P-256
  const privBuf = b64urlDecode(vapid.privateKey);
  const der = buildEcPrivateKeyDer(privBuf);
  const sig = sign.sign({ key: Buffer.from(der), format: "der", type: "sec1" });

  // Convert DER signature to raw r||s (each 32 bytes)
  const rawSig = derToRaw(sig);
  const sigB64 = b64urlEncode(rawSig);

  return `${unsigned}.${sigB64}`;
}

/** Build a minimal SEC1 DER encoding for a P-256 private key. */
function buildEcPrivateKeyDer(privKey: Buffer): Uint8Array {
  // SEC1 ECPrivateKey structure for P-256
  const ecOid = Buffer.from("06082a8648ce3d030107", "hex"); // OID 1.2.840.10045.3.1.7
  // SEQUENCE { INTEGER 1, OCTET STRING privKey, [0] OID }
  const privOctet = Buffer.concat([Buffer.from([0x04, privKey.length]), privKey]);
  const oidTagged = Buffer.concat([Buffer.from([0xa0, ecOid.length]), ecOid]);
  const innerLen = 3 + privOctet.length + oidTagged.length; // 02 01 01 + octet + oid
  const seq = Buffer.alloc(2 + innerLen);
  seq[0] = 0x30; seq[1] = innerLen;
  seq[2] = 0x02; seq[3] = 0x01; seq[4] = 0x01;
  privOctet.copy(seq, 5);
  oidTagged.copy(seq, 5 + privOctet.length);
  return seq;
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

function hkdfExpand(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
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
  const ikm = hkdfExpand(sharedSecret, clientAuth, authInfo, 32);

  // Derive content encryption key and nonce
  const cekInfo = Buffer.from("Content-Encoding: aes128gcm\0");
  const nonceInfo = Buffer.from("Content-Encoding: nonce\0");
  const cek = hkdfExpand(ikm, salt, cekInfo, 16);
  const nonce = hkdfExpand(ikm, salt, nonceInfo, 12);

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
  const toRemove: string[] = [];
  let sent = 0;
  let failed = 0;

  await Promise.all(subs.map(async (sub) => {
    try {
      const audience = new URL(sub.endpoint).origin;
      const jwt = createVapidJwt(audience, "mailto:wolfpack@localhost", vapid);
      const vapidPubB64 = vapid.publicKey;

      const { body } = encryptPayload(payloadBuf, sub);

      const resp = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Encoding": "aes128gcm",
          TTL: "86400",
          Authorization: `vapid t=${jwt}, k=${vapidPubB64}`,
        },
        body,
      });

      if (resp.status === 201 || resp.status === 200) {
        sent++;
      } else if (resp.status === 404 || resp.status === 410) {
        // Subscription expired or unsubscribed
        toRemove.push(sub.endpoint);
      } else {
        log.warn("push delivery failed", { status: resp.status, endpoint: sub.endpoint.slice(0, 60) });
        failed++;
      }
    } catch (e) {
      log.warn("push send error", { error: errMsg(e), endpoint: sub.endpoint.slice(0, 60) });
      failed++;
    }
  }));

  // Prune dead subscriptions
  if (toRemove.length > 0) {
    const remaining = subs.filter((s) => !toRemove.includes(s.endpoint));
    saveSubscriptions(remaining);
    log.info("pruned expired push subscriptions", { count: toRemove.length });
  }

  return { sent, failed, pruned: toRemove.length };
}
