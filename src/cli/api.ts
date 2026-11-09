/**
 * Shared CLI HTTP/auth helpers.
 */
import { issueJwt } from "../jwt-issue.js";
export { issueJwt } from "../jwt-issue.js";
import { loadConfig } from "./config.js";
import type { VerifiedMachineTarget } from "./machine-target.js";
import { qualifyRemoteTaskEndpoint, unqualifiedRemoteTaskEndpoint } from "./task-endpoint.js";

export function baseUrl(target?: VerifiedMachineTarget): string {
  if (target) return target.origin;
  const config = loadConfig();
  const port = config?.port ?? 18790;
  return `http://127.0.0.1:${port}`;
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
