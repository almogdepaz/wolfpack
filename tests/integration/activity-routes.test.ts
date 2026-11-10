import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ACTIVITY_KIND } from "../../src/activity-journal.ts";
import { ActivityJournal } from "../../src/server/activity-journal.ts";
process.env.WOLFPACK_TEST = "1";
const { createServerContext } = await import("../../src/server/context.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");

test("GET /api/activity pages rows behind normal owner auth, like /api/sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "activity-route-"));
  const prior = process.env.WOLFPACK_JWT_SECRET;
  const { __resetJwtAuthConfig } = await import("../../src/test-hooks.ts");
  const { issueJwt } = await import("../../src/jwt-issue.ts");
  process.env.WOLFPACK_JWT_SECRET = "activity-route-test-secret-01234567890123456789";
  __resetJwtAuthConfig();
  const { createServerInstance } = await import("../../src/server/index.ts");
  const { getInstallationId } = await import("../../src/tailnet-machine-installation.ts");
  const journal = new ActivityJournal({ dir: join(root, "activity") });
  for (const id of ["a", "b", "c"]) journal.append({ kind: ACTIVITY_KIND.TASK_UPDATED, taskId: id, eventType: "task.completed" });
  journal.append({ kind: ACTIVITY_KIND.INPUT, session: "app", source: "browser", bucket: "2026-11-06T10:00:00.000Z" });
  const ctx = createServerContext({ backend: new MockBackend(), config: null, activityJournal: journal, taskRelayRoot: join(root, "relay") });
  const { server, wss } = createServerInstance(ctx);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { Authorization: `Bearer ${issueJwt()}` };
  try {
    expect((await fetch(`${base}/api/activity`)).status).toBe(401);
    expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
    const first = await (await fetch(`${base}/api/activity?since=0&limit=2`, { headers })).json();
    expect(first.installationId).toBe(getInstallationId());
    expect(typeof first.machine).toBe("string");
    expect(first.journalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.rows.map((r: { seq: number }) => r.seq)).toEqual([1, 2]);
    expect(first).toMatchObject({ next: 2, headSeq: 4, oldestSeq: 1, truncated: false });
    expect(typeof first.lastInputAt).toBe("string");
    const second = await (await fetch(`${base}/api/activity?since=${first.next}`, { headers })).json();
    expect(second.rows.map((r: { seq: number }) => r.seq)).toEqual([3, 4]);
    const probe = await (await fetch(`${base}/api/activity?since=4&limit=0`, { headers })).json();
    expect(probe).toMatchObject({ rows: [], next: 4, headSeq: 4 });
    // git summary: owner auth, from/to required and ordered, only cwds of sessions active in the window
    journal.append({ kind: ACTIVITY_KIND.SESSION_CREATED, session: "app", sessionId: "app-id", cwd: root });
    const now = Date.now();
    const range = (from: number, to: number) => `from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`;
    expect((await fetch(`${base}/api/activity/git?${range(now - 60_000, now + 60_000)}`)).status).toBe(401);
    for (const query of ["", `from=${new Date(now).toISOString()}`, range(now, now), range(now, now - 1), `${range(now - 1, now)}&x=1`, "from=yesterday&to=today"]) {
      const response = await fetch(`${base}/api/activity/git?${query}`, { headers });
      expect(response.status).toBe(400);
    }
    const git = await fetch(`${base}/api/activity/git?${range(now - 60_000, now + 60_000)}`, { headers });
    expect(git.headers.get("cache-control")).toBe("no-store");
    expect(await git.json()).toEqual({ repos: [{ cwd: root, commits: [], error: "not a readable git repository", repository: false }] });
    expect(await (await fetch(`${base}/api/activity/git?${range(now - 7_200_000, now - 3_600_000)}`, { headers })).json()).toEqual({ repos: [] });
    const bad = await fetch(`${base}/api/activity?limit=5000`, { headers });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("cache-control")).toBe("no-store");
  } finally {
    wss.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    if (prior === undefined) delete process.env.WOLFPACK_JWT_SECRET; else process.env.WOLFPACK_JWT_SECRET = prior;
    __resetJwtAuthConfig();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli send records presence for the target session without the text", async () => {
  const root = mkdtempSync(join(tmpdir(), "activity-cli-presence-"));
  const { createRoutes } = await import("../../src/server/routes.ts");
  const { createServer } = await import("node:http");
  const journal = new ActivityJournal({ dir: join(root, "activity") });
  const ctx = createServerContext({ backend: new MockBackend({ sessions: ["live"] }), config: null, activityJournal: journal, taskRelayRoot: join(root, "relay") });
  const routes = createRoutes(ctx);
  const server = createServer((req, res) => { void routes[`${req.method} ${new URL(req.url!, "http://localhost").pathname}`]!(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const send = await fetch(`${base}/api/session-control/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: "live", text: "private words" }) });
    expect(send.status).toBe(200);
    const rows = journal.read(0, 100).rows;
    expect(rows.map(r => ({ kind: r.kind, session: "session" in r ? r.session : undefined, source: "source" in r ? r.source : undefined }))).toEqual([{ kind: ACTIVITY_KIND.INPUT, session: "live", source: "cli" }]);
    expect(JSON.stringify(rows)).not.toContain("private");
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
