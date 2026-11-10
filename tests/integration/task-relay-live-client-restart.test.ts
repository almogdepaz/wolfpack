import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

// Explicit trusted source input permits testing the unmodified pre-recovery RAM client.
const source = process.env.WOLFPACK_PI_TASKS_SOURCE;
test.skipIf(!source)("baseline RAM controllers survive real server/worker restarts, response loss and a lease gap", async () => {
  expect(isAbsolute(source!)).toBe(true);
  expect(process.env.WOLFPACK_PI_TASKS_REVISION).toMatch(/^[0-9a-f]{40}$/);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim()).toBe(process.env.WOLFPACK_PI_TASKS_REVISION!);
  expect(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: source, encoding: "utf8" }).trim()).toBe("");
  const { createTaskStore } = await import(pathToFileURL(join(source!, "src/task-store.ts")).href);
  const { createVolatileTaskSession } = await import(pathToFileURL(join(source!, "src/volatile-task-session.ts")).href);
  const { deliverTaskInbox } = await import(pathToFileURL(join(source!, "src/task-inbox.ts")).href);
  const entries: any[] = [], dispatched: any[] = [];
  const host = {
    sendMessage(message: any, options: any) { entries.push({ type: "custom_message", ...message }); dispatched.push({ message, options }); },
    appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
  };
  const context = { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getEntries: () => entries } };
  const root = mkdtempSync(join(tmpdir(), "live-relay-restart-"));
  const mapping = join(root, "network.json");
  writeFileSync(mapping, "{}", { mode: 0o600 });
  mkdirSync(join(root, "state"), { mode: 0o700 });
  writeFileSync(join(root, "state/config.json"), JSON.stringify({ devDir: root, port: 18790 }), { mode: 0o600 });
  const ids = { sender: randomUUID(), receiver: randomUUID() };
  let child: ReturnType<typeof Bun.spawn> | undefined, errors: Promise<string> | undefined, port = 0;
  const stop = async (abrupt = false) => {
    if (!child) return;
    child.kill(abrupt ? "SIGKILL" : "SIGTERM");
    const timer = setTimeout(() => child?.kill("SIGKILL"), 5000);
    try { const code = await child.exited; if (!abrupt) expect(code, await errors).toBe(0); }
    finally { clearTimeout(timer); child = undefined; }
  };
  const boot = async () => {
    rmSync(join(root, "ready.json"), { force: true });
    const nonce = randomUUID();
    child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/volatile-peer-http.ts"), root, mapping, nonce], {
      cwd: root, env: { PATH: process.env.PATH, HOME: root, WOLFPACK_DIR: join(root, "state"), WOLFPACK_TEST: "1",
        WOLFPACK_TASK_RELAY_ROOT: join(root, "relay"), WOLFPACK_TEST_SESSION_IDS: JSON.stringify(ids),
        WOLFPACK_TEST_HTTP_PORT: String(port), WOLFPACK_BROKER_SOCKET: join(root, "no-live-broker.sock") },
      stdout: "ignore", stderr: "pipe",
    });
    errors = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    const deadline = Date.now() + 15_000;
    while (!existsSync(join(root, "ready.json")) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
    if (!existsSync(join(root, "ready.json"))) {
      child.kill("SIGKILL"); await child.exited;
      throw new Error(`server startup failed: ${await errors}`);
    }
    const ready = JSON.parse(readFileSync(join(root, "ready.json"), "utf8"));
    expect(ready).toMatchObject({ nonce, pid: child.pid });
    if (port) expect(ready.port).toBe(port); port = ready.port;
  };
  const stores = [createTaskStore(), createTaskStore()];
  const sessions: any[] = [];
  let dropSend = false, dropAck = false;
  const sends: string[] = [], acknowledgements: string[] = [];
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.operation === "send") sends.push(JSON.stringify(body.envelope));
    if (body.operation === "acknowledge") acknowledgements.push(String(init?.body));
    const response = await fetch(input, init);
    if (response.ok && ((body.operation === "send" && dropSend) || (body.operation === "acknowledge" && dropAck))) {
      if (body.operation === "send") dropSend = false; else dropAck = false;
      await response.arrayBuffer(); throw new Error("lost committed response");
    }
    return response;
  }, { preconnect: fetch.preconnect }) as typeof fetch;
  try {
    await boot();
    for (const [index, name] of ["sender", "receiver"].entries()) sessions.push(createVolatileTaskSession({
      url: `http://127.0.0.1:${port}/api/task-relay/volatile-v1`, callerSession: name, store: stores[index], fetch: fetcher,
    }));
    const a = await sessions[0].connect(), b = await sessions[1].connect();
    const bindings = stores.map((store: any) => store.getRelayTransportBinding());
    dropSend = true;
    const task = await a.createTask({ target: b.endpoint, task: "do this only once", timeoutMs: 300_000 }).catch((error: any) => {
      expect(error.code).toBe("RELAY_UNAVAILABLE"); expect(error.details.taskId).toBeString();
      return { taskId: error.details.taskId };
    });
    const original = sends[0];
    await stop(true); await boot();
    await a.flushOutbox();
    expect(sends.filter(wire => wire === original).length).toBeGreaterThanOrEqual(2);
    dropAck = true;
    await deliverTaskInbox(host, b, context).catch((error: any) => { expect(error.code).toBe("RELAY_UNAVAILABLE"); });
    expect(dispatched.filter(item => item.options.triggerTurn)).toHaveLength(1);
    expect(b.getTask(task.taskId).task).toBe("do this only once");
    expect(b.getTask(task.taskId).events.filter((event: any) => event.type === "task.created")).toHaveLength(1);
    const cursors = stores.map((store: any) => store.getReceiveCursor());
    // The same plugin objects remain alive through a real lease-length outage.
    await stop(true); await Bun.sleep(61_000); await boot();
    expect(stores.map((store: any) => store.getReceiveCursor())).toEqual(cursors);
    expect(await sessions[0].connect()).toBe(a); expect(await sessions[1].connect()).toBe(b);
    expect(stores.map((store: any) => store.getRelayTransportBinding())).toEqual(bindings);
    // Reconnect repairs the previously lost delivery ACK; the RAM frontier advances, never resets.
    expect(BigInt(stores[1].getReceiveCursor())).toBeGreaterThanOrEqual(BigInt(cursors[1]));
    await deliverTaskInbox(host, b, context); await deliverTaskInbox(host, b, context);
    expect(dispatched.filter(item => item.options.triggerTurn)).toHaveLength(1);
    expect(dispatched.filter(item => item.message.details.event?.type === "task.created")).toHaveLength(1);
    expect(b.getTask(task.taskId).events.filter((event: any) => event.type === "task.created")).toHaveLength(1);
    await b.submitIntent({ taskId: task.taskId, type: "task.completed", payload: { summary: "completed once" } });
    await stop(true); await boot();
    dropAck = true;
    await a.receive().catch((error: any) => { expect(error.code).toBe("RELAY_UNAVAILABLE"); });
    await a.receive();
    expect(a.getTask(task.taskId).status).toBe("completed");
    await a.acknowledgeParent(task.taskId);
    await b.receive();
    await a.receive(); await b.receive();
    expect(a.getTask(task.taskId).events.filter((event: any) => event.type === "task.parent_acknowledged")).toHaveLength(1);
    expect(b.getTask(task.taskId).events.filter((event: any) => event.type === "task.parent_acknowledged")).toHaveLength(1);
    expect(a.getTask(task.taskId).events.filter((event: any) => event.type === "task.completed")).toHaveLength(1);
    expect(acknowledgements.length).toBeGreaterThan(0);
  } finally {
    sessions.forEach(session => session.close()); stores.forEach((store: any) => store.close());
    await stop(); rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
