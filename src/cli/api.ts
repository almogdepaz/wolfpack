/**
 * Shared CLI HTTP/auth helpers.
 */
import { issueJwt } from "../jwt-issue.js";
import { loadConfig } from "../config.js";
import type { VerifiedMachineTarget } from "./machine-target.js";
import { qualifyRemoteTaskEndpoint, unqualifiedRemoteTaskEndpoint } from "./task-endpoint.js";

export function baseUrl(target?: VerifiedMachineTarget): string {
  if (target) return target.origin;
  const config = loadConfig();
  const port = config?.port ?? 18790;
  return `http://127.0.0.1:${port}`;
}

/** Why the CLI could not reach a Wolfpack server: no response, or a sandbox proxy refused the connection. */
export interface ServerTransportFailure {
  /** The request URL without its query. */
  readonly url: string;
  /** System error code (`ECONNREFUSED`, `EPERM`, Bun's `FailedToOpenSocket`, ...) or `proxy denial (HTTP 403)`. */
  readonly cause: string;
  readonly hint: string;
}

/** Bun reports some connect failures with its own codes; map the ones with a system equivalent. */
const BUN_TRANSPORT_CODES: Readonly<Record<string, string>> = {
  ConnectionRefused: "ECONNREFUSED",
  ConnectionReset: "ECONNRESET",
};

const LOCAL_SERVER_UNREACHABLE_HINT =
  "a sandboxed agent (for example Claude Code with its Bash sandbox) cannot reach the local Wolfpack server; "
  + "the sandbox or its network proxy blocks the connection";
const REMOTE_SERVER_UNREACHABLE_HINT =
  "check that the machine is reachable; a sandboxed agent's network proxy may block the connection";

export const PROXY_DENIAL_CAUSE = "proxy denial (HTTP 403)";

/** Extra time a long request allows past the server's own timeout before it gives up on the response. */
export const LONG_REQUEST_GRACE_MS = 30_000;

/**
 * Request options for a call whose response may stay silent longer than Bun's default fetch
 * timeout (~360 s in Bun 1.4.2, which then throws TimeoutError). Bun's `timeout: false` option,
 * absent from its RequestInit typing, disables that default; the caller's deadline replaces it.
 */
export function longRequestInit(init: RequestInit, deadlineMs: number): RequestInit {
  const options: RequestInit & { readonly timeout: false } = { ...init, timeout: false, signal: AbortSignal.timeout(deadlineMs) };
  return options;
}

function transportFailure(url: string, cause: string, target: VerifiedMachineTarget | undefined): ServerTransportFailure {
  return {
    url: url.split("?")[0]!,
    cause,
    hint: target ? REMOTE_SERVER_UNREACHABLE_HINT : LOCAL_SERVER_UNREACHABLE_HINT,
  };
}

function systemErrorCode(error: unknown): string | undefined {
  const code = (error as { readonly code?: unknown } | undefined)?.code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

/**
 * Describe a `fetch` that failed without a response. Only errors that carry a connect error
 * code count, so a deadline, an abort, or a local failure (token, JSON parse) returns undefined
 * and callers keep reporting it as before.
 */
export function serverTransportFailure(
  error: unknown,
  url: string,
  target?: VerifiedMachineTarget,
): ServerTransportFailure | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name === "TimeoutError" || error.name === "AbortError") return undefined;
  const code = systemErrorCode(error) ?? systemErrorCode(error.cause);
  if (code === undefined) return undefined;
  return transportFailure(url, BUN_TRANSPORT_CODES[code] ?? code, target);
}

/**
 * A sandbox network proxy refuses a connection with its own HTTP 403 and a plain-text body.
 * Wolfpack servers answer 403 only with JSON, so a non-JSON 403 is the proxy, not the server.
 */
export function proxyDenialFailure(
  response: Response,
  url: string,
  target?: VerifiedMachineTarget,
): ServerTransportFailure | undefined {
  if (response.status !== 403) return undefined;
  if ((response.headers.get("content-type") ?? "").toLowerCase().includes("json")) return undefined;
  return transportFailure(url, PROXY_DENIAL_CAUSE, target);
}

export async function call(
  path: string,
  init: RequestInit = {},
  target?: VerifiedMachineTarget,
): Promise<Response> {
  const headers = new Headers(init.headers);
  const jwt = issueJwt();
  if (jwt) headers.set("Authorization", `Bearer ${jwt}`);
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${baseUrl(target)}${path}`, { ...init, headers });
  const pathname = path.split("?")[0];
  if (!target || !response.ok || !["/api/session-open", "/api/session-create", "/api/session-control/status", "/api/session-control/list"].includes(pathname!)) return response;
  const value: unknown = await response.json();
  const projected = pathname === "/api/session-control/list"
    ? value && typeof value === "object" && "sessions" in value && Array.isArray(value.sessions)
      ? { ...value, sessions: value.sessions.map(session => unqualifiedRemoteTaskEndpoint(session)) } : value
    : await qualifyRemoteTaskEndpoint(value, { origin: target.origin, localBase: baseUrl(), callerSession: process.env.WOLFPACK_SESSION_NAME, headers });
  return Response.json(projected, { status: response.status, headers: { "cache-control": "no-store" } });
}
