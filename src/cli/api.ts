/**
 * Shared CLI HTTP/auth helpers.
 */
import { createHmac, randomBytes } from "node:crypto";
import { loadConfig } from "./config.js";
import { yellow } from "./formatting.js";

export function baseUrl(): string {
  const config = loadConfig();
  const port = config?.port ?? 18790;
  return `http://127.0.0.1:${port}`;
}

/** Track a one-shot warning so a too-short JWT secret is surfaced once
 *  per CLI invocation rather than spammed on every API/WS call. */
let warnedShortSecret = false;

/** Mint a short-lived HS256 JWT if WOLFPACK_JWT_SECRET is set. Matches the
 *  format src/auth.ts validates. iss/aud filled in if the matching env vars
 *  are configured server-side. */
export function issueJwt(): string | null {
  const secret = process.env.WOLFPACK_JWT_SECRET;
  if (!secret) return null;
  if (secret.length < 32) {
    if (!warnedShortSecret) {
      warnedShortSecret = true;
      process.stderr.write(`${yellow(`  WOLFPACK_JWT_SECRET is set but only ${secret.length} chars; >=32 required. Sending unauthenticated; expect 401.`)}\n`);
    }
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { iat: now, exp: now + 60, jti: randomBytes(8).toString("hex") };
  const iss = process.env.WOLFPACK_JWT_ISSUER?.trim();
  if (iss) payload.iss = iss;
  const aud = process.env.WOLFPACK_JWT_AUDIENCE?.trim();
  if (aud) payload.aud = aud;
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `${header}.${body}`;
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const jwt = issueJwt();
  if (jwt) headers.set("Authorization", `Bearer ${jwt}`);
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  return fetch(`${baseUrl()}${path}`, { ...init, headers });
}
