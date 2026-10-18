import { createHmac, randomBytes } from "node:crypto";
import { printError, yellow } from "./terminal-output.js";

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
      printError(yellow(`  WOLFPACK_JWT_SECRET is set but only ${secret.length} chars; >=32 required. Sending unauthenticated; expect 401.`));
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
