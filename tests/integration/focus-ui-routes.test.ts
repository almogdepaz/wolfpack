import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { FOCUS_UI_PATH, FOCUS_UI_ACTION as A } from "../../src/focus-ui-log";
import { FocusUiJournal } from "../../src/server/focus-ui-journal";
process.env.WOLFPACK_TEST = "1";
const { createServerContext } = await import("../../src/server/context");
const { MockBackend } = await import("../../src/server/mock-backend");
const { createServerInstance } = await import("../../src/server/index");
const { __resetJwtAuthConfig } = await import("../../src/test-hooks");
const { issueJwt } = await import("../../src/jwt-issue");
test("ui endpoint uses owner auth, rejects unknown/content keys atomically and refuses non-home writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "focus-ui-route-"));
  const prior = process.env.WOLFPACK_JWT_SECRET;
  process.env.WOLFPACK_JWT_SECRET = "focus-ui-test-secret-at-least-32-characters";
  __resetJwtAuthConfig();
  const journal = new FocusUiJournal({ dir });
  const config = { devDir: dir, port: 19793, focus: undefined as { home: string } | undefined };
  const ctx = createServerContext({ backend: new MockBackend(), config, focusUiJournal: journal });
  const { server, wss } = createServerInstance(ctx);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const body = { events: [{ action: A.OPEN, visit: "v1", at: new Date().toISOString() }] };
  const headers = { Authorization: `Bearer ${issueJwt()}`, "Content-Type": "application/json" };
  const post = (data: unknown, auth = true) => fetch(base + FOCUS_UI_PATH, { method: "POST", ...(auth && { headers }), body: JSON.stringify(data) });
  try {
    expect((await post(body, false)).status).toBe(401);
    expect((await post(body)).status).toBe(200);
    expect(journal.readAll()).toHaveLength(1);
    expect((await post({ events: [...body.events, { ...body.events[0], text: "SECRET" }] })).status).toBe(400);
    expect(journal.readAll()).toHaveLength(1);
    expect((await post({ events: [{ ...body.events[0], at: "2000-01-01T00:00:00.000Z" }] })).status).toBe(400);
    expect((await post({ events: [], padding: "x".repeat(70_000) })).status).toBe(413);
    config.focus = { home: "other-install" };
    expect((await post(body)).status).toBe(409);
    expect(journal.readAll()).toHaveLength(1);
  } finally {
    journal.close(); wss.close();
    await new Promise<void>(r => { server.close(() => r()); server.closeAllConnections(); });
    if (prior === undefined) delete process.env.WOLFPACK_JWT_SECRET; else process.env.WOLFPACK_JWT_SECRET = prior;
    __resetJwtAuthConfig(); rmSync(dir, { recursive: true, force: true });
  }
});
