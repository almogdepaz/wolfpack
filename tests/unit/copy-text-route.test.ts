import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const previousTestMode = process.env.WOLFPACK_TEST;
process.env.WOLFPACK_TEST = "1";
const { MockBackend } = await import("../../src/server/mock-backend.ts");
const { createServerContext } = await import("../../src/server/context.ts");
const { createRoutes } = await import("../../src/server/routes.ts");
const panes: Record<string, string> = {
  "worker one": "\x1b[32mhello λ\x1b[0m\nsecond line\n",
  other: "other snapshot\n",
  empty: "",
};
const backend = new MockBackend({ sessions: Object.keys(panes), capturePane: async name => panes[name]! });
const handler = createRoutes(createServerContext({ backend, config: null }))["GET /api/copy-text"]!;
const server = createServer((req, res) => { void handler(req, res); });
let base: string;
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  if (previousTestMode === undefined) delete process.env.WOLFPACK_TEST;
  else process.env.WOLFPACK_TEST = previousTestMode;
});

for (const [session, expected] of [["worker one", "hello λ\nsecond line\n"], ["other", "other snapshot\n"], ["empty", ""]]) {
  test(`GET /api/copy-text returns uncached plain text for ${session}`, async () => {
    const response = await fetch(`${base}/api/copy-text?session=${encodeURIComponent(session!)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toBe(expected);
    expect(text).not.toContain("\x1b");
  });
}

test("GET /api/copy-text rejects a missing session", async () => {
  const response = await fetch(`${base}/api/copy-text`);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "missing session param" });
});
test("GET /api/copy-text rejects a session not in the backend list", async () => {
  const response = await fetch(`${base}/api/copy-text?session=missing`);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "session not found" });
});
