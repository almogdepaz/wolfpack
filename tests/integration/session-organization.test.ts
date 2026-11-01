import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const prior = process.env.WOLFPACK_TEST;
process.env.WOLFPACK_TEST = "1";
const { MockBackend } = await import("../../src/server/mock-backend.ts");
const { createServerContext } = await import("../../src/server/context.ts");
const { createSessionControlRoutes } = await import("../../src/server/session-control-routes.ts");
const { createRoutes } = await import("../../src/server/routes.ts");
const { SessionOrganizationService } = await import("../../src/server/session-organization.ts");
afterAll(() => { if (prior === undefined) delete process.env.WOLFPACK_TEST; else process.env.WOLFPACK_TEST = prior; });

const ID = "11111111-1111-4111-8111-111111111111";
class Backend extends MockBackend {
  unavailable = false;
  id = ID;
  constructor() { super({ sessions: ["live"] }); }
  override async inspectSession(selector: string) {
    if (this.unavailable) throw new Error("broker disconnected");
    return super.inspectSession(selector);
  }
  override async listIdentities() {
    const identities = await super.listIdentities();
    identities.live!.wolfpackSessionId = this.id;
    return identities;
  }
}

test("organization HTTP read and guarded mutation persist canonical labels by UUID", async () => {
  const root = mkdtempSync(join(tmpdir(), "organization-route-"));
  const old = process.env.WOLFPACK_DIR;
  process.env.WOLFPACK_DIR = root;
  const backend = new Backend();
  const ctx = createServerContext({ backend, config: null, sessionOrganization: new SessionOrganizationService({ root: join(root, "store") }), taskRelayRoot: join(root, "relay") });
  const routes = { ...createRoutes(ctx), ...createSessionControlRoutes(ctx) };
  const server = createServer((req, res) => {
    const route = routes[`${req.method} ${new URL(req.url!, "http://localhost").pathname}`];
    if (!route) { res.writeHead(404).end(); return; }
    void route(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/session-control/organization`;
  try {
    const response = await fetch(`${url}?sessionId=${ID}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionId: ID, organization: { group: null, tags: [], revision: 0 } });
    const save = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: ID, expectedRevision: 0, group: " ops ", tags: ["Cafe\u0301", "CAFÉ", "urgent"] }) });
    expect(save.status).toBe(200);
    expect(await save.json()).toEqual({ sessionId: ID, organization: { group: "ops", tags: ["Café", "urgent"], revision: 1 } });
    const conflict = await fetch(url, { method: "POST", body: JSON.stringify({ sessionId: ID, expectedRevision: 0, group: null }) });
    expect(conflict.status).toBe(409);
    const post = (body: unknown) => fetch(url, { method: "POST", body: JSON.stringify(body) });
    expect((await post({ sessionId: "live", expectedRevision: 1, tags: [] })).status).toBe(400);
    expect((await post({ sessionId: ID, expectedRevision: 1, tags: [], extra: true })).status).toBe(400);
    expect((await post({ sessionId: ID, expectedRevision: 1, group: "x".repeat(9000) })).status).toBe(413);
    const statusUrl = url.replace("organization", `status?session=${ID}`);
    const status = await (await fetch(statusUrl)).json();
    const list = await (await fetch(url.replace("organization", "list"))).json();
    const dashboard = await (await fetch(url.replace("/session-control/organization", "/sessions"))).json();
    expect(status.organization).toEqual(list.sessions[0].organization);
    expect(dashboard.sessions[0].organization).toEqual(status.organization);
    expect(status.organization).toEqual({ group: "ops", tags: ["Café", "urgent"], revision: 1 });
    writeFileSync(join(root, "store", `${ID}.json`), "broken");
    expect((await fetch(`${url}?sessionId=${ID}`)).status).toBe(503);
    expect((await post({ sessionId: ID, expectedRevision: 1, tags: [] })).status).toBe(503);
    const degraded = await (await fetch(statusUrl)).json();
    expect(degraded.organization).toEqual({ status: "unavailable" });
    expect(degraded.terminal).toEqual({ exists: true, alive: true, status: "ready" });
    const degradedDashboard = await (await fetch(url.replace("/session-control/organization", "/sessions"))).json();
    expect(degradedDashboard.sessions[0].organization).toEqual({ status: "unavailable" });
    backend.setSessionAlive("live", false);
    expect((await post({ sessionId: ID, expectedRevision: 1, tags: [] })).status).toBe(410);
    backend.setSessionAlive("live", true);
    backend.id = "22222222-2222-4222-8222-222222222222";
    expect((await post({ sessionId: ID, expectedRevision: 1, tags: [] })).status).toBe(404);
    const replacement = await (await fetch(`${url}?sessionId=${backend.id}`)).json();
    expect(replacement.organization).toEqual({ group: null, tags: [], revision: 0 });
    backend.unavailable = true;
    expect((await fetch(`${url}?sessionId=${ID}`)).status).toBe(503);
  } finally {
    await ctx.taskRelayGateway.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    if (old === undefined) delete process.env.WOLFPACK_DIR; else process.env.WOLFPACK_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});
