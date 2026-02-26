import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

process.env.WOLFPACK_TEST = "1";
process.env.WOLFPACK_JWT_SECRET = "wolfpack-test-secret-long-enough-for-validation";
process.env.WOLFPACK_JWT_AUDIENCE = "wolfpack-client";

// Reset cached auth config + dynamic import so env vars take effect
const { __resetJwtAuthConfig } = await import("../../auth.ts");
__resetJwtAuthConfig();

const { __setTmuxList, server } = await import("../../serve.ts") as {
  __setTmuxList: (fn: () => Promise<string[]>) => void;
  server: Server;
};

const AUTH_SECRET = "wolfpack-test-secret-long-enough-for-validation";
const AUTH_AUDIENCE = "wolfpack-client";

let port = 0;
let baseUrl = "";
let baseWsUrl = "";

__setTmuxList(async () => ["auth-session"]);

function b64url(input: string): string {
  return Buffer.from(input, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createJwt(
  payload: Record<string, unknown>,
  opts?: { secret?: string; header?: Record<string, unknown> },
): string {
  const header = opts?.header ?? { alg: "HS256", typ: "JWT" };
  const secret = opts?.secret ?? AUTH_SECRET;
  const encodedHeader = b64url(JSON.stringify(header));
  const encodedPayload = b64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function createValidToken(): string {
  const now = Math.floor(Date.now() / 1000);
  return createJwt({
    sub: "integration-test",
    aud: AUTH_AUDIENCE,
    iat: now - 10,
    exp: now + 300,
  });
}

function createExpiredToken(): string {
  const now = Math.floor(Date.now() / 1000);
  return createJwt({
    sub: "integration-test",
    aud: AUTH_AUDIENCE,
    iat: now - 600,
    exp: now - 120,
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.addEventListener("close", () => resolve());
    ws.close();
  });
}

async function rawUpgrade(path: string): Promise<{ status: number; ws?: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${baseWsUrl}${path}`);
    ws.addEventListener("open", () => resolve({ status: 101, ws }));
    ws.addEventListener("error", () => resolve({ status: 0 }));
    ws.addEventListener("close", (ev) => resolve({ status: ev.code === 1006 ? 401 : ev.code }));
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}`;
      baseWsUrl = `ws://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
  delete process.env.WOLFPACK_JWT_SECRET;
  delete process.env.WOLFPACK_JWT_AUDIENCE;
  // Reset cached auth config so other test files sharing the module aren't affected
  __resetJwtAuthConfig();
});

describe("JWT auth middleware", () => {
  test("allows unauthenticated access to GET /api/info", async () => {
    const res = await fetch(`${baseUrl}/api/info`);
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string; version: string };
    expect(typeof body.name).toBe("string");
  });

  test("rejects protected API routes without a token", async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  test("rejects protected auth endpoints across GET/POST methods without a token", async () => {
    const protectedEndpoints = [
      { method: "GET", path: "/api/projects" },
      { method: "GET", path: "/api/sessions" },
      { method: "GET", path: "/api/settings" },
      { method: "GET", path: "/api/discover" },
      { method: "GET", path: "/api/ralph" },
      { method: "POST", path: "/api/send" },
      { method: "POST", path: "/api/key" },
      { method: "POST", path: "/api/resize" },
      { method: "POST", path: "/api/ralph/start" },
      { method: "POST", path: "/api/ralph/cancel" },
    ] as const;

    for (const endpoint of protectedEndpoints) {
      const res = await fetch(`${baseUrl}${endpoint.path}`, { method: endpoint.method });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      const body = await res.json() as { error: string };
      expect(body.error).toBe("unauthorized");
    }
  });

  test("rejects protected API routes with an invalid token", async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: "Bearer not-a-jwt" },
    });
    expect(res.status).toBe(401);
  });

  test("rejects expired JWTs on protected API routes", async () => {
    const token = createExpiredToken();
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("rejects JWTs with wrong audience", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createJwt({
      sub: "integration-test",
      aud: "wrong-audience",
      iat: now - 10,
      exp: now + 300,
    });
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("does not accept JWT in query string for HTTP auth endpoints", async () => {
    const token = createValidToken();
    const res = await fetch(`${baseUrl}/api/projects?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(401);
  });

  test("accepts protected API routes with a valid JWT", async () => {
    const token = createValidToken();
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { projects: string[] };
    expect(Array.isArray(body.projects)).toBe(true);
  });

  test("reaches endpoint validation logic when authorized", async () => {
    const token = createValidToken();
    const res = await fetch(`${baseUrl}/api/poll`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("missing session param");
  });

  test("rejects websocket upgrade without token", async () => {
    const { status, ws } = await rawUpgrade("/ws/terminal?session=auth-session");
    expect(status).not.toBe(101);
    if (ws) await closeWs(ws);
  });

  test("accepts websocket upgrade with valid query JWT", async () => {
    const token = createValidToken();
    const { status, ws } = await rawUpgrade(
      `/ws/terminal?session=auth-session&token=${encodeURIComponent(token)}`,
    );
    expect(status).toBe(101);
    expect(ws).toBeDefined();
    await closeWs(ws!);
  });

  test("applies JWT auth to /ws/mobile and /ws/pty routes", async () => {
    const noTokenMobile = await rawUpgrade("/ws/mobile?session=auth-session");
    expect(noTokenMobile.status).not.toBe(101);
    if (noTokenMobile.ws) await closeWs(noTokenMobile.ws);

    const noTokenPty = await rawUpgrade("/ws/pty?session=auth-session");
    expect(noTokenPty.status).not.toBe(101);
    if (noTokenPty.ws) await closeWs(noTokenPty.ws);

    const token = createValidToken();
    const authedMobile = await rawUpgrade(
      `/ws/mobile?session=auth-session&token=${encodeURIComponent(token)}`,
    );
    expect(authedMobile.status).toBe(101);
    expect(authedMobile.ws).toBeDefined();
    await closeWs(authedMobile.ws!);

    const authedPty = await rawUpgrade(
      `/ws/pty?session=auth-session&token=${encodeURIComponent(token)}`,
    );
    expect(authedPty.status).toBe(101);
    expect(authedPty.ws).toBeDefined();
    await closeWs(authedPty.ws!);
  });

  // ── Signature & algorithm edge cases ──────────────────────────────────────

  test("rejects JWT signed with wrong secret", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createJwt(
      { sub: "test", aud: AUTH_AUDIENCE, iat: now - 10, exp: now + 300 },
      { secret: "wrong-secret-entirely" },
    );
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("rejects JWT with non-HS256 algorithm header", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createJwt(
      { sub: "test", aud: AUTH_AUDIENCE, iat: now - 10, exp: now + 300 },
      { header: { alg: "HS384", typ: "JWT" } },
    );
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("rejects JWT with 'none' algorithm", async () => {
    const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
    const now = Math.floor(Date.now() / 1000);
    const payload = b64url(JSON.stringify({
      sub: "test", aud: AUTH_AUDIENCE, iat: now - 10, exp: now + 300,
    }));
    const token = `${header}.${payload}.`;
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  // ── Malformed token structures ────────────────────────────────────────────

  test("rejects single-segment token", async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: "Bearer just-one-segment" },
    });
    expect(res.status).toBe(401);
  });

  test("rejects two-segment token (missing signature)", async () => {
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = b64url(JSON.stringify({ sub: "test" }));
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${header}.${payload}` },
    });
    expect(res.status).toBe(401);
  });

  test("rejects four-segment token", async () => {
    const token = createValidToken();
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${token}.extra` },
    });
    expect(res.status).toBe(401);
  });

  test("rejects empty bearer value", async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
  });

  test("rejects non-Bearer auth scheme", async () => {
    const token = createValidToken();
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Basic ${token}` },
    });
    expect(res.status).toBe(401);
  });

  // ── Temporal claim edge cases ─────────────────────────────────────────────

  test("rejects JWT with nbf in the future", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createJwt({
      sub: "test",
      aud: AUTH_AUDIENCE,
      iat: now - 10,
      exp: now + 600,
      nbf: now + 300, // not valid for another 5 minutes
    });
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("rejects JWT with iat far in the future", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createJwt({
      sub: "test",
      aud: AUTH_AUDIENCE,
      iat: now + 600, // issued 10 minutes from now
      exp: now + 900,
    });
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  // ── Audience variations ───────────────────────────────────────────────────

  test("rejects JWT with array audience not containing expected value", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createJwt({
      sub: "test",
      aud: ["other-service", "another-service"],
      iat: now - 10,
      exp: now + 300,
    });
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("accepts JWT with array audience containing expected value", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createJwt({
      sub: "test",
      aud: ["other-service", AUTH_AUDIENCE],
      iat: now - 10,
      exp: now + 300,
    });
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  test("rejects JWT with no audience claim", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createJwt({
      sub: "test",
      iat: now - 10,
      exp: now + 300,
    });
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  // ── Response shape on 401 ─────────────────────────────────────────────────

  test("401 response includes WWW-Authenticate Bearer realm header", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate");
    expect(wwwAuth).toContain("Bearer");
    expect(wwwAuth).toContain("realm=");
  });

  test("401 response body is JSON with error field", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  // ── Auth boundary: static assets bypass auth ──────────────────────────────

  test("static root (/) does not require auth", async () => {
    const res = await fetch(`${baseUrl}/`);
    // should serve index.html (200) or redirect — NOT 401
    expect(res.status).not.toBe(401);
  });

  test("manifest.json does not require auth", async () => {
    const res = await fetch(`${baseUrl}/manifest.json`);
    expect(res.status).not.toBe(401);
  });

  // ── WebSocket auth edge cases ─────────────────────────────────────────────

  test("rejects websocket with expired query token", async () => {
    const token = createExpiredToken();
    const { status, ws } = await rawUpgrade(
      `/ws/terminal?session=auth-session&token=${encodeURIComponent(token)}`,
    );
    expect(status).not.toBe(101);
    if (ws) await closeWs(ws);
  });

  test("rejects websocket with wrong-secret query token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createJwt(
      { sub: "test", aud: AUTH_AUDIENCE, iat: now - 10, exp: now + 300 },
      { secret: "wrong-secret" },
    );
    const { status, ws } = await rawUpgrade(
      `/ws/terminal?session=auth-session&token=${encodeURIComponent(token)}`,
    );
    expect(status).not.toBe(101);
    if (ws) await closeWs(ws);
  });
});
