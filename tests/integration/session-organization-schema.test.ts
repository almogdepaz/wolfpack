import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateControlApiSchemaValue as validate } from "../control-api-schema-validator.ts";

const prior = process.env.WOLFPACK_TEST;
process.env.WOLFPACK_TEST = "1";
const { MockBackend } = await import("../../src/server/mock-backend.ts");
const { createServerContext } = await import("../../src/server/context.ts");
const { createSessionControlRoutes } = await import("../../src/server/session-control-routes.ts");
const { SessionOrganizationService } = await import("../../src/server/session-organization.ts");
afterAll(() => { if (prior === undefined) delete process.env.WOLFPACK_TEST; else process.env.WOLFPACK_TEST = prior; });
const schema = JSON.parse(readFileSync("docs/generated/control-api.schema.json", "utf8"));
const contract = schema.http.updateSessionOrganization;
const ID = "11111111-1111-4111-8111-111111111111";
class Backend extends MockBackend {
  constructor() { super({ sessions: ["live"] }); }
  override async listIdentities() {
    const identities = await super.listIdentities();
    identities.live!.wolfpackSessionId = ID;
    return identities;
  }
}
async function withRoute(run: (post: (update: Record<string, unknown>) => Promise<Response>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "organization-schema-"));
  const routes = createSessionControlRoutes(createServerContext({ backend: new Backend(), config: null, sessionOrganization: new SessionOrganizationService({ root }) }));
  const server = createServer((req, res) => {
    const handler = routes[`${req.method} ${new URL(req.url!, "http://localhost").pathname}`];
    if (!handler) { res.writeHead(404).end(); return; }
    void handler(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/session-control/organization`;
  const post = (body: Record<string, unknown>) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    expect((await post({ sessionId: ID, expectedRevision: 0, group: "seed", tags: ["seed"] })).status).toBe(200);
    await run(post);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  }
}

for (const [name, update, expected] of [
  ["decomposed group", { group: "e\u0301".repeat(64) }, { group: "é".repeat(64), tags: ["seed"] }],
  ["decomposed tag", { tags: ["e\u0301".repeat(64)] }, { group: "seed", tags: ["é".repeat(64)] }],
  ["trimmed group", { group: `  ${"x".repeat(64)}  ` }, { group: "x".repeat(64), tags: ["seed"] }],
  ["trimmed tag", { tags: [`  ${"x".repeat(64)}  `] }, { group: "seed", tags: ["x".repeat(64)] }],
  ["both fields", { group: ` ${"e\u0301".repeat(64)} `, tags: [` ${"e\u0301".repeat(64)} `] }, { group: "é".repeat(64), tags: ["é".repeat(64)] }],
  ["clear group", { group: null }, { group: null, tags: ["seed"] }],
  ["clear tags", { tags: [] }, { group: "seed", tags: [] }],
  ["clear both", { group: null, tags: [] }, { group: null, tags: [] }],
] as const) test(`organization raw request schema accepts runtime-valid ${name}`, async () => {
  await withRoute(async post => {
    const body = { sessionId: ID, expectedRevision: 1, ...update };
    const response = await post(body);
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved).toEqual({ sessionId: ID, organization: { ...expected, revision: 2 } });
    expect(validate(contract.response, saved, schema)).toEqual([]);
    expect(validate(contract.request, body, schema)).toEqual([]);
  });
});

for (const [name, update] of [
  ["missing update fields", {}],
  ["unknown fields", { group: "valid", unknown: true }],
  ["too many tags", { tags: Array.from({ length: 17 }, (_, i) => String(i)) }],
] as const) test(`organization schema and runtime reject ${name}`, async () => {
  await withRoute(async post => {
    const body = { sessionId: ID, expectedRevision: 1, ...update };
    expect((await post(body)).status).toBe(400);
    expect(validate(contract.request, body, schema).length).toBeGreaterThan(0);
  });
});

test("organization normalized response limits and runtime label rejection remain unchanged", async () => {
  await withRoute(async post => {
    for (const update of [{ group: "x".repeat(65) }, { tags: ["e\u0301".repeat(65)] }, { group: "   " }, { tags: ["x\n"] }]) {
      expect((await post({ sessionId: ID, expectedRevision: 1, ...update })).status).toBe(400);
    }
    for (const organization of [{ group: "x".repeat(65), tags: [] }, { group: null, tags: ["é".repeat(65)] }]) {
      expect(validate(contract.response, { sessionId: ID, organization: { ...organization, revision: 1 } }, schema).length).toBeGreaterThan(0);
    }
  });
});
