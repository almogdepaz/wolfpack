#!/usr/bin/env bun
/**
 * Native extension-runtime acceptance child.
 *
 * This intentionally compiles both public CLI and server bootstrap into the
 * owned sandbox. The only source import is the real broker client used to
 * create/retire harmless shell sessions; package installation and document
 * traffic always go through the compiled public CLI and compiled HTTP server.
 */
import { randomUUID, createHash, createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BrokerClient } from "../../../src/broker/client.ts";
import type { BrokerBackend } from "../../../src/server/broker-backend.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const brokerBin = process.env.WOLFPACK_BROKER_BIN ?? join(ROOT, "broker", "target", "release", "wolfpack-broker");
const expectedBrokerSha256 = process.env.WOLFPACK_BROKER_SHA256;
const sandbox = mkdtempSync(join(tmpdir(), "wolfpack-extension-native-"));
const home = join(sandbox, "home");
const socket = join(sandbox, "broker.sock");
const bin = join(sandbox, "bin");
const project = join(sandbox, "project");
const secret = "extension-native-acceptance-secret-1234567890";
let broker: ChildProcess | undefined;
let server: ChildProcess | undefined;
let BrokerClientClass: typeof BrokerClient;
let BrokerBackendClass: typeof BrokerBackend;
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
    WOLFPACK_LOG_LEVEL: "error",
    WOLFPACK_BROKER_SOCKET: socket,
    WOLFPACK_MACHINE_ID_PATH: join(home, ".wolfpack", "machine-id"),
    WOLFPACK_SESSION_IDENTITY_PATH: join(home, ".wolfpack", "session-identities.json"),
    WOLFPACK_JWT_SECRET: secret,
    WOLFPACK_DEV_DIR: project,
    WOLFPACK_SETTINGS_PATH: join(home, ".wolfpack", "settings.json"),
    WOLFPACK_TASK_ROOT: join(home, ".wolfpack", "tasks"),
    WOLFPACK_TASK_RELAY_ROOT: join(home, ".wolfpack", "relay"),
    WOLFPACK_PI_SKILLS_ROOT: join(home, ".pi", "agent", "skills"),
    ...(port === undefined ? {} : { WOLFPACK_PORT: String(port) }),
  };
}
function assertOwned(path: string, label: string): void {
  const root = `${resolve(sandbox)}/`; const value = resolve(path);
  if (!value.startsWith(root)) fail(`${label} escapes the owned native sandbox: ${value}`);
}
function configureOuterEnvironment(): void {
  for (const [name, value] of Object.entries(childEnv())) process.env[name] = value;
  assertOwned(home, "HOME"); assertOwned(project, "WOLFPACK_DEV_DIR"); assertOwned(socket, "WOLFPACK_BROKER_SOCKET");
  for (const name of ["WOLFPACK_MACHINE_ID_PATH", "WOLFPACK_SESSION_IDENTITY_PATH", "WOLFPACK_SETTINGS_PATH", "WOLFPACK_TASK_ROOT", "WOLFPACK_TASK_RELAY_ROOT", "WOLFPACK_PI_SKILLS_ROOT"]) assertOwned(process.env[name]!, name);
}
async function assertOwnedPersistentPaths(): Promise<void> {
  configureOuterEnvironment();
  const { sessionIdentityStorePath } = await import("../../../src/server/session-identity.ts");
  assertOwned(sessionIdentityStorePath(), "session identity store");
  const clientModule = await import("../../../src/broker/client.ts");
  const backendModule = await import("../../../src/server/broker-backend.ts");
  BrokerClientClass = clientModule.BrokerClient;
  BrokerBackendClass = backendModule.BrokerBackend;
}
function run(command: readonly string[], env = childEnv()): string {
  const result = Bun.spawnSync([...command], { cwd: sandbox, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail(`${command.join(" ")} exited ${result.exitCode}: ${result.stderr.toString().slice(-1000)}`);
  return result.stdout.toString();
}
function runCli(cli: string, args: readonly string[], port: number, expected = 0): string {
  const result = Bun.spawnSync([cli, ...args], { cwd: sandbox, env: childEnv(port), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== expected) fail(`CLI ${args.join(" ")} exited ${result.exitCode}, expected ${expected}: ${result.stderr.toString().slice(-1000)} ${result.stdout.toString().slice(-2000)}`);
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
  if (expectedBrokerSha256 !== undefined && checksum !== expectedBrokerSha256) fail(`configured broker digest mismatch: ${checksum}`);
  broker = spawn(brokerBin, [], { env: { ...childEnv(), WOLFPACK_BROKER_SOCKET: socket }, stdio: ["ignore", "ignore", "pipe"] });
  await waitForSocket();
  let connected = false;
  client = new BrokerClientClass({ socketPath: socket, requestTimeoutMs: 5_000, onConnect: () => { connected = true; } });
  client.start();
  const deadline = Date.now() + 5_000;
  while (!connected && Date.now() < deadline) await wait(25);
  if (!connected) fail("broker client did not connect");
  if ((await client.request("list_sessions", {})).status !== "ok") fail("broker did not accept list_sessions");
  backend = new BrokerBackendClass(client);
}
async function waitForExit(child: ChildProcess, timeout: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return await new Promise((resolve) => { const timer = setTimeout(() => resolve(false), timeout); child.once("exit", () => { clearTimeout(timer); resolve(true); }); });
}
async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 3_000)) return;
  child.kill("SIGKILL");
  if (!await waitForExit(child, 3_000)) fail("owned child did not exit after SIGKILL");
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
async function packagedSampleSource(): Promise<string> {
  const source = join(ROOT, "examples", "extensions", "agent-context"); const packs = join(sandbox, "packs"); mkdirSync(packs, { recursive: true, mode: 0o700 });
  const packed = Bun.spawnSync(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", packs], { cwd: source, env: childEnv(), stdout: "pipe", stderr: "pipe" });
  if (packed.exitCode !== 0) fail(`sample package pack failed: ${packed.stderr.toString().slice(-1000)}`);
  const value = JSON.parse(packed.stdout.toString()) as Array<{ filename?: string }>; const filename = value[0]?.filename;
  if (!filename) fail("sample package pack returned no filename"); const archive = join(packs, filename); const integrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
  const { inspectNpmTarball, extractVerifiedNpmTarball } = await import("../../../src/extensions/package-security.ts");
  await inspectNpmTarball(archive); const extracted = await extractVerifiedNpmTarball(archive, join(sandbox, "sample-extract"), { integrity });
  const required = ["dist/ui.js", "schemas/context.schema.json", "skills/wolfpack-agent-context/SKILL.md"];
  if (!required.every((path) => existsSync(join(extracted, path)))) fail("packed sample omitted a declared UI/schema/skill file");
  return extracted;
}
async function expectSelfContext(cli: string, port: number, sessionId: string): Promise<string> {
  const output = join(sandbox, `self-${randomUUID()}.json`);
  const done = `${output}.exit`;
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  // Execute INSIDE the real broker-created shell: no harness-supplied self UUID.
  const command = `${quote(cli)} session current-context --json > ${quote(output)}; printf '%s' \"$?\" > ${quote(done)}`;
  runCli(cli, ["session", "send", sessionId, command, "--json"], port);
  const deadline = Date.now() + 8_000;
  while (!existsSync(done) && Date.now() < deadline) await wait(25);
  if (!existsSync(done) || readFileSync(done, "utf8") !== "0") {
    fail(`in-session current-context failed: exit=${existsSync(done) ? readFileSync(done, "utf8") : "missing"}; response=${existsSync(output) ? readFileSync(output, "utf8") : "missing"}`);
  }
  const context = JSON.parse(readFileSync(output, "utf8"));
  if (context.ok !== true || context.verified !== true || context.sessionId !== sessionId || context.projectDir !== project || context.harness !== "shell") fail(`incorrect self context: ${JSON.stringify(context)}`);
  return context.sessionId;
}
async function expectRead(cli: string, port: number, sessionId: string, revision: number, goal: string | null): Promise<void> {
  const data = JSON.parse(runCli(cli, ["extension-data", "read", "agent-context/context", "--session", sessionId, "--json"], port));
  if (data.revision !== revision || (goal === null ? data.document !== null : data.document?.goal !== goal)) fail(`unexpected read response ${JSON.stringify(data)}`);
}

try {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  mkdirSync(project, { recursive: true, mode: 0o700 });
  await assertOwnedPersistentPaths();
  const source = await packagedSampleSource();
  // Keep a second compiled declaration at a non-1 schema version. This proves
  // extension-data resolves the installed declaration rather than hardcoding 1.
  const nonOneSource = join(sandbox, "non-one-extension"); mkdirSync(join(nonOneSource, "dist"), { recursive: true }); mkdirSync(join(nonOneSource, "schemas"), { recursive: true });
  writeFileSync(join(nonOneSource, "package.json"), JSON.stringify({ name: "native-version-fixture", version: "1.0.0", wolfpack: { manifestVersion: 1, apiVersion: 1, id: "native", ui: "dist/ui.js", skills: [], documents: [{ id: "context", schemaVersion: 7, schema: "schemas/context.json" }] } }));
  writeFileSync(join(nonOneSource, "dist", "ui.js"), "export const nativeVersionFixture = true;\n");
  writeFileSync(join(nonOneSource, "schemas", "context.json"), JSON.stringify({ type: "object", required: ["goal"], properties: { goal: { type: "string" } }, additionalProperties: false }));
  const nonOneDocument = join(sandbox, "non-one.json"); writeFileSync(nonOneDocument, JSON.stringify({ goal: "non-one declaration version" }));
  const firstDocument = join(sandbox, "first.json");
  const secondDocument = join(sandbox, "second.json");
  const document = (goal: string) => ({ schemaVersion: 1, goal, planItems: [], decisions: [], blockers: [], nextSteps: [] });
  writeFileSync(firstDocument, JSON.stringify(document("retained across compiled server restart")));
  writeFileSync(secondDocument, JSON.stringify(document("revision two")));
  const cli = join(bin, "wolfpack");
  const serverBin = join(bin, "wolfpack-extension-server");
  const workerEntry = join(ROOT, "src", "task-relay", "worker-entry.ts");
  // Status inspection uses the production relay gateway; embed its named worker
  // just as the normal release build does, rather than mocking registrations.
  run([process.execPath, "build", "--compile", "--entry-naming", "[name].js", join(ROOT, "src", "cli", "index.ts"), workerEntry, "--outfile", cli]);
  run([process.execPath, "build", "--compile", "--entry-naming", "[name].js", join(ROOT, "tests", "integration", "fixtures", "extension-native-server.ts"), workerEntry, "--outfile", serverBin]);
  runCli(cli, ["extensions", "install", source, "--trust-browser-code", "--skills", "pi"], 18790);
  runCli(cli, ["extensions", "install", nonOneSource, "--trust-browser-code"], 18790);
  if (!existsSync(join(home, ".pi", "agent", "skills", "wolfpack-agent-context", "SKILL.md"))) fail("installed sample skill was not deployed into the owned discovery root");
  await startBroker();
  const original = await createShell("native-scope");
  let port = await startServer(serverBin);
  const selfScope = await expectSelfContext(cli, port, original.wolfpackSessionId);

  const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/extensions`);
  if (unauthenticated.status !== 401) fail(`catalog accepted unauthenticated request (${unauthenticated.status})`);
  const catalogResponse = await fetch(`http://127.0.0.1:${port}/api/extensions`, { headers: { Authorization: `Bearer ${jwt()}` } });
  const catalog = await catalogResponse.json() as any;
  const installed = catalog.installations?.find((item: any) => item.extensionId === "agent-context"); const nonOne = catalog.installations?.find((item: any) => item.extensionId === "native");
  if (!catalogResponse.ok || installed?.documents?.[0]?.schemaVersion !== 1 || nonOne?.documents?.[0]?.schemaVersion !== 7 || typeof installed?.ui?.url !== "string") fail(`catalog did not expose installed declaration: ${JSON.stringify(catalog)}`);
  const asset = await fetch(`http://127.0.0.1:${port}${installed.ui.url}`, { headers: { Authorization: `Bearer ${jwt()}` } });
  if (!asset.ok || (await asset.text()).includes("wolfpack-bridge/extensions")) fail("authenticated sample asset was not served as a self-contained installed bundle");

  // This must be the first compiled publication so an extension-data mutant
  // that sends schemaVersion: 1 is rejected before sample coverage can mask it.
  runCli(cli, ["extension-data", "publish", "native/context", "--session", original.wolfpackSessionId, "--file", nonOneDocument, "--if-revision", "0", "--request-id", randomUUID(), "--json"], port);
  const requestId = randomUUID();
  runCli(cli, ["extension-data", "publish", "agent-context/context", "--session", selfScope, "--file", firstDocument, "--if-revision", "0", "--request-id", requestId, "--json"], port);
  await expectRead(cli, port, original.wolfpackSessionId, 1, "retained across compiled server restart");
  runCli(cli, ["extension-data", "publish", "agent-context/context", "--session", "not-a-uuid", "--file", firstDocument, "--if-revision", "0", "--request-id", randomUUID(), "--json"], port, 2);
  runCli(cli, ["extension-data", "publish", "agent-context/context", "--session", randomUUID(), "--file", firstDocument, "--if-revision", "0", "--request-id", randomUUID(), "--json"], port, 1);

  await stop(server); server = undefined;
  port = await startServer(serverBin);
  await expectSelfContext(cli, port, original.wolfpackSessionId);
  const retry = JSON.parse(runCli(cli, ["extension-data", "publish", "agent-context/context", "--session", original.wolfpackSessionId, "--file", firstDocument, "--if-revision", "0", "--request-id", requestId, "--json"], port));
  if (retry.receipt?.revision !== 1 || retry.receipt?.requestId !== requestId) fail(`identical retry did not return retained receipt: ${JSON.stringify(retry)}`);
  runCli(cli, ["extension-data", "publish", "agent-context/context", "--session", original.wolfpackSessionId, "--file", secondDocument, "--if-revision", "0", "--request-id", randomUUID(), "--json"], port, 1);
  runCli(cli, ["extension-data", "publish", "agent-context/context", "--session", original.wolfpackSessionId, "--file", secondDocument, "--if-revision", "1", "--request-id", randomUUID(), "--json"], port);
  await expectRead(cli, port, original.wolfpackSessionId, 2, "revision two");

  await backend!.killSessionById(original.wolfpackSessionId);
  const retainedAfterExit = JSON.parse(runCli(cli, ["extension-data", "publish", "agent-context/context", "--session", original.wolfpackSessionId, "--file", firstDocument, "--if-revision", "0", "--request-id", requestId, "--json"], port));
  if (retainedAfterExit.receipt?.revision !== 1) fail("retained retry was revalidated after terminal exit");
  runCli(cli, ["extension-data", "publish", "agent-context/context", "--session", original.wolfpackSessionId, "--file", secondDocument, "--if-revision", "2", "--request-id", randomUUID(), "--json"], port, 1);
  const replacement = await createShell("native-scope");
  if (replacement.wolfpackSessionId === original.wolfpackSessionId) fail("same-name shell did not receive a new broker UUID");
  await expectSelfContext(cli, port, replacement.wolfpackSessionId);
  const stale = Bun.spawnSync([cli, "session", "current-context", "--json"], { cwd: sandbox, env: { ...childEnv(port), WOLFPACK_SESSION_ID: original.wolfpackSessionId, WOLFPACK_SESSION_NAME: "native-scope", WOLFPACK_PROJECT_DIR: project, WOLFPACK_AGENT_KIND: "shell" }, stdout: "pipe", stderr: "pipe" });
  if (stale.exitCode === 0 || JSON.parse(stale.stdout.toString()).ok !== false) fail("stale self identity borrowed a replacement by name");
  await expectRead(cli, port, replacement.wolfpackSessionId, 0, null);
  const replacementPublish = runCli(cli, ["extension-data", "publish", "agent-context/context", "--session", replacement.wolfpackSessionId, "--file", firstDocument, "--if-revision", "0", "--request-id", randomUUID(), "--json"], port);
  try { await expectRead(cli, port, replacement.wolfpackSessionId, 1, "retained across compiled server restart"); }
  catch (error) { fail(`${error instanceof Error ? error.message : String(error)}; replacement publish=${replacementPublish}`); }
  process.stdout.write("extension-native-acceptance: compiled CLI/server + in-session verified UUID/restart/CAS/isolation OK\n");
} finally {
  try { client?.close(); } catch { /* owned cleanup */ }
  await stop(server);
  await stop(broker);
  rmSync(sandbox, { recursive: true, force: true });
}
