#!/usr/bin/env bun
/**
 * Native extension-runtime acceptance child.
 *
 * This intentionally compiles both public CLI and server bootstrap into the
 * owned sandbox. The only source import is the real broker client used to
 * create/retire harmless shell sessions; package installation and document
 * traffic always go through the compiled public CLI and compiled HTTP server.
 */
import { randomUUID, createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerClient } from "../../../src/broker/client.ts";
import { BrokerBackend } from "../../../src/server/broker-backend.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const EXPECTED_BROKER_SHA256 = "21c124a6f5251759c4b87e588eb2e4d2fbcfb2ed9557d29e36ce1f517eb42029";
const brokerBin = process.env.WOLFPACK_BROKER_BIN ?? "/private/tmp/wolfpack-extensions-native.DCYC5T/wolfpack-broker";
const sandbox = mkdtempSync(join(tmpdir(), "wolfpack-extension-native-"));
const home = join(sandbox, "home");
const socket = join(sandbox, "broker.sock");
const bin = join(sandbox, "bin");
const project = join(sandbox, "project");
const secret = "extension-native-acceptance-secret-1234567890";
let broker: ChildProcess | undefined;
let server: ChildProcess | undefined;
let client: BrokerClient | undefined;
let backend: BrokerBackend | undefined;

function fail(message: string): never { throw new Error(`extension native acceptance: ${message}`); }
function wait(milliseconds: number) { return new Promise<void>((resolve) => setTimeout(resolve, milliseconds)); }
function childEnv(port?: number): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    SHELL: process.env.SHELL ?? "/bin/sh",
    HOME: home,
    TMPDIR: sandbox,
    WOLFPACK_TEST: "1",
    WOLFPACK_BROKER_SOCKET: socket,
    WOLFPACK_MACHINE_ID_PATH: join(home, ".wolfpack", "machine-id"),
    WOLFPACK_JWT_SECRET: secret,
    WOLFPACK_DEV_DIR: project,
    WOLFPACK_SETTINGS_PATH: join(home, ".wolfpack", "settings.json"),
    WOLFPACK_TASK_ROOT: join(home, ".wolfpack", "tasks"),
    WOLFPACK_TASK_RELAY_ROOT: join(home, ".wolfpack", "relay"),
    ...(port === undefined ? {} : { WOLFPACK_PORT: String(port) }),
  };
}
function run(command: readonly string[], env = childEnv()): string {
  const result = Bun.spawnSync([...command], { cwd: sandbox, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail(`${command.join(" ")} exited ${result.exitCode}: ${result.stderr.toString().slice(-1000)}`);
  return result.stdout.toString();
}
function runCli(cli: string, args: readonly string[], port: number, expected = 0): string {
  const result = Bun.spawnSync([cli, ...args], { cwd: sandbox, env: childEnv(port), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== expected) fail(`CLI ${args.join(" ")} exited ${result.exitCode}, expected ${expected}: ${result.stderr.toString().slice(-1000)}`);
  return result.stdout.toString();
}
function jwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 60 })).toString("base64url");
  return `${header}.${payload}.${createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url")}`;
}
async function waitForSocket(): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!existsSync(socket) && Date.now() < deadline) await wait(25);
  if (!existsSync(socket)) fail("broker socket did not appear");
}
async function startBroker(): Promise<void> {
  const checksum = run(["shasum", "-a", "256", brokerBin]).trim().split(/\s+/)[0];
  if (checksum !== EXPECTED_BROKER_SHA256) fail(`authorized broker digest mismatch: ${checksum}`);
  broker = spawn(brokerBin, [], { env: { ...childEnv(), WOLFPACK_BROKER_SOCKET: socket }, stdio: ["ignore", "ignore", "pipe"] });
  await waitForSocket();
  let connected = false;
  client = new BrokerClient({ socketPath: socket, requestTimeoutMs: 5_000, onConnect: () => { connected = true; } });
  client.start();
  const deadline = Date.now() + 5_000;
  while (!connected && Date.now() < deadline) await wait(25);
  if (!connected) fail("broker client did not connect");
  if ((await client.request("list_sessions", {})).status !== "ok") fail("broker did not accept list_sessions");
  backend = new BrokerBackend(client);
}
async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolve) => child!.once("exit", () => resolve())), wait(3_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
async function startServer(serverBin: string): Promise<number> {
  let output = "";
  server = spawn(serverBin, [], { cwd: sandbox, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`compiled server did not become ready: ${output.slice(-1000)}`)), 12_000);
    server!.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/READY:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
    server!.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    server!.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`compiled server exited ${code}: ${output.slice(-1000)}`)); });
  });
  writeFileSync(join(home, ".wolfpack", "config.json"), JSON.stringify({ devDir: project, port }), { mode: 0o600 });
  return port;
}
async function createShell(name: string) {
  if (!backend) fail("broker backend unavailable");
  return backend.createSession(name, project, "shell", () => ({ agentCmd: "shell" }));
}
async function expectRead(cli: string, port: number, sessionId: string, revision: number, goal: string | null): Promise<void> {
  const data = JSON.parse(runCli(cli, ["extension-data", "read", "native/context", "--session", sessionId, "--json"], port));
  if (data.revision !== revision || (goal === null ? data.document !== null : data.document?.goal !== goal)) fail(`unexpected read response ${JSON.stringify(data)}`);
}

try {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  mkdirSync(project, { recursive: true, mode: 0o700 });
  const source = join(sandbox, "extension");
  mkdirSync(join(source, "dist"), { recursive: true });
  mkdirSync(join(source, "schemas"), { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({
    name: "native-extension-fixture", version: "1.0.0",
    wolfpack: { manifestVersion: 1, apiVersion: 1, id: "native", ui: "dist/ui.js", skills: [], documents: [{ id: "context", schemaVersion: 7, schema: "schemas/context.json" }] },
  }));
  writeFileSync(join(source, "dist", "ui.js"), "export const nativeFixture = true;\n");
  writeFileSync(join(source, "schemas", "context.json"), JSON.stringify({ type: "object", required: ["goal"], properties: { goal: { type: "string" } }, additionalProperties: false }));
  const firstDocument = join(sandbox, "first.json");
  const secondDocument = join(sandbox, "second.json");
  writeFileSync(firstDocument, JSON.stringify({ goal: "retained across compiled server restart" }));
  writeFileSync(secondDocument, JSON.stringify({ goal: "revision two" }));
  const cli = join(bin, "wolfpack");
  const serverBin = join(bin, "wolfpack-extension-server");
  run([process.execPath, "build", "--compile", join(ROOT, "src", "cli", "index.ts"), "--outfile", cli]);
  run([process.execPath, "build", "--compile", join(ROOT, "tests", "integration", "fixtures", "extension-native-server.ts"), "--outfile", serverBin]);
  runCli(cli, ["extensions", "install", source, "--trust-browser-code"], 18790);
  await startBroker();
  const original = await createShell("native-scope");
  let port = await startServer(serverBin);

  const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/extensions`);
  if (unauthenticated.status !== 401) fail(`catalog accepted unauthenticated request (${unauthenticated.status})`);
  const catalogResponse = await fetch(`http://127.0.0.1:${port}/api/extensions`, { headers: { Authorization: `Bearer ${jwt()}` } });
  const catalog = await catalogResponse.json() as any;
  const installed = catalog.installations?.find((item: any) => item.extensionId === "native");
  if (!catalogResponse.ok || installed?.documents?.[0]?.schemaVersion !== 7 || typeof installed?.ui?.url !== "string") fail(`catalog did not expose installed declaration: ${JSON.stringify(catalog)}`);
  const asset = await fetch(`http://127.0.0.1:${port}${installed.ui.url}`, { headers: { Authorization: `Bearer ${jwt()}` } });
  if (!asset.ok || await asset.text() !== "export const nativeFixture = true;\n") fail("authenticated qualified asset was not served from installed snapshot");

  const requestId = randomUUID();
  runCli(cli, ["extension-data", "publish", "native/context", "--session", original.wolfpackSessionId, "--file", firstDocument, "--if-revision", "0", "--request-id", requestId, "--json"], port);
  await expectRead(cli, port, original.wolfpackSessionId, 1, "retained across compiled server restart");
  runCli(cli, ["extension-data", "publish", "native/context", "--session", "not-a-uuid", "--file", firstDocument, "--if-revision", "0", "--request-id", randomUUID(), "--json"], port, 2);
  runCli(cli, ["extension-data", "publish", "native/context", "--session", randomUUID(), "--file", firstDocument, "--if-revision", "0", "--request-id", randomUUID(), "--json"], port, 1);

  await stop(server); server = undefined;
  port = await startServer(serverBin);
  const retry = JSON.parse(runCli(cli, ["extension-data", "publish", "native/context", "--session", original.wolfpackSessionId, "--file", firstDocument, "--if-revision", "0", "--request-id", requestId, "--json"], port));
  if (retry.receipt?.revision !== 1 || retry.receipt?.requestId !== requestId) fail(`identical retry did not return retained receipt: ${JSON.stringify(retry)}`);
  runCli(cli, ["extension-data", "publish", "native/context", "--session", original.wolfpackSessionId, "--file", secondDocument, "--if-revision", "0", "--request-id", randomUUID(), "--json"], port, 1);
  runCli(cli, ["extension-data", "publish", "native/context", "--session", original.wolfpackSessionId, "--file", secondDocument, "--if-revision", "1", "--request-id", randomUUID(), "--json"], port);
  await expectRead(cli, port, original.wolfpackSessionId, 2, "revision two");

  await backend!.killSessionById(original.wolfpackSessionId);
  const retainedAfterExit = JSON.parse(runCli(cli, ["extension-data", "publish", "native/context", "--session", original.wolfpackSessionId, "--file", firstDocument, "--if-revision", "0", "--request-id", requestId, "--json"], port));
  if (retainedAfterExit.receipt?.revision !== 1) fail("retained retry was revalidated after terminal exit");
  runCli(cli, ["extension-data", "publish", "native/context", "--session", original.wolfpackSessionId, "--file", secondDocument, "--if-revision", "2", "--request-id", randomUUID(), "--json"], port, 1);
  const replacement = await createShell("native-scope");
  if (replacement.wolfpackSessionId === original.wolfpackSessionId) fail("same-name shell did not receive a new broker UUID");
  await expectRead(cli, port, replacement.wolfpackSessionId, 0, null);
  const replacementPublish = runCli(cli, ["extension-data", "publish", "native/context", "--session", replacement.wolfpackSessionId, "--file", firstDocument, "--if-revision", "0", "--request-id", randomUUID(), "--json"], port);
  try { await expectRead(cli, port, replacement.wolfpackSessionId, 1, "retained across compiled server restart"); }
  catch (error) { fail(`${error instanceof Error ? error.message : String(error)}; replacement publish=${replacementPublish}`); }
  process.stdout.write("extension-native-acceptance: compiled CLI/server + real broker UUID/restart/CAS/isolation OK\n");
} finally {
  try { client?.close(); } catch { /* owned cleanup */ }
  await stop(server);
  await stop(broker);
  rmSync(sandbox, { recursive: true, force: true });
}
