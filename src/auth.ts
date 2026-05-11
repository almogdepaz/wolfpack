import type { IncomingHttpHeaders } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createLogger } from "./log.js";

const log = createLogger("auth");

type JsonObject = Record<string, unknown>;

export interface JwtValidationOptions {
  issuer?: string;
  audience?: string;
  clockToleranceSec?: number;
  nowSeconds?: number;
}

export interface JwtValidationResult {
  ok: boolean;
  payload?: JsonObject;
  error?: string;
}

export interface JwtAuthConfig {
  enabled: boolean;
  /** True if WOLFPACK_JWT_SECRET was set (regardless of length). Distinguishes
   * "misconfigured" (set but rejected — e.g. too short) from "unset" (no
   * secret at all). Used by startup checks to fail hard on misconfiguration. */
  present: boolean;
  secret: string;
  issuer?: string;
  audience?: string;
  clockToleranceSec: number;
  /** Human-readable explanation when `present && !enabled` (i.e. secret was
   * set but rejected). Surfaced as a fatal startup error. */
  invalidReason?: string;
}

/** Result of {@link verifyJwtAuthAtStartup}. Used by the server bootstrap to
 * decide whether to abort, warn, or proceed silently. */
export type JwtStartupStatus = "ok" | "missing" | "invalid";

const BASE64URL_SEGMENT = /^[A-Za-z0-9\-_]+$/;
const DEFAULT_CLOCK_TOLERANCE_SEC = 30;

function decodeBase64Url(segment: string): Buffer {
  if (!segment || !BASE64URL_SEGMENT.test(segment)) {
    throw new Error("invalid base64url segment");
  }
  const padded = segment
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(segment.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function parseSegmentJson(segment: string): JsonObject {
  const decoded = decodeBase64Url(segment).toString("utf-8");
  const parsed = JSON.parse(decoded);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JWT segment must be a JSON object");
  }
  return parsed as JsonObject;
}

function readNumericClaim(payload: JsonObject, claim: string): number | null {
  const value = payload[claim];
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`invalid ${claim} claim`);
  }
  return value;
}

function hasAudience(payload: JsonObject, expectedAudience: string): boolean {
  const aud = payload.aud;
  if (typeof aud === "string") return aud === expectedAudience;
  if (Array.isArray(aud)) {
    return aud.some((value) => typeof value === "string" && value === expectedAudience);
  }
  return false;
}

export function extractBearerToken(authorization: string | string[] | undefined): string | null {
  const value = Array.isArray(authorization) ? authorization.find(Boolean) : authorization;
  if (!value) return null;
  const match = value.trim().match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : null;
}

const MIN_SECRET_LENGTH = 32;

export function getJwtAuthConfig(env: NodeJS.ProcessEnv = process.env): JwtAuthConfig {
  const secret = (env.WOLFPACK_JWT_SECRET ?? "").trim();
  const issuer = (env.WOLFPACK_JWT_ISSUER ?? "").trim() || undefined;
  const audience = (env.WOLFPACK_JWT_AUDIENCE ?? "").trim() || undefined;
  const parsedTolerance = Number(env.WOLFPACK_JWT_CLOCK_TOLERANCE_SEC);
  const clockToleranceSec =
    Number.isFinite(parsedTolerance) && parsedTolerance >= 0
      ? parsedTolerance
      : DEFAULT_CLOCK_TOLERANCE_SEC;

  const present = secret.length > 0;
  const enabled = present && secret.length >= MIN_SECRET_LENGTH;
  let invalidReason: string | undefined;
  if (present && !enabled) {
    invalidReason = `WOLFPACK_JWT_SECRET is too short (${secret.length} chars, minimum ${MIN_SECRET_LENGTH}).`;
  }

  return {
    enabled,
    present,
    secret,
    issuer,
    audience,
    clockToleranceSec,
    invalidReason,
  };
}

/** Pure classifier for startup decisions. Returns:
 *  - `"invalid"` — secret was set but rejected; caller MUST refuse to start.
 *  - `"missing"` — no secret at all; caller SHOULD log an ERROR and continue.
 *  - `"ok"` — secret valid and JWT enforcement is on.
 */
export function verifyJwtAuthAtStartup(cfg: JwtAuthConfig): JwtStartupStatus {
  if (cfg.present && !cfg.enabled) return "invalid";
  if (!cfg.present) return "missing";
  return "ok";
}

export function getRequestToken(
  headers: IncomingHttpHeaders,
  url: URL,
  allowQueryToken: boolean,
): string | null {
  const bearer = extractBearerToken(headers.authorization);
  if (bearer) return bearer;
  if (!allowQueryToken) return null;
  const token = (url.searchParams.get("token") ?? "").trim();
  return token || null;
}

export function validateJwtHs256(
  token: string,
  secret: string,
  options: JwtValidationOptions = {},
): JwtValidationResult {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return { ok: false, error: "malformed token" };
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = parseSegmentJson(encodedHeader);
    const payload = parseSegmentJson(encodedPayload);

    if (header.alg !== "HS256") {
      return { ok: false, error: "unsupported JWT algorithm" };
    }

    const expectedSignature = createHmac("sha256", secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest();
    const signature = decodeBase64Url(encodedSignature);
    if (
      signature.length !== expectedSignature.length ||
      !timingSafeEqual(signature, expectedSignature)
    ) {
      return { ok: false, error: "invalid signature" };
    }

    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const tolerance = options.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC;

    const exp = readNumericClaim(payload, "exp");
    if (exp != null && now - tolerance >= exp) {
      return { ok: false, error: "token expired" };
    }

    const nbf = readNumericClaim(payload, "nbf");
    if (nbf != null && now + tolerance < nbf) {
      return { ok: false, error: "token not active yet" };
    }

    const iat = readNumericClaim(payload, "iat");
    if (iat != null && now + tolerance < iat) {
      return { ok: false, error: "token issued in the future" };
    }

    if (options.issuer && payload.iss !== options.issuer) {
      return { ok: false, error: "invalid issuer" };
    }

    if (options.audience && !hasAudience(payload, options.audience)) {
      return { ok: false, error: "invalid audience" };
    }

    return { ok: true, payload };
  } catch (err: any) {
    return { ok: false, error: err?.message || "invalid token" };
  }
}

/** Cached config — read once at import time. Restart server to pick up env changes. */
let _cachedConfig: JwtAuthConfig | null = null;

export function getCachedJwtAuthConfig(): JwtAuthConfig {
  if (!_cachedConfig) {
    _cachedConfig = getJwtAuthConfig();
  }
  return _cachedConfig;
}

/** Reset cached config — only for tests that need to override env vars. */
export function __resetJwtAuthConfig(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__resetJwtAuthConfig() is only available in test mode");
  _cachedConfig = null;
}

export function validateRequestJwt(
  headers: IncomingHttpHeaders,
  url: URL,
  allowQueryToken: boolean,
): JwtValidationResult {
  const cfg = getCachedJwtAuthConfig();
  if (!cfg.enabled) return { ok: true, payload: {} };

  const token = getRequestToken(headers, url, allowQueryToken);
  if (!token) return { ok: false, error: "missing bearer token" };

  return validateJwtHs256(token, cfg.secret, {
    issuer: cfg.issuer,
    audience: cfg.audience,
    clockToleranceSec: cfg.clockToleranceSec,
  });
}
