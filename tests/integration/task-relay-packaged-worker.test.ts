import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const cli = process.env.WOLFPACK_PACKAGED_CLI;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
async function until<T>(label: string, operation: () => Promise<T> | T, timeout = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await operation(); if (value) return value as NonNullable<T>; await sleep(100); }
  throw new Error(`deadline: ${label}`);
}

/** Explicit private artifact gate, never discover installed/operator packages or sockets. */
test.skipIf(!cli)("packaged CLI/native broker/installed Pi tool loop survives server-only reset with explicit rebind", async () => {
  const required = (key: string) => { const value = process.env[key]; expect(value, key).toBeTruthy(); return value!; };
  const broker = required("WOLFPACK_BROKER_BIN"), archive = required("WOLFPACK_PI_TASKS_ARCHIVE"), modules = required("WOLFPACK_PI_RUNTIME_MODULES");
  for (const path of [cli!, broker, archive, modules]) expect(isAbsolute(path)).toBe(true);
  expect(digest(cli!)).toBe(required("WOLFPACK_PACKAGED_CLI_SHA256"));
  expect(digest(broker)).toBe(required("WOLFPACK_BROKER_SHA256"));
  expect(digest(archive)).toBe(required("WOLFPACK_PI_TASKS_ARCHIVE_SHA256"));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wp-pkg-worker-"))); chmodSync(root, 0o700);
  let model: ReturnType<typeof Bun.serve> | undefined;
  try {
  const home = join(root, "home"), project = join(root, "project"), bin = join(root, "bin"), socket = join(home, ".wolfpack", "broker.sock");
  const agent = join(home, ".pi", "agent"), installed = join(agent, "npm", "node_modules", "@sgtbeatdown", "pi-tasks");
  for (const dir of [home, project, bin, installed, join(home, ".wolfpack")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Only extract a caller-pinned artifact; reject paths and special/link members first.
  const members = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 128 * 1024 }).trim().split("\n");
  expect(members.length).toBeLessThan(400);
  for (const member of members) expect(member.startsWith("package/") && !member.split("/").includes("..")).toBe(true);
  const listing = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8", maxBuffer: 128 * 1024 });
  for (const line of listing.trim().split("\n")) expect(["-", "d"]).toContain(line[0]);
  execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", installed]);
  symlinkSync(modules, join(installed, "node_modules"));
  symlinkSync(join(modules, ".bin", "pi"), join(bin, "pi"));
  const node = execFileSync("which", ["node"], { encoding: "utf8" }).trim(); expect(isAbsolute(node)).toBe(true);
  const path = `${bin}:${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`;
  writeFileSync(join(home, ".bash_profile"), `export PATH=${JSON.stringify(path)}\n`, { mode: 0o600 });
  let parent: any, child: any, taskId: string | undefined, sent = false, done = false, ack = false, historical = false, checkHistorical = false;
  const calls: Array<{ model: string; tool?: string }> = [];
  const snapshots: any[] = [];
  const readEntries = (): any[] => {
    const sessionRoot = join(agent, "sessions");
    if (!existsSync(sessionRoot)) return [];
    return readdirSync(sessionRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(directory =>
      readdirSync(join(sessionRoot, directory.name)).filter(file => file.endsWith(".jsonl")).flatMap(file => {
        const text = readFileSync(join(sessionRoot, directory.name, file), "utf8"); expect(text.length).toBeLessThan(2_000_000);
        // Observe complete records only while Pi may be appending the last line.
        const end = text.lastIndexOf("\n"); if (end < 0) return [];
        const complete = text.slice(0, end);
        return complete ? complete.split("\n").map(line => ({ ...JSON.parse(line), fixtureFile: file })) : [];
      }));
  };
  const events = () => readEntries().flatMap(entry => {
    const event = entry.customType === "pi-tasks-event" ? entry.details?.event
      : entry.customType === "pi-tasks-event-record" ? entry.data?.event : undefined;
    return event ? [{ file: entry.fixtureFile, event }] : [];
  });
  const hasEvent = (type: string) => events().some(item => item.event.taskId === taskId && item.event.type === type);
  let modelError: string | undefined, historicalDenied = false;
  model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    try {
      expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
      const text = await request.text(); expect(text.length).toBeLessThan(300_000);
      const body = JSON.parse(text); expect(["parent", "child"]).toContain(body.model); expect(calls.length).toBeLessThan(24);
      taskId ??= events().find(item => item.event.type === "task.created" && item.event.payload.task === "PACKAGED_FIXTURE_ASSIGNMENT")?.event.taskId
        ?? readEntries().find(entry => entry.message?.toolName === "agent_task_send")?.message.details?.taskId;
      let tool: string | undefined, args: any;
      if (body.model === "parent" && !sent) {
        expect(child?.taskEndpoint).toBeDefined(); expect(text).toContain("FIXTURE_START");
        tool = "agent_task_send"; args = { to: child.taskEndpoint, task: "PACKAGED_FIXTURE_ASSIGNMENT", timeoutMs: 60_000 }; sent = true;
      } else if (body.model === "child" && !done) {
        expect(taskId).toBeString(); expect(text).toContain(taskId!); expect(text).toContain("PACKAGED_FIXTURE_ASSIGNMENT");
        tool = "agent_task_done"; args = { taskId, status: "completed", summary: "completed by installed Pi tool through native broker" }; done = true;
      } else if (body.model === "parent" && text.includes("## task completed") && !ack) {
        tool = "agent_task_ack"; args = { taskId }; ack = true;
      } else if (body.model === "parent" && checkHistorical && !historical) {
        tool = "agent_task_message"; args = { taskId, type: "information", message: "must not adopt old scope" }; historical = true;
      }
      if (historical && text.includes("unknown task:")) historicalDenied = true;
      if (tool) expect(body.tools.some((item: any) => item.function?.name === tool)).toBe(true);
      calls.push({ model: body.model, tool });
      const id = `fixture-${randomUUID()}`, delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] } : { role: "assistant", content: "fixture turn complete" };
      const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(chunk(delta, null) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    } catch (error) { modelError = String(error); return Response.json({ error: modelError }, { status: 500 }); }
  } });
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `${model.url.origin}/v1`, api: "openai-completions", apiKey: "private-fixture-only", compat: { supportsUsageInStreaming: false }, models: ["parent", "child"].map(id => ({ id, contextWindow: 128000, maxTokens: 1024 })) } } }), { mode: 0o600 });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [installed], defaultProvider: "fixture", defaultModel: "parent", compaction: { enabled: false }, quietStartup: true }), { mode: 0o600 });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const port = reservation.port!; await reservation.stop(true);
  writeFileSync(join(home, ".wolfpack", "config.json"), JSON.stringify({ port, devDir: root }), { mode: 0o600 });
  const env = { PATH: path, HOME: home, SHELL: "/bin/bash", TERM: "xterm-256color", PI_TELEMETRY: "0", WOLFPACK_PORT: String(port), WOLFPACK_BROKER_SOCKET: socket,
    WOLFPACK_JWT_SECRET: "private-packaged-worker-secret-at-least-thirty-two", WOLFPACK_SERVICE: "1" };
  const processes: ReturnType<typeof Bun.spawn>[] = [];
  const spawn = (command: string[], label: string) => {
    const process = Bun.spawn(command, { cwd: root, env, stdin: "ignore", stdout: Bun.file(join(root, label + ".stdout")), stderr: Bun.file(join(root, label + ".stderr")) }); processes.push(process); return process;
  };
  const stop = async (process: ReturnType<typeof Bun.spawn>) => {
    if (process.exitCode !== null) return;
    process.kill("SIGTERM");
    for (let i = 0; i < 50 && process.exitCode === null; i++) await sleep(100);
    if (process.exitCode === null) process.kill("SIGKILL"); await process.exited;
  };
  const run = async (args: string[], extra: Record<string, string> = {}) => {
    const process = Bun.spawn([cli!, ...args], { cwd: root, env: { ...env, ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    processes.push(process);
    const result = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    expect(result[0], `${args.join(" ")}: ${result[1]} ${result[2]}`).toBe(0); return JSON.parse(result[1]);
  };
  const startServer = async (label: string) => {
    const process = spawn([cli!], label);
    await until("owned server listener", () => {
      if (process.exitCode !== null) throw new Error(readFileSync(join(root, label + ".stderr"), "utf8").slice(-4000));
      try { return execFileSync("/usr/sbin/lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === String(process.pid); } catch { return false; }
    });
    return process;
  };
  try {
    const brokerProcess = spawn([broker], "broker"); await until("owned broker socket", () => existsSync(socket));
    let server = await startServer("server-1");
    expect((await run(["list", "--json"])).sessions).toHaveLength(0);
    parent = await run(["session", "create", "--project-dir", project, "--harness", "pi", "--json"]);
    await until("ordinary installed extension registration", async () => (await run(["session", "status", parent.sessionId, "--json"])).taskTransport?.profile === "volatile-v1", 30_000);
    child = await run(["agent", "spawn", "--project-dir", project, "--task-worker", "--model", "fixture/child", "--json"], { WOLFPACK_SESSION_NAME: parent.session, WOLFPACK_AGENT_KIND: parent.harness });
    expect(child.taskEndpoint.id).toMatch(/^[0-9a-f-]{36}$/); expect(child.harness).toBe("pi");
    await run(["session", "send", parent.sessionId, "FIXTURE_START", "--json"]);
    await until("canonical completion and parent ACK through actual Pi tools", () => {
      if (modelError) throw new Error(modelError);
      return taskId && ack && hasEvent("task.completed") && hasEvent("task.parent_acknowledged")
        && readEntries().some(entry => entry.message?.toolName === "agent_task_ack" && !entry.message.details?.error);
    }, 45_000);
    const before = { binding: (await run(["session", "status", parent.sessionId, "--json"])).taskTransport, events: events() };
    expect(before.binding?.profile).toBe("volatile-v1"); snapshots.push(before);
    expect(existsSync(join(home, ".pi", "tasks"))).toBe(false);
    const echo = await run(["session", "create", "--project-dir", project, "--harness", "shell", "--json"]);
    await stop(server); expect(brokerProcess.exitCode).toBeNull();
    server = await startServer("server-2");
    const echoStatus = await run(["session", "status", echo.sessionId, "--json"]);
    expect(echoStatus.terminal.alive).toBe(true); expect(echoStatus.sessionId).toBe(echo.sessionId);
    await until("existing Pi reports relay reset without automatic rebind", async () => JSON.stringify(await run(["session", "read", parent.sessionId, "--json"])).includes("tasks: relay reset"));
    expect((await run(["session", "status", parent.sessionId, "--json"])).taskTransport).toBeUndefined();
    await run(["session", "send", parent.sessionId, "/task-relay-rebind", "--json"]); await sleep(700);
    expect((await run(["session", "status", parent.sessionId, "--json"])).taskTransport).toBeUndefined();
    await run(["session", "send", parent.sessionId, "/task-relay-rebind --accept-relay-loss", "--json"]);
    const after = await until("explicit rebind to new server epoch", async () => {
      const binding = (await run(["session", "status", parent.sessionId, "--json"])).taskTransport;
      return binding && binding.epoch !== before.binding.epoch && { binding, events: events() };
    });
    snapshots.push(after); expect(after.binding.endpoint).not.toEqual(before.binding.endpoint);
    expect(after.events).toEqual(expect.arrayContaining(before.events));
    checkHistorical = true;
    await run(["session", "send", parent.sessionId, "FIXTURE_HISTORICAL", "--json"]);
    await until("historical task mutation refusal", () => historicalDenied);
    // Model serialization includes tool text, not the structured details object.
    // Assert the actual error code from Pi's persisted tool result instead.
    const entries = readEntries();
    expect(entries.some(entry => entry.message?.role === "toolResult" && entry.message.toolName === "agent_task_message" && entry.message.details?.error?.code === "UNKNOWN_TASK")).toBe(true);
    expect(events()).toEqual(expect.arrayContaining(before.events));
    expect(existsSync(join(home, ".pi", "tasks"))).toBe(false);
    expect(existsSync(join(home, ".wolfpack", "task-relay"))).toBe(false);
    for (const id of [parent.sessionId, echo.sessionId]) await run(["kill", id, "--json"]);
    // Worker may have exited itself after parent ACK. Kill only an exact ID if still active.
    const active = (await run(["list", "--json"])).sessions;
    if (active.some((session: any) => session.sessionId === child.sessionId)) await run(["kill", child.sessionId, "--json"]);
    await until("no owned sessions remain", async () => (await run(["list", "--json"])).sessions.length === 0);
    expect(modelError).toBeUndefined(); expect(calls.some(call => call.tool === "agent_task_send")).toBe(true); expect(calls.some(call => call.tool === "agent_task_done")).toBe(true);
  } finally {
    for (const process of [...processes].reverse()) await stop(process);
    await model.stop(true);
    const artifacts = process.env.WOLFPACK_VERIFICATION_ARTIFACT_DIR;
    if (artifacts) { const output = join(artifacts, `packaged-worker-${randomUUID()}`); mkdirSync(output, { mode: 0o700 }); cpSync(root, output, { recursive: true, dereference: false, filter: source => !source.includes("node_modules") && !source.endsWith("broker.sock") && !source.endsWith("/bin/pi") }); writeFileSync(join(output, "observations.json"), JSON.stringify({ parent, child, taskId, calls, modelError, snapshots }, null, 2), { mode: 0o600 }); console.log(`private packaged-worker evidence: ${output}`); }
  }
  } finally { await model?.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 120_000);
