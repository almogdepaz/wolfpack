import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { FocusStore } from "../../src/server/focus-store.ts";
process.env.WOLFPACK_TEST = "1";
const { createServerContext } = await import("../../src/server/context.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");
const { createRoutes } = await import("../../src/server/routes.ts");

test("focus HTTP CAS, first write, invalid ops and corrupt-file protection", async () => {
  const root = mkdtempSync(join(tmpdir(), "focus-route-"));
  const path = join(root, "assistant", "focus.json");
  const ctx = createServerContext({ backend: new MockBackend({ sessions: ["live"] }), config: null, focusStore: new FocusStore(path), taskRelayRoot: join(root, "relay") });
  const routes = createRoutes(ctx);
  const server = createServer((req, res) => { void routes[`${req.method} ${new URL(req.url!, "http://localhost").pathname}`]!(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown) => fetch(`${base}/api/focus`, { method: "POST", headers: { Authorization: "Bearer peer-credential", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const first = await (await fetch(`${base}/api/focus`)).json();
    expect(first.document).toBeNull();
    expect(first.revision).toBe(0);
    const write = { expectedRevision: 0, ops: [{ type: "add", intention: { id: "ship", title: "ship" } }] };
    expect((await post(write)).status).toBe(200);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const conflict = await post(write);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).document.intentions[0].title).toBe("ship");
    expect((await post({ expectedRevision: 1, ops: [{ type: "done", id: "absent" }] })).status).toBe(400);
    const dashboard = await (await fetch(`${base}/api/sessions`)).json();
    expect(dashboard.sessions[0].changedAt).toBe(dashboard.sessions[0].runtimeState.changedAt);
    writeFileSync(path, "corrupt");
    expect((await fetch(`${base}/api/focus`)).status).toBe(503);
    expect((await post(write)).status).toBe(503);
    expect(readFileSync(path, "utf8")).toBe("corrupt");
    rmSync(path);
    const parent = join(root, "assistant");
    chmodSync(parent, 0o500);
    try { expect((await post(write)).status).toBe(503); }
    finally { chmodSync(parent, 0o700); }
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  }
});

test("peer clients use normal owner auth for focus reads and CAS writes; non-home refuses local writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "focus-peer-auth-"));
  const prior = process.env.WOLFPACK_JWT_SECRET;
  const { __resetJwtAuthConfig } = await import("../../src/test-hooks.ts");
  const { issueJwt } = await import("../../src/jwt-issue.ts");
  process.env.WOLFPACK_JWT_SECRET = "focus-peer-test-secret-012345678901234567890";
  __resetJwtAuthConfig();
  const { createServerInstance } = await import("../../src/server/index.ts");
  const ctx = createServerContext({ backend: new MockBackend(), config: null, focusStore: new FocusStore(join(root, "focus.json")) });
  const { server, wss } = createServerInstance(ctx);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    expect((await fetch(`${base}/api/focus`)).status).toBe(401);
    const headers = { Authorization: `Bearer ${issueJwt()}`, "Content-Type": "application/json" };
    const response = await fetch(`${base}/api/focus`, { headers });
    expect(response.status).toBe(200);
    const current = await response.json();
    const body = JSON.stringify({ expectedRevision: current.revision, ops: [{ type: "add", intention: { id: "peer", title: "written from a peer client" } }] });
    expect((await fetch(`${base}/api/focus`, { method: "POST", body })).status).toBe(401);
    expect((await fetch(`${base}/api/focus`, { method: "POST", headers, body })).status).toBe(200);
    expect((await (await fetch(`${base}/api/focus`, { headers })).json()).document.intentions[0].id).toBe("peer");
    const remoteCtx = createServerContext({ backend: new MockBackend(), config: { devDir: root, port: 19791, focus: { home: "other-install" } }, focusStore: ctx.focusStore });
    const { createFocusRoutes } = await import("../../src/server/focus-routes.ts");
    const remoteRoutes = createFocusRoutes(remoteCtx);
    const remote = createServer((req, res) => { void remoteRoutes[`${req.method} /api/focus` as "GET /api/focus"]!(req, res); });
    await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
    try {
      const remoteBase = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`;
      const read = await (await fetch(`${remoteBase}/api/focus`)).json();
      expect(read.local).toBe(false);
      expect(read.document).toBeNull();
      expect((await fetch(`${remoteBase}/api/focus`, { method: "POST", body })).status).toBe(409);
    } finally { await new Promise<void>(resolve => { remote.close(() => resolve()); remote.closeAllConnections(); }); }
  } finally {
    wss.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    if (prior === undefined) delete process.env.WOLFPACK_JWT_SECRET; else process.env.WOLFPACK_JWT_SECRET = prior;
    __resetJwtAuthConfig();
    rmSync(root, { recursive: true, force: true });
  }
});

test("focus config preserves home identity and refuses invalid home", async () => {
  const { parseConfig } = await import("../../src/config.ts");
  expect(parseConfig({ devDir: "/tmp", port: 19791, focus: { home: "home-install" } })?.focus).toEqual({ home: "home-install" });
  expect(parseConfig({ devDir: "/tmp", port: 19791, focus: { home: "" } })).toBeNull();
});

test("routine routes on the focus home: catch-up, status in /api/focus, day note, ack contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "focus-routine-routes-"));
  const { AssistantService } = await import("../../src/server/assistant-service.ts");
  const { ActivityJournal } = await import("../../src/server/activity-journal.ts");
  const assistantService = new AssistantService({ root, readConfig: () => null });
  let enabled = false;
  Object.defineProperty(assistantService, "enabled", { get: () => enabled });
  const ctx = createServerContext({ backend: new MockBackend(), config: null, assistantService, focusStore: new FocusStore(join(root, "assistant", "focus.json")),
    activityJournal: new ActivityJournal({ dir: join(root, "activity") }), taskRelayRoot: join(root, "relay") });
  const routes = createRoutes(ctx);
  const server = createServer((req, res) => { void routes[`${req.method} ${new URL(req.url!, "http://localhost").pathname}`]!(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  try {
    expect((await post("/api/focus/catch-up")).status).toBe(409);
    enabled = true;
    const caught = await post("/api/focus/catch-up");
    expect(caught.status).toBe(200);
    expect((await caught.json()).notice).toBe("nothing new to catch up on");
    const focus = await (await fetch(`${base}/api/focus?open=1`)).json();
    expect(focus.routines).toMatchObject({ catchingUp: null, surfaced: null, unreachable: [] });
    expect(focus.routines.yesterday.date).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect((await fetch(`${base}/api/focus/day-note?date=bad`)).status).toBe(400);
    expect((await fetch(`${base}/api/focus/day-note?date=2026-11-05`)).status).toBe(404);
    mkdirSync(join(root, "assistant", "days"), { recursive: true });
    writeFileSync(join(root, "assistant", "days", "2026-11-05.md"), "# 2026-11-05\n");
    expect(await (await fetch(`${base}/api/focus/day-note?date=2026-11-05`)).json()).toEqual({ date: "2026-11-05", markdown: "# 2026-11-05\n" });
    expect((await post("/api/activity/ack", { file: "../routines.json" })).status).toBe(400);
    expect((await post("/api/activity/ack", { nope: 1 })).status).toBe(400);
    expect((await post("/api/activity/ack", { file: "catch-up-20261106T100000Z.json" })).status).toBe(404);
  } finally {
    ctx.focusRuntime.stop();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  }
});
