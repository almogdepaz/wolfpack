import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { seedInvalidRelayJournal, relayJournalRows } from "./fixtures/invalid-relay-journal.ts";
import { waitForMessage } from "./pty-test-helpers.ts";

const repository = resolve(import.meta.dir, "../..");
const broker = process.env.WOLFPACK_BROKER_BIN ?? ["debug", "release"].map(mode => join(repository, "broker/target", mode, "wolfpack-broker")).find(existsSync);
if (!broker) console.warn("[relay-containment] real broker checks skipped: build a private broker or set WOLFPACK_BROKER_BIN");

async function until(check: () => boolean | Promise<boolean>, label: string, ms = 10000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`deadline: ${label}`);
    await Bun.sleep(20);
  }
}

for (const compiled of [false, true]) test.skipIf(!broker)(`invalid relay preserves real terminal access and broker identity through explicit server-only recovery (${compiled ? "compiled" : "source"})`, async () => {
  // Short, unique socket path: never discover an installed service or operator socket.
  const root = mkdtempSync("/tmp/wp-contain-"), socket = join(root, "b.sock"), relay = join(root, "relay");
  const processes: ReturnType<typeof Bun.spawn>[] = [];
  let viewer: WebSocket | undefined, passed = false;
  const env = { PATH: process.env.PATH, HOME: root, SHELL: "/bin/bash", TERM: "xterm-256color", WOLFPACK_TEST: "1", WOLFPACK_DIR: join(root, "state"), WOLFPACK_TASK_ROOT: join(root, "tasks"), WOLFPACK_TASK_RELAY_ROOT: relay, WOLFPACK_TASK_RELAY_STORAGE: "sqlite", WOLFPACK_BROKER_SOCKET: socket };
  const spawn = (command: string[], label: string) => {
    const child = Bun.spawn(command, { cwd: root, env, stdin: "ignore", stdout: Bun.file(join(root, label + ".stdout")), stderr: Bun.file(join(root, label + ".stderr")) });
    processes.push(child); return child;
  };
  const stop = async (child: ReturnType<typeof Bun.spawn>) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try { await child.exited; } finally { clearTimeout(timer); }
  };
  try {
    const oldEpoch = seedInvalidRelayJournal(relay), before = relayJournalRows(relay);
    const entry = join(import.meta.dir, "fixtures/relay-containment-server.ts"), binary = join(root, "server");
    if (compiled) {
      const build = Bun.spawn([process.execPath, "build", "--compile", "--entry-naming", "[name].js", entry,
        join(repository, "src/task-relay/worker-entry.ts"), "--outfile", binary], { cwd: repository, stdout: "pipe", stderr: "pipe", timeout: 60000, killSignal: "SIGKILL" });
      const [code, out, err] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
      expect(code, out + err).toBe(0);
    }
    const brokerProcess = spawn([broker!], "broker"), brokerPid = brokerProcess.pid;
    await until(() => { if (brokerProcess.exitCode !== null) throw new Error(readFileSync(join(root, "broker.stderr"), "utf8")); return existsSync(socket); }, "private broker socket");
    const start = async (label: string) => {
      rmSync(join(root, "ready.json"), { force: true });
      const child = spawn(compiled ? [binary, root] : [process.execPath, entry, root], label);
      await until(() => {
        if (child.exitCode !== null) throw new Error(readFileSync(join(root, label + ".stderr"), "utf8"));
        return existsSync(join(root, "ready.json"));
      }, "production server listener");
      const ready = JSON.parse(readFileSync(join(root, "ready.json"), "utf8"));
      expect(ready.compiled).toBe(compiled);
      return { child, base: `http://127.0.0.1:${ready.port}` };
    };
    const json = async (base: string, path: string) => {
      const response = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
      expect(response.status).toBe(200); return response.json() as Promise<any>;
    };
    const terminal = async (base: string, marker: string) => {
      viewer = new WebSocket(base.replace("http:", "ws:") + "/ws/pty?session=containment-shell");
      viewer.binaryType = "arraybuffer";
      let output = "";
      viewer.addEventListener("message", event => { if (event.data instanceof ArrayBuffer) output += new TextDecoder().decode(event.data); });
      await new Promise<void>((resolve, reject) => { viewer!.addEventListener("open", () => resolve()); viewer!.addEventListener("error", () => reject(new Error("terminal websocket failed"))); });
      const ready = waitForMessage(viewer, "pty_ready", 5000);
      viewer.send(JSON.stringify({ type: "attach", cols: 80, rows: 24 }));
      viewer.send(JSON.stringify({ type: "take_control" }));
      await ready;
      // The complete marker never appears in the input: seeing it proves shell execution, not local echo.
      viewer.send(new TextEncoder().encode(`printf '%s%s\\n' '${marker.slice(0, 12)}' '${marker.slice(12)}'\n`));
      await until(() => output.includes(marker), "shell output through production WebSocket");
      viewer.close(); viewer = undefined;
    };
    const first = await start("invalid");
    expect(await json(first.base, "/api/health")).toMatchObject({ status: "ready", relay: { state: "unavailable", code: "RELAY_STORAGE_INVALID", retryable: false } });
    const sessions = await json(first.base, "/api/sessions");
    const id = sessions.sessions.find((session: any) => session.name === "containment-shell")?.identity.wolfpackSessionId;
    expect(id).toBeString();
    const asset = await fetch(first.base + "/app.bundle.js"); expect(asset.status).toBe(200); await asset.arrayBuffer();
    await terminal(first.base, "INVALID_RELAY_" + randomUUID());
    expect(relayJournalRows(relay)).toEqual(before);
    await stop(first.child); expect(first.child.signalCode).toBe("SIGTERM");
    expect(brokerProcess.exitCode).toBeNull(); expect(brokerProcess.pid).toBe(brokerPid);
    // Simulated explicit operator approval in a private fixture, after the owner has exited.
    const archive = join(root, "archive"); mkdirSync(archive, { mode: 0o700 }); renameSync(relay, join(archive, "relay"));
    const second = await start("fresh");
    expect(await json(second.base, "/api/health")).toMatchObject({ status: "ready", relay: { state: "ready" } });
    const profile = await json(second.base, "/api/task-relay/profile"); expect(profile.epoch).not.toBe(oldEpoch);
    const after = await json(second.base, "/api/sessions");
    expect(after.sessions.find((session: any) => session.name === "containment-shell")?.identity.wolfpackSessionId).toBe(id);
    await terminal(second.base, "FRESH_RELAY_" + randomUUID());
    expect(relayJournalRows(join(archive, "relay"))).toEqual(before);
    expect(brokerProcess.exitCode).toBeNull(); expect(brokerProcess.pid).toBe(brokerPid);
    await stop(second.child); expect(second.child.signalCode).toBe("SIGTERM");
    passed = true;
  } finally {
    viewer?.close();
    for (const child of processes.reverse()) await stop(child);
    if (passed) rmSync(root, { recursive: true, force: true });
    else console.error(`relay containment fixture evidence retained: ${root}`);
  }
}, 90000);
