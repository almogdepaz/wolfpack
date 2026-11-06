import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { FocusStore } from "../../src/server/focus-store.ts";
process.env.WOLFPACK_TEST = "1";
const { createServerContext } = await import("../../src/server/context.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");
const { createRoutes } = await import("../../src/server/routes.ts");

test("focus HTTP CAS, first write, invalid ops, peer-style authenticated request and corrupt-file protection", async () => {
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
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  }
});

test("focus config preserves home identity and refuses invalid home", async () => {
  const { parseConfig } = await import("../../src/config.ts");
  expect(parseConfig({ devDir: "/tmp", port: 19791, focus: { home: "home-install" } })?.focus).toEqual({ home: "home-install" });
  expect(parseConfig({ devDir: "/tmp", port: 19791, focus: { home: "" } })).toBeNull();
});
