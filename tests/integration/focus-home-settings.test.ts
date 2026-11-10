import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderReadiness } from "../../src/provider-readiness.ts";
import { ActivityJournal } from "../../src/server/activity-journal.ts";
import { FocusRoutines, localActivitySource } from "../../src/server/focus-routines.ts";
import { ASSISTANT_TIMING_DEFAULTS } from "../../src/focus-scheduler.ts";
import { parseConfig, loadConfigFromText } from "../../src/config.ts";
import { AssistantService } from "../../src/server/assistant-service.ts";
import { FocusStore } from "../../src/server/focus-store.ts";
import { createServerContext } from "../../src/server/context.ts";
import { MockBackend } from "../../src/server/mock-backend.ts";
import { createFocusRoutes } from "../../src/server/focus-routes.ts";
import { getInstallationId } from "../../src/tailnet-machine-installation.ts";

async function fixture(detectProviders?: () => Promise<ProviderReadiness[]>) {
  const root = mkdtempSync(join(tmpdir(), "focus-home-settings-"));
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify({ devDir: root, port: 19865, futureKey: { keep: true }, pinnedSessions: [] }));
  const raw = () => JSON.parse(readFileSync(path, "utf8"));
  const config = parseConfig(raw())!;
  const backend = new MockBackend();
  const service = new AssistantService({ root, readConfig: () => loadConfigFromText(readFileSync(path, "utf8")), writeConfig: c => writeFileSync(path, JSON.stringify(c)), detectProviders });
  const ctx = createServerContext({ backend, config, assistantService: service, focusStore: new FocusStore(join(root, "assistant/focus.json")), taskRelayRoot: join(root, "relay"), activityJournal: new ActivityJournal({ dir: join(root, "activity") }) });
  const routes = createFocusRoutes(ctx) as Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>;
  let arrived!: () => void;
  const homeArrived = new Promise<void>(resolve => { arrived = resolve; });
  let partialStarted!: () => void;
  const partialArrived = new Promise<void>(resolve => { partialStarted = resolve; });
  const server = createServer((req, res) => {
    if (req.url === "/api/focus/home") arrived();
    if (req.method === "POST" && (req.url === "/api/focus" || req.url === "/api/activity/ack")) partialStarted();
    const route = routes[`${req.method} ${new URL(req.url!, "http://localhost").pathname}`];
    if (route) void route(req, res); else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ctx, backend, service, config, path, raw, homeArrived, partialArrived,
    beginPartial(path: string, body: unknown) {
      const text = JSON.stringify(body);
      let req!: ReturnType<typeof request>;
      const response = new Promise<number>((resolve, reject) => {
        req = request(`${base}${path}`, { method: "POST" }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
        req.on("error", reject); req.write(text.slice(0, 5));
      });
      return { finish() { req.end(text.slice(5)); return response; } };
    },
    postAssistant: () => fetch(`${base}/api/focus/assistant`, { method: "POST", body: JSON.stringify({ enabled: true, loginConfirmed: true }) }),
    pin() { writeFileSync(path, JSON.stringify({ ...raw(), pinnedSessions: [{ name: "assistant", cwd: service.folder, command: ["pi"], harness: "pi" }] })); },
    post: (body: unknown) => fetch(`${base}/api/focus/home`, { method: "POST", body: JSON.stringify(body) }),
    get: () => fetch(`${base}/api/focus`).then(r => r.json()),
    async close() { ctx.focusRuntime.stop(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); rmSync(root, { recursive: true, force: true }); },
  };
}

test("home settings validate, preserve unknown keys, apply identity/routines/pins live, and return local with the assistant off", async () => {
  const f = await fixture();
  try {
    for (const body of [{}, { home: "" }, { home: "bad id" }, { home: 1 }, { home: "peer", extra: true }, { home: "x".repeat(129) }]) expect((await f.post(body)).status).toBe(400);
    expect((await f.post({ home: "peer-install" })).status).toBe(200);
    expect(f.raw().futureKey).toEqual({ keep: true });
    expect(f.config.focus).toEqual({ home: "peer-install" });
    expect(await f.get()).toMatchObject({ local: false, home: "peer-install", document: null });
    // Even a stale pin written by an older CLI must not launch on a non-home.
    f.pin();
    const helper = { name: "helper", cwd: f.config.devDir, command: ["sh"], harness: "shell" };
    writeFileSync(f.path, JSON.stringify({ ...f.raw(), pinnedSessions: [...f.raw().pinnedSessions, helper] }));
    await f.ctx.focusRuntime.pins.tick();
    expect((await f.backend.listSessionFacts()).map(fact => fact.name)).toEqual(["helper"]);
    expect((await f.ctx.focusRuntime.status()).enabled).toBe(false);
    expect(f.ctx.focusRuntime.routines.status().catchingUp).toBeNull();
    // A pin on a non-home is filtered out, not an enabled local assistant.
    expect((await f.post({ home: "another-peer" })).status).toBe(200);
    expect(f.config.focus).toEqual({ home: "another-peer" });
    expect((await f.ctx.focusRuntime.status()).enabled).toBe(false);
    expect((await f.post({ home: null })).status).toBe(200);
    expect(f.config.focus).toBeUndefined();
    expect(await f.get()).toMatchObject({ local: true, home: getInstallationId(), assistant: { enabled: false } });
    expect(f.raw().pinnedSessions).toEqual([helper]);
    expect(f.raw().futureKey).toEqual({ keep: true });
    expect(f.ctx.focusRuntime.routines.status().catchingUp).toBeNull();
  } finally { await f.close(); }
});

test.each([
  ["/api/focus", { expectedRevision: 0, ops: [{ type: "add", intention: { id: "late", title: "must not write on the old home" } }] }],
  ["/api/activity/ack", { file: "catch-up-20261106T100000Z.json" }],
])("an in-flight %s body cannot commit after this machine stops being the home", async (path, body) => {
  const f = await fixture();
  const pending = f.beginPartial(path, body);
  try {
    await f.partialArrived;
    expect((await f.post({ home: "peer-install" })).status).toBe(200);
    expect(await pending.finish()).toBe(409);
    expect(f.ctx.focusStore.read()).toBeNull();
  } finally { await f.close(); }
});

test("a home move cannot overtake an in-flight assistant enable", async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(async () => {
    started(); await gate;
    return [{ id: "pi", displayName: "Pi", command: "pi", status: "installed", executablePath: "/fixture/pi", version: "1.3.0", authStatus: "unknown", loginCommand: "pi" }];
  });
  try {
    const enabling = f.postAssistant();
    await entered;
    const moving = f.post({ home: "peer-install" });
    await f.homeArrived;
    expect((await f.get()).local).toBe(true);
    release();
    expect((await enabling).status).toBe(200);
    expect((await moving).status).toBe(409);
    expect(f.config.focus).toBeUndefined();
  } finally { release(); await f.close(); }
});

test("moving home drains an old journal pull and subsequent ticks do not pull for the non-home", async () => {
  const f = await fixture();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  let pulls = 0;
  const routines = new FocusRoutines({ folder: f.service.folder,
    enabled: () => f.service.enabled && f.ctx.focusRuntime.homeIsLocal(),
    sources: async () => { pulls++; started(); await gate; return [localActivitySource(getInstallationId(), "fixture", f.ctx.activityJournal)]; },
    timing: async () => ASSISTANT_TIMING_DEFAULTS, assistant: async () => ({ idle: false }), queueBusy: () => false,
    enqueue: () => { throw new Error("disabled assistant must not receive a routine"); },
  });
  Object.defineProperty(f.ctx.focusRuntime, "routines", { value: routines });
  try {
    f.pin();
    const pulling = routines.tick();
    await entered;
    writeFileSync(f.path, JSON.stringify({ ...f.raw(), pinnedSessions: [] }));
    const moving = f.post({ home: "peer-install" });
    await f.homeArrived;
    expect((await f.get()).local).toBe(true);
    release(); await pulling;
    expect((await moving).status).toBe(200);
    await routines.tick();
    expect(pulls).toBe(1);
    expect((await f.get()).local).toBe(false);
  } finally { release(); await f.close(); }
});

test("an enabled local assistant refuses a home move; invalid disk config never changes live ownership", async () => {
  const f = await fixture();
  try {
    f.pin();
    const before = readFileSync(f.path, "utf8");
    const refused = await f.post({ home: "peer-install" });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toContain("Disable this machine's assistant first");
    expect(readFileSync(f.path, "utf8")).toBe(before);
    expect(f.config.focus).toBeUndefined();
    writeFileSync(f.path, "{broken");
    expect((await f.post({ home: "peer-install" })).status).toBe(503);
    expect(f.config.focus).toBeUndefined();
    expect(readFileSync(f.path, "utf8")).toBe("{broken");
  } finally { await f.close(); }
});
