/**
 * `wolfpack ls` and `wolfpack kill <name>` — talk to the local server's
 * HTTP API. JWT auth is honored when WOLFPACK_JWT_SECRET is set.
 */
import { createHmac, randomBytes } from "node:crypto";
import { print, bold, dim, red, green, yellow } from "./formatting.js";
import { loadConfig } from "./config.js";

interface SessionRow {
  name: string;
  lastLine?: string;
  triage?: string;
}

function baseUrl(): string {
  const config = loadConfig();
  const port = config?.port ?? 18790;
  return `http://127.0.0.1:${port}`;
}

/** Track a one-shot warning so a too-short JWT secret is surfaced once
 *  per CLI invocation rather than spammed on every API call. (issues.md M1) */
let _warnedShortSecret = false;

/** Mint a short-lived HS256 JWT if WOLFPACK_JWT_SECRET is set. Matches the
 *  format src/auth.ts validates. iss/aud filled in if the matching env vars
 *  are configured server-side. */
function issueJwt(): string | null {
  const secret = process.env.WOLFPACK_JWT_SECRET;
  if (!secret) return null;
  if (secret.length < 32) {
    if (!_warnedShortSecret) {
      _warnedShortSecret = true;
      // Match the server's startup gate (auth.ts requires ≥32 chars).
      // Without this warning the CLI silently sends unauthenticated
      // requests and the user sees only generic 401s.
      print(yellow(`  WOLFPACK_JWT_SECRET is set but only ${secret.length} chars; ≥32 required. Sending unauthenticated; expect 401.`));
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

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const jwt = issueJwt();
  if (jwt) headers.set("Authorization", `Bearer ${jwt}`);
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  return fetch(`${baseUrl()}${path}`, { ...init, headers });
}

export async function lsSessions(): Promise<number> {
  let resp: Response;
  try {
    resp = await call("/api/sessions");
  } catch (e: unknown) {
    print(red(`  Could not reach the wolfpack server at ${baseUrl()}.`));
    print(dim(`  Is it running? Try: wolfpack service status`));
    print(dim(`  Error: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  }
  if (resp.status === 401) {
    print(red("  Auth required. Set WOLFPACK_JWT_SECRET to the server's secret and re-run."));
    return 1;
  }
  if (!resp.ok) {
    print(red(`  /api/sessions returned ${resp.status}: ${await resp.text()}`));
    return 1;
  }
  const data = (await resp.json()) as { sessions?: SessionRow[] };
  const sessions = data.sessions ?? [];
  if (sessions.length === 0) {
    print(dim("  No active sessions."));
    return 0;
  }
  print(bold(`  ${sessions.length} session${sessions.length === 1 ? "" : "s"}:`));
  print("");
  for (const s of sessions) {
    const triage = s.triage ?? "idle";
    const colored = triage === "running" ? green(triage) : triage === "idle" ? yellow(triage) : dim(triage);
    print(`    ${bold(s.name)}  ${colored}`);
    if (s.lastLine) print(`      ${dim(s.lastLine)}`);
  }
  print("");
  return 0;
}

export async function killSession(name: string | undefined): Promise<number> {
  if (!name) {
    print(red("  Usage: wolfpack kill <session>"));
    return 1;
  }
  let resp: Response;
  try {
    resp = await call("/api/kill", { method: "POST", body: JSON.stringify({ session: name }) });
  } catch (e: unknown) {
    print(red(`  Could not reach the wolfpack server at ${baseUrl()}.`));
    print(dim(`  Error: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  }
  if (resp.status === 401) {
    print(red("  Auth required. Set WOLFPACK_JWT_SECRET and re-run."));
    return 1;
  }
  if (resp.status === 404) {
    print(yellow(`  Session "${name}" not found.`));
    return 1;
  }
  if (!resp.ok) {
    print(red(`  Kill failed: HTTP ${resp.status} — ${await resp.text()}`));
    return 1;
  }
  print(green(`  Killed session "${name}".`));
  return 0;
}
