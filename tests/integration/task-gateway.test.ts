import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import type { Server } from "node:http";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

process.env.WOLFPACK_TEST = "1";
process.env.WOLFPACK_TAILNET_SUFFIX = "example.ts.net";
delete process.env.WOLFPACK_JWT_SECRET;
const root = join(tmpdir(), `wolfpack-task-gateway-${process.pid}`);
const parentProject = join(root, "parent-project");
const receiverProject = join(root, "receiver-project");
process.env.WOLFPACK_TASK_ROOT = join(root, "tasks");
mkdirSync(parentProject, { recursive: true });
mkdirSync(receiverProject, { recursive: true });

const { __setTestBackend } = await import("../../src/server/backend.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");
const { createServerInstance } = await import("../../src/server/index.ts");
const { TASK_EVENT_TYPE, TASK_LIMITS, hashImmutableAssignment } = await import("../../src/tasks/domain.ts");
const { RELAY_ID, RELAY_PROTOCOL_VERSION } = await import("../../src/task-relay/domain.ts");
const { TASK_LEDGER_ROLE, TaskStore } = await import("../../src/tasks/store.ts");
const { TaskGateway, __resetTaskGatewayForTests } = await import("../../src/tasks/gateway.ts");

class PiBackend extends MockBackend {
  override async listIdentities() {
    const now = new Date(0).toISOString();
    return {
      parent: { wolfpackSessionId: "parent-id", wolfpackSessionName: "parent", projectPath: parentProject, agentKind: "pi", createdAt: now, updatedAt: now },
      receiver: { wolfpackSessionId: "receiver-id", wolfpackSessionName: "receiver", projectPath: receiverProject, agentKind: "pi", createdAt: now, updatedAt: now },
    };
  }
}

__setTestBackend(new PiBackend({ sessions: ["parent", "receiver"] }));
const { server } = createServerInstance();
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => (server as Server).listen(0, "127.0.0.1", () => {
    base = `http://127.0.0.1:${((server as Server).address() as AddressInfo).port}`;
    resolve();
  }));
});

afterAll(() => {
  (server as Server).close();
  rmSync(root, { recursive: true, force: true });
});

async function request(path: string, method: "GET" | "POST", body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function peerResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

interface PeerServer {
  readonly process: ChildProcess;
  readonly base: string;
  readonly taskRoot: string;
  readonly stderr: { value: string };
}

interface PeerEventResponseLoss {
  readonly type: string;
  readonly count: number;
}

interface PeerServerOptions {
  readonly role: "sender" | "receiver";
  readonly port: number;
  readonly taskRoot: string;
  readonly home: string;
  readonly projectRoot: string;
  readonly peerMapPath: string;
  readonly peerOrigin: string;
  readonly dispatchLogPath: string;
  readonly clockPath?: string;
  readonly losePeerReceiveResponse?: boolean;
  readonly peerEventResponseLoss?: readonly PeerEventResponseLoss[];
  readonly peerEventResponseDelayMs?: number;
  readonly crashAfterPeerEvent?: string;
  readonly crashBeforePeerEvent?: string;
  readonly crashBeforePeerEventAttempt?: number;
  readonly fastRetry?: boolean;
  readonly taskRelay?: boolean;
}

async function reservePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("expected a reserved TCP port");
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function waitForPeerReady(process: ChildProcess, port: number, stderr: { value: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(new Error(`peer server did not become ready on ${port}: ${stderr.value}`)), 10_000);
    process.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes(`READY:${port}`)) finish(undefined);
    });
    process.stderr?.on("data", (chunk: Buffer) => { stderr.value += chunk.toString(); });
    process.once("error", (error) => finish(error));
    process.once("exit", (code, signal) => finish(new Error(`peer server exited before ready (code ${code}, signal ${signal}): ${stderr.value}`)));
  });
}

async function spawnPeerServer(options: PeerServerOptions): Promise<PeerServer> {
  const child = spawn(process.execPath, [join(import.meta.dir, "fixtures", "task-gateway-peer-server.ts")], {
    cwd: join(import.meta.dir, "..", ".."),
    env: {
      ...process.env,
      HOME: options.home,
      WOLFPACK_TASK_ROOT: options.taskRoot,
      WOLFPACK_TEST: "1",
      WOLFPACK_TEST_DISPATCH_LOG: options.dispatchLogPath,
      WOLFPACK_TEST_CLOCK_PATH: options.clockPath ?? "",
      WOLFPACK_TEST_LOSE_PEER_RECEIVE_RESPONSE: options.losePeerReceiveResponse ? "1" : "",
      WOLFPACK_TEST_PEER_EVENT_RESPONSE_LOSS: JSON.stringify(options.peerEventResponseLoss ?? []),
      WOLFPACK_TEST_PEER_EVENT_RESPONSE_DELAY_MS: String(options.peerEventResponseDelayMs ?? 0),
      WOLFPACK_TEST_CRASH_AFTER_PEER_EVENT: options.crashAfterPeerEvent ?? "",
      WOLFPACK_TEST_CRASH_BEFORE_PEER_EVENT: options.crashBeforePeerEvent ?? "",
      WOLFPACK_TEST_CRASH_BEFORE_PEER_EVENT_ATTEMPT: String(options.crashBeforePeerEventAttempt ?? 0),
      WOLFPACK_TEST_FAST_RETRY: options.fastRetry ? "1" : "",
      WOLFPACK_TEST_TASK_RELAY: options.taskRelay ? "1" : "",
      WOLFPACK_TEST_LISTEN_PORT: String(options.port),
      WOLFPACK_TEST_PEER_MAP: options.peerMapPath,
      WOLFPACK_TEST_PEER_ORIGIN: options.peerOrigin,
      WOLFPACK_TEST_PEER_ROLE: options.role,
      WOLFPACK_TEST_PROJECT_ROOT: options.projectRoot,
      WOLFPACK_TAILNET_SUFFIX: "example.ts.net",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = { value: "" };
  await waitForPeerReady(child, options.port, stderr);
  return { process: child, base: `http://127.0.0.1:${options.port}`, taskRoot: options.taskRoot, stderr };
}

async function stopPeerServer(peer: PeerServer | undefined): Promise<void> {
  if (!peer || peer.process.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => peer.process.once("exit", () => resolve()));
  peer.process.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  if (peer.process.exitCode === null) {
    peer.process.kill("SIGKILL");
    await exited;
  }
}

interface PeerRedirectFixture {
  readonly port: number;
  readonly redirectRequests: number;
  readonly sinkRequests: number;
  readonly sinkBytes: number;
  readonly stop: () => Promise<void>;
}

async function createPeerRedirectFixture(status: 307 | 308): Promise<PeerRedirectFixture> {
  let redirectRequests = 0;
  let sinkRequests = 0;
  let sinkBytes = 0;
  const sink = createHttpServer((request, response) => {
    sinkRequests += 1;
    request.on("data", (chunk: Buffer) => { sinkBytes += chunk.length; });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  const sinkPort = await new Promise<number>((resolve, reject) => {
    sink.once("error", reject);
    sink.listen(0, "127.0.0.1", () => {
      const address = sink.address();
      if (!address || typeof address === "string") throw new Error("expected a sink TCP port");
      resolve(address.port);
    });
  });
  const redirect = createHttpServer((_request, response) => {
    redirectRequests += 1;
    response.writeHead(status, { location: `http://127.0.0.1:${sinkPort}/sink` });
    response.end();
  });
  const port = await new Promise<number>((resolve, reject) => {
    redirect.once("error", reject);
    redirect.listen(0, "127.0.0.1", () => {
      const address = redirect.address();
      if (!address || typeof address === "string") throw new Error("expected a redirect TCP port");
      resolve(address.port);
    });
  });
  const close = (server: Server): Promise<void> => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return {
    port,
    get redirectRequests(): number { return redirectRequests; },
    get sinkRequests(): number { return sinkRequests; },
    get sinkBytes(): number { return sinkBytes; },
    stop: async (): Promise<void> => { await Promise.all([close(redirect), close(sink)]); },
  };
}

async function peerRequest(base: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await response.json();
  if (response.status !== 200) throw new Error(`task API request failed with ${response.status}: ${JSON.stringify(parsed)}`);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected task API object response");
  return parsed as Record<string, unknown>;
}

function canonicalEvents(body: Record<string, unknown>): Array<{ readonly id: string; readonly type: string; readonly sequence: string }> {
  const events = body.events;
  if (!Array.isArray(events)) throw new Error("expected task status events");
  return events.map((event) => {
    if (typeof event !== "object" || event === null) throw new Error("expected canonical task event");
    const candidate = event as Record<string, unknown>;
    if (typeof candidate.id !== "string" || typeof candidate.type !== "string" || typeof candidate.sequence !== "string") throw new Error("expected canonical task event identity");
    return { id: candidate.id, type: candidate.type, sequence: candidate.sequence };
  });
}

interface PeerPairOptions {
  readonly now?: () => Date;
  readonly receiverStore?: InstanceType<typeof TaskStore>;
  readonly senderTransport?: (
    payload: Record<string, unknown>,
    deliver: () => Promise<Response>,
  ) => Promise<Response>;
  readonly receiverTransport?: (
    payload: Record<string, unknown>,
    deliver: () => Promise<Response>,
  ) => Promise<Response>;
}

function createPeerPair(taskRoot: string, options: PeerPairOptions = {}): {
  readonly sender: InstanceType<typeof TaskGateway>;
  readonly receiver: InstanceType<typeof TaskGateway>;
  readonly senderRoot: string;
  readonly receiverRoot: string;
} {
  const senderRoot = join(taskRoot, "sender");
  const receiverRoot = join(taskRoot, "receiver");
  let sender: InstanceType<typeof TaskGateway>;
  const receiver = new TaskGateway({
    root: receiverRoot,
    store: options.receiverStore,
    peerOrigin: "https://receiver.example.ts.net",
    now: options.now,
    peerFetch: async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const deliver = async () => peerResponse(await sender.acceptPeerEvent(payload));
      return options.receiverTransport?.(payload, deliver) ?? deliver();
    },
    sleep: async () => undefined,
    random: () => 0.5,
  });
  sender = new TaskGateway({
    root: senderRoot,
    peerOrigin: "https://sender.example.ts.net",
    now: options.now,
    peerFetch: async (url, init) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const deliver = async () => peerResponse(new URL(String(url)).pathname.endsWith("/receive")
        ? await receiver.receivePeer(payload)
        : await receiver.acceptPeerEvent(payload));
      return options.senderTransport?.(payload, deliver) ?? deliver();
    },
    sleep: async () => undefined,
    random: () => 0.5,
  });
  return { sender, receiver, senderRoot, receiverRoot };
}

interface HttpPeerFixture {
  readonly root: string;
  readonly senderPort: number;
  readonly receiverPort: number;
  readonly senderOrigin: string;
  readonly receiverOrigin: string;
  readonly senderTaskRoot: string;
  readonly receiverTaskRoot: string;
  readonly peerMapPath: string;
  readonly dispatchLogPath: string;
  readonly clockPath: string;
}

async function createHttpPeerFixture(label: string): Promise<HttpPeerFixture> {
  const root = join(tmpdir(), `wolfpack-task-peer-http-${label}-${process.pid}-${Date.now()}`);
  const senderPort = await reservePort();
  const receiverPort = await reservePort();
  const senderOrigin = "https://sender.example.ts.net";
  const receiverOrigin = "https://receiver.example.ts.net";
  const peerMapPath = join(root, "peer-map.json");
  const dispatchLogPath = join(root, "peer-dispatches.jsonl");
  const clockPath = join(root, "clock.txt");
  mkdirSync(root, { recursive: true });
  writeFileSync(peerMapPath, JSON.stringify({ "sender.example.ts.net": senderPort, "receiver.example.ts.net": receiverPort }));
  writeFileSync(clockPath, "2026-08-04T00:00:00.000Z");
  return {
    root, senderPort, receiverPort, senderOrigin, receiverOrigin,
    senderTaskRoot: join(root, "sender", "tasks"), receiverTaskRoot: join(root, "receiver", "tasks"),
    peerMapPath, dispatchLogPath, clockPath,
  };
}

function peerServerOptions(
  fixture: HttpPeerFixture,
  role: "sender" | "receiver",
  peerEventResponseLoss: readonly PeerEventResponseLoss[] = [],
  fastRetry = false,
  crashAfterPeerEvent: string | undefined = undefined,
  crashBeforePeerEvent: string | undefined = undefined,
  crashBeforePeerEventAttempt: number | undefined = undefined,
  peerEventResponseDelayMs: number | undefined = undefined,
): PeerServerOptions {
  return {
    role,
    port: role === "sender" ? fixture.senderPort : fixture.receiverPort,
    taskRoot: role === "sender" ? fixture.senderTaskRoot : fixture.receiverTaskRoot,
    home: join(fixture.root, `${role}-home`),
    projectRoot: join(fixture.root, `${role}-project`),
    peerMapPath: fixture.peerMapPath,
    peerOrigin: role === "sender" ? fixture.senderOrigin : fixture.receiverOrigin,
    dispatchLogPath: fixture.dispatchLogPath,
    clockPath: fixture.clockPath,
    peerEventResponseLoss,
    peerEventResponseDelayMs,
    crashAfterPeerEvent,
    crashBeforePeerEvent,
    crashBeforePeerEventAttempt,
    fastRetry,
  };
}

function taskRelayPeerServerOptions(fixture: HttpPeerFixture, role: "sender" | "receiver"): PeerServerOptions {
  return { ...peerServerOptions(fixture, role), taskRelay: true };
}

function peerDispatches(fixture: HttpPeerFixture): readonly Record<string, unknown>[] {
  if (!existsSync(fixture.dispatchLogPath)) return [];
  const text = readFileSync(fixture.dispatchLogPath, "utf8").trim();
  return text === "" ? [] : text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForPeerDispatch(fixture: HttpPeerFixture, eventType: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (peerDispatches(fixture).some((entry) => entry.role === "sender" && entry.path === "/api/tasks/v1/peer/event" && entry.eventType === eventType)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${eventType} peer dispatch`);
}

async function postPeerRequest(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function remoteSendInput(task: string, timeoutMs: number | undefined = undefined): Parameters<InstanceType<typeof TaskGateway>["send"]>[0] {
  return {
    callerSession: "parent",
    to: { machine: "https://receiver.example.ts.net", sessionId: "receiver-id" },
    task,
    context: undefined,
    role: undefined,
    preflight: undefined,
    metadata: undefined,
    onCompletePrompt: undefined,
    timeoutMs,
    idempotencyKey: undefined,
    rawBody: undefined,
  };
}

describe("cross-process peer task gateway", () => {
  test("resolves and forwards opaque relay endpoints through two isolated HTTP servers", async () => {
    const fixture = await createHttpPeerFixture("relay-topology");
    let sender: PeerServer | undefined;
    let receiver: PeerServer | undefined;
    try {
      receiver = await spawnPeerServer(taskRelayPeerServerOptions(fixture, "receiver"));
      sender = await spawnPeerServer(taskRelayPeerServerOptions(fixture, "sender"));
      const receiverConnect = await postPeerRequest(receiver.base, "/api/task-relay/v2/connect", {
        callerSession: "receiver",
        generation: "receiver-process",
        protocolVersions: [RELAY_PROTOCOL_VERSION],
      });
      const receiverEndpoint = await receiverConnect.json() as { readonly endpoint: { readonly relay: string; readonly id: string } };
      const senderConnect = await postPeerRequest(sender.base, "/api/task-relay/v2/connect", {
        callerSession: "parent",
        generation: "sender-process",
        protocolVersions: [RELAY_PROTOCOL_VERSION],
      });
      const senderEndpoint = await senderConnect.json() as { readonly endpoint: { readonly relay: string; readonly id: string } };
      const topology = await postPeerRequest(sender.base, "/api/task-relay/v2/peer/resolve", {
        origin: fixture.receiverOrigin,
        endpoint: receiverEndpoint.endpoint,
      });
      const target = await topology.json() as { readonly endpoint: { readonly relay: string; readonly id: string } };

      expect(receiverConnect.status).toBe(200);
      expect(senderConnect.status).toBe(200);
      expect(topology.status).toBe(200);
      expect(target.endpoint).toMatchObject({ id: receiverEndpoint.endpoint.id });
      expect(target.endpoint.relay).toMatch(/^wolfpack-pi-tasks-v2:peer:[0-9a-f-]{36}$/);
      expect(JSON.stringify(target)).not.toContain(fixture.receiverOrigin);
      const accepted = await postPeerRequest(sender.base, "/api/task-relay/v2/send", {
        callerSession: "parent",
        envelope: {
          envelopeId: "two-server-relay-envelope",
          protocolVersion: RELAY_PROTOCOL_VERSION,
          source: senderEndpoint.endpoint,
          target: target.endpoint,
          payload: { opaque: true },
          createdAt: new Date(0).toISOString(),
        },
      });
      expect(await accepted.json()).toMatchObject({ ok: true, forwarding: "forwarded" });
      const inbox = await fetch(`${receiver.base}/api/task-relay/v2/receive?callerSession=receiver&cursor=0`);
      const inboxBody = await inbox.json() as { readonly ok: boolean; readonly envelopes: readonly { readonly envelopeId: string; readonly source: { readonly relay: string }; readonly target: { readonly relay: string; readonly id: string } }[] };
      expect(inboxBody.ok).toBe(true);
      expect(inboxBody.envelopes).toHaveLength(1);
      expect(inboxBody.envelopes[0]).toMatchObject({
        envelopeId: "two-server-relay-envelope",
        source: { relay: RELAY_ID },
        target: receiverEndpoint.endpoint,
      });
    } finally {
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("routes a canonical remote task lifecycle through two isolated HTTP servers", async () => {
    const fixtureRoot = join(tmpdir(), `wolfpack-task-peer-http-${process.pid}-${Date.now()}`);
    const senderPort = await reservePort();
    const receiverPort = await reservePort();
    const senderOrigin = "https://sender.example.ts.net";
    const receiverOrigin = "https://receiver.example.ts.net";
    const peerMapPath = join(fixtureRoot, "peer-map.json");
    const dispatchLogPath = join(fixtureRoot, "peer-dispatches.jsonl");
    const senderTaskRoot = join(fixtureRoot, "sender", "tasks");
    const receiverTaskRoot = join(fixtureRoot, "receiver", "tasks");
    mkdirSync(fixtureRoot, { recursive: true });
    writeFileSync(peerMapPath, JSON.stringify({ "sender.example.ts.net": senderPort, "receiver.example.ts.net": receiverPort }));

    let sender: PeerServer | undefined;
    let receiver: PeerServer | undefined;
    try {
      receiver = await spawnPeerServer({
        role: "receiver",
        port: receiverPort,
        taskRoot: receiverTaskRoot,
        home: join(fixtureRoot, "receiver-home"),
        projectRoot: join(fixtureRoot, "receiver-project"),
        peerMapPath,
        peerOrigin: receiverOrigin,
        dispatchLogPath,
      });
      sender = await spawnPeerServer({
        role: "sender",
        port: senderPort,
        taskRoot: senderTaskRoot,
        home: join(fixtureRoot, "sender-home"),
        projectRoot: join(fixtureRoot, "sender-project"),
        peerMapPath,
        peerOrigin: senderOrigin,
        dispatchLogPath,
      });

      const senderMachineId = readFileSync(join(dirname(senderTaskRoot), "machine-id"), "utf8").trim();
      const receiverMachineId = readFileSync(join(dirname(receiverTaskRoot), "machine-id"), "utf8").trim();
      expect(senderMachineId).not.toBe(receiverMachineId);

      const sent = await peerRequest(sender.base, "/api/tasks/v1/send", {
        callerSession: "parent",
        to: { machine: receiverOrigin, sessionId: "receiver-id" },
        task: "complete the cross-process task",
        idempotencyKey: "cross-process-send",
      });
      expect(sent.ok).toBe(true);
      if (typeof sent.taskId !== "string" || typeof sent.eventId !== "string") throw new Error("expected remote send receipt");
      const taskId = sent.taskId;
      const createdEventId = sent.eventId;

      const senderReceipt = await fetch(`${sender.base}/api/tasks/v1/status?callerSession=parent&taskId=${taskId}`);
      expect(senderReceipt.status).toBe(200);
      const senderAfterReceipt = await senderReceipt.json() as Record<string, unknown>;
      expect(canonicalEvents(senderAfterReceipt)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: createdEventId, type: "task.created", sequence: "1" }),
        expect.objectContaining({ type: "task.received", sequence: "2" }),
        expect.objectContaining({ type: "task.receipt_confirmed", sequence: "3" }),
      ]));

      const receiverInboxResponse = await fetch(`${receiver.base}/api/tasks/v1/inbox?callerSession=receiver&cursor=0`);
      expect(receiverInboxResponse.status).toBe(200);
      const receiverInbox = await receiverInboxResponse.json() as Record<string, unknown>;
      expect(receiverInbox.events).toEqual([expect.objectContaining({ id: createdEventId, type: "task.created", sequence: "1" })]);

      const question = await peerRequest(receiver.base, "/api/tasks/v1/message", {
        callerSession: "receiver",
        taskId,
        type: "question",
        message: "which branch should i use?",
      });
      if (typeof question.eventId !== "string") throw new Error("expected canonical remote question receipt");
      const answer = await peerRequest(sender.base, "/api/tasks/v1/message", {
        callerSession: "parent",
        taskId,
        type: "answer",
        message: "use main",
        replyToMessageId: question.eventId,
      });
      if (typeof answer.eventId !== "string") throw new Error("expected canonical remote answer receipt");
      await peerRequest(receiver.base, "/api/tasks/v1/complete", {
        callerSession: "receiver",
        taskId,
        status: "completed",
        result: { summary: "cross-process result", result: { branch: "main" } },
      });

      const senderFinalResponse = await fetch(`${sender.base}/api/tasks/v1/status?callerSession=parent&taskId=${taskId}`);
      const receiverFinalResponse = await fetch(`${receiver.base}/api/tasks/v1/status?callerSession=receiver&taskId=${taskId}`);
      expect(senderFinalResponse.status).toBe(200);
      expect(receiverFinalResponse.status).toBe(200);
      const senderFinal = await senderFinalResponse.json() as Record<string, unknown>;
      const receiverFinal = await receiverFinalResponse.json() as Record<string, unknown>;
      const senderEvents = canonicalEvents(senderFinal);
      const receiverEvents = canonicalEvents(receiverFinal);
      expect(senderFinal).toMatchObject({ ok: true, status: "completed", completion: { summary: "cross-process result", result: { branch: "main" } } });
      expect(senderEvents.map((event) => event.sequence)).toEqual(senderEvents.map((_event, index) => String(index + 1)));
      expect(senderEvents.map(({ id, type, sequence }) => ({ id, type, sequence }))).toEqual(receiverEvents.map(({ id, type, sequence }) => ({ id, type, sequence })));
      expect(senderEvents.map((event) => event.type)).toEqual([
        "task.created",
        "task.received",
        "task.receipt_confirmed",
        "task.question",
        "task.answer",
        "task.completed",
      ]);

      const dispatches = readFileSync(dispatchLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(dispatches).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "sender", origin: receiverOrigin, path: "/api/tasks/v1/peer/receive" }),
        expect.objectContaining({ role: "sender", origin: receiverOrigin, path: "/api/tasks/v1/peer/event" }),
        expect.objectContaining({ role: "receiver", origin: senderOrigin, path: "/api/tasks/v1/peer/event" }),
      ]));
      expect(existsSync(join(sender.taskRoot, "ledgers", "sender"))).toBe(true);
      expect(existsSync(join(receiver.taskRoot, "ledgers", "receiver"))).toBe(true);
      expect(existsSync(join(sender.taskRoot, "ledgers", "receiver"))).toBe(false);
      expect(existsSync(join(receiver.taskRoot, "ledgers", "sender"))).toBe(false);
    } finally {
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("rejects canonical peer POST redirects before assignment or event body delivery", async () => {
    const fixture = await createHttpPeerFixture("redirect");
    const assignmentRedirect = await createPeerRedirectFixture(307);
    const eventRedirect = await createPeerRedirectFixture(308);
    let sender: PeerServer | undefined;
    let receiver: PeerServer | undefined;
    try {
      writeFileSync(fixture.peerMapPath, JSON.stringify({ "sender.example.ts.net": fixture.senderPort, "receiver.example.ts.net": assignmentRedirect.port }));
      sender = await spawnPeerServer(peerServerOptions(fixture, "sender", [], true));
      const failedAssignment = await postPeerRequest(sender.base, "/api/tasks/v1/send", {
        callerSession: "parent", to: { machine: fixture.receiverOrigin, sessionId: "receiver-id" }, task: "do not disclose this assignment",
      });
      expect(failedAssignment.status).toBe(503);
      expect(await failedAssignment.json()).toMatchObject({ ok: false, error: { code: "PEER_UNREACHABLE" } });
      expect(assignmentRedirect.redirectRequests).toBe(1);
      expect(assignmentRedirect.sinkRequests).toBe(0);
      expect(assignmentRedirect.sinkBytes).toBe(0);

      writeFileSync(fixture.peerMapPath, JSON.stringify({ "sender.example.ts.net": fixture.senderPort, "receiver.example.ts.net": fixture.receiverPort }));
      receiver = await spawnPeerServer(peerServerOptions(fixture, "receiver"));
      const sent = await peerRequest(sender.base, "/api/tasks/v1/send", {
        callerSession: "parent", to: { machine: fixture.receiverOrigin, sessionId: "receiver-id" }, task: "deliver this assignment normally",
      });
      if (typeof sent.taskId !== "string") throw new Error("expected remote task receipt");

      writeFileSync(fixture.peerMapPath, JSON.stringify({ "sender.example.ts.net": fixture.senderPort, "receiver.example.ts.net": eventRedirect.port }));
      const failedEvent = await postPeerRequest(sender.base, "/api/tasks/v1/message", {
        callerSession: "parent", taskId: sent.taskId, type: "information", message: "do not disclose this subsequent event",
      });
      expect(failedEvent.status).toBe(503);
      expect(await failedEvent.json()).toMatchObject({ ok: false, error: { code: "PEER_UNREACHABLE" } });
      expect(eventRedirect.redirectRequests).toBe(4);
      expect(eventRedirect.sinkRequests).toBe(0);
      expect(eventRedirect.sinkBytes).toBe(0);
    } finally {
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver), assignmentRedirect.stop(), eventRedirect.stop()]);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("deduplicates concurrent remote sends through peer receive and event HTTP routes", async () => {
    const fixture = await createHttpPeerFixture("idempotency");
    let sender: PeerServer | undefined;
    let receiver: PeerServer | undefined;
    try {
      receiver = await spawnPeerServer(peerServerOptions(fixture, "receiver"));
      sender = await spawnPeerServer(peerServerOptions(fixture, "sender"));
      const body = {
        callerSession: "parent", to: { machine: fixture.receiverOrigin, sessionId: "receiver-id" },
        task: "create exactly one remote task", idempotencyKey: "http-idempotency",
      };
      const [first, second] = await Promise.all([
        postPeerRequest(sender.base, "/api/tasks/v1/send", body),
        postPeerRequest(sender.base, "/api/tasks/v1/send", body),
      ]);
      expect([first.status, second.status]).toEqual([200, 200]);
      const [firstReceipt, secondReceipt] = await Promise.all([first.json(), second.json()]) as [Record<string, unknown>, Record<string, unknown>];
      expect(secondReceipt).toMatchObject({ taskId: firstReceipt.taskId, eventId: firstReceipt.eventId });
      expect(typeof firstReceipt.taskId).toBe("string");
      const taskId = firstReceipt.taskId as string;
      const receiverInbox = await fetch(`${receiver.base}/api/tasks/v1/inbox?callerSession=receiver&cursor=0`);
      expect(receiverInbox.status).toBe(200);
      expect((await receiverInbox.json() as { readonly events: readonly { readonly taskId: string }[] }).events.filter((event) => event.taskId === taskId)).toHaveLength(1);
      expect(peerDispatches(fixture).filter((entry) => entry.role === "sender" && entry.path === "/api/tasks/v1/peer/receive")).toHaveLength(1);
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      sender = undefined;
      receiver = undefined;
      const senderLedgers = await new TaskStore({ root: fixture.senderTaskRoot }).ledgers();
      const receiverLedgers = await new TaskStore({ root: fixture.receiverTaskRoot }).ledgers();
      expect(senderLedgers.filter((ledger) => ledger.key.taskId === taskId && ledger.key.role === TASK_LEDGER_ROLE.SENDER)).toHaveLength(1);
      expect(receiverLedgers.filter((ledger) => ledger.key.taskId === taskId && ledger.key.role === TASK_LEDGER_ROLE.RECEIVER)).toHaveLength(1);
    } finally {
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("records four routed delivery failures and does not replay an exhausted sender intent after restart", async () => {
    const fixture = await createHttpPeerFixture("exhaustion");
    let sender: PeerServer | undefined;
    let receiver: PeerServer | undefined;
    try {
      receiver = await spawnPeerServer(peerServerOptions(fixture, "receiver"));
      sender = await spawnPeerServer(peerServerOptions(fixture, "sender", [{ type: TASK_EVENT_TYPE.INFORMATION, count: 4 }], true));
      const sent = await peerRequest(sender.base, "/api/tasks/v1/send", {
        callerSession: "parent", to: { machine: fixture.receiverOrigin, sessionId: "receiver-id" }, task: "exhaust remote information delivery",
      });
      if (typeof sent.taskId !== "string") throw new Error("expected remote task receipt");
      const failed = await postPeerRequest(sender.base, "/api/tasks/v1/message", {
        callerSession: "parent", taskId: sent.taskId, type: "information", message: "this response is intentionally lost",
      });
      expect(failed.status).toBe(503);
      const failedBody = await failed.json() as Record<string, unknown>;
      expect(failedBody).toMatchObject({ ok: false, error: { code: "PEER_UNREACHABLE" } });
      const attempts = peerDispatches(fixture).filter((entry) => entry.role === "sender" && entry.path === "/api/tasks/v1/peer/event" && entry.eventType === TASK_EVENT_TYPE.INFORMATION);
      expect(attempts).toHaveLength(4);
      expect(new Set(attempts.map((entry) => entry.eventId)).size).toBe(1);
      await stopPeerServer(sender);
      sender = undefined;
      const senderStore = new TaskStore({ root: fixture.senderTaskRoot });
      const senderLedger = (await senderStore.ledgers()).find((ledger) => ledger.key.taskId === sent.taskId && ledger.key.role === TASK_LEDGER_ROLE.SENDER);
      expect(senderLedger?.state.events.filter((event) => event.type === TASK_EVENT_TYPE.DELIVERY_FAILED)).toHaveLength(1);
      expect(senderLedger?.records.filter((record) => record.kind === "outbox.attempt" && record.eventId === attempts[0]?.eventId)).toHaveLength(4);
      sender = await spawnPeerServer(peerServerOptions(fixture, "sender"));
      const restartedStatus = await fetch(`${sender.base}/api/tasks/v1/status?callerSession=parent&taskId=${sent.taskId}`);
      expect(restartedStatus.status).toBe(200);
      expect(peerDispatches(fixture).filter((entry) => entry.role === "sender" && entry.path === "/api/tasks/v1/peer/event" && entry.eventType === TASK_EVENT_TYPE.INFORMATION)).toHaveLength(4);
    } finally {
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  // This lifecycle starts six peer-server processes across crash recovery; keep the deadline above Bun's 5s default.
  test("recovers a pending canonical sender intent after a crash before peer delivery", async () => {
    const fixture = await createHttpPeerFixture("sender-recovery");
    let sender: PeerServer | undefined;
    let receiver: PeerServer | undefined;
    try {
      receiver = await spawnPeerServer(peerServerOptions(fixture, "receiver"));
      sender = await spawnPeerServer(peerServerOptions(fixture, "sender", [], true, undefined, TASK_EVENT_TYPE.INFORMATION));
      const sent = await peerRequest(sender.base, "/api/tasks/v1/send", {
        callerSession: "parent", to: { machine: fixture.receiverOrigin, sessionId: "receiver-id" }, task: "recover a pending canonical sender event",
      });
      if (typeof sent.taskId !== "string") throw new Error("expected remote task receipt");
      const senderExit = new Promise<void>((resolve) => sender?.process.once("exit", () => resolve()));
      await expect(postPeerRequest(sender.base, "/api/tasks/v1/message", {
        callerSession: "parent", taskId: sent.taskId, type: "information", message: "durably recover this original event",
      })).rejects.toThrow();
      await senderExit;
      sender = undefined;
      await stopPeerServer(receiver);
      receiver = undefined;

      const beforeRestart = (await new TaskStore({ root: fixture.senderTaskRoot }).ledgers())
        .find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.SENDER && ledger.key.taskId === sent.taskId);
      const pendingIntent = beforeRestart?.records.find((record) => record.kind === "outbox.intent" && record.event.type === TASK_EVENT_TYPE.INFORMATION);
      if (pendingIntent?.kind !== "outbox.intent") throw new Error("expected a durable pending sender intent");
      const originalEventId = pendingIntent.event.id;
      expect(beforeRestart?.records.filter((record) => record.kind === "outbox.attempt" && record.eventId === originalEventId)).toHaveLength(1);
      const beforeReceiverRestart = (await new TaskStore({ root: fixture.receiverTaskRoot }).ledgers())
        .find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.RECEIVER && ledger.key.taskId === sent.taskId);
      expect(beforeReceiverRestart?.state.events.filter((event) => event.id === originalEventId)).toHaveLength(0);

      receiver = await spawnPeerServer(peerServerOptions(fixture, "receiver"));
      sender = await spawnPeerServer(peerServerOptions(fixture, "sender", [], true));
      const recovered = await fetch(`${receiver.base}/api/tasks/v1/status?callerSession=receiver&taskId=${sent.taskId}`);
      expect(recovered.status).toBe(200);
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      sender = undefined;
      receiver = undefined;

      const afterRecoverySender = (await new TaskStore({ root: fixture.senderTaskRoot }).ledgers())
        .find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.SENDER && ledger.key.taskId === sent.taskId);
      const afterRecoveryReceiver = (await new TaskStore({ root: fixture.receiverTaskRoot }).ledgers())
        .find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.RECEIVER && ledger.key.taskId === sent.taskId);
      expect(afterRecoverySender?.records.filter((record) => record.kind === "outbox.attempt" && record.eventId === originalEventId)).toHaveLength(2);
      expect(afterRecoverySender?.records).toContainEqual(expect.objectContaining({ kind: "outbox.delivered", eventId: originalEventId }));
      expect(afterRecoveryReceiver?.state.events.filter((event) => event.id === originalEventId)).toHaveLength(1);
      const deliveryAttempts = peerDispatches(fixture).filter((entry) => entry.role === "sender" && entry.path === "/api/tasks/v1/peer/event" && entry.eventId === originalEventId);
      expect(deliveryAttempts).toHaveLength(2);
      expect(deliveryAttempts.length).toBeLessThanOrEqual(4);

      receiver = await spawnPeerServer(peerServerOptions(fixture, "receiver"));
      sender = await spawnPeerServer(peerServerOptions(fixture, "sender", [], true));
      expect((await fetch(`${sender.base}/api/tasks/v1/status?callerSession=parent&taskId=${sent.taskId}`)).status).toBe(200);
      expect(peerDispatches(fixture).filter((entry) => entry.role === "sender" && entry.path === "/api/tasks/v1/peer/event" && entry.eventId === originalEventId)).toHaveLength(2);
    } finally {
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 20_000);

  test("finalizes a four-attempt sender intent after a crash before the delivery failure record", async () => {
    const fixture = await createHttpPeerFixture("sender-exhaustion-finalization");
    let sender: PeerServer | undefined;
    let receiver: PeerServer | undefined;
    try {
      receiver = await spawnPeerServer(peerServerOptions(fixture, "receiver"));
      sender = await spawnPeerServer(peerServerOptions(fixture, "sender", [], true, undefined, TASK_EVENT_TYPE.INFORMATION, 4));
      const sent = await peerRequest(sender.base, "/api/tasks/v1/send", {
        callerSession: "parent", to: { machine: fixture.receiverOrigin, sessionId: "receiver-id" }, task: "finalize the exhausted sender intent",
      });
      if (typeof sent.taskId !== "string") throw new Error("expected remote task receipt");
      await stopPeerServer(receiver);
      receiver = undefined;
      const senderExit = new Promise<void>((resolve) => sender?.process.once("exit", () => resolve()));
      await expect(postPeerRequest(sender.base, "/api/tasks/v1/message", {
        callerSession: "parent", taskId: sent.taskId, type: "information", message: "persist the fourth attempt before crashing",
      })).rejects.toThrow();
      await senderExit;
      sender = undefined;
      const beforeRestart = (await new TaskStore({ root: fixture.senderTaskRoot }).ledgers())
        .find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.SENDER && ledger.key.taskId === sent.taskId);
      const pendingIntent = beforeRestart?.records.find((record) => record.kind === "outbox.intent" && record.event.type === TASK_EVENT_TYPE.INFORMATION);
      if (pendingIntent?.kind !== "outbox.intent") throw new Error("expected a durable sender intent");
      const originalEventId = pendingIntent.event.id;
      expect(beforeRestart?.records.filter((record) => record.kind === "outbox.attempt" && record.eventId === originalEventId)).toHaveLength(4);
      expect(beforeRestart?.state.events.filter((event) => event.type === TASK_EVENT_TYPE.DELIVERY_FAILED)).toHaveLength(0);
      expect(beforeRestart?.records.filter((record) => record.kind === "diagnostic" && record.id === `peer.delivery:${originalEventId}`)).toHaveLength(0);

      sender = await spawnPeerServer(peerServerOptions(fixture, "sender", [], true));
      expect((await fetch(`${sender.base}/api/tasks/v1/status?callerSession=parent&taskId=${sent.taskId}`)).status).toBe(200);
      await stopPeerServer(sender);
      sender = undefined;
      const afterFinalization = (await new TaskStore({ root: fixture.senderTaskRoot }).ledgers())
        .find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.SENDER && ledger.key.taskId === sent.taskId);
      expect(afterFinalization?.state.events.filter((event) => event.type === TASK_EVENT_TYPE.DELIVERY_FAILED)).toHaveLength(1);
      expect(afterFinalization?.records.filter((record) => record.kind === "diagnostic" && record.id === `peer.delivery:${originalEventId}`)).toHaveLength(1);
      expect(peerDispatches(fixture).filter((entry) => entry.role === "sender" && entry.path === "/api/tasks/v1/peer/event" && entry.eventId === originalEventId)).toHaveLength(4);

      sender = await spawnPeerServer(peerServerOptions(fixture, "sender", [], true));
      expect((await fetch(`${sender.base}/api/tasks/v1/status?callerSession=parent&taskId=${sent.taskId}`)).status).toBe(200);
      await stopPeerServer(sender);
      sender = undefined;
      const afterSecondRestart = (await new TaskStore({ root: fixture.senderTaskRoot }).ledgers())
        .find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.SENDER && ledger.key.taskId === sent.taskId);
      expect(afterSecondRestart?.state.events.filter((event) => event.type === TASK_EVENT_TYPE.DELIVERY_FAILED)).toHaveLength(1);
      expect(afterSecondRestart?.records.filter((record) => record.kind === "diagnostic" && record.id === `peer.delivery:${originalEventId}`)).toHaveLength(1);
      expect(peerDispatches(fixture).filter((entry) => entry.role === "sender" && entry.path === "/api/tasks/v1/peer/event" && entry.eventId === originalEventId)).toHaveLength(4);
    } finally {
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 15_000);

  test("serializes concurrent sender sweep delivery attempts for one remote event", async () => {
    const fixture = await createHttpPeerFixture("sender-concurrency");
    let sender: PeerServer | undefined;
    let receiver: PeerServer | undefined;
    try {
      receiver = await spawnPeerServer(peerServerOptions(fixture, "receiver"));
      sender = await spawnPeerServer(peerServerOptions(fixture, "sender", [{ type: TASK_EVENT_TYPE.INFORMATION, count: 20 }], true, undefined, undefined, undefined, 100));
      const sent = await peerRequest(sender.base, "/api/tasks/v1/send", {
        callerSession: "parent", to: { machine: fixture.receiverOrigin, sessionId: "receiver-id" }, task: "serialize concurrent sender delivery",
      });
      if (typeof sent.taskId !== "string") throw new Error("expected remote task receipt");
      const sending = postPeerRequest(sender.base, "/api/tasks/v1/message", {
        callerSession: "parent", taskId: sent.taskId, type: "information", message: "force concurrent durable delivery attempts",
      });
      await waitForPeerDispatch(fixture, TASK_EVENT_TYPE.INFORMATION);
      const statuses = await Promise.all(Array.from({ length: 8 }, () => fetch(`${sender!.base}/api/tasks/v1/status?callerSession=parent&taskId=${sent.taskId}`)));
      expect(statuses.map((response) => response.status)).toEqual(Array.from({ length: 8 }, () => 200));
      expect((await sending).status).toBe(503);
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      sender = undefined;
      receiver = undefined;

      const senderLedger = (await new TaskStore({ root: fixture.senderTaskRoot }).ledgers())
        .find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.SENDER && ledger.key.taskId === sent.taskId);
      const event = senderLedger?.state.events.find((candidate) => candidate.type === TASK_EVENT_TYPE.INFORMATION);
      if (!event) throw new Error("expected canonical sender information event");
      const receiverLedger = (await new TaskStore({ root: fixture.receiverTaskRoot }).ledgers())
        .find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.RECEIVER && ledger.key.taskId === sent.taskId);
      expect(senderLedger?.records.filter((record) => record.kind === "outbox.attempt" && record.eventId === event.id)).toHaveLength(4);
      expect(senderLedger?.state.events.filter((candidate) => candidate.type === TASK_EVENT_TYPE.DELIVERY_FAILED)).toHaveLength(1);
      expect(senderLedger?.records.filter((record) => record.kind === "diagnostic" && record.id === `peer.delivery:${event.id}`)).toHaveLength(1);
      expect(receiverLedger?.state.events.filter((candidate) => candidate.id === event.id)).toHaveLength(1);
      const attempts = peerDispatches(fixture).filter((entry) => entry.role === "sender" && entry.path === "/api/tasks/v1/peer/event" && entry.eventId === event.id);
      expect(attempts).toHaveLength(4);

      sender = await spawnPeerServer(peerServerOptions(fixture, "sender", [], true));
      expect((await fetch(`${sender.base}/api/tasks/v1/status?callerSession=parent&taskId=${sent.taskId}`)).status).toBe(200);
      await stopPeerServer(sender);
      sender = undefined;
      expect(peerDispatches(fixture).filter((entry) => entry.role === "sender" && entry.path === "/api/tasks/v1/peer/event" && entry.eventId === event.id)).toHaveLength(4);
    } finally {
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("restarts the receiver with the original accepted completion event after its HTTP response is lost", async () => {
    const fixture = await createHttpPeerFixture("receiver-recovery");
    let sender: PeerServer | undefined;
    let receiver: PeerServer | undefined;
    try {
      sender = await spawnPeerServer(peerServerOptions(fixture, "sender"));
      receiver = await spawnPeerServer(peerServerOptions(fixture, "receiver", [], false, TASK_EVENT_TYPE.COMPLETED));
      const sent = await peerRequest(sender.base, "/api/tasks/v1/send", {
        callerSession: "parent", to: { machine: fixture.receiverOrigin, sessionId: "receiver-id" }, task: "recover accepted completion",
      });
      if (typeof sent.taskId !== "string") throw new Error("expected remote task receipt");
      const completion = { callerSession: "receiver", taskId: sent.taskId, status: "completed", result: { summary: "stable completion" } };
      const receiverExit = new Promise<void>((resolve) => receiver?.process.once("exit", () => resolve()));
      await expect(postPeerRequest(receiver.base, "/api/tasks/v1/complete", completion)).rejects.toThrow();
      await receiverExit;
      const lostAttempts = peerDispatches(fixture).filter((entry) => entry.role === "receiver" && entry.path === "/api/tasks/v1/peer/event" && entry.eventType === TASK_EVENT_TYPE.COMPLETED);
      expect(lostAttempts).toHaveLength(1);
      const originalEventId = lostAttempts[0]?.eventId;
      receiver = undefined;
      const senderStatus = await fetch(`${sender.base}/api/tasks/v1/status?callerSession=parent&taskId=${sent.taskId}`);
      expect(await senderStatus.json()).toMatchObject({ status: "completed" });
      receiver = await spawnPeerServer(peerServerOptions(fixture, "receiver"));
      expect((await fetch(`${receiver.base}/api/tasks/v1/status?callerSession=receiver&taskId=${sent.taskId}`)).status).toBe(200);
      const completionAttempts = peerDispatches(fixture).filter((entry) => entry.role === "receiver" && entry.path === "/api/tasks/v1/peer/event" && entry.eventType === TASK_EVENT_TYPE.COMPLETED);
      expect(completionAttempts).toHaveLength(2);
      expect(completionAttempts[1]).toMatchObject({ eventId: originalEventId });
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      sender = undefined;
      receiver = undefined;
      const canonical = (await new TaskStore({ root: fixture.senderTaskRoot }).ledgers()).find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.SENDER && ledger.key.taskId === sent.taskId);
      expect(canonical?.state.events.filter((event) => event.type === TASK_EVENT_TYPE.COMPLETED)).toHaveLength(1);
    } finally {
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("propagates timeout and converges a cancellation-versus-completion race through the peer routes", async () => {
    const fixture = await createHttpPeerFixture("timeout-cancel");
    let sender: PeerServer | undefined;
    let receiver: PeerServer | undefined;
    try {
      receiver = await spawnPeerServer(peerServerOptions(fixture, "receiver"));
      sender = await spawnPeerServer(peerServerOptions(fixture, "sender"));
      const timed = await peerRequest(sender.base, "/api/tasks/v1/send", {
        callerSession: "parent", to: { machine: fixture.receiverOrigin, sessionId: "receiver-id" }, task: "propagate timeout", timeoutMs: 1_000,
      });
      if (typeof timed.taskId !== "string") throw new Error("expected timeout task receipt");
      writeFileSync(fixture.clockPath, "2026-08-04T00:00:01.001Z");
      expect((await fetch(`${sender.base}/api/tasks/v1/status?callerSession=parent&taskId=${timed.taskId}`)).status).toBe(200);
      const receiverTimeout = await fetch(`${receiver.base}/api/tasks/v1/status?callerSession=receiver&taskId=${timed.taskId}`);
      expect(await receiverTimeout.json()).toMatchObject({ status: "timed_out" });
      const race = await peerRequest(sender.base, "/api/tasks/v1/send", {
        callerSession: "parent", to: { machine: fixture.receiverOrigin, sessionId: "receiver-id" }, task: "race cancellation and completion",
      });
      if (typeof race.taskId !== "string") throw new Error("expected race task receipt");
      const [cancelled, completed] = await Promise.all([
        postPeerRequest(sender.base, "/api/tasks/v1/cancel", { callerSession: "parent", taskId: race.taskId }),
        postPeerRequest(receiver.base, "/api/tasks/v1/complete", { callerSession: "receiver", taskId: race.taskId, status: "completed", result: { summary: "race result" } }),
      ]);
      expect([cancelled.status, completed.status]).not.toContain(500);
      const [senderRace, receiverRace] = await Promise.all([
        fetch(`${sender.base}/api/tasks/v1/status?callerSession=parent&taskId=${race.taskId}`).then((response) => response.json() as Promise<Record<string, unknown>>),
        fetch(`${receiver.base}/api/tasks/v1/status?callerSession=receiver&taskId=${race.taskId}`).then((response) => response.json() as Promise<Record<string, unknown>>),
      ]);
      const senderEvents = canonicalEvents(senderRace);
      const receiverEvents = canonicalEvents(receiverRace);
      const terminalTypes: readonly string[] = [TASK_EVENT_TYPE.COMPLETED, TASK_EVENT_TYPE.CANCELLED, TASK_EVENT_TYPE.TIMED_OUT];
      const routedTypes: readonly string[] = [TASK_EVENT_TYPE.TIMED_OUT, TASK_EVENT_TYPE.CANCEL_REQUESTED, TASK_EVENT_TYPE.COMPLETED];
      expect(senderEvents).toEqual(receiverEvents);
      expect(senderEvents.filter((event) => terminalTypes.includes(event.type))).toHaveLength(1);
      expect(peerDispatches(fixture).filter((entry) => entry.path === "/api/tasks/v1/peer/event" && routedTypes.includes(entry.eventType as string))).not.toHaveLength(0);
    } finally {
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("does not replay an exhausted two-phase parent acknowledgment after restart", async () => {
    const fixture = await createHttpPeerFixture("parent-ack");
    let sender: PeerServer | undefined;
    let receiver: PeerServer | undefined;
    try {
      receiver = await spawnPeerServer(peerServerOptions(fixture, "receiver"));
      sender = await spawnPeerServer(peerServerOptions(fixture, "sender", [{ type: TASK_EVENT_TYPE.PARENT_ACK_PENDING, count: 4 }], true));
      const sent = await peerRequest(sender.base, "/api/tasks/v1/send", {
        callerSession: "parent", to: { machine: fixture.receiverOrigin, sessionId: "receiver-id" }, task: "repair parent acknowledgment",
      });
      if (typeof sent.taskId !== "string") throw new Error("expected remote task receipt");
      expect((await postPeerRequest(receiver.base, "/api/tasks/v1/complete", {
        callerSession: "receiver", taskId: sent.taskId, status: "completed", result: { summary: "acknowledge this" },
      })).status).toBe(200);
      expect((await postPeerRequest(sender.base, "/api/tasks/v1/ack", { callerSession: "parent", taskId: sent.taskId })).status).toBe(503);
      const pendingAttempts = peerDispatches(fixture).filter((entry) => entry.role === "sender" && entry.path === "/api/tasks/v1/peer/event" && entry.eventType === TASK_EVENT_TYPE.PARENT_ACK_PENDING);
      expect(pendingAttempts).toHaveLength(4);
      const pendingEventId = pendingAttempts[0]?.eventId;
      expect(new Set(pendingAttempts.map((entry) => entry.eventId))).toEqual(new Set([pendingEventId]));
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      sender = undefined;
      receiver = undefined;
      const beforeRepair = (await new TaskStore({ root: fixture.receiverTaskRoot }).ledgers()).find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.RECEIVER && ledger.key.taskId === sent.taskId);
      expect(beforeRepair?.records.some((record) => record.kind === "acknowledgment" && record.eventId === pendingEventId)).toBe(true);
      expect(beforeRepair?.records.some((record) => record.kind === "cleanup.eligible")).toBe(false);
      receiver = await spawnPeerServer(peerServerOptions(fixture, "receiver"));
      sender = await spawnPeerServer(peerServerOptions(fixture, "sender"));
      expect((await postPeerRequest(sender.base, "/api/tasks/v1/ack", { callerSession: "parent", taskId: sent.taskId })).status).toBe(503);
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      sender = undefined;
      receiver = undefined;
      const afterRepair = (await new TaskStore({ root: fixture.receiverTaskRoot }).ledgers()).find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.RECEIVER && ledger.key.taskId === sent.taskId);
      expect(afterRepair?.records.filter((record) => record.kind === "acknowledgment" && record.eventId === pendingEventId)).toHaveLength(1);
      expect(afterRepair?.records.some((record) => record.kind === "cleanup.eligible")).toBe(false);
      const restartedPendingAttempts = peerDispatches(fixture).filter((entry) => entry.role === "sender" && entry.path === "/api/tasks/v1/peer/event" && entry.eventType === TASK_EVENT_TYPE.PARENT_ACK_PENDING);
      expect(restartedPendingAttempts).toHaveLength(4);
      expect(restartedPendingAttempts.at(-1)).toMatchObject({ eventId: pendingEventId });
    } finally {
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects an absolute remote context ref before any subprocess peer route dispatch or ledger creation", async () => {
    const fixture = await createHttpPeerFixture("absolute-ref");
    let sender: PeerServer | undefined;
    let receiver: PeerServer | undefined;
    try {
      receiver = await spawnPeerServer(peerServerOptions(fixture, "receiver"));
      sender = await spawnPeerServer(peerServerOptions(fixture, "sender"));
      const response = await postPeerRequest(sender.base, "/api/tasks/v1/send", {
        callerSession: "parent",
        to: { machine: fixture.receiverOrigin, sessionId: "receiver-id" },
        task: "reject this remote absolute ref",
        context: { refs: [{ path: join(fixture.root, "sender-project"), purpose: "must remain local" }] },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      expect(peerDispatches(fixture).filter((entry) => entry.path === "/api/tasks/v1/peer/receive" || entry.path === "/api/tasks/v1/peer/event")).toEqual([]);
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      sender = undefined;
      receiver = undefined;
      expect(await new TaskStore({ root: fixture.senderTaskRoot }).ledgers()).toEqual([]);
      expect(await new TaskStore({ root: fixture.receiverTaskRoot }).ledgers()).toEqual([]);
    } finally {
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("returns receiver-derived artifact metadata through the two-server HTTP path without source paths or bytes", async () => {
    const fixture = await createHttpPeerFixture("artifact");
    const artifactPath = "evidence/subprocess-artifact.txt";
    const artifactContents = "subprocess artifact bytes must stay on the receiver";
    const receiverProject = join(fixture.root, "receiver-project");
    mkdirSync(join(receiverProject, "evidence"), { recursive: true });
    writeFileSync(join(receiverProject, artifactPath), artifactContents);
    let sender: PeerServer | undefined;
    let receiver: PeerServer | undefined;
    try {
      receiver = await spawnPeerServer(peerServerOptions(fixture, "receiver"));
      sender = await spawnPeerServer(peerServerOptions(fixture, "sender"));
      const receiverMachineId = readFileSync(join(dirname(fixture.receiverTaskRoot), "machine-id"), "utf8").trim();
      const senderMachineId = readFileSync(join(dirname(fixture.senderTaskRoot), "machine-id"), "utf8").trim();
      expect(receiverMachineId).not.toBe(senderMachineId);
      const sent = await peerRequest(sender.base, "/api/tasks/v1/send", {
        callerSession: "parent", to: { machine: fixture.receiverOrigin, sessionId: "receiver-id" }, task: "return paths-only artifact metadata",
      });
      if (typeof sent.taskId !== "string") throw new Error("expected remote task receipt");
      expect((await postPeerRequest(receiver.base, "/api/tasks/v1/complete", {
        callerSession: "receiver",
        taskId: sent.taskId,
        status: "completed",
        result: { summary: "artifact complete", artifacts: [{ path: artifactPath, mimeType: "text/plain", description: "subprocess evidence" }] },
      })).status).toBe(200);
      const statusResponse = await fetch(`${sender.base}/api/tasks/v1/status?callerSession=parent&taskId=${sent.taskId}`);
      expect(statusResponse.status).toBe(200);
      const status = await statusResponse.json() as Record<string, unknown>;
      expect(status).toMatchObject({
        ok: true,
        task: { source: { machine: fixture.senderOrigin }, target: { machine: fixture.receiverOrigin } },
        completion: {
          artifacts: [expect.objectContaining({
            machine: receiverMachineId,
            project: "receiver-project",
            path: artifactPath,
            mimeType: "text/plain",
            description: "subprocess evidence",
            sizeBytes: Buffer.byteLength(artifactContents),
          })],
        },
      });
      const artifact = ((status.completion as { readonly artifacts: readonly Record<string, unknown>[] }).artifacts[0]);
      expect(artifact).not.toHaveProperty("sourcePath");
      expect(artifact).not.toHaveProperty("bytes");
      expect(JSON.stringify(status)).not.toContain(receiverProject);
      expect(JSON.stringify(status)).not.toContain(artifactContents);
      expect(peerDispatches(fixture)).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "sender", path: "/api/tasks/v1/peer/receive", origin: fixture.receiverOrigin }),
        expect.objectContaining({ role: "receiver", path: "/api/tasks/v1/peer/event", origin: fixture.senderOrigin, eventType: TASK_EVENT_TYPE.COMPLETED }),
      ]));
    } finally {
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe("local task gateway", () => {
  test("durably sends a local assignment and exposes it only to the confirmed receiver inbox", async () => {
    const sent = await request("/api/tasks/v1/send", "POST", {
      callerSession: "parent",
      to: { machine: "local", sessionId: "receiver" },
      task: "implement the narrow change",
      context: { summary: "keep scope minimal", refs: [{ path: "missing.md", purpose: "optional context" }] },
      timeoutMs: 1_000,
      idempotencyKey: "send-1",
    });
    expect(sent.status).toBe(200);
    const receipt = await sent.json() as { ok: boolean; taskId: string; eventId: string };
    expect(receipt.ok).toBe(true);

    const receiverInbox = await request(`/api/tasks/v1/inbox?callerSession=receiver&cursor=0`, "GET");
    expect(receiverInbox.status).toBe(200);
    const page = await receiverInbox.json() as { events: Array<{ taskId: string }>; nextCursor: string };
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.taskId).toBe(receipt.taskId);
    expect(page.nextCursor).toBe("1");

    const replay = await request("/api/tasks/v1/send", "POST", {
      callerSession: "parent", to: { machine: "local", sessionId: "receiver" }, task: "implement the narrow change",
      context: { summary: "keep scope minimal", refs: [{ path: "missing.md", purpose: "optional context" }] }, timeoutMs: 1_000, idempotencyKey: "send-1",
    });
    expect(await replay.json()).toMatchObject({ ok: true, taskId: receipt.taskId, eventId: receipt.eventId });
    const status = await request(`/api/tasks/v1/status?callerSession=parent&taskId=${receipt.taskId}`, "GET");
    expect(await status.json()).toMatchObject({ warnings: [{ code: "MISSING_REF" }] });

    const parentInbox = await request(`/api/tasks/v1/inbox?callerSession=parent&cursor=0`, "GET");
    expect((await parentInbox.json() as { events: unknown[] }).events).toHaveLength(0);
  });

  test("measures the send assignment envelope without nesting the transport body", async () => {
    const underAssignmentLimit = {
      callerSession: "parent",
      to: { machine: "local", sessionId: "receiver" },
      task: "bounded assignment envelope",
      context: { refs: Array.from({ length: 15 }, (_, index) => ({ path: `context/${index}-${"x".repeat(2_000)}` })) },
    };
    expect(Buffer.byteLength(JSON.stringify(underAssignmentLimit))).toBeLessThan(TASK_LIMITS.ASSIGNMENT_ENVELOPE_BYTES);
    expect(Buffer.byteLength(JSON.stringify({ ...underAssignmentLimit, rawBody: underAssignmentLimit }))).toBeGreaterThan(TASK_LIMITS.ASSIGNMENT_ENVELOPE_BYTES);
    const accepted = await request("/api/tasks/v1/send", "POST", underAssignmentLimit);
    expect(accepted.status).toBe(200);

    const overAssignmentLimit = {
      callerSession: "parent",
      to: { machine: "local", sessionId: "receiver" },
      task: "oversized assignment envelope",
      context: { refs: Array.from({ length: 20 }, (_, index) => ({ path: `context/${index}-${"x".repeat(2_500)}` })) },
    };
    expect(Buffer.byteLength(JSON.stringify(overAssignmentLimit))).toBeGreaterThan(TASK_LIMITS.ASSIGNMENT_ENVELOPE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(overAssignmentLimit))).toBeLessThan(TASK_LIMITS.HTTP_BODY_BYTES);
    const rejected = await request("/api/tasks/v1/send", "POST", overAssignmentLimit);
    expect(rejected.status).toBe(413);
    expect(await rejected.json()).toMatchObject({ ok: false, error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  test("serializes identical idempotent sends to one durable receiver assignment", async () => {
    const body = { callerSession: "parent", to: { machine: "local", sessionId: "receiver" }, task: "one task", idempotencyKey: "concurrent-send" };
    const responses = await Promise.all([request("/api/tasks/v1/send", "POST", body), request("/api/tasks/v1/send", "POST", body)]);
    const receipts = await Promise.all(responses.map((response) => response.json() as Promise<{ taskId: string; eventId: string }>));
    expect(receipts[0]).toEqual(receipts[1]);
    const inbox = await request("/api/tasks/v1/inbox?callerSession=receiver&cursor=0", "GET");
    const events = (await inbox.json() as { events: Array<{ taskId: string }> }).events.filter((event) => event.taskId === receipts[0]?.taskId);
    expect(events).toHaveLength(1);
  });

  test("does not lose the 51st inbox event at the count page boundary", async () => {
    let cursor = "0";
    for (;;) {
      const page = await request(`/api/tasks/v1/inbox?callerSession=receiver&cursor=${cursor}`, "GET");
      const body = await page.json() as { nextCursor: string; hasMore: boolean };
      cursor = body.nextCursor;
      if (!body.hasMore) break;
    }
    const taskIds: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      const sent = await request("/api/tasks/v1/send", "POST", { callerSession: "parent", to: { machine: "local", sessionId: "receiver" }, task: `page boundary ${index}` });
      taskIds.push((await sent.json() as { taskId: string }).taskId);
    }
    const first = await request(`/api/tasks/v1/inbox?callerSession=receiver&cursor=${cursor}`, "GET");
    const firstPage = await first.json() as { events: Array<{ taskId: string }>; nextCursor: string; hasMore: boolean };
    expect(firstPage.events).toHaveLength(50);
    expect(firstPage.hasMore).toBe(true);
    const second = await request(`/api/tasks/v1/inbox?callerSession=receiver&cursor=${firstPage.nextCursor}`, "GET");
    const secondPage = await second.json() as { events: Array<{ taskId: string }> };
    const returnedTaskIds = [...firstPage.events, ...secondPage.events].map((event) => event.taskId).filter((taskId) => taskIds.includes(taskId));
    expect(returnedTaskIds).toEqual(taskIds);
  }, 15_000);

  test("keeps canonical terminal ordering stable under concurrent cancellation and completion", async () => {
    const sent = await request("/api/tasks/v1/send", "POST", { callerSession: "parent", to: { machine: "local", sessionId: "receiver" }, task: "race terminal" });
    const assignment = await sent.json() as { taskId: string };
    const [cancel, complete] = await Promise.all([
      request("/api/tasks/v1/cancel", "POST", { callerSession: "parent", taskId: assignment.taskId }),
      request("/api/tasks/v1/complete", "POST", { callerSession: "receiver", taskId: assignment.taskId, status: "completed", result: { summary: "racing completion" } }),
    ]);
    expect([cancel.status, complete.status]).not.toContain(500);
    const status = await request(`/api/tasks/v1/status?callerSession=parent&taskId=${assignment.taskId}`, "GET");
    const task = await status.json() as { events: Array<{ sequence: string; type: string }> };
    expect(new Set(task.events.map((event) => event.sequence)).size).toBe(task.events.length);
    expect(task.events.filter((event) => ["task.completed", "task.cancelled", "task.late_terminal"].includes(event.type)).length).toBeGreaterThanOrEqual(1);
  });

  test("routes sender timeout terminal evidence to the parent inbox", async () => {
    const sent = await request("/api/tasks/v1/send", "POST", {
      callerSession: "parent",
      to: { machine: "local", sessionId: "receiver" },
      task: "timeout routing",
      timeoutMs: 1_000,
      onCompletePrompt: "verify and acknowledge this terminal result",
    });
    const assignment = await sent.json() as { taskId: string };

    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    const parentInbox = await request("/api/tasks/v1/inbox?callerSession=parent&cursor=0", "GET");
    const parentEvents = (await parentInbox.json() as { events: Array<{ taskId: string; type: string }> }).events.filter((event) => event.taskId === assignment.taskId);
    expect(parentEvents).toEqual([expect.objectContaining({ type: "task.timed_out" })]);

    const receiverInbox = await request("/api/tasks/v1/inbox?callerSession=receiver&cursor=0", "GET");
    const receiverEvents = (await receiverInbox.json() as { events: Array<{ taskId: string; type: string }> }).events.filter((event) => event.taskId === assignment.taskId);
    expect(receiverEvents.some((event) => event.type === "task.timed_out")).toBe(false);

    const status = await request(`/api/tasks/v1/status?callerSession=parent&taskId=${assignment.taskId}`, "GET");
    expect(await status.json()).toMatchObject({ status: "timed_out" });
    const acknowledged = await request("/api/tasks/v1/ack", "POST", { callerSession: "parent", taskId: assignment.taskId });
    expect(acknowledged.status).toBe(200);
  });

  test("canonicalizes assignment delivery after a receiver question without leaving waiting_for_parent", async () => {
    const sent = await request("/api/tasks/v1/send", "POST", { callerSession: "parent", to: { machine: "local", sessionId: "receiver" }, task: "delivery after question" });
    const assignment = await sent.json() as { taskId: string; eventId: string };
    const question = await request("/api/tasks/v1/message", "POST", { callerSession: "receiver", taskId: assignment.taskId, type: "question", message: "which branch?" });
    expect(question.status).toBe(200);

    const delivered = await request("/api/tasks/v1/delivered", "POST", { callerSession: "receiver", taskId: assignment.taskId, eventId: assignment.eventId });
    const receipt = await delivered.json() as { eventId: string; sequence: string };
    expect(delivered.status).toBe(200);
    const retry = await request("/api/tasks/v1/delivered", "POST", { callerSession: "receiver", taskId: assignment.taskId, eventId: assignment.eventId });
    expect(await retry.json()).toMatchObject(receipt);

    const status = await request(`/api/tasks/v1/status?callerSession=parent&taskId=${assignment.taskId}`, "GET");
    const task = await status.json() as { status: string; events: Array<{ id: string; type: string; payload: { injectedEventId?: string } }> };
    expect(task.status).toBe("waiting_for_parent");
    const deliveryEvents = task.events.filter((event) => event.type === "task.delivered");
    expect(deliveryEvents).toHaveLength(1);
    expect(deliveryEvents[0]).toMatchObject({ id: receipt.eventId, payload: { injectedEventId: assignment.eventId } });

    const receiverLedger = (await new TaskStore({ root: join(root, "tasks") }).ledgers()).find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.RECEIVER && ledger.key.taskId === assignment.taskId);
    expect(receiverLedger?.records).toContainEqual(expect.objectContaining({ kind: "outbox.intent", event: expect.objectContaining({ id: receipt.eventId, type: "task.delivered" }) }));
  });

  test("reconciles canonical message and completion events after replica or inbox propagation crashes", async () => {
    const exercise = async (event: "answer" | "completion", failure: "replica" | "inbox") => {
      const taskRoot = join(tmpdir(), `wolfpack-task-reconcile-${event}-${failure}-${process.pid}-${Date.now()}`);
      let failNextPropagation: "replica" | "inbox" | undefined;
      const store = new TaskStore({
        root: taskRoot,
        testHooks: {
          beforeFsync: (step, path) => {
            if (failNextPropagation === "replica" && step === "ledger-file" && path.includes("/ledgers/receiver/")) {
              failNextPropagation = undefined;
              throw new Error("simulated replica crash");
            }
            if (failNextPropagation === "inbox" && step === "delivery-sequence-file") {
              failNextPropagation = undefined;
              throw new Error("simulated inbox crash");
            }
          },
          afterFsync: undefined,
        },
      });
      const gateway = new TaskGateway({ root: taskRoot, store });
      const sent = await gateway.send({ callerSession: "parent", to: { machine: "local", sessionId: "receiver" }, task: `recover ${event}`, context: undefined, role: undefined, preflight: undefined, metadata: undefined, onCompletePrompt: undefined, timeoutMs: undefined, idempotencyKey: undefined, rawBody: undefined });
      if (!sent.ok) throw new Error("expected task send");

      let expectedEventId: string;
      if (event === "answer") {
        const question = await gateway.message({ callerSession: "receiver", taskId: sent.taskId, type: "question", message: "which branch?", replyToMessageId: undefined, rawBody: undefined });
        if (!question.ok) throw new Error("expected receiver question");
        failNextPropagation = failure;
        await expect(gateway.message({ callerSession: "parent", taskId: sent.taskId, type: "answer", message: "main", replyToMessageId: question.eventId, rawBody: undefined })).rejects.toThrow(failure === "replica" ? "could not append task ledger record" : "could not reserve inbox delivery sequence");
        const canonical = await store.getLedger({ role: TASK_LEDGER_ROLE.SENDER, sourceMachine: gateway.machineId, taskId: sent.taskId });
        expectedEventId = canonical?.state.events.find((candidate) => candidate.type === "task.answer")?.id ?? "";
      } else {
        failNextPropagation = failure;
        await expect(gateway.complete({ callerSession: "receiver", taskId: sent.taskId, status: "completed", result: { summary: "recover canonical result", result: undefined, error: undefined, artifacts: undefined }, rawBody: undefined })).rejects.toThrow(failure === "replica" ? "could not append task ledger record" : "could not reserve inbox delivery sequence");
        const canonical = await store.getLedger({ role: TASK_LEDGER_ROLE.SENDER, sourceMachine: gateway.machineId, taskId: sent.taskId });
        expectedEventId = canonical?.state.events.find((candidate) => candidate.type === "task.completed")?.id ?? "";
      }

      if (failure === "inbox") {
        const recipientLedger = await store.getLedger({
          role: event === "answer" ? TASK_LEDGER_ROLE.RECEIVER : TASK_LEDGER_ROLE.SENDER,
          sourceMachine: gateway.machineId,
          taskId: sent.taskId,
        });
        if (!recipientLedger) throw new Error("expected recipient ledger");
        await store.appendInboxRecord(recipientLedger, { id: `inbox:${expectedEventId}`, eventId: expectedEventId, occurredAt: "2000-01-01T00:00:00.000Z" });
      }

      const restarted = new TaskGateway({ root: taskRoot });
      const recipient = event === "answer" ? "receiver" : "parent";
      const inbox = await restarted.inbox(recipient, "0", false);
      expect(inbox.ok).toBe(true);
      const matching = inbox.ok ? inbox.events.filter((candidate) => candidate.id === expectedEventId) : [];
      expect(matching).toHaveLength(1);
      const status = await restarted.status("parent", sent.taskId);
      expect(status).toMatchObject({ ok: true, status: event === "answer" ? "active" : "completed" });
      expect(status.ok && new Set(status.events.map((candidate) => candidate.sequence)).size).toBe(status.ok ? status.events.length : 0);
      rmSync(taskRoot, { recursive: true, force: true });
    };

    for (const event of ["answer", "completion"] as const) {
      await exercise(event, "replica");
      await exercise(event, "inbox");
    }
  });

  test("recovers a received assignment before confirmation without exposing a false receipt", async () => {
    const taskRoot = join(tmpdir(), `wolfpack-task-receipt-reconcile-${process.pid}-${Date.now()}`);
    let receiverLedgerWrites = 0;
    const crashing = new TaskGateway({
      root: taskRoot,
      store: new TaskStore({
        root: taskRoot,
        testHooks: {
          beforeFsync: (step, path) => {
            if (step === "ledger-file" && path.includes("/ledgers/receiver/") && ++receiverLedgerWrites === 3) throw new Error("simulated received replica crash");
          },
          afterFsync: undefined,
        },
      }),
    });
    const body = { callerSession: "parent", to: { machine: "local", sessionId: "receiver" }, task: "recover receipt", context: undefined, role: undefined, preflight: undefined, metadata: undefined, onCompletePrompt: undefined, timeoutMs: undefined, idempotencyKey: "recover-receipt", rawBody: undefined };
    await expect(crashing.send(body)).rejects.toThrow("could not append task ledger record");

    const restarted = new TaskGateway({ root: taskRoot });
    const receipt = await restarted.send(body);
    expect(receipt).toMatchObject({ ok: true });
    if (!receipt.ok) throw new Error("expected recovered receipt");
    const status = await restarted.status("parent", receipt.taskId);
    expect(status).toMatchObject({ ok: true, status: "received" });
    expect(status.ok && status.events.some((event) => event.type === "task.receipt_confirmed")).toBe(true);
    const inbox = await restarted.inbox("receiver", "0", false);
    expect(inbox.ok && inbox.events.filter((event) => event.id === receipt.eventId)).toHaveLength(1);
    rmSync(taskRoot, { recursive: true, force: true });
  });

  test("does not confirm an overdue received assignment during restart recovery", async () => {
    const taskRoot = join(tmpdir(), `wolfpack-task-overdue-receipt-${process.pid}-${Date.now()}`);
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    let receiverLedgerWrites = 0;
    const crashing = new TaskGateway({
      root: taskRoot,
      now: () => createdAt,
      store: new TaskStore({
        root: taskRoot,
        testHooks: {
          beforeFsync: (step, path) => {
            if (step === "ledger-file" && path.includes("/ledgers/receiver/") && ++receiverLedgerWrites === 3) throw new Error("simulated received replica crash");
          },
          afterFsync: undefined,
        },
      }),
    });
    await expect(crashing.send({ callerSession: "parent", to: { machine: "local", sessionId: "receiver" }, task: "overdue receipt", context: undefined, role: undefined, preflight: undefined, metadata: undefined, onCompletePrompt: undefined, timeoutMs: 1_000, idempotencyKey: "overdue-receipt", rawBody: undefined })).rejects.toThrow("could not append task ledger record");

    const store = new TaskStore({ root: taskRoot });
    const canonicalBeforeTimeout = (await store.ledgers()).find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.SENDER);
    if (!canonicalBeforeTimeout) throw new Error("expected canonical ledger");
    const restarted = new TaskGateway({ root: taskRoot, now: () => new Date("2026-01-01T00:00:01.000Z") });
    await expect(restarted.initialize()).resolves.toBeUndefined();

    const status = await restarted.status("parent", canonicalBeforeTimeout.key.taskId);
    expect(status).toMatchObject({ ok: true, status: "timed_out" });
    const recoveredStore = new TaskStore({ root: taskRoot });
    const canonical = await recoveredStore.getLedger(canonicalBeforeTimeout.key);
    const timeout = canonical?.state.events.find((event) => event.type === "task.timed_out");
    expect(timeout).toBeDefined();
    expect(canonical?.state.events.some((event) => event.type === "task.receipt_confirmed")).toBe(false);

    const receiver = await recoveredStore.getLedger({ role: TASK_LEDGER_ROLE.RECEIVER, sourceMachine: restarted.machineId, taskId: canonicalBeforeTimeout.key.taskId });
    expect(receiver?.state.events.filter((event) => event.id === timeout?.id)).toEqual([expect.objectContaining({ id: timeout?.id, sequence: timeout?.sequence })]);
    const parentInbox = await restarted.inbox("parent", "0", false);
    expect(parentInbox.ok && parentInbox.events.filter((event) => event.id === timeout?.id)).toEqual([expect.objectContaining({ id: timeout?.id, sequence: timeout?.sequence })]);
    const receiverInbox = await restarted.inbox("receiver", "0", false);
    expect(receiverInbox.ok && receiverInbox.events.filter((event) => event.taskId === canonicalBeforeTimeout.key.taskId)).toHaveLength(0);
    rmSync(taskRoot, { recursive: true, force: true });
  });

  test("records assignment delivery after terminal completion and parent acknowledgment", async () => {
    const sent = await request("/api/tasks/v1/send", "POST", { callerSession: "parent", to: { machine: "local", sessionId: "receiver" }, task: "late delivery" });
    const assignment = await sent.json() as { taskId: string; eventId: string };
    const complete = await request("/api/tasks/v1/complete", "POST", {
      callerSession: "receiver", taskId: assignment.taskId, status: "completed", result: { summary: "completed before idle delivery" },
    });
    expect(complete.status).toBe(200);
    const acknowledged = await request("/api/tasks/v1/ack", "POST", { callerSession: "parent", taskId: assignment.taskId });
    expect(acknowledged.status).toBe(200);

    const delivered = await request("/api/tasks/v1/delivered", "POST", { callerSession: "receiver", taskId: assignment.taskId, eventId: assignment.eventId });
    const deliveryReceipt = await delivered.json() as { eventId: string; sequence: string };
    expect(delivered.status).toBe(200);
    const retry = await request("/api/tasks/v1/delivered", "POST", { callerSession: "receiver", taskId: assignment.taskId, eventId: assignment.eventId });
    expect(await retry.json()).toMatchObject(deliveryReceipt);

    const status = await request(`/api/tasks/v1/status?callerSession=parent&taskId=${assignment.taskId}`, "GET");
    const task = await status.json() as { status: string; events: Array<{ id: string; type: string; payload: { injectedEventId?: string } }> };
    expect(task.status).toBe("completed");
    const deliveryEvents = task.events.filter((event) => event.type === "task.delivered");
    expect(deliveryEvents).toHaveLength(1);
    expect(deliveryEvents[0]).toMatchObject({ id: deliveryReceipt.eventId, payload: { injectedEventId: assignment.eventId } });

    const receiverLedger = (await new TaskStore({ root: join(root, "tasks") }).ledgers()).find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.RECEIVER && ledger.key.taskId === assignment.taskId);
    expect(receiverLedger?.records.some((record) => record.kind === "acknowledgment" && record.eventId === assignment.eventId)).toBe(true);
    expect(receiverLedger?.records.some((record) => record.kind === "cleanup.eligible")).toBe(true);
  });

  test("names every rejected artifact declaration without weakening terminal acceptance or valid provenance", async () => {
    const validPath = "valid-artifact.txt";
    const unavailablePath = "unavailable-artifact.txt";
    const escapedPath = "../escaped-artifact.txt";
    const symlinkPath = "symlink-artifact.txt";
    writeFileSync(join(receiverProject, validPath), "verified artifact");
    writeFileSync(join(parentProject, "escaped-artifact.txt"), "outside receiver project");
    symlinkSync(join(receiverProject, validPath), join(receiverProject, symlinkPath));

    const sent = await request("/api/tasks/v1/send", "POST", { callerSession: "parent", to: { machine: "local", sessionId: "receiver" }, task: "preserve valid artifact provenance" });
    const assignment = await sent.json() as { taskId: string };
    const complete = await request("/api/tasks/v1/complete", "POST", {
      callerSession: "receiver", taskId: assignment.taskId, status: "completed",
      result: {
        summary: "artifact warnings name declarations",
        artifacts: [
          { path: validPath },
          { path: "" },
          { path: "/absolute-artifact.txt" },
          { path: validPath },
          { path: unavailablePath },
          { path: escapedPath },
          { path: symlinkPath },
        ],
      },
    });
    expect(complete.status).toBe(200);

    const status = await request(`/api/tasks/v1/status?callerSession=parent&taskId=${assignment.taskId}`, "GET");
    const result = await status.json() as { readonly status: string; readonly completion: { readonly artifacts: readonly { readonly project: string; readonly path: string }[]; readonly warnings: readonly { readonly code: string; readonly message: string }[] } };
    expect(result.status).toBe("completed");
    expect(result.completion.artifacts).toEqual([expect.objectContaining({ project: "receiver-project", path: validPath })]);
    expect(result.completion.warnings).toEqual([
      { code: "INVALID_ARTIFACT", message: 'artifact path must be project-relative: ""' },
      { code: "INVALID_ARTIFACT", message: 'artifact path must be project-relative: "/absolute-artifact.txt"' },
      { code: "INVALID_ARTIFACT", message: `duplicate artifact declaration: ${validPath}` },
      { code: "INVALID_ARTIFACT", message: `artifact is unavailable or outside project: ${unavailablePath}` },
      { code: "INVALID_ARTIFACT", message: `artifact is unavailable or outside project: ${escapedPath}` },
      { code: "INVALID_ARTIFACT", message: `artifact is unavailable or outside project: ${symlinkPath}` },
    ]);
  });

  test("keeps over-limit artifact warnings bounded", async () => {
    const sent = await request("/api/tasks/v1/send", "POST", { callerSession: "parent", to: { machine: "local", sessionId: "receiver" }, task: "bound aggregate artifact warnings" });
    const assignment = await sent.json() as { taskId: string };
    const complete = await request("/api/tasks/v1/complete", "POST", {
      callerSession: "receiver", taskId: assignment.taskId, status: "completed",
      result: { summary: "too many artifact declarations", artifacts: Array.from({ length: TASK_LIMITS.ARTIFACTS + 1 }, (_, index) => ({ path: `artifact-${index}.txt` })) },
    });
    expect(complete.status).toBe(200);

    const status = await request(`/api/tasks/v1/status?callerSession=parent&taskId=${assignment.taskId}`, "GET");
    const result = await status.json() as { readonly status: string; readonly completion: { readonly warnings: readonly { readonly code: string; readonly message: string }[] } };
    expect(result.status).toBe("completed");
    expect(result.completion).not.toHaveProperty("artifacts");
    expect(result.completion.warnings).toEqual([{ code: "INVALID_ARTIFACT", message: "too many artifacts" }]);
  });

  test("warns for a duplicate artifact declaration while preserving every terminal result", async () => {
    writeFileSync(join(receiverProject, "duplicate-artifact.txt"), "verified artifact");
    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      const sent = await request("/api/tasks/v1/send", "POST", { callerSession: "parent", to: { machine: "local", sessionId: "receiver" }, task: `${terminal} with duplicate artifact` });
      const assignment = await sent.json() as { taskId: string };
      const complete = await request("/api/tasks/v1/complete", "POST", {
        callerSession: "receiver", taskId: assignment.taskId, status: terminal,
        result: { summary: `${terminal} with duplicate artifact`, result: { checked: true }, artifacts: [{ path: "duplicate-artifact.txt" }, { path: "duplicate-artifact.txt" }] },
      });
      expect(complete.status).toBe(200);

      const status = await request(`/api/tasks/v1/status?callerSession=parent&taskId=${assignment.taskId}`, "GET");
      expect(await status.json()).toMatchObject({
        ok: true,
        status: terminal,
        completion: {
          summary: `${terminal} with duplicate artifact`,
          result: { checked: true },
          artifacts: [{ path: "duplicate-artifact.txt" }],
          warnings: [{ code: "INVALID_ARTIFACT", message: "duplicate artifact declaration: duplicate-artifact.txt" }],
        },
      });
    }
  });

  test("routes messages, terminal results, delivery and parent acknowledgment through the durable ledgers", async () => {
    writeFileSync(join(receiverProject, "result.txt"), "verified artifact");
    const sent = await request("/api/tasks/v1/send", "POST", {
      callerSession: "parent", to: { machine: "local", sessionId: "receiver" }, task: "finish the task", idempotencyKey: "flow-1",
    });
    const assignment = await sent.json() as { taskId: string; eventId: string };
    const delivered = await request("/api/tasks/v1/delivered", "POST", { callerSession: "receiver", taskId: assignment.taskId, eventId: assignment.eventId });
    const deliveredReceipt = await delivered.json() as { eventId: string; sequence: string };
    expect(delivered.status).toBe(200);
    const deliveredRetry = await request("/api/tasks/v1/delivered", "POST", { callerSession: "receiver", taskId: assignment.taskId, eventId: assignment.eventId });
    expect(await deliveredRetry.json()).toMatchObject(deliveredReceipt);
    const question = await request("/api/tasks/v1/message", "POST", { callerSession: "receiver", taskId: assignment.taskId, type: "question", message: "which test?" });
    const questionReceipt = await question.json() as { eventId: string };
    expect(question.status).toBe(200);
    const answer = await request("/api/tasks/v1/message", "POST", { callerSession: "parent", taskId: assignment.taskId, type: "answer", message: "the focused one", replyToMessageId: questionReceipt.eventId });
    const answerReceipt = await answer.json() as { eventId: string };
    expect(answer.status).toBe(200);
    const messageDelivery = await request("/api/tasks/v1/delivered", "POST", { callerSession: "receiver", taskId: assignment.taskId, eventId: answerReceipt.eventId });
    const messageDeliveryReceipt = await messageDelivery.json() as { eventId: string; sequence: string };
    expect(messageDelivery.status).toBe(200);
    const messageDeliveryRetry = await request("/api/tasks/v1/delivered", "POST", { callerSession: "receiver", taskId: assignment.taskId, eventId: answerReceipt.eventId });
    expect(await messageDeliveryRetry.json()).toMatchObject(messageDeliveryReceipt);
    const complete = await request("/api/tasks/v1/complete", "POST", {
      callerSession: "receiver", taskId: assignment.taskId, status: "completed",
      result: { summary: "implemented", result: { checked: true }, artifacts: [{ path: "result.txt" }] },
    });
    expect(complete.status).toBe(200);
    const status = await request(`/api/tasks/v1/status?callerSession=parent&taskId=${assignment.taskId}`, "GET");
    expect(await status.json()).toMatchObject({ ok: true, status: "completed", completion: { result: { checked: true }, artifacts: [{ project: "receiver-project", path: "result.txt" }] } });
    const ack = await request("/api/tasks/v1/ack", "POST", { callerSession: "parent", taskId: assignment.taskId });
    const ackReceipt = await ack.json() as { eventId: string; sequence: string };
    expect(ack.status).toBe(200);
    const ackRetry = await request("/api/tasks/v1/ack", "POST", { callerSession: "parent", taskId: assignment.taskId });
    expect(await ackRetry.json()).toMatchObject(ackReceipt);
    const finalStatus = await request(`/api/tasks/v1/status?callerSession=parent&taskId=${assignment.taskId}`, "GET");
    const history = await finalStatus.json() as { events: Array<{ type: string; payload: { injectedEventId?: string } }> };
    expect(history.events.filter((event) => event.type === "task.delivered")[0]?.payload.injectedEventId).toBe(assignment.eventId);
    expect(history.events.filter((event) => event.type === "message.delivered")[0]?.payload.injectedEventId).toBe(answerReceipt.eventId);
  });

  test("rejects remote absolute context refs before creating a ledger or fetching the peer", async () => {
    const taskRoot = join(tmpdir(), `wolfpack-task-peer-absolute-ref-${process.pid}-${Date.now()}`);
    let peerFetches = 0;
    const sender = new TaskGateway({
      root: taskRoot,
      peerOrigin: "https://sender.example.ts.net",
      peerFetch: async () => {
        peerFetches += 1;
        return peerResponse({ ok: true });
      },
    });

    expect(await sender.send({
      ...remoteSendInput("reject an absolute remote ref"),
      context: { refs: [{ path: parentProject, selector: undefined, purpose: undefined }] },
    })).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", path: "/context/refs/0/path" } });
    expect(peerFetches).toBe(0);
    expect(await new TaskStore({ root: taskRoot }).ledgers()).toEqual([]);
    rmSync(taskRoot, { recursive: true, force: true });
  });

  test("stores a provisional peer assignment until its sender confirmation makes it visible", async () => {
    const peerRoot = join(tmpdir(), `wolfpack-task-peer-provisional-${process.pid}-${Date.now()}`);
    const receiver = new TaskGateway({ root: peerRoot, peerOrigin: "https://receiver.example.ts.net" });
    const assignment = {
      taskId: "01878a80-0000-7000-8000-000000000001",
      source: { machine: "https://sender.example.ts.net", sessionId: "parent-id" },
      target: { machine: "https://receiver.example.ts.net", sessionId: "receiver-id" },
      task: "peer assignment",
      context: { refs: [{ path: "missing-peer-context.md" }] },
      createdAt: new Date().toISOString(),
      expiresAt: "2027-08-03T01:00:00.000Z",
    };
    const assignmentHash = await hashImmutableAssignment(assignment);
    const createdEventId = "01878a80-0000-7000-8000-000000000004";
    const received = await receiver.receivePeer({ source: assignment.source, assignment, assignmentHash, createdEventId });
    expect(received).toMatchObject({ ok: true });
    if (!received.ok) throw new Error("expected provisional peer receipt");
    const provisional = (await new TaskStore({ root: peerRoot }).ledgers()).find((ledger) => ledger.key.taskId === assignment.taskId);
    expect(provisional?.records.find((record) => record.kind === "peer.receipt")).toMatchObject({ createdEventId });

    expect(await receiver.inbox("receiver", "0", false)).toMatchObject({ ok: true, events: [] });
    expect(await receiver.acceptPeerEvent({
      source: { machine: assignment.source.machine, sessionId: "gateway" },
      destination: assignment.target,
      event: {
        id: "01878a80-0000-7000-8000-000000000002",
        taskId: assignment.taskId,
        type: TASK_EVENT_TYPE.RECEIPT_CONFIRMED,
        actor: "sender",
        source: { machine: assignment.source.machine, sessionId: "gateway" },
        destination: assignment.target,
        sequence: "3",
        occurredAt: "2026-08-03T00:00:01.000Z",
        message: undefined,
        replyToMessageId: undefined,
        payload: {
          kind: "receipt_confirmation",
          receiptId: received.receiptId,
          assignmentHash,
          createdEventId,
          receivedEventId: "01878a80-0000-7000-8000-000000000003",
          receivedEventSequence: "2",
          receivedEventOccurredAt: "2026-08-03T00:00:00.500Z",
        },
        completion: undefined,
      },
    })).toMatchObject({ ok: true });
    expect(await receiver.inbox("receiver", "0", false)).toMatchObject({
      ok: true,
      events: [expect.objectContaining({ taskId: assignment.taskId, id: createdEventId })],
    });
    expect(await receiver.status("receiver", assignment.taskId)).toMatchObject({
      ok: true,
      warnings: [expect.objectContaining({ code: "MISSING_REF" })],
    });
    rmSync(peerRoot, { recursive: true, force: true });
  });

  test("rejects peer origins outside its configured tailnet suffix", async () => {
    const taskRoot = join(tmpdir(), `wolfpack-task-peer-origin-${process.pid}-${Date.now()}`);
    const receiver = new TaskGateway({
      root: taskRoot,
      peerOrigin: "https://receiver.example.ts.net",
    } as never);
    const assignment = {
      taskId: "01878a80-0000-7000-8000-000000000101",
      source: { machine: "https://sender.foreign.ts.net", sessionId: "parent-id" },
      target: { machine: "https://receiver.example.ts.net", sessionId: "receiver-id" },
      task: "reject foreign tailnet",
      createdAt: "2026-08-03T00:00:00.000Z",
      expiresAt: "2026-08-03T01:00:00.000Z",
    };

    expect(await receiver.receivePeer({
      source: assignment.source,
      assignment,
      assignmentHash: await hashImmutableAssignment(assignment),
      createdEventId: "01878a80-0000-7000-8000-000000000102",
    })).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    const wrongLocalTarget = { ...assignment, source: { ...assignment.source, machine: "https://sender.example.ts.net" }, target: { ...assignment.target, machine: "https://other.example.ts.net" } };
    expect(await receiver.receivePeer({
      source: wrongLocalTarget.source,
      assignment: wrongLocalTarget,
      assignmentHash: await hashImmutableAssignment(wrongLocalTarget),
      createdEventId: "01878a80-0000-7000-8000-000000000103",
    })).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    rmSync(taskRoot, { recursive: true, force: true });
  });

  test("uses one sender-authoritative creation instant across remote replicas", async () => {
    const taskRoot = join(tmpdir(), `wolfpack-task-created-at-${process.pid}-${Date.now()}`);
    let nowMs = Date.parse("2026-08-03T00:00:00.000Z");
    const { sender, receiver } = createPeerPair(taskRoot, { now: () => new Date(nowMs += 1_000) });

    try {
      const sent = await sender.send(remoteSendInput("preserve the canonical creation instant", 60_000));
      if (!sent.ok) throw new Error("expected remote send");
      const senderStatus = await sender.status("parent", sent.taskId);
      const receiverStatus = await receiver.status("receiver", sent.taskId);
      if (!senderStatus.ok || !receiverStatus.ok) throw new Error("expected sender and receiver task status");
      const senderCreated = senderStatus.events.find((event) => event.type === TASK_EVENT_TYPE.CREATED);
      const receiverCreated = receiverStatus.events.find((event) => event.type === TASK_EVENT_TYPE.CREATED);

      expect(receiverCreated).toEqual(senderCreated);
      expect(senderCreated?.occurredAt).toBe(senderStatus.task.createdAt);
      expect(Date.parse(senderStatus.task.expiresAt) - Date.parse(senderStatus.task.createdAt)).toBe(60_000);
    } finally {
      rmSync(taskRoot, { recursive: true, force: true });
    }
  });

  test("forwards remote receiver actions to the sender canonical ledger", async () => {
    const senderRoot = join(tmpdir(), `wolfpack-task-peer-sender-${process.pid}-${Date.now()}`);
    const receiverRoot = join(tmpdir(), `wolfpack-task-peer-receiver-${process.pid}-${Date.now()}`);
    let sender: InstanceType<typeof TaskGateway>;
    let peerNowMs = Date.parse("2026-08-03T00:00:00.000Z");
    const now = () => new Date(peerNowMs += 1_000);
    const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    const receiver = new TaskGateway({
      root: receiverRoot,
      peerOrigin: "https://receiver.example.ts.net",
      now,
      peerFetch: async (_url, init) => response(await sender.acceptPeerEvent(JSON.parse(String(init?.body)))),
      sleep: async () => undefined,
      random: () => 0.5,
    });
    sender = new TaskGateway({
      root: senderRoot,
      peerOrigin: "https://sender.example.ts.net",
      now,
      peerFetch: async (url, init) => response(new URL(String(url)).pathname.endsWith("/receive")
        ? await receiver.receivePeer(JSON.parse(String(init?.body)))
        : await receiver.acceptPeerEvent(JSON.parse(String(init?.body)))),
      sleep: async () => undefined,
      random: () => 0.5,
    });

    const sent = await sender.send({
      callerSession: "parent",
      to: { machine: "https://receiver.example.ts.net", sessionId: "receiver-id" },
      task: "complete remotely",
      context: undefined,
      role: undefined,
      preflight: undefined,
      metadata: undefined,
      onCompletePrompt: undefined,
      timeoutMs: undefined,
      idempotencyKey: undefined,
      rawBody: undefined,
    });
    expect(sent).toMatchObject({ ok: true });
    if (!sent.ok) throw new Error("expected remote send");
    const senderCreated = (await sender.status("parent", sent.taskId));
    const receiverCreated = (await receiver.status("receiver", sent.taskId));
    const createdEventId = receiverCreated.ok ? receiverCreated.events.find((event) => event.type === TASK_EVENT_TYPE.CREATED)?.id : undefined;
    expect(createdEventId).toBe(senderCreated.ok ? senderCreated.events.find((event) => event.type === TASK_EVENT_TYPE.CREATED)?.id : undefined);
    expect(receiverCreated.ok ? receiverCreated.events.find((event) => event.type === TASK_EVENT_TYPE.RECEIVED) : undefined)
      .toEqual(senderCreated.ok ? senderCreated.events.find((event) => event.type === TASK_EVENT_TYPE.RECEIVED) : undefined);
    expect(await receiver.delivered("receiver", sent.taskId, createdEventId ?? "missing")).toMatchObject({ ok: true });
    expect(await sender.status("parent", sent.taskId)).toMatchObject({
      ok: true,
      events: expect.arrayContaining([expect.objectContaining({ type: TASK_EVENT_TYPE.DELIVERED, payload: { kind: "delivery", injectedEventId: createdEventId } })]),
    });
    const question = await sender.message({
      callerSession: "parent",
      taskId: sent.taskId,
      type: "question",
      message: "which result?",
      replyToMessageId: undefined,
      rawBody: undefined,
    });
    expect(question).toMatchObject({ ok: true });
    if (!question.ok) throw new Error("expected remote question");
    const answer = await receiver.message({
      callerSession: "receiver",
      taskId: sent.taskId,
      type: "answer",
      message: "the canonical result",
      replyToMessageId: question.eventId,
      rawBody: undefined,
    });
    expect(answer).toMatchObject({ ok: true });
    expect(await sender.status("parent", sent.taskId)).toMatchObject({
      ok: true,
      events: expect.arrayContaining([
        expect.objectContaining({ id: question.eventId, type: TASK_EVENT_TYPE.QUESTION }),
        expect.objectContaining({ id: answer.ok ? answer.eventId : "missing", type: TASK_EVENT_TYPE.ANSWER, replyToMessageId: question.eventId }),
      ]),
    });

    const completed = await receiver.complete({
      callerSession: "receiver",
      taskId: sent.taskId,
      status: "completed",
      result: { summary: "remote completion", result: undefined, error: undefined, artifacts: undefined },
      rawBody: undefined,
    });
    expect(completed).toMatchObject({ ok: true });
    const senderStatus = await sender.status("parent", sent.taskId);
    expect(senderStatus).toMatchObject({ ok: true, status: "completed" });
    const receiverLedger = (await new TaskStore({ root: receiverRoot }).ledgers()).find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.RECEIVER && ledger.key.taskId === sent.taskId);
    expect(receiverLedger?.state.events.find((event) => event.type === TASK_EVENT_TYPE.COMPLETED)).toMatchObject({ id: completed.ok ? completed.eventId : "", sequence: completed.ok ? completed.sequence : "" });
    const acknowledged = await sender.acknowledge("parent", sent.taskId);
    expect(acknowledged).toMatchObject({ ok: true });
    const repairedReceiver = (await new TaskStore({ root: receiverRoot }).ledgers()).find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.RECEIVER && ledger.key.taskId === sent.taskId);
    expect(repairedReceiver?.records.some((record) => record.kind === "cleanup.eligible")).toBe(true);
    rmSync(senderRoot, { recursive: true, force: true });
    rmSync(receiverRoot, { recursive: true, force: true });
  });

  test("returns remote artifact metadata without source paths or bytes", async () => {
    const taskRoot = join(tmpdir(), `wolfpack-task-peer-artifact-${process.pid}-${Date.now()}`);
    const artifactPath = "remote-artifact.txt";
    const artifactContents = "remote artifact bytes must not cross the gateway";
    writeFileSync(join(receiverProject, artifactPath), artifactContents);
    const { sender, receiver } = createPeerPair(taskRoot);
    const sent = await sender.send(remoteSendInput("complete with remote artifact"));
    expect(sent).toMatchObject({ ok: true });
    if (!sent.ok) throw new Error("expected remote send");

    expect(await receiver.complete({
      callerSession: "receiver",
      taskId: sent.taskId,
      status: "completed",
      result: { summary: "remote artifact", result: undefined, error: undefined, artifacts: [{ path: artifactPath, mimeType: "text/plain", description: "verification artifact" }] },
      rawBody: undefined,
    })).toMatchObject({ ok: true });
    const status = await sender.status("parent", sent.taskId);
    expect(status).toMatchObject({
      ok: true,
      completion: {
        artifacts: [expect.objectContaining({ machine: expect.stringMatching(/.+/), project: "receiver-project", path: artifactPath, mimeType: "text/plain", description: "verification artifact" })],
      },
    });
    if (!status.ok) throw new Error("expected sender completion status");
    const artifact = (status.completion as { readonly artifacts: readonly Record<string, unknown>[] }).artifacts[0];
    expect(artifact).not.toHaveProperty("sourcePath");
    expect(artifact).not.toHaveProperty("bytes");
    expect(JSON.stringify(status)).not.toContain(receiverProject);
    expect(JSON.stringify(status)).not.toContain(artifactContents);
    rmSync(taskRoot, { recursive: true, force: true });
  });

  test("fails an unreachable initial peer assignment after one fetch without retrying", async () => {
    const taskRoot = join(tmpdir(), `wolfpack-task-peer-initial-unreachable-${process.pid}-${Date.now()}`);
    let peerFetches = 0;
    const delays: number[] = [];
    const sender = new TaskGateway({
      root: taskRoot,
      peerOrigin: "https://sender.example.ts.net",
      peerFetch: async () => {
        peerFetches += 1;
        throw new Error("receiver unavailable");
      },
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    });

    expect(await sender.send(remoteSendInput("fail initial peer delivery"))).toMatchObject({
      ok: false,
      error: { code: "PEER_UNREACHABLE", retryable: true },
    });
    expect(peerFetches).toBe(1);
    expect(delays).toEqual([]);
    const [ledger] = await new TaskStore({ root: taskRoot }).ledgers();
    expect(ledger?.state).toMatchObject({
      status: "failed",
      completion: { error: { code: "PEER_UNREACHABLE", retryable: true } },
    });
    expect(ledger?.state.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: TASK_EVENT_TYPE.CREATED }),
      expect.objectContaining({
        type: TASK_EVENT_TYPE.FAILED,
        completion: expect.objectContaining({ error: expect.objectContaining({ code: "PEER_UNREACHABLE", retryable: true }) }),
      }),
    ]));
    rmSync(taskRoot, { recursive: true, force: true });
  });

  test("purges a receiver provisional receipt after its real initial HTTP response is lost", async () => {
    const fixtureRoot = join(tmpdir(), `wolfpack-task-peer-http-orphan-${process.pid}-${Date.now()}`);
    const senderPort = await reservePort();
    const receiverPort = await reservePort();
    const senderOrigin = "https://sender.example.ts.net";
    const receiverOrigin = "https://receiver.example.ts.net";
    const senderTaskRoot = join(fixtureRoot, "sender", "tasks");
    const receiverTaskRoot = join(fixtureRoot, "receiver", "tasks");
    const senderHome = join(fixtureRoot, "sender-home");
    const receiverHome = join(fixtureRoot, "receiver-home");
    const peerMapPath = join(fixtureRoot, "peer-map.json");
    const dispatchLogPath = join(fixtureRoot, "peer-dispatches.jsonl");
    const clockPath = join(fixtureRoot, "clock.txt");
    mkdirSync(fixtureRoot, { recursive: true });
    writeFileSync(peerMapPath, JSON.stringify({ "sender.example.ts.net": senderPort, "receiver.example.ts.net": receiverPort }));
    writeFileSync(clockPath, "2026-08-03T00:00:00.000Z");

    let sender: PeerServer | undefined;
    let receiver: PeerServer | undefined;
    try {
      receiver = await spawnPeerServer({
        role: "receiver", port: receiverPort, taskRoot: receiverTaskRoot, home: receiverHome,
        projectRoot: join(fixtureRoot, "receiver-project"), peerMapPath, peerOrigin: receiverOrigin, dispatchLogPath, clockPath,
      });
      sender = await spawnPeerServer({
        role: "sender", port: senderPort, taskRoot: senderTaskRoot, home: senderHome,
        projectRoot: join(fixtureRoot, "sender-project"), peerMapPath, peerOrigin: senderOrigin, dispatchLogPath, clockPath,
        losePeerReceiveResponse: true,
      });

      const failedResponse = await fetch(`${sender.base}/api/tasks/v1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callerSession: "parent", to: { machine: receiverOrigin, sessionId: "receiver-id" }, task: "lose the initial peer receive response" }),
      });
      expect(failedResponse.status).toBe(503);
      expect(await failedResponse.json()).toMatchObject({ ok: false, error: { code: "PEER_UNREACHABLE", retryable: true } });

      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      const inspection = await (async () => {
        const senderStore = new TaskStore({ root: senderTaskRoot });
        const receiverStore = new TaskStore({ root: receiverTaskRoot });
        const [senderLedger] = await senderStore.ledgers();
        const [provisional] = await receiverStore.ledgers();
        if (!senderLedger || !provisional) throw new Error("expected sender failure and receiver provisional ledgers");
        return {
          senderState: senderLedger.state,
          provisionalKey: provisional.key,
          provisionalRecords: provisional.records,
          provisionalEvents: provisional.state.events,
          provisionalAssignmentHash: provisional.header.assignmentHash,
        };
      })();
      expect(inspection.senderState).toMatchObject({
        status: "failed",
        events: [
          expect.objectContaining({ type: TASK_EVENT_TYPE.CREATED }),
          expect.objectContaining({ type: TASK_EVENT_TYPE.FAILED, completion: expect.objectContaining({ error: expect.objectContaining({ code: "PEER_UNREACHABLE", retryable: true }) }) }),
        ],
      });
      expect(inspection.provisionalKey.role).toBe(TASK_LEDGER_ROLE.RECEIVER);
      expect(inspection.provisionalRecords).toContainEqual(expect.objectContaining({ kind: "peer.receipt", taskId: inspection.provisionalKey.taskId }));
      expect(inspection.provisionalEvents).toEqual([]);
      const dispatches = readFileSync(dispatchLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      const receiveDispatches = dispatches.filter((entry) => entry.role === "sender" && entry.path === "/api/tasks/v1/peer/receive");
      expect(receiveDispatches.filter((entry) => entry.responseStatus === undefined)).toHaveLength(1);
      expect(receiveDispatches).toContainEqual(expect.objectContaining({ responseStatus: 200 }));

      writeFileSync(clockPath, "2026-08-03T00:10:00.000Z");
      receiver = await spawnPeerServer({
        role: "receiver", port: receiverPort, taskRoot: receiverTaskRoot, home: receiverHome,
        projectRoot: join(fixtureRoot, "receiver-project"), peerMapPath, peerOrigin: receiverOrigin, dispatchLogPath, clockPath,
      });
      await stopPeerServer(receiver);

      const purgedStore = new TaskStore({ root: receiverTaskRoot });
      expect(await purgedStore.getLedger(inspection.provisionalKey)).toBeUndefined();
      expect(await purgedStore.readTombstone(inspection.provisionalKey)).toMatchObject({
        key: inspection.provisionalKey,
        assignmentHash: inspection.provisionalAssignmentHash,
        writtenAt: "2026-08-03T00:10:00.000Z",
      });
    } finally {
      await Promise.all([stopPeerServer(sender), stopPeerServer(receiver)]);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("reuses the durable sender ledger for an identical remote idempotent send", async () => {
    const taskRoot = join(tmpdir(), `wolfpack-task-peer-idempotency-${process.pid}-${Date.now()}`);
    const { sender } = createPeerPair(taskRoot);
    const input = { ...remoteSendInput("one remote task"), idempotencyKey: "remote-idempotency" };
    const first = await sender.send(input);
    const second = await sender.send(input);
    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual(first);
    rmSync(taskRoot, { recursive: true, force: true });
  });

  test("does not replay an exhausted parent acknowledgment after the receiver becomes reachable", async () => {
    const taskRoot = join(tmpdir(), `wolfpack-task-peer-ack-repair-${process.pid}-${Date.now()}`);
    let losePendingResponse = false;
    const { sender, receiver, receiverRoot } = createPeerPair(taskRoot, {
      senderTransport: async (payload, deliver) => {
        const delivered = await deliver();
        const event = payload.event as { readonly type?: string } | undefined;
        return losePendingResponse && event?.type === TASK_EVENT_TYPE.PARENT_ACK_PENDING
          ? peerResponse({ ok: false, error: { code: "PEER_UNREACHABLE", message: "lost response", retryable: true } })
          : delivered;
      },
    });
    const sent = await sender.send(remoteSendInput("repair remote acknowledgment"));
    expect(sent).toMatchObject({ ok: true });
    if (!sent.ok) throw new Error("expected remote send");
    expect(await receiver.complete({
      callerSession: "receiver",
      taskId: sent.taskId,
      status: "completed",
      result: { summary: "finished", result: undefined, error: undefined, artifacts: undefined },
      rawBody: undefined,
    })).toMatchObject({ ok: true });

    losePendingResponse = true;
    expect(await sender.acknowledge("parent", sent.taskId)).toMatchObject({ ok: false, error: { code: "PEER_UNREACHABLE" } });
    let receiverLedger = (await new TaskStore({ root: receiverRoot }).ledgers())
      .find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.RECEIVER && ledger.key.taskId === sent.taskId);
    expect(receiverLedger?.records.some((record) => record.kind === "cleanup.eligible")).toBe(false);
    expect(receiverLedger?.records.filter((record) => record.kind === "acknowledgment")).toHaveLength(1);

    losePendingResponse = false;
    expect(await sender.acknowledge("parent", sent.taskId)).toMatchObject({ ok: false, error: { code: "PEER_UNREACHABLE" } });
    expect(await sender.status("parent", sent.taskId)).toMatchObject({
      ok: true,
      events: expect.not.arrayContaining([expect.objectContaining({ type: TASK_EVENT_TYPE.PARENT_ACKNOWLEDGED })]),
    });
    receiverLedger = (await new TaskStore({ root: receiverRoot }).ledgers())
      .find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.RECEIVER && ledger.key.taskId === sent.taskId);
    expect(receiverLedger?.records.some((record) => record.kind === "cleanup.eligible")).toBe(false);
    rmSync(taskRoot, { recursive: true, force: true });
  });

  test("does not replay an exhausted final parent acknowledgment after the receiver becomes reachable", async () => {
    const taskRoot = join(tmpdir(), `wolfpack-task-peer-final-ack-repair-${process.pid}-${Date.now()}`);
    let rejectFinalAcknowledgment = true;
    const { sender, receiver, receiverRoot } = createPeerPair(taskRoot, {
      senderTransport: async (payload, deliver) => {
        const event = payload.event as { readonly type?: string } | undefined;
        return rejectFinalAcknowledgment && event?.type === TASK_EVENT_TYPE.PARENT_ACKNOWLEDGED
          ? peerResponse({ ok: false, error: { code: "PEER_UNREACHABLE", message: "receiver offline", retryable: true } })
          : deliver();
      },
    });
    const sent = await sender.send(remoteSendInput("repair final acknowledgment"));
    expect(sent).toMatchObject({ ok: true });
    if (!sent.ok) throw new Error("expected remote send");
    expect(await receiver.complete({
      callerSession: "receiver",
      taskId: sent.taskId,
      status: "completed",
      result: { summary: "finished", result: undefined, error: undefined, artifacts: undefined },
      rawBody: undefined,
    })).toMatchObject({ ok: true });

    expect(await sender.acknowledge("parent", sent.taskId)).toMatchObject({ ok: false, error: { code: "PEER_UNREACHABLE" } });
    let receiverLedger = (await new TaskStore({ root: receiverRoot }).ledgers())
      .find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.RECEIVER && ledger.key.taskId === sent.taskId);
    expect(receiverLedger?.records.some((record) => record.kind === "cleanup.eligible")).toBe(false);

    rejectFinalAcknowledgment = false;
    expect(await sender.acknowledge("parent", sent.taskId)).toMatchObject({ ok: false, error: { code: "PEER_UNREACHABLE" } });
    receiverLedger = (await new TaskStore({ root: receiverRoot }).ledgers())
      .find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.RECEIVER && ledger.key.taskId === sent.taskId);
    expect(receiverLedger?.records.some((record) => record.kind === "cleanup.eligible")).toBe(false);
    rmSync(taskRoot, { recursive: true, force: true });
  });

  test("forwards remote cancellation request and receiver cancellation terminal state", async () => {
    const taskRoot = join(tmpdir(), `wolfpack-task-peer-cancel-${process.pid}-${Date.now()}`);
    const { sender, receiver } = createPeerPair(taskRoot);
    const sent = await sender.send(remoteSendInput("cancel remote work"));
    expect(sent).toMatchObject({ ok: true });
    if (!sent.ok) throw new Error("expected remote send");
    const assignmentPage = await receiver.inbox("receiver", "0", false);
    expect(assignmentPage).toMatchObject({ ok: true });
    if (!assignmentPage.ok) throw new Error("expected receiver assignment inbox");

    expect(await sender.cancel("parent", sent.taskId)).toMatchObject({ ok: true });
    expect(await receiver.status("receiver", sent.taskId)).toMatchObject({ ok: true, status: "cancel_requested" });
    expect(await receiver.inbox("receiver", assignmentPage.nextCursor, false)).toMatchObject({
      ok: true,
      events: [expect.objectContaining({ taskId: sent.taskId, type: TASK_EVENT_TYPE.CANCEL_REQUESTED })],
    });
    expect(await receiver.complete({
      callerSession: "receiver",
      taskId: sent.taskId,
      status: "cancelled",
      result: { summary: "cancelled by parent", result: undefined, error: undefined, artifacts: undefined },
      rawBody: undefined,
    })).toMatchObject({ ok: true });
    expect(await sender.status("parent", sent.taskId)).toMatchObject({ ok: true, status: "cancelled" });
    rmSync(taskRoot, { recursive: true, force: true });
  });

  test("propagates sender timeout to the remote receiver inbox", async () => {
    const taskRoot = join(tmpdir(), `wolfpack-task-peer-timeout-${process.pid}-${Date.now()}`);
    let nowMs = Date.parse("2026-08-03T00:00:00.000Z");
    const { sender, receiver } = createPeerPair(taskRoot, { now: () => new Date(nowMs) });
    const sent = await sender.send(remoteSendInput("stop remote work on timeout", 1_000));
    expect(sent).toMatchObject({ ok: true });
    if (!sent.ok) throw new Error("expected remote send");
    const assignmentPage = await receiver.inbox("receiver", "0", false);
    expect(assignmentPage).toMatchObject({ ok: true });
    if (!assignmentPage.ok) throw new Error("expected receiver assignment inbox");

    nowMs += 1_001;
    expect(await sender.status("parent", sent.taskId)).toMatchObject({ ok: true, status: "timed_out" });
    expect(await receiver.status("receiver", sent.taskId)).toMatchObject({ ok: true, status: "timed_out" });
    expect(await receiver.inbox("receiver", assignmentPage.nextCursor, false)).toMatchObject({
      ok: true,
      events: [expect.objectContaining({ taskId: sent.taskId, type: TASK_EVENT_TYPE.TIMED_OUT })],
    });
    rmSync(taskRoot, { recursive: true, force: true });
  });

  test("reconciles the original receiver event after a crash following sender acceptance", async () => {
    const taskRoot = join(tmpdir(), `wolfpack-task-peer-restart-${process.pid}-${Date.now()}`);
    const receiverRoot = join(taskRoot, "receiver");
    let crashAfterSenderAcceptance = false;
    let receiverWrites = 0;
    const receiverStore = new TaskStore({
      root: receiverRoot,
      testHooks: {
        beforeFsync: (step, path) => {
          if (crashAfterSenderAcceptance && step === "ledger-file" && path.includes("/ledgers/receiver/") && ++receiverWrites === 3) {
            throw new Error("crash after sender acceptance");
          }
        },
        afterFsync: undefined,
      },
    });
    const pair = createPeerPair(taskRoot, { receiverStore });
    const sent = await pair.sender.send(remoteSendInput("recover canonical completion"));
    expect(sent).toMatchObject({ ok: true });
    if (!sent.ok) throw new Error("expected remote send");
    const completion = {
      callerSession: "receiver",
      taskId: sent.taskId,
      status: "completed" as const,
      result: { summary: "stable result", result: undefined, error: undefined, artifacts: undefined },
      rawBody: undefined,
    };
    crashAfterSenderAcceptance = true;
    await expect(pair.receiver.complete(completion)).rejects.toThrow("could not append task ledger record");
    const senderBefore = await pair.sender.status("parent", sent.taskId);
    expect(senderBefore).toMatchObject({ ok: true, status: "completed" });
    if (!senderBefore.ok) throw new Error("expected sender terminal state");
    const canonicalCompletion = senderBefore.events.find((event) => event.type === TASK_EVENT_TYPE.COMPLETED);

    const restarted = new TaskGateway({
      root: receiverRoot,
      peerOrigin: "https://receiver.example.ts.net",
      peerFetch: async (_url, init) => peerResponse(await pair.sender.acceptPeerEvent(JSON.parse(String(init?.body)))),
      sleep: async () => undefined,
      random: () => 0.5,
    });
    expect(await restarted.complete(completion)).toMatchObject({
      ok: true,
      eventId: canonicalCompletion?.id,
      sequence: canonicalCompletion?.sequence,
    });
    expect(await pair.sender.status("parent", sent.taskId)).toMatchObject({
      ok: true,
      events: expect.not.arrayContaining([expect.objectContaining({ type: TASK_EVENT_TYPE.LATE_TERMINAL })]),
    });
    rmSync(taskRoot, { recursive: true, force: true });
  });

  test("does not replay an exhausted receiver outbox intent on later access", async () => {
    const taskRoot = join(tmpdir(), `wolfpack-task-peer-exhaustion-${process.pid}-${Date.now()}`);
    let receiverAttempts = 0;
    const { sender, receiver } = createPeerPair(taskRoot, {
      receiverTransport: async () => {
        receiverAttempts += 1;
        return peerResponse({ ok: false, error: { code: "PEER_UNREACHABLE", message: "offline", retryable: true } });
      },
    });
    const sent = await sender.send(remoteSendInput("stop after bounded event attempts"));
    expect(sent).toMatchObject({ ok: true });
    if (!sent.ok) throw new Error("expected remote send");
    expect(await receiver.message({
      callerSession: "receiver",
      taskId: sent.taskId,
      type: "information",
      message: "cannot deliver",
      replyToMessageId: undefined,
      rawBody: undefined,
    })).toMatchObject({ ok: false, error: { code: "PEER_UNREACHABLE" } });
    expect(receiverAttempts).toBe(4);

    expect(await receiver.status("receiver", sent.taskId)).toMatchObject({ ok: true });
    expect(await receiver.status("receiver", sent.taskId)).toMatchObject({ ok: true });
    expect(receiverAttempts).toBe(4);
    rmSync(taskRoot, { recursive: true, force: true });
  });

  test("uses four durable attempts then stops peer receipt confirmation delivery", async () => {
    const senderRoot = join(tmpdir(), `wolfpack-task-peer-retry-sender-${process.pid}-${Date.now()}`);
    const receiverRoot = join(tmpdir(), `wolfpack-task-peer-retry-receiver-${process.pid}-${Date.now()}`);
    const receiver = new TaskGateway({ root: receiverRoot, peerOrigin: "https://receiver.example.ts.net" });
    const delays: number[] = [];
    const sender = new TaskGateway({
      root: senderRoot,
      peerOrigin: "https://sender.example.ts.net",
      peerFetch: async (url, init) => new URL(String(url)).pathname.endsWith("/receive")
        ? new Response(JSON.stringify(await receiver.receivePeer(JSON.parse(String(init?.body)))))
        : new Response(JSON.stringify({ ok: false, error: { code: "PEER_UNREACHABLE", message: "offline", retryable: true } }), { status: 503 }),
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      random: () => 0.5,
    });
    const sent = await sender.send({
      callerSession: "parent", to: { machine: "https://receiver.example.ts.net", sessionId: "receiver-id" }, task: "retry confirmation",
      context: undefined, role: undefined, preflight: undefined, metadata: undefined, onCompletePrompt: undefined, timeoutMs: undefined, idempotencyKey: undefined, rawBody: undefined,
    });
    expect(sent).toMatchObject({ ok: true });
    if (!sent.ok) throw new Error("expected initial receipt");
    expect(delays).toEqual([1_000, 2_000, 4_000]);
    const senderLedger = (await new TaskStore({ root: senderRoot }).ledgers()).find((ledger) => ledger.key.role === TASK_LEDGER_ROLE.SENDER && ledger.key.taskId === sent.taskId);
    expect(senderLedger?.records.filter((record) => record.kind === "outbox.attempt")).toHaveLength(4);
    expect(senderLedger?.state.events.filter((event) => event.type === TASK_EVENT_TYPE.DELIVERY_FAILED)).toHaveLength(1);
    rmSync(senderRoot, { recursive: true, force: true });
    rmSync(receiverRoot, { recursive: true, force: true });
  });

  test("identifies invalid send HTTP fields with JSON Pointers", async () => {
    const valid = { callerSession: "parent", to: { machine: "local", sessionId: "receiver" }, task: "send validation" };
    const cases = [
      { name: "missing caller", body: { to: valid.to, task: valid.task }, path: "/callerSession" },
      { name: "wrong target session type", body: { ...valid, to: { machine: "local", sessionId: 1 } }, path: "/to/sessionId" },
      { name: "empty task", body: { ...valid, task: "" }, path: "/task" },
      { name: "wrong nested context ref type", body: { ...valid, context: { refs: [{ path: 1 }] } }, path: "/context/refs/0/path" },
      { name: "unexpected escaped property", body: { ...valid, "unexpected/a~b": true }, path: "/unexpected~1a~0b" },
    ] as const;

    for (const invalid of cases) {
      const response = await request("/api/tasks/v1/send", "POST", invalid.body);
      expect(response.status, invalid.name).toBe(400);
      expect(await response.json(), invalid.name).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", path: invalid.path },
      });
    }
  });

  test("identifies semantic invalid send fields before persistence", async () => {
    const taskRoot = join(tmpdir(), `wolfpack-task-send-validation-${process.pid}-${Date.now()}`);
    const sender = new TaskGateway({
      root: taskRoot,
      peerOrigin: "https://sender.example.ts.net",
      peerFetch: async () => peerResponse({ ok: true }),
    });
    const cases = [
      { name: "empty task", input: remoteSendInput(""), path: "/task" },
      { name: "out of range timeout", input: remoteSendInput("timeout", 999), path: "/timeoutMs" },
      { name: "empty required project", input: { ...remoteSendInput("preflight"), to: { machine: "local", sessionId: "receiver" }, preflight: { requiredProject: "" } }, path: "/preflight/requiredProject" },
      {
        name: "remote absolute context ref",
        input: { ...remoteSendInput("absolute ref"), context: { refs: [{ path: parentProject, selector: undefined, purpose: undefined }] } },
        path: "/context/refs/0/path",
      },
    ] as const;

    for (const invalid of cases) {
      expect(await sender.send(invalid.input), invalid.name).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", path: invalid.path },
      });
    }
    expect(await new TaskStore({ root: taskRoot }).ledgers()).toEqual([]);
    rmSync(taskRoot, { recursive: true, force: true });
  });

  test("does not persist an HTTP preflight rejection before one valid retry", async () => {
    const taskRoot = join(tmpdir(), `wolfpack-task-preflight-retry-${process.pid}-${Date.now()}`);
    const previousTaskRoot = process.env.WOLFPACK_TASK_ROOT;
    process.env.WOLFPACK_TASK_ROOT = taskRoot;
    __resetTaskGatewayForTests();
    const body = { callerSession: "parent", to: { machine: "local", sessionId: "receiver" }, task: "retry after preflight correction" };

    try {
      const rejected = await request("/api/tasks/v1/send", "POST", { ...body, preflight: { requiredProject: "" } });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", path: "/preflight/requiredProject" },
      });
      const store = new TaskStore({ root: taskRoot });
      expect(await store.ledgers()).toEqual([]);

      const accepted = await request("/api/tasks/v1/send", "POST", { ...body, preflight: { requiredProject: basename(receiverProject) } });
      expect(accepted.status).toBe(200);
      const receipt = await accepted.json() as { readonly taskId: string };
      const ledgers = await new TaskStore({ root: taskRoot }).ledgers();
      expect(ledgers.filter((ledger) => ledger.key.taskId === receipt.taskId && ledger.key.role === TASK_LEDGER_ROLE.SENDER)).toHaveLength(1);
      expect(ledgers.filter((ledger) => ledger.key.taskId === receipt.taskId && ledger.key.role === TASK_LEDGER_ROLE.RECEIVER)).toHaveLength(1);
      expect(new Set(ledgers.map((ledger) => ledger.key.taskId))).toEqual(new Set([receipt.taskId]));
    } finally {
      __resetTaskGatewayForTests();
      if (previousTaskRoot === undefined) delete process.env.WOLFPACK_TASK_ROOT;
      else process.env.WOLFPACK_TASK_ROOT = previousTaskRoot;
      rmSync(taskRoot, { recursive: true, force: true });
    }
  });

  test("enforces task content type and keeps local routes strict", async () => {
    const invalid = await request("/api/tasks/v1/send", "POST", undefined, { "content-type": "text/plain" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ ok: false, error: { code: "INVALID_CONTENT_TYPE" } });

    const oversized = await request("/api/tasks/v1/send", "POST", { callerSession: "parent", to: { machine: "local", sessionId: "receiver" }, task: "x".repeat(64 * 1024) });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ ok: false, error: { code: "PAYLOAD_TOO_LARGE" } });

    const tooShortTimeout = await request("/api/tasks/v1/send", "POST", { callerSession: "parent", to: { machine: "local", sessionId: "receiver" }, task: "short timeout", timeoutMs: 999 });
    expect(tooShortTimeout.status).toBe(400);
    const minimumTimeout = await request("/api/tasks/v1/send", "POST", { callerSession: "parent", to: { machine: "local", sessionId: "receiver" }, task: "minimum timeout", timeoutMs: 1_000 });
    expect(minimumTimeout.status).toBe(200);

    const peer = await request("/api/tasks/v1/peer/receive", "POST", {});
    expect(peer.status).toBe(400);
  });
});
