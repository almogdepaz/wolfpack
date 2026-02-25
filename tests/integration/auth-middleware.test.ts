import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";

process.env.WOLFPACK_TEST = "1";
process.env.WOLFPACK_JWT_SECRET = "wolfpack-test-secret";
process.env.WOLFPACK_JWT_AUDIENCE = "wolfpack-client";

import { __setTmuxList, server } from "../../serve.ts";

const AUTH_SECRET = "wolfpack-test-secret";
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

function createJwt(payload: Record<string, unknown>): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = b64url(JSON.stringify(header));
  const encodedPayload = b64url(JSON.stringify(payload));
  const signature = createHmac("sha256", AUTH_SECRET)
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

  test("rejects protected API routes with an invalid token", async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: "Bearer not-a-jwt" },
    });
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
});
