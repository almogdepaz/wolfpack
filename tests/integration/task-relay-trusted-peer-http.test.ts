import { expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateControlApiSchemaValue as validate, type JsonObject } from "../control-api-schema-validator.ts";
import { buildControlApiSchema } from "../../src/control-api/schema.ts";
import { qualifyRemoteTaskEndpoint } from "../../src/cli/task-endpoint.ts";
const profile = "volatile-v1", route = "/api/task-relay/volatile-v1", schema = buildControlApiSchema() as JsonObject;
const secret = "private-tailnet-relay-fixture-secret-at-least-32";
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const signed = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 600 })}`;
const headers = { "content-type": "application/json", authorization: `Bearer ${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}` };
const origin = (name: string) => `https://${name}.tail123.ts.net`;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function fixture(ownerAuth = true) {
  const root = mkdtempSync(join(tmpdir(), "trusted-peer-http-")), mapping = join(root, "network.json");
  writeFileSync(mapping, "{}", { mode: 0o600 });
  const children: ReturnType<typeof Bun.spawn>[] = [], roots: Record<string, string> = {}, bases: Record<string, string> = {};
  const close = async () => {
    for (const child of children) child.kill("SIGTERM");
    for (const child of children) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exit = await Promise.race([child.exited, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5000); })]);
      clearTimeout(timer);
      if (exit === null) { child.kill("SIGKILL"); await child.exited; throw new Error("owned peer fixture did not stop gracefully"); }
      expect(exit).toBe(0);
    }
    rmSync(root, { recursive: true, force: true });
  };
  try {
    for (const name of ["a", "b"]) {
      const home = join(root, name); roots[name] = home; mkdirSync(join(home, ".wolfpack"), { recursive: true, mode: 0o700 });
      // mkdir recursive modes do not retrofit an existing ancestor; own the fixture root explicitly.
      const { chmodSync } = await import("node:fs"); chmodSync(home, 0o700);
      writeFileSync(join(home, ".wolfpack", "config.json"), JSON.stringify({ devDir: home, port: 18790, tailscaleHostname: `${name}.tail123.ts.net` }), { mode: 0o600 });
      const node = (id: string) => ({ ID: `node-${id}`, DNSName: `${id}.tail123.ts.net.`, Online: true, UserID: id === "b" ? 2 : 1, ...(id === "b" && { Tags: ["tag:server"] }) });
      const status = { BackendState: "Running", Self: node(name), Peer: { other: node(name === "a" ? "b" : "a"), guest: { ...node("guest"), UserID: 2 } } };
      const nonce = randomUUID();
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/volatile-peer-http.ts"), home, mapping, nonce], {
        cwd: home, env: { PATH: process.env.PATH, HOME: home, WOLFPACK_TEST: "1",
          WOLFPACK_TASK_RELAY_ROOT: join(home, "relay"), WOLFPACK_BROKER_SOCKET: join(home, "no-broker.sock"), ...(ownerAuth && { WOLFPACK_JWT_SECRET: secret }),
          WOLFPACK_TAILSCALE_STATUS_JSON: JSON.stringify(status) }, stdin: "ignore", stdout: Bun.file(join(home, "stdout.log")), stderr: Bun.file(join(home, "stderr.log")),
      }); children.push(child);
      const deadline = Date.now() + 8000;
      while (!existsSync(join(home, "ready.json")) && child.exitCode === null && Date.now() < deadline) await pause(10);
      if (!existsSync(join(home, "ready.json"))) throw new Error(`private peer startup failed: ${readFileSync(join(home, "stderr.log"), "utf8").slice(-2000)}`);
      const ready = JSON.parse(readFileSync(join(home, "ready.json"), "utf8")); expect(ready.nonce).toBe(nonce); expect(ready.pid).toBe(child.pid);
      bases[name] = `http://127.0.0.1:${ready.port}`;
    }
    writeFileSync(mapping, JSON.stringify(Object.fromEntries(Object.entries(bases).map(([name, base]) => [origin(name), base]))));
    const post = async (name: string, body: unknown, path = route) => {
      const response = await fetch(bases[name] + path, { method: "POST", headers, body: JSON.stringify(body) });
      const value = await response.json() as any;
      expect(validate({ $ref: "#/$defs/VolatileResponse" }, value, schema)).toEqual([]);
      return { status: response.status, body: value };
    };
    const connect = async (name: string, callerSession: string) => {
      const result = await post(name, { profile, operation: "connect", callerSession, generation: randomUUID(), protocolVersions: [2] }); expect(result.status).toBe(200);
      return { profile, epoch: result.body.epoch, callerSession, endpoint: result.body.value.endpoint };
    };
    return { root, roots, bases, post, connect, close };
  } catch (error) { await close(); throw error; }
}

for (const ownerAuth of [false, true]) test(`production trusted-Tailnet HTTP accepts other-user tagged peers without signatures (optional JWT=${ownerAuth})`, async () => {
  const f = await fixture(ownerAuth);
  try {
    const a = await f.connect("a", "sender"), b = await f.connect("b", "receiver");
    const resolved = await f.post("a", { ...a, origin: origin("b"), target: b.endpoint }, route + "/resolve-peer"); expect(resolved.status).toBe(200);
    const envelope = { envelopeId: randomUUID(), protocolVersion: 2, source: a.endpoint, target: resolved.body.value.endpoint, payload: { opaque: "first" }, createdAt: new Date().toISOString() };
    const sent = await f.post("a", { ...a, operation: "send", envelope }); expect(sent.status).toBe(200); expect(sent.body.value.forwarding).toBe("forwarded");
    const duplicate = await f.post("a", { ...a, operation: "send", envelope }); expect(duplicate.body.value).toMatchObject({ duplicate: true, acceptanceId: sent.body.value.acceptanceId });
    const inbox = await f.post("b", { ...b, operation: "receive", cursor: "0" }); expect(inbox.body.value.deliveries).toHaveLength(1);
    expect(inbox.body.value.deliveries[0].envelope.payload).toEqual(envelope.payload);
    writeFileSync(join(f.roots.a!, "network-mode"), "drop-next");
    const lost = { ...envelope, envelopeId: randomUUID(), payload: { opaque: "lost confirmation" } };
    const uncertain = await f.post("a", { ...a, operation: "send", envelope: lost }); expect(uncertain.body.error.code).toBe("PEER_UNREACHABLE");
    const firstFrame = JSON.parse(readFileSync(join(f.roots.a!, "last-forward.json"), "utf8"));
    await pause(1050);
    const retry = await f.post("a", { ...a, operation: "send", envelope: lost }); expect(retry.status).toBe(200); expect(retry.body.value.duplicate).toBe(true);
    expect(JSON.parse(readFileSync(join(f.roots.a!, "last-forward.json"), "utf8"))).toEqual(firstFrame);
    expect((await f.post("b", { ...b, operation: "receive", cursor: "0" })).body.value.deliveries).toHaveLength(2);
    const frame = JSON.parse(readFileSync(join(f.roots.a!, "last-forward.json"), "utf8"));
    expect(frame.signature).toBeUndefined(); expect(frame.ownerAuth).toBe(ownerAuth);
    expect((await fetch(f.bases.b + route + "/peer", { method: "POST", headers: { "content-type": "application/json" }, body: frame.raw })).status).toBe(ownerAuth ? 401 : 200);
    const admitted = await fetch(f.bases.b + route + "/peer", { method: "POST", headers, body: frame.raw });
    expect(admitted.status).toBe(200); expect(await admitted.json()).toMatchObject({ ok: true, value: { duplicate: true } });
    const prior = JSON.parse(frame.raw), changed = { ...prior, envelope: { ...prior.envelope, payload: { opaque: "changed retry" } } };
    const conflict = await fetch(f.bases.b + route + "/peer", { method: "POST", headers, body: JSON.stringify(changed) });
    expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ ok: false, error: { code: "ENVELOPE_CONFLICT" } });
    expect((await f.post("a", { ...a, origin: origin("unknown"), target: b.endpoint }, route + "/resolve-peer")).status).toBe(403);
  } finally { await f.close(); }
}, 30_000);

const piSource = process.env.WOLFPACK_PI_TASKS_SOURCE;
test.skipIf(!piSource)("normal pinned RAM cores authenticate locally and complete through CLI-qualified trusted HTTP peers", async () => {
  expect(isAbsolute(piSource!)).toBe(true); expect(process.env.WOLFPACK_PI_TASKS_REVISION).toMatch(/^[0-9a-f]{40}$/);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: piSource, encoding: "utf8" }).trim()).toBe(process.env.WOLFPACK_PI_TASKS_REVISION!);
  expect(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: piSource, encoding: "utf8" }).trim()).toBe("");
  const { createConfiguredTaskCore } = await import(pathToFileURL(join(piSource!, "src/index.ts")).href);
  const f = await fixture(), cores: any[] = [];
  const authNames = ["WOLFPACK_JWT_SECRET", "WOLFPACK_JWT_ISSUER", "WOLFPACK_JWT_AUDIENCE"];
  const prior = authNames.map(name => process.env[name]);
  process.env.WOLFPACK_JWT_SECRET = secret; delete process.env.WOLFPACK_JWT_ISSUER; delete process.env.WOLFPACK_JWT_AUDIENCE;
  try {
    for (const name of ["a", "b"]) {
      // No authenticated fetch injection: the normal factory must mint its local JWT.
      cores.push(await createConfiguredTaskCore({ sessionName: name === "a" ? "sender" : "receiver", baseUrl: f.bases[name] }));
    }
    const [a, b] = cores;
    const selected = await qualifyRemoteTaskEndpoint({ ok: true, sessionId: "receiver-id", taskEndpoint: b.endpoint }, {
      origin: origin("b"), localBase: f.bases.a!, callerSession: "sender", headers: new Headers(headers),
      fetch: Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith(origin("b") + "/") && !url.startsWith(f.bases.a! + "/")) throw new Error("fixture selection network denied");
        return fetch(url.replace(origin("b"), f.bases.b!), init);
      }, { preconnect: fetch.preconnect }) as typeof fetch,
    }) as any;
    expect(selected.taskEndpointError).toBeUndefined(); expect(selected.taskEndpoint.relay).toContain(":peer:");
    const task = await a.createTask({ target: selected.taskEndpoint, task: "trusted cross-host completion", timeoutMs: 60_000 });
    await b.receive(); await b.submitIntent({ taskId: task.taskId, type: "task.completed", payload: { summary: "done through trusted peer ingress" } });
    await a.receive(); expect(a.getTask(task.taskId).status).toBe("completed");
    await b.receive(); expect(b.getTask(task.taskId).status).toBe("completed");
  } finally {
    try { await Promise.all(cores.map(core => core.close())); }
    finally { authNames.forEach((name, index) => { if (prior[index] === undefined) delete process.env[name]; else process.env[name] = prior[index]; }); await f.close(); }
  }
}, 30_000);
