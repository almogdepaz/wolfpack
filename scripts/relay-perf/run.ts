import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { dueSlots, ECHO_INTERVAL_MS, number, record, startSampling, text, waitUntil } from "./measurement.ts";

const repo = resolve(import.meta.dir, "../..");
const input = record(JSON.parse(readFileSync(text(process.argv[2]), "utf8")));
const output = text(input.output), source = text(input.source), broker = text(input.broker);
for (const path of [output, source, broker]) if (!isAbsolute(path)) throw new Error("absolute paths required");
if (!output.startsWith("/private/tmp/")) throw new Error("private tmp evidence directory required");
const revision = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (revision !== text(input.revision) || execFileSync("git", ["-C", source, "status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("adapter revision/cleanliness mismatch");
const brokerHash = createHash("sha256").update(readFileSync(broker)).digest("hex");
if (brokerHash !== text(input.brokerSha256)) throw new Error("broker hash mismatch");
const warmup = number(input.warmupMs), duration = number(input.durationMs), relays = number(input.relays);
if (![1, 2].includes(relays) || warmup < 0 || duration < 1 || duration > 300_000) throw new Error("invalid workload");
mkdirSync(output, { mode: 0o700, recursive: true });
const root = mkdtempSync(join(output, "trial-"));
console.log(JSON.stringify({ kind: "trial", root }));
const secret = randomUUID() + randomUUID();
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const unsigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 1800 })}`;
const token = `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
interface Child { readonly role: string; readonly process: Subprocess; readonly root: string }
interface EchoSample { readonly session: string; readonly sequence: number; readonly scheduled: number; readonly dispatched: number; readonly lateness: number; readonly sentMono: number; received: number | null; latency: number | null }
const children: Child[] = [], sockets: WebSocket[] = [], echoes: EchoSample[] = [], socketEvents: unknown[] = [];
const teardown: unknown[] = [], configured = new Set<number>(), ptyPids: number[] = [];
let stopRequested = false;
process.on("SIGTERM", () => { stopRequested = true; });
process.on("SIGINT", () => { stopRequested = true; });
function launch(role: string, args: string[], home: string, env: Record<string, string>, ipc = false): Subprocess {
  const child = Bun.spawn(args, { cwd: home, env, stdin: "ignore", stdout: Bun.file(join(home, role + ".stdout.log")), stderr: Bun.file(join(home, role + ".stderr.log")),
    ...(ipc ? { ipc(message: unknown, subprocess: Subprocess) { if (record(message).kind === "configured") configured.add(subprocess.pid); } } : {}) });
  children.push({ role, process: child, root: home });
  writeFileSync(join(root, "children.json"), JSON.stringify(children.map(child => ({ role: child.role, pid: child.process.pid, root: child.root }))), { mode: 0o600 });
  return child;
}
async function ready(home: string, filename: string, child: Subprocess, nonce: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  await waitUntil(() => {
    if (child.exitCode !== null) throw new Error(`${filename}: child exited ${child.exitCode}; inspect ${home}`);
    return existsSync(join(home, filename));
  }, timeoutMs, filename);
  const value = record(JSON.parse(readFileSync(join(home, filename), "utf8")));
  if (value.pid !== child.pid || value.nonce !== nonce) throw new Error("readiness identity mismatch");
  return value;
}
const hostBases: string[] = [], hosts: Subprocess[] = [];
let metrics: unknown;
try {
  for (let index = 0; index < relays; index++) {
    const home = join(root, String(index)), name = index ? "b" : "a";
    mkdirSync(home, { mode: 0o700 }); mkdirSync(join(home, ".wolfpack"), { mode: 0o700 });
    const socket = join(home, "b.sock");
    if (socket.length > 100) throw new Error("broker socket exceeds macOS limit");
    const nonce = randomUUID();
    writeFileSync(join(home, "host.json"), JSON.stringify({ nonce }), { mode: 0o600 });
    writeFileSync(join(home, ".wolfpack/config.json"), JSON.stringify({ devDir: home, port: 18790, tailscaleHostname: `${name}.tail123.ts.net` }), { mode: 0o600 });
    const node = (id: string): object => ({ ID: `node-${id}`, DNSName: `${id}.tail123.ts.net.`, Online: true, UserID: 1 });
    const env = { HOME: home, PATH: "/usr/bin:/bin", WOLFPACK_BROKER_SOCKET: socket, WOLFPACK_BROKER_LOG: "warn" };
    const native = launch("broker", [broker], home, env);
    await waitUntil(() => { if (native.exitCode !== null) throw new Error("broker exited before readiness"); return existsSync(socket); }, 5_000, "broker socket");
    const host = launch("host", [process.execPath, join(import.meta.dir, "host.ts"), home], home, {
      ...env, WOLFPACK_TEST: "1", WOLFPACK_JWT_SECRET: secret, WOLFPACK_TASK_RELAY_ROOT: join(home, "relay"),
      WOLFPACK_SESSION_IDENTITY_MODE: "memory", WOLFPACK_SESSION_IDENTITY_PATH: join(home, "identities.json"),
      WOLFPACK_TAILSCALE_STATUS_JSON: JSON.stringify({ BackendState: "Running", Self: node(name), Peer: { other: node(index ? "a" : "b") } }),
    }, true);
    const observed = await ready(home, "ready.json", host, nonce);
    if (!Array.isArray(observed.sessions)) throw new Error("missing broker session identities");
    ptyPids.push(...observed.sessions.map(session => number(record(session).pid)));
    hostBases.push(`http://127.0.0.1:${number(observed.port)}`); hosts.push(host);
  }
  const peers = Object.fromEntries(hostBases.map((base, index) => [`https://${index ? "b" : "a"}.tail123.ts.net`, base]));
  for (const host of hosts) host.send({ kind: "configure", peers, fault: input.fault ?? "none", recoverAfterMs: input.recoverAfterMs ?? 0 });
  await waitUntil(() => configured.size === hosts.length, 5_000, "host configuration");
  const adapterHome = join(root, "adapter"); mkdirSync(adapterHome, { mode: 0o700 });
  const nonce = randomUUID();
  writeFileSync(join(adapterHome, "adapter.json"), JSON.stringify({ source, seedMailbox: input.seedMailbox ?? 0, baseA: hostBases[0], baseB: hostBases.at(-1), peerOrigin: "https://b.tail123.ts.net", authorization: "Bearer " + token, nonce }), { mode: 0o600 });
  const adapter = launch("adapter", [process.execPath, join(import.meta.dir, "adapter.ts"), adapterHome], adapterHome, { HOME: adapterHome, PATH: "/usr/bin:/bin" }, true);
  await ready(adapterHome, "adapter-ready.json", adapter, nonce, 15_000 + number(input.seedMailbox ?? 0) * 100);
  const echoesBySocket: Map<string, EchoSample>[] = [];
  for (let index = 0; index < 2; index++) {
    const session = `echo-${index}`, base = hostBases[index % relays]!;
    const ws = new WebSocket(base.replace("http:", "ws:") + `/ws/pty?session=${session}&token=${encodeURIComponent(token)}`);
    sockets.push(ws); ws.binaryType = "arraybuffer";
    const pending = new Map<string, EchoSample>(); echoesBySocket.push(pending);
    let buffered = Buffer.alloc(0), attached = false;
    ws.addEventListener("message", event => {
      if (typeof event.data === "string") {
        const control = record(JSON.parse(event.data));
        socketEvents.push({ at: Date.now(), session, ...control });
        if (control.type === "pty_ready") attached = true;
        return;
      }
      buffered = Buffer.concat([buffered, Buffer.from(event.data)]);
      // Raw cat stream uses declared fixed-width 16-byte benchmark frames; no terminal text scraping.
      while (buffered.length >= 16) {
        const marker = buffered.subarray(0, 16).toString("ascii"); buffered = buffered.subarray(16);
        const sample = pending.get(marker);
        if (!sample) { socketEvents.push({ at: Date.now(), session, kind: "unexpected_bytes", hex: Buffer.from(marker).toString("hex") }); continue; }
        sample.received = Date.now(); sample.latency = performance.now() - sample.sentMono; pending.delete(marker);
      }
    });
    ws.addEventListener("close", event => socketEvents.push({ at: Date.now(), session, kind: "close", code: event.code, reason: event.reason }));
    ws.addEventListener("error", () => socketEvents.push({ at: Date.now(), session, kind: "error" }));
    await waitUntil(() => ws.readyState === WebSocket.OPEN, 5_000, "websocket open");
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, prefillMode: "none" }));
    ws.send(JSON.stringify({ type: "take_control" }));
    await waitUntil(() => attached, 5_000, "pty ready");
  }
  const start = Date.now() + 250, end = start + warmup + duration;
  const sampling = startSampling();
  adapter.send({ kind: "run", start, duration: warmup + duration, payloadBytes: input.payloadBytes, load: input.load === true });
  let next = 0;
  const count = Math.floor((warmup + duration) / ECHO_INTERVAL_MS);
  while (Date.now() < end && !stopRequested) {
    const now = Date.now();
    for (const slot of dueSlots(start, now, ECHO_INTERVAL_MS, next, count)) {
      const sequence = next++;
      for (let index = 0; index < sockets.length; index++) {
        const marker = "WP" + sequence.toString().padStart(14, "0");
        const sample: EchoSample = { session: `echo-${index}`, sequence, ...slot, sentMono: performance.now(), received: null, latency: null };
        echoes.push(sample); echoesBySocket[index]!.set(marker, sample);
        if (sockets[index]!.readyState === WebSocket.OPEN) sockets[index]!.send(Buffer.from(marker));
      }
    }
    await Bun.sleep(5);
  }
  if (stopRequested) throw new Error("interrupted");
  await waitUntil(() => adapter.exitCode !== null, 40_000, "adapter drain");
  if (adapter.exitCode !== 0 || !existsSync(join(adapterHome, "adapter-metrics.json"))) throw new Error("adapter workload failed");
  metrics = { start, measuredStart: start + warmup, end, echoes, socketEvents, controller: sampling.stop() };
} finally {
  for (const ws of sockets) ws.close();
  for (const child of [...children].reverse()) {
    if (child.process.exitCode === null) child.process.kill("SIGTERM");
    const timer = setTimeout(() => { if (child.process.exitCode === null) child.process.kill("SIGKILL"); }, 5_000);
    const exit = await child.process.exited; clearTimeout(timer);
    const usage = child.process.resourceUsage();
    // Bun 1.4 exposes prototype getters, not enumerable JSON fields; CPU counters are runtime bigint.
    const resourceUsage = usage ? { maxRSS: Number(usage.maxRSS), cpuMicros: Number(usage.cpuTime.total) } : null;
    teardown.push({ role: child.role, pid: child.process.pid, exit, signal: child.process.signalCode, resourceUsage });
  }
  const remainingPtys = (): number[] => ptyPids.filter(pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false; throw error; }
  });
  // Broker exit and kernel/reaper observation are asynchronous; do not mistake a transient PID for a leak.
  const cleanupDeadline = Date.now() + 5_000;
  let stillAlive = remainingPtys();
  while (stillAlive.length && Date.now() < cleanupDeadline) { await Bun.sleep(10); stillAlive = remainingPtys(); }
  writeFileSync(join(root, "run.json"), JSON.stringify({ config: input, brokerHash, adapterRevision: revision, ptyCleanup: { owned: ptyPids, stillAlive }, sourceRevision: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), metrics, teardown }), { mode: 0o600 });
  if (stillAlive.length) throw new Error(`owned PTY cleanup unconfirmed: ${JSON.stringify(stillAlive)}`);
  console.log(JSON.stringify({ kind: "stopped", root, teardown: teardown.map(value => { const child = record(value); return { role: child.role, pid: child.pid, exit: child.exit }; }) }));
}
