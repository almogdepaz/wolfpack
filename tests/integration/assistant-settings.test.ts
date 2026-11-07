import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
process.env.WOLFPACK_TEST = "1";
const { createServerContext } = await import("../../src/server/context.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");
const { createRoutes } = await import("../../src/server/routes.ts");

test("assistant timing lives in bridge settings: defaults, validated writes, preserved by unrelated writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "assistant-settings-"));
  const prior = process.env.WOLFPACK_SETTINGS_PATH;
  const path = join(root, "bridge-settings.json");
  process.env.WOLFPACK_SETTINGS_PATH = path;
  const routes = createRoutes(createServerContext({ backend: new MockBackend(), config: null, taskRelayRoot: join(root, "relay") }));
  const server = createServer((req, res) => { void routes[`${req.method} ${new URL(req.url!, "http://localhost").pathname}`]!(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown) => fetch(`${base}/api/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    expect((await (await fetch(`${base}/api/settings`)).json()).settings.assistant).toEqual({ quietMinutes: 90, fallbackTime: "03:00", catchUpDebounceMinutes: 15, journalRetentionDays: 30 });
    const assistant = { quietMinutes: 45, fallbackTime: "04:30", catchUpDebounceMinutes: 5, journalRetentionDays: 14 };
    const saved = await post({ assistant });
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings.assistant).toEqual(assistant);
    expect(JSON.parse(readFileSync(path, "utf8")).assistant).toEqual(assistant);
    const bad = await post({ assistant: { ...assistant, quietMinutes: 10 } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "quietMinutes must be a whole number from 15 to 480", field: "quietMinutes", expected: "a whole number from 15 to 480" });
    const badTime = await post({ assistant: { ...assistant, fallbackTime: "4:30" } });
    expect(badTime.status).toBe(400);
    expect(await badTime.json()).toMatchObject({ field: "fallbackTime", expected: "HH:MM (00:00–23:59)" });
    expect((await post({ agentCmd: "shell" })).status).toBe(200);
    expect(JSON.parse(readFileSync(path, "utf8")).assistant).toEqual(assistant);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    if (prior === undefined) delete process.env.WOLFPACK_SETTINGS_PATH; else process.env.WOLFPACK_SETTINGS_PATH = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
