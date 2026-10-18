import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ExtensionRuntime, getExtensionRuntime, __setExtensionRuntimeForTests } from "../../src/extensions/runtime.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MockBackend } from "../../src/server/mock-backend.ts";
import { createServerContext, getDefaultServerContext, setDefaultServerContext } from "../../src/server/context.ts";
import { createTaskRoutes } from "../../src/server/task-routes.ts";
import { TaskGateway, __resetTaskGatewayForTests } from "../../src/tasks/gateway.ts";
import { WorkerRelayGateway } from "../../src/task-relay/worker-client.ts";

process.env.WOLFPACK_TEST = "1";

class InspectableBackend extends MockBackend {
  readonly inspected: string[] = [];
  beforeInspect = async (_selector: string): Promise<void> => {};
  constructor(readonly name: string, readonly project: string, readonly id = `mock:${name}`) { super({ sessions: [name] }); }
  override async listIdentities() {
    const identities = await super.listIdentities();
    for (const identity of Object.values(identities)) {
      identity.wolfpackSessionId = this.id;
      identity.agentKind = "pi";
      identity.projectPath = this.project;
    }
    return identities;
  }
  override async inspectSession(selector: string) {
    this.inspected.push(selector);
    await this.beforeInspect(selector);
    return super.inspectSession(selector);
  }
}

// Interleave real sends at the authority check, not a timing-dependent sleep.
test("a task request cannot rebind another context's in-flight session inspector", async () => {
  const root = mkdtempSync(join(tmpdir(), "context-task-"));
  const previousRoot = process.env.WOLFPACK_TASK_ROOT;
  process.env.WOLFPACK_TASK_ROOT = join(root, "legacy");
  __resetTaskGatewayForTests();
  const a = new InspectableBackend("a", root), b = new InspectableBackend("b", root);
  let entered!: () => void, release!: () => void;
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  b.beforeInspect = async () => { if (first) { first = false; entered(); await resumed; } };
  const servers = [a, b].map(backend => {
    const routes = createTaskRoutes(createServerContext({ backend, taskRoot: join(root, backend.name) }));
    return createServer((req, res) => { void routes["POST /api/tasks/v1/send"]!(req, res); });
  });
  try {
    for (const server of servers) await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const send = (index: number, name: string) => fetch(`http://127.0.0.1:${(servers[index]!.address() as AddressInfo).port}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ callerSession: name, to: { machine: "local", sessionId: `mock:${name}` }, task: "inspect the exact target" }),
    }).then(response => response.json());
    const pendingB = send(1, "b");
    await blocked;
    expect(await send(0, "a")).toMatchObject({ ok: true });
    release();
    expect(await pendingB).toMatchObject({ ok: true });
    expect(b.inspected).toContain("mock:b");
    expect(a.inspected).not.toContain("mock:b");
  } finally {
    release();
    await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
    __resetTaskGatewayForTests();
    if (previousRoot === undefined) delete process.env.WOLFPACK_TASK_ROOT; else process.env.WOLFPACK_TASK_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("context relay workers retain their own inspectors after another context sends a task", async () => {
  const root = mkdtempSync(join(tmpdir(), "context-relay-"));
  const backends = ["a", "b"].map(name => new InspectableBackend(name, root));
  const contexts = backends.map(backend => createServerContext({
    backend, taskRoot: join(root, backend.name, "tasks"), taskRelayRoot: join(root, backend.name, "relay"),
  }));
  const [a, b] = contexts;
  try {
    const relayB = b!.taskRelayGateway;
    const routes = createTaskRoutes(a!);
    const server = createServer((req, res) => { void routes["POST /api/tasks/v1/send"]!(req, res); });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ callerSession: "a", to: { machine: "local", sessionId: "mock:a" }, task: "keep backend ownership" }),
      });
      expect(response.status).toBe(200);
      expect(await relayB.volatile({ profile: "volatile-v1", operation: "connect", callerSession: "b", generation: "generation", protocolVersions: [2] })).toMatchObject({ ok: true, value: { kind: "connected" } });
      expect(backends[1]!.inspected).toContain("b");
      expect(backends[0]!.inspected).not.toContain("b");
      expect(a!.taskRelayGateway).not.toBe(relayB);
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  } finally {
    await Promise.all(contexts.map(context => context.taskRelayGateway.close()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("extension document authority follows the HTTP context, not the default backend", async () => {
  const root = mkdtempSync(join(tmpdir(), "context-extension-"));
  const previousRuntime = getExtensionRuntime();
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "package.json"), JSON.stringify({
    name: "context-fixture", version: "1.0.0", wolfpack: { manifestVersion: 1, apiVersion: 1,
      id: "context-fixture", ui: "ui.js", skills: [], documents: [{ id: "context", schemaVersion: 1, schema: "schema.json" }] },
  }));
  writeFileSync(join(source, "ui.js"), "export default () => null;");
  writeFileSync(join(source, "schema.json"), JSON.stringify({ type: "object", properties: { schemaVersion: { const: 1 } } }));
  const runtime = new ExtensionRuntime({ root: join(root, "runtime"), installationId: randomUUID() });
  const { createServerInstance } = await import("../../src/server/index.ts");
  const backends = ["a", "b"].map(name => new InspectableBackend(name, root, randomUUID()));
  const servers = backends.map(backend => createServerInstance(createServerContext({ backend })).server);
  try {
    await runtime.install({ source, trustBrowserCode: true });
    __setExtensionRuntimeForTests(runtime);
    for (const server of servers) await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const publish = (index: number, scope: string) => fetch(`http://127.0.0.1:${(servers[index]!.address() as AddressInfo).port}/api/extensions/documents/context-fixture/context`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: scope, document: { schemaVersion: 1 }, ifRevision: 0, requestId: randomUUID(), schemaVersion: 1 }),
    });
    expect((await publish(0, backends[1]!.id)).status).toBe(409);
    expect((await publish(0, backends[0]!.id)).status).toBe(200);
    expect((await publish(1, backends[1]!.id)).status).toBe(200);
  } finally {
    await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
    __setExtensionRuntimeForTests(previousRuntime);
    rmSync(root, { recursive: true, force: true });
  }
});

test("gateways without an inspector retain default-backend inspection", async () => {
  const root = mkdtempSync(join(tmpdir(), "context-fallback-"));
  const previous = getDefaultServerContext();
  const backend = new InspectableBackend("legacy", root);
  setDefaultServerContext(createServerContext({ backend }));
  const tasks = new TaskGateway({ root: join(root, "tasks") });
  const relay = new WorkerRelayGateway({ root: join(root, "relay") });
  try {
    const taskResult = await tasks.inbox("legacy", "0", false);
    const relayResult = await relay.volatile({ profile: "volatile-v1", operation: "connect", callerSession: "legacy", generation: "generation", protocolVersions: [2] });
    expect({ taskResult, relayResult }).toMatchObject({ taskResult: { ok: true }, relayResult: { ok: true, value: { kind: "connected" } } });
    expect(backend.inspected.filter(selector => selector === "legacy").length).toBeGreaterThanOrEqual(2);
  } finally {
    await relay.close();
    setDefaultServerContext(previous);
    rmSync(root, { recursive: true, force: true });
  }
});
