import { expect, test } from "bun:test";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const piSource = process.env.WOLFPACK_PI_TASKS_SOURCE, piRevision = process.env.WOLFPACK_PI_TASKS_REVISION;
if (Boolean(piSource) !== Boolean(piRevision)) throw new Error("both trusted pi-tasks source and exact revision are required");

test.skipIf(!piSource)("actual RAM adapter crosses source-free compiled HTTP host/worker, same-lifetime retry/ACK loss and restart loss", async () => {
  if (!piSource || !isAbsolute(piSource) || !/^[a-f0-9]{40}$/.test(piRevision!)) throw new Error("invalid trusted pi-tasks source selection");
  expect(execFileSync("git", ["-C", piSource, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(piRevision!);
  expect(execFileSync("git", ["-C", piSource, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()).toBe("");
  const { createTaskStore, createVolatileTaskSession } = await import(pathToFileURL(join(piSource, "src/index.ts")).href);
  const root = mkdtempSync(join(tmpdir(), "volatile-compiled-adapter-")), repo = resolve(import.meta.dir, "../..");
  const buildRoot = join(root, "build-input"), runtime = join(root, "runtime"), binary = join(runtime, "host"), ready = join(runtime, "ready.json");
  mkdirSync(buildRoot, { mode: 0o700 }); mkdirSync(runtime, { mode: 0o700 });
  mkdirSync(join(runtime, "home"), { mode: 0o700 }); mkdirSync(join(runtime, "relay"), { mode: 0o700 });
  const sentinel = join(runtime, "relay/relay-state.json"), historical = "malformed legacy ledger must remain untouched\n";
  writeFileSync(sentinel, historical, { mode: 0o600 });
  const secret = randomUUID() + randomUUID();
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: "compiled-fixture", aud: "compiled-fixture", exp: Math.floor(Date.now() / 1000) + 600 })}`;
  const authorization = `Bearer ${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
  type Child = { process: ReturnType<typeof Bun.spawn>; stdout: Promise<string>; stderr: Promise<string>; stopped: boolean };
  const children: Child[] = [], sessions: { close(): void }[] = [], stores: { close(): void }[] = [];
  let binaryHash = "", port = 0, child: Child | undefined;
  async function stop(c: Child) {
    if (c.stopped) return;
    c.process.kill("SIGTERM"); const timer = setTimeout(() => c.process.kill("SIGKILL"), 2000);
    try {
      const [exit, output, errors] = await Promise.all([c.process.exited, c.stdout, c.stderr]);
      c.stopped = true;
      if (output) console.log(output.trim()); if (errors) console.error(errors.trim());
      expect(exit, output + errors).toBe(0);
    } finally { clearTimeout(timer); }
  }
  async function start(profile = "volatile-v1") {
    expect(createHash("sha256").update(readFileSync(binary)).digest("hex")).toBe(binaryHash);
    rmSync(ready, { force: true }); const nonce = randomUUID();
    const process = Bun.spawn([binary, runtime, String(port), profile, nonce], { cwd: runtime,
      env: { HOME: join(runtime, "home"), PATH: "/usr/bin:/bin", WOLFPACK_TEST: "1", WOLFPACK_PORT: "1",
        WOLFPACK_BROKER_SOCKET: join(runtime, "no-live-broker.sock"), WOLFPACK_JWT_SECRET: secret, WOLFPACK_JWT_AUDIENCE: "compiled-fixture" },
      stdout: "pipe", stderr: "pipe", timeout: 60_000, killSignal: "SIGKILL" });
    const c: Child = { process, stdout: new Response(process.stdout).text(), stderr: new Response(process.stderr).text(), stopped: false };
    children.push(c);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (existsSync(ready)) {
        const value = JSON.parse(readFileSync(ready, "utf8"));
        expect(value).toMatchObject({ nonce, pid: process.pid, compiled: true });
        expect(Number.isInteger(value.port) && value.port > 0 && value.port < 65536).toBe(true);
        if (port) expect(value.port).toBe(port); port = value.port;
        return c;
      }
      if (process.exitCode !== null) throw new Error(`compiled host exited before readiness: ${await c.stdout}\n${await c.stderr}`);
      await Bun.sleep(20);
    }
    throw new Error("compiled host readiness deadline exceeded");
  }
  try {
    // Build from a private copy, then REMOVE all its source/dependency paths.
    // The binary may not fall back to source-loaded worker-entry.ts.
    cpSync(join(repo, "src"), join(buildRoot, "src"), { recursive: true });
    cpSync(join(repo, "package.json"), join(buildRoot, "package.json"));
    const fixture = join(buildRoot, "tests/integration/fixtures/volatile-compiled-http.ts");
    mkdirSync(join(buildRoot, "tests/integration/fixtures"), { recursive: true });
    cpSync(join(import.meta.dir, "fixtures/volatile-compiled-http.ts"), fixture);
    symlinkSync(join(repo, "node_modules"), join(buildRoot, "node_modules"), "dir");
    const build = Bun.spawn([process.execPath, "build", "--compile", "--entry-naming", "[name].js", fixture,
      join(buildRoot, "src/task-relay/worker-entry.ts"), "--outfile", binary], { cwd: buildRoot, stdout: "pipe", stderr: "pipe", timeout: 60_000, killSignal: "SIGKILL" });
    const [exit, output, error] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
    expect(exit, output + error).toBe(0);
    binaryHash = createHash("sha256").update(readFileSync(binary)).digest("hex");
    rmSync(join(buildRoot, "node_modules")); rmSync(buildRoot, { recursive: true }); expect(existsSync(buildRoot)).toBe(false);
    child = await start();
    const url = `http://127.0.0.1:${port}/api/task-relay/volatile-v1`;
    expect((await fetch(url, { method: "POST" })).status).toBe(401);
    const malformed = await fetch(url + "/peer", { method: "POST", headers: { authorization } });
    expect(malformed.status).toBe(400); // No signature gate: malformed body/content type still fails admission.
    expect(await malformed.json()).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    const info = await (await fetch(`http://127.0.0.1:${port}/api/task-relay/profile`, { headers: { authorization } })).json() as any;
    expect(info).toMatchObject({ profile: "volatile-v1", federation: "trusted-tailnet-v1" });
    let loseSend = true, loseAck = true;
    const sends: string[] = [], confirmations: any[] = [], acks: string[] = [];
    const authenticated = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)), wire = String(init?.body);
      if (body.operation === "send" && body.callerSession === "sender") sends.push(wire);
      if (body.operation === "acknowledge" && body.callerSession === "receiver") acks.push(wire);
      const headers = new Headers(init?.headers); headers.set("authorization", authorization);
      const response = await fetch(input, { ...init, headers });
      if (response.ok && body.operation === "send" && body.callerSession === "sender") {
        confirmations.push(await response.clone().json());
        if (loseSend) { loseSend = false; await response.arrayBuffer(); throw new Error("fixture lost confirmed send response"); }
      }
      if (response.ok && body.operation === "acknowledge" && body.callerSession === "receiver" && loseAck) {
        loseAck = false; await response.arrayBuffer(); throw new Error("fixture lost confirmed ACK response");
      }
      return response;
    }, { preconnect: fetch.preconnect }) as typeof fetch;
    const store = (name: string) => {
      const raw = createTaskStore(); let closed = false;
      const value = { ...raw, close() { if (!closed) { closed = true; raw.close(); } } };
      stores.push(value); return value;
    };
    const session = (callerSession: string, store: any) => { const value = createVolatileTaskSession({ callerSession, store, url, fetch: authenticated }); sessions.push(value); return value; };
    let as = store("a"), bs = store("b"), a = session("sender", as), b = session("receiver", bs);
    let ac = await a.connect(), bc = await b.connect();
    expect(b.status().binding.epoch).toBe(info.epoch);
    await expect(ac.createTask({ target: bc.endpoint, task: "compiled accepted response loss", timeoutMs: 60_000 })).rejects.toMatchObject({ code: "RELAY_UNAVAILABLE", retryable: true });
    expect(as.outbox("pending")).toHaveLength(1); expect(as.outbox("accepted")).toEqual([]);
    a.close(); a = session("sender", as); ac = await a.connect(); // Same RAM lifetime, not process recovery.
    await ac.flushOutbox();
    expect(sends).toHaveLength(2); expect(sends[1]).toBe(sends[0]);
    expect(confirmations[1].value).toMatchObject({ acceptanceId: confirmations[0].value.acceptanceId, duplicate: true, forwarding: "local" });
    expect(as.outbox("pending")).toEqual([]); expect(as.outbox("accepted")).toHaveLength(1);
    await ac.createTask({ target: bc.endpoint, task: "compiled sparse ACK", timeoutMs: 60_000 });
    expect((await bc.receive()).map((item: any) => item.cursor)).toEqual(["1", "2"]);
    await expect(bc.acknowledgeRelayDelivery("2")).rejects.toMatchObject({ code: "RELAY_UNAVAILABLE" });
    expect(bs.getReceiveCursor()).toBe("0");
    b.close(); b = session("receiver", bs); bc = await b.connect(); // Same RAM lifetime retains individual ACK state.
    expect(acks).toHaveLength(2); expect(acks[1]).toBe(acks[0]);
    expect((await bc.receive()).map((item: any) => item.cursor)).toEqual(["1"]);
    await bc.acknowledgeRelayDelivery("1"); expect(bs.getReceiveCursor()).toBe("2");
    const history = bc.listTasks(), oldEndpoint = bc.endpoint;
    await stop(child); child = await start();
    await expect(bc.receive()).rejects.toMatchObject({ code: "RELAY_RESET", retryable: false });
    expect(bs.getRelayTransportBinding().reset).toBe(true);
    b.close(); b = session("receiver", bs);
    await expect(b.connect()).rejects.toMatchObject({ code: "RELAY_REBIND_REQUIRED", retryable: false });
    const fresh = await b.rebind(); expect(fresh.endpoint).not.toEqual(oldEndpoint);
    expect(fresh.listTasks()).toEqual([]); expect(bs.getReceiveCursor()).toBe("0");
    await expect(fresh.submitIntent({ taskId: history[0].taskId, type: "task.information", payload: { message: "not my lifetime" } })).rejects.toMatchObject({ code: "UNKNOWN_TASK" });
    const task = await fresh.createTask({ target: fresh.endpoint, task: "new compiled lifetime", timeoutMs: 60_000 });
    const first = await fresh.receive(); expect(first.map((item: any) => item.cursor)).toEqual(["1"]);
    await fresh.acknowledgeRelayDelivery("1");
    await fresh.submitIntent({ taskId: task.taskId, type: "task.completed", payload: { summary: "synthetic fixture completed" } });
    for (let i = 0; i < 3; i++) for (const delivery of await fresh.receive()) await fresh.acknowledgeRelayDelivery(delivery.cursor);
    expect(fresh.getTask(task.taskId).status).toBe("completed");
    b.close(); bs.close(); bs = store("b"); b = session("receiver", bs); // Actual endpoint lifetime loss.
    const restarted = await b.connect();
    expect(restarted.endpoint).not.toEqual(fresh.endpoint); expect(restarted.listTasks()).toEqual([]);
    expect(bs.getReceiveCursor()).toBe("0"); expect(bs.outbox("pending")).toEqual([]);
    expect(existsSync(join(runtime, "a.sqlite"))).toBe(false); expect(existsSync(join(runtime, "b.sqlite"))).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe(historical);
    expect(existsSync(buildRoot)).toBe(false);
    console.log(JSON.stringify({ fixture: "compiled-volatile-http-adapter", binarySha256: binaryHash, piTasksRevision: piRevision, sourceRemoved: true, relayRestarts: 1, endpointRestarts: 1 }));
  } finally {
    for (const value of sessions) value.close();
    for (const value of stores) value.close();
    try { for (const c of children) await stop(c); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
}, 120_000);
