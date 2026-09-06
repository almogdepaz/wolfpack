/**
 * Web Push notification support — VAPID signing + payload encryption (RFC 8291).
 * Zero external dependencies, uses node:crypto only.
 */
import { createECDH, createSign, createPrivateKey, createHmac, createCipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createLogger, errMsg } from "../log.js";
import { buildSessionNotificationUrl } from "../session-notification-route.js";
import { onQuietAlertPolicyInvalidation } from "../quiet-alert-policy-invalidation.js";
import { isQuietAlertFact } from "../quiet-alert-policy.js";
import type { QuietAlertFact } from "../quiet-alert-policy.js";
import { readValidatedJsonFile } from "./persistence.js";

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
const PUSH_FETCH_TIMEOUT_MS = 10_000;
const PUSH_DELIVERY_TIMEOUT_CODE = "PUSH_DELIVERY_TIMEOUT";
const PUSH_RETRY_DELAYS_MS = [250, 1_000] as const;
const RETRYABLE_PUSH_STATUSES = new Set([408, 425, 429]);

const ALLOWED_PUSH_HOSTS = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "wns.windows.com",
  "web.push.apple.com",
]);

function isPushSubscription(value: unknown): value is PushSubscription {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.endpoint !== "string" || !candidate.keys || typeof candidate.keys !== "object") {
    return false;
  }
  const keys = candidate.keys as Record<string, unknown>;
  return typeof keys.p256dh === "string" && typeof keys.auth === "string";
}

function isSubscriptionStore(value: unknown): value is PushSubscription[] {
  return Array.isArray(value) && value.every(isPushSubscription);
}

function loadSubscriptions(): PushSubscription[] {
  return readValidatedJsonFile(SUBS_PATH, "push subscription", isSubscriptionStore) ?? [];
}

function saveSubscriptions(subs: PushSubscription[]): void {
  mkdirSync(dirname(SUBS_PATH), { recursive: true, mode: 0o700 });
  const tmp = SUBS_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(subs, null, 2), { mode: 0o600 });
  renameSync(tmp, SUBS_PATH);
  // fsync the containing directory so the rename is durable across an
  // ungraceful shutdown on non-CoW filesystems (ext4 without
  // data=ordered would otherwise be free to reorder the dir-entry write
  // and silently revert the subscription file).
  try {
    const dirFd = openSync(dirname(SUBS_PATH), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (e: unknown) {
    // macOS APFS rejects directory fsync with EINVAL/EISDIR — that's fine
    // because APFS already gives us atomic rename durability. Linux and
    // FreeBSD support it; if it fails there, log debug and continue (the
    // rename itself succeeded; durability is best-effort).
    log.debug("saveSubscriptions: dir fsync skipped", { error: errMsg(e) });
  }
}

/** Validate subscription keys have correct decoded lengths. Returns error string or null. */
export function validateSubscription(sub: PushSubscription): string | null {
  if (!sub.endpoint || typeof sub.endpoint !== "string") return "missing endpoint";
  if (sub.endpoint.length > MAX_ENDPOINT_LENGTH) return "endpoint too long";
  try {
    const url = new URL(sub.endpoint);
    if (url.protocol !== "https:") return "endpoint must use HTTPS";
    // Exact-match allowlist prevents SSRF via attacker-controlled subdomains
    if (!ALLOWED_PUSH_HOSTS.has(url.hostname)) {
      return "endpoint host not recognized as a push service";
    }
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
  const hadSubscriptions = subs.length > 0;
  // Dedupe by endpoint
  const idx = subs.findIndex((s) => s.endpoint === sub.endpoint);
  if (idx >= 0) {
    subs[idx] = sub;
  } else {
    if (subs.length >= MAX_SUBSCRIPTIONS) return { ok: false, error: "subscription limit reached (max " + MAX_SUBSCRIPTIONS + ")" };
    subs.push(sub);
  }
  saveSubscriptions(subs);
  if (!hadSubscriptions) resetSessionTransitionTracking();
  log.info("push subscription added", { endpoint: sub.endpoint.slice(0, 60) });
  return { ok: true };
}

export function removeSubscription(endpoint: string): void {
  const subs = loadSubscriptions().filter((s) => s.endpoint !== endpoint);
  saveSubscriptions(subs);
  if (subs.length === 0) resetSessionTransitionTracking();
  log.info("push subscription removed", { endpoint: endpoint.slice(0, 60) });
}

export function getSubscriptionCount(): number {
  return loadSubscriptions().length;
}

function registeredSubscriptionEndpoints(): ReadonlySet<string> {
  return new Set(loadSubscriptions().map((subscription) => subscription.endpoint));
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
  // P-256 sigs are always < 128 bytes so BER multi-byte length encoding cannot occur here.
  if (der.length < 8 || der[0] !== 0x30) throw new Error("derToRaw: invalid DER header");
  let offset = 2; // skip 0x30 + total length
  if (der[offset] !== 0x02) throw new Error("derToRaw: expected INTEGER tag for r");
  offset += 1;
  const rLen = der[offset++];
  if (offset + rLen > der.length) throw new Error("derToRaw: r length overflows");
  const r = der.subarray(offset, offset + rLen);
  offset += rLen;
  if (der[offset] !== 0x02) throw new Error("derToRaw: expected INTEGER tag for s");
  offset += 1;
  const sLen = der[offset++];
  if (offset + sLen > der.length) throw new Error("derToRaw: s length overflows");
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
  if (length > 32) throw new Error(`hkdfSha256: single-block limit is 32 bytes, requested ${length}`);
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

export interface NotificationSessionTarget {
  readonly sessionId: string;
  readonly sessionName: string;
}

export function buildAgentNotificationPayload(
  message: string,
  target?: NotificationSessionTarget,
): PushPayload {
  return {
    title: "Wolfpack",
    body: message,
    tag: "wolfpack-notify",
    ...(target && {
      url: buildSessionNotificationUrl({
        sessionId: target.sessionId,
        sessionName: target.sessionName,
        machineIdentity: "local",
      }),
    }),
  };
}

class PushDeliveryTimeoutError extends Error {
  readonly code = PUSH_DELIVERY_TIMEOUT_CODE;
  readonly endpoint: string;

  constructor(endpoint: string, timeoutMs: number) {
    super(`push delivery timed out after ${timeoutMs}ms`);
    this.name = "PushDeliveryTimeoutError";
    this.endpoint = endpoint;
  }
}

type PushFetch = (input: string, init: RequestInit) => Promise<Response>;

async function fetchWithDeadline(
  endpoint: string,
  init: RequestInit,
  timeoutMs: number,
  fetcher: PushFetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new PushDeliveryTimeoutError(endpoint, timeoutMs));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetcher(endpoint, { ...init, signal: controller.signal }),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type PushSleep = (delayMs: number) => Promise<void>;

function retryablePushStatus(status: number): boolean {
  return RETRYABLE_PUSH_STATUSES.has(status) || status >= 500;
}

async function sendSubscriptionWithRetry(
  sub: PushSubscription,
  payload: Buffer,
  vapid: VapidKeys,
  fetcher: PushFetch = fetch,
  sleep: PushSleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<number> {
  const audience = new URL(sub.endpoint).origin;
  const jwt = createVapidJwt(audience, "mailto:noreply@wolfpack.local", vapid);
  const { body } = encryptPayload(payload, sub);
  const request: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: "86400",
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
    },
    body: new Uint8Array(body),
  };

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetchWithDeadline(sub.endpoint, request, PUSH_FETCH_TIMEOUT_MS, fetcher);
      const retryDelay = PUSH_RETRY_DELAYS_MS[attempt];
      if (!retryablePushStatus(response.status) || retryDelay === undefined) return response.status;
      await sleep(retryDelay);
    } catch (error: unknown) {
      const retryDelay = PUSH_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) throw error;
      await sleep(retryDelay);
    }
  }
}

export interface PushDeliveryResult {
  readonly sent: number;
  readonly failed: number;
  readonly pruned: number;
}

interface PushDeliveryOutcome extends PushDeliveryResult {
  readonly successfulEndpoints: readonly string[];
  readonly failedEndpoints: readonly string[];
}

/**
 * Delivers to every current subscription or an explicit subset. The subset is
 * intersected with the current persisted store, so retries never pick up a
 * newly enrolled device. Endpoint details stay internal to notification
 * delivery and are never returned from public routes.
 */
async function sendPushToSubscriptions(
  payload: PushPayload,
  targetEndpoints: ReadonlySet<string> | undefined,
): Promise<PushDeliveryOutcome> {
  const subs = loadSubscriptions();
  if (subs.length === 0) {
    return { sent: 0, failed: 0, pruned: 0, successfulEndpoints: [], failedEndpoints: [] };
  }

  const vapid = getVapidKeys();
  const payloadBuf = Buffer.from(JSON.stringify(payload));

  // Filter out stored subscriptions with invalid endpoints (defense-in-depth for legacy data).
  const validSubs = subs.filter(sub => {
    try {
      const url = new URL(sub.endpoint);
      return url.protocol === "https:" && ALLOWED_PUSH_HOSTS.has(url.hostname);
    } catch { return false; }
  });
  if (validSubs.length < subs.length) {
    saveSubscriptions(validSubs);
    log.warn("pruned invalid subscriptions on send", { count: subs.length - validSubs.length });
  }
  const selectedSubs = targetEndpoints === undefined
    ? validSubs
    : validSubs.filter((subscription) => targetEndpoints.has(subscription.endpoint));
  if (selectedSubs.length === 0) {
    return { sent: 0, failed: 0, pruned: 0, successfulEndpoints: [], failedEndpoints: [] };
  }

  const results = await Promise.allSettled(selectedSubs.map(async (sub) => ({
    endpoint: sub.endpoint,
    status: await sendSubscriptionWithRetry(sub, payloadBuf, vapid),
  })));

  let sent = 0;
  let failed = 0;
  const successfulEndpoints: string[] = [];
  const failedEndpoints: string[] = [];
  const toRemove: string[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      if (result.reason instanceof PushDeliveryTimeoutError) {
        log.warn("push delivery timed out", { endpoint: result.reason.endpoint.slice(0, 60) });
      } else {
        log.warn("push send error", { error: errMsg(result.reason) });
      }
      failed++;
      continue;
    }
    if (result.value.status === 200 || result.value.status === 201) {
      sent++;
      successfulEndpoints.push(result.value.endpoint);
    } else if (result.value.status === 404 || result.value.status === 410) {
      toRemove.push(result.value.endpoint);
    } else {
      log.warn("push delivery failed", { status: result.value.status, endpoint: result.value.endpoint.slice(0, 60) });
      failed++;
      failedEndpoints.push(result.value.endpoint);
    }
  }

  // Rejected promises do not carry a safe endpoint in the settled result. Map
  // their positions back to the selected subscription list without logging it.
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      const subscription = selectedSubs[index];
      if (subscription) failedEndpoints.push(subscription.endpoint);
    }
  }

  if (toRemove.length > 0) {
    const remaining = validSubs.filter((subscription) => !toRemove.includes(subscription.endpoint));
    saveSubscriptions(remaining);
    if (remaining.length === 0) resetSessionTransitionTracking();
    log.info("pruned expired push subscriptions", { count: toRemove.length });
  }

  return { sent, failed, pruned: toRemove.length, successfulEndpoints, failedEndpoints };
}

export async function sendPush(payload: PushPayload): Promise<PushDeliveryResult> {
  const { sent, failed, pruned } = await sendPushToSubscriptions(payload, undefined);
  return { sent, failed, pruned };
}

// ── Push state tracking (quiet-alert delivery) ──

interface SessionTransitionFact {
  readonly name: string;
  readonly identity?: { readonly wolfpackSessionId?: string };
  readonly quietAlert?: QuietAlertFact;
}

interface QuietAlertDeliveryState {
  readonly episodeId: string;
  readonly attempts: number;
  readonly pendingEndpoints: ReadonlySet<string>;
  readonly nextAttemptAtMs: number;
}

const quietAlertDeliveries = new Map<string, QuietAlertDeliveryState>();
const lastSessionPushTime = new Map<string, number>();
const PUSH_DEBOUNCE_MS = 30_000;
const QUIET_ALERT_MAX_DELIVERY_ATTEMPTS = 3;

/** Rate-limit timestamps for POST /api/notify (10/min). */
let notifyTimestamps: number[] = [];

function sessionNotificationStableId(session: SessionTransitionFact): string | null {
  const id = session.identity?.wolfpackSessionId;
  return typeof id === "string" && id.length > 0 && id.length <= 256 ? id : null;
}

function quietAlertPayload(session: SessionTransitionFact, sessionId: string): PushPayload {
  const canRoute = session.name.length > 0 && session.name.length <= 100;
  return {
    title: `Wolfpack: ${session.name}`,
    body: "Quiet",
    tag: `session-${sessionId}`,
    ...(canRoute && {
      url: buildSessionNotificationUrl({
        sessionId,
        sessionName: session.name,
        machineIdentity: "local",
      }),
    }),
  };
}

type SessionPushResult = PushDeliveryResult & Partial<Pick<PushDeliveryOutcome, "successfulEndpoints" | "failedEndpoints">>;
type SessionPushSender = (payload: PushPayload, targetEndpoints: ReadonlySet<string>) => Promise<SessionPushResult>;
let testSessionPushSender: SessionPushSender | null = null;

async function sendSessionPush(payload: PushPayload, targetEndpoints: ReadonlySet<string>): Promise<SessionPushResult> {
  if (testSessionPushSender) return testSessionPushSender(payload, targetEndpoints);
  return sendPushToSubscriptions(payload, targetEndpoints);
}

function deliveryKey(sessionId: string): string {
  return sessionId;
}

function validQuietAlert(session: SessionTransitionFact, sessionId: string): QuietAlertFact | null {
  const alert = session.quietAlert;
  if (!isQuietAlertFact(alert) || alert.sessionId !== sessionId) return null;
  return alert;
}

async function deliverQuietAlert(
  session: SessionTransitionFact,
  sessionId: string,
  alert: QuietAlertFact,
  now: number,
): Promise<void> {
  const key = deliveryKey(sessionId);
  const existing = quietAlertDeliveries.get(key);
  if (existing?.episodeId === alert.episodeId && existing.pendingEndpoints.size === 0) return;
  if (existing?.episodeId === alert.episodeId && now < existing.nextAttemptAtMs) return;

  // Freeze the original recipients before debounce can defer the first attempt.
  // A device that subscribes after the episode becomes eligible must not get a
  // historical quiet alert when the delay expires.
  const initialEndpoints = registeredSubscriptionEndpoints();
  const matchingEpisode = existing?.episodeId === alert.episodeId;
  const targetEndpoints = matchingEpisode
    ? new Set([...existing.pendingEndpoints].filter((endpoint) => initialEndpoints.has(endpoint)))
    : initialEndpoints;
  const last = lastSessionPushTime.get(sessionId) ?? 0;
  if (now - last < PUSH_DEBOUNCE_MS) {
    if (!matchingEpisode) {
      quietAlertDeliveries.set(key, {
        episodeId: alert.episodeId,
        attempts: 0,
        pendingEndpoints: targetEndpoints,
        nextAttemptAtMs: last + PUSH_DEBOUNCE_MS,
      });
    }
    return;
  }
  if (targetEndpoints.size === 0) {
    quietAlertDeliveries.set(key, {
      episodeId: alert.episodeId,
      attempts: existing?.episodeId === alert.episodeId ? existing.attempts : 1,
      pendingEndpoints: new Set(),
      nextAttemptAtMs: now,
    });
    return;
  }

  const attempt = (existing?.episodeId === alert.episodeId ? existing.attempts : 0) + 1;
  const ownership = {
    episodeId: alert.episodeId,
    attempts: attempt,
    pendingEndpoints: targetEndpoints,
    nextAttemptAtMs: now,
  } as const;
  quietAlertDeliveries.set(key, ownership);
  const delivery = await sendSessionPush(quietAlertPayload(session, sessionId), targetEndpoints);
  // A new activity episode, continuity loss, disable, or removal can retire
  // this entry while the transport is in flight. Never let stale completion
  // consume or clear the newer episode.
  if (quietAlertDeliveries.get(key) !== ownership) return;

  if (delivery.sent > 0) lastSessionPushTime.set(sessionId, now);
  const failedEndpoints = delivery.failedEndpoints === undefined
    ? (delivery.failed > 0 ? targetEndpoints : new Set<string>())
    : new Set(delivery.failedEndpoints.filter((endpoint) => registeredSubscriptionEndpoints().has(endpoint)));
  quietAlertDeliveries.set(key, {
    episodeId: alert.episodeId,
    attempts: attempt,
    pendingEndpoints: attempt < QUIET_ALERT_MAX_DELIVERY_ATTEMPTS ? failedEndpoints : new Set(),
    nextAttemptAtMs: now + PUSH_DEBOUNCE_MS,
  });
}

/** Deliver each observed quiet episode once per subscription, with bounded retries. */
export async function checkSessionTransitions(sessions: readonly SessionTransitionFact[]): Promise<void> {
  if (getSubscriptionCount() === 0) return;
  const now = Date.now();
  const activeSessionIds = new Set<string>();
  for (const session of sessions) {
    const sessionId = sessionNotificationStableId(session);
    if (!sessionId) continue;
    activeSessionIds.add(sessionId);
    const alert = validQuietAlert(session, sessionId);
    if (!alert) {
      quietAlertDeliveries.delete(deliveryKey(sessionId));
      continue;
    }
    await deliverQuietAlert(session, sessionId, alert, now);
  }
  for (const sessionId of quietAlertDeliveries.keys()) {
    if (!activeSessionIds.has(sessionId)) quietAlertDeliveries.delete(sessionId);
  }
  for (const sessionId of lastSessionPushTime.keys()) {
    if (!activeSessionIds.has(sessionId)) lastSessionPushTime.delete(sessionId);
  }
}

export function resetSessionTransitionTracking(): void {
  quietAlertDeliveries.clear();
  lastSessionPushTime.clear();
}

onQuietAlertPolicyInvalidation(resetSessionTransitionTracking);

/** Check notify rate limit (10/min). Returns error string or null if ok. */
export function checkNotifyRateLimit(): string | null {
  const now = Date.now();
  notifyTimestamps = notifyTimestamps.filter(t => now - t < 60_000);
  if (notifyTimestamps.length >= 10) return "rate limit exceeded (10/min)";
  notifyTimestamps.push(now);
  return null;
}

// ── Test-only exports ──

/** Reset all per-namespace debounce and rate-limit state. Tests should call this in beforeEach. */
export function _testingResetDebounce(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("_testingResetDebounce() is only available in test mode");
  resetSessionTransitionTracking();
  notifyTimestamps = [];
  testSessionPushSender = null;
}

export const _testing = {
  createVapidJwt,
  encryptPayload,
  derToRaw,
  hkdfSha256,
  b64urlEncode,
  b64urlDecode,
  quietAlertDeliveries,
  lastSessionPushTime,
  PUSH_DEBOUNCE_MS,
  PUSH_FETCH_TIMEOUT_MS,
  fetchWithDeadline,
  sendSubscriptionWithRetry,
  quietAlertPayload,
  resetDebounce: _testingResetDebounce,
  get sessionPushSender() { return testSessionPushSender; },
  set sessionPushSender(sender: SessionPushSender | null) {
    if (!process.env.WOLFPACK_TEST) throw new Error("_testing.sessionPushSender is only available in test mode");
    testSessionPushSender = sender;
  },
  get notifyTimestamps() { return notifyTimestamps; },
  set notifyTimestamps(v: number[]) {
    if (!process.env.WOLFPACK_TEST) throw new Error("_testing.notifyTimestamps setter is only available in test mode");
    notifyTimestamps = v;
  },
};
