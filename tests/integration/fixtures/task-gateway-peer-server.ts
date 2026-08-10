#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { PublicSessionIdentity } from "../../../src/server/session-identity.ts";

const role = process.env.WOLFPACK_TEST_PEER_ROLE;
const taskRoot = process.env.WOLFPACK_TASK_ROOT;
const projectRoot = process.env.WOLFPACK_TEST_PROJECT_ROOT;
const peerMapPath = process.env.WOLFPACK_TEST_PEER_MAP;
const peerOrigin = process.env.WOLFPACK_TEST_PEER_ORIGIN;
const listenPort = Number(process.env.WOLFPACK_TEST_LISTEN_PORT);
const dispatchLogPath = process.env.WOLFPACK_TEST_DISPATCH_LOG;
const clockPath = process.env.WOLFPACK_TEST_CLOCK_PATH;
const losePeerReceiveResponse = process.env.WOLFPACK_TEST_LOSE_PEER_RECEIVE_RESPONSE === "1";
const crashAfterPeerEvent = process.env.WOLFPACK_TEST_CRASH_AFTER_PEER_EVENT;
const crashBeforePeerEvent = process.env.WOLFPACK_TEST_CRASH_BEFORE_PEER_EVENT;
const crashBeforePeerEventAttempt = Number(process.env.WOLFPACK_TEST_CRASH_BEFORE_PEER_EVENT_ATTEMPT ?? "0");
const peerEventResponseDelayMs = Number(process.env.WOLFPACK_TEST_PEER_EVENT_RESPONSE_DELAY_MS ?? "0");
const taskRelay = process.env.WOLFPACK_TEST_TASK_RELAY === "1";
if (!Number.isInteger(crashBeforePeerEventAttempt) || crashBeforePeerEventAttempt < 0) throw new Error("peer event crash attempt must be a non-negative integer");
if (!Number.isInteger(peerEventResponseDelayMs) || peerEventResponseDelayMs < 0) throw new Error("peer event response delay must be a non-negative integer");
let crashBeforePeerEventCount = 0;
if (process.env.WOLFPACK_TEST_FAST_RETRY === "1") {
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => nativeSetTimeout(
    handler,
    typeof timeout === "number" && timeout >= 1_000 ? 1 : timeout,
    ...args,
  )) as typeof setTimeout;
}
const peerEventResponseLoss = new Map<string, number>();
for (const entry of JSON.parse(process.env.WOLFPACK_TEST_PEER_EVENT_RESPONSE_LOSS ?? "[]") as unknown[]) {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("peer event response loss must be an object");
  const value = entry as Record<string, unknown>;
  if (typeof value.type !== "string" || typeof value.count !== "number" || !Number.isInteger(value.count) || value.count < 1) {
    throw new Error("peer event response loss requires a type and positive count");
  }
  peerEventResponseLoss.set(value.type, value.count);
}

if ((role !== "sender" && role !== "receiver") || !taskRoot || !projectRoot || !peerMapPath || !peerOrigin
  || !Number.isInteger(listenPort) || listenPort < 1 || !dispatchLogPath) {
  throw new Error("peer server fixture requires role, task root, project root, peer map, origin, port, and dispatch log");
}
const fixtureProjectRoot = projectRoot;

process.env.WOLFPACK_TEST = "1";
process.env.WOLFPACK_TAILNET_SUFFIX = "example.ts.net";
mkdirSync(projectRoot, { recursive: true });
mkdirSync(join(process.env.HOME ?? "", ".wolfpack"), { recursive: true });
writeFileSync(join(process.env.HOME ?? "", ".wolfpack", "config.json"), JSON.stringify({
  ...(taskRelay ? { devDir: projectRoot, port: listenPort } : {}),
  tailscaleHostname: new URL(peerOrigin).hostname,
}));

const NativeDate = Date;
if (clockPath) {
  const now = (): number => {
    const milliseconds = NativeDate.parse(readFileSync(clockPath, "utf8").trim());
    if (Number.isNaN(milliseconds)) throw new Error("peer server fixture clock must contain an ISO-8601 timestamp");
    return milliseconds;
  };
  class FixtureDate extends NativeDate {
    constructor(...args: [] | [string | number | Date]) {
      super(args.length === 0 ? now() : args[0]);
    }

    static now(): number {
      return now();
    }
  }
  globalThis.Date = FixtureDate as unknown as DateConstructor;
}

const nativeFetch = globalThis.fetch;
const rewrittenFetch: typeof globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const peerPort = JSON.parse(readFileSync(peerMapPath, "utf8"))[url.hostname] as unknown;
  if (url.protocol === "https:" && typeof peerPort === "number") {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    const event = typeof body === "object" && body !== null && !Array.isArray(body)
      && typeof (body as Record<string, unknown>).event === "object" && (body as Record<string, unknown>).event !== null
      ? (body as Record<string, unknown>).event as Record<string, unknown>
      : undefined;
    const eventId = typeof event?.id === "string" ? event.id : undefined;
    const eventType = typeof event?.type === "string" ? event.type : undefined;
    appendFileSync(dispatchLogPath, `${JSON.stringify({ role, path: url.pathname, origin: url.origin, eventId, eventType })}\n`);
    if (url.pathname === "/api/tasks/v1/peer/event" && eventType !== undefined && eventType === crashBeforePeerEvent) {
      crashBeforePeerEventCount += 1;
      if (crashBeforePeerEventAttempt === 0 || crashBeforePeerEventCount === crashBeforePeerEventAttempt) process.exit(85);
    }
    const response = nativeFetch(`http://127.0.0.1:${peerPort}${url.pathname}${url.search}`, init);
    const delayedResponse = response.then(async (received) => {
      if (url.pathname === "/api/tasks/v1/peer/event" && peerEventResponseDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, peerEventResponseDelayMs));
      }
      return received;
    });
    if (losePeerReceiveResponse && role === "sender" && url.pathname === "/api/tasks/v1/peer/receive") {
      return delayedResponse.then((received) => {
        appendFileSync(dispatchLogPath, `${JSON.stringify({ role, path: url.pathname, origin: url.origin, responseStatus: received.status })}\n`);
        if (!received.ok) return received;
        throw new Error("peer receive response intentionally lost after receiver persistence");
      });
    }
    if (url.pathname === "/api/tasks/v1/peer/event" && eventType !== undefined && eventType === crashAfterPeerEvent) {
      return delayedResponse.then((received) => {
        appendFileSync(dispatchLogPath, `${JSON.stringify({ role, path: url.pathname, origin: url.origin, responseStatus: received.status })}\n`);
        if (!received.ok) return received;
        return process.exit(86);
      });
    }
    const remainingLosses = eventType === undefined ? undefined : peerEventResponseLoss.get(eventType);
    if (url.pathname === "/api/tasks/v1/peer/event" && eventType !== undefined && remainingLosses !== undefined && remainingLosses > 0) {
      return delayedResponse.then((received) => {
        appendFileSync(dispatchLogPath, `${JSON.stringify({ role, path: url.pathname, origin: url.origin, responseStatus: received.status })}\n`);
        if (!received.ok) return received;
        peerEventResponseLoss.set(eventType, remainingLosses - 1);
        throw new Error("peer event response intentionally lost after durable peer routing");
      });
    }
    return delayedResponse;
  }
  return nativeFetch(input, init);
}, { preconnect: nativeFetch.preconnect });
globalThis.fetch = rewrittenFetch;

const { __setTestBackend } = await import("../../../src/server/backend.ts");
const { MockBackend } = await import("../../../src/server/mock-backend.ts");

class PeerBackend extends MockBackend {
  override async listIdentities(): Promise<Record<string, PublicSessionIdentity>> {
    const now = new Date(0).toISOString();
    return role === "sender"
      ? {
        parent: { wolfpackSessionId: "parent-id", wolfpackSessionName: "parent", projectPath: fixtureProjectRoot, agentKind: "pi" as const, createdAt: now, updatedAt: now },
      }
      : {
        receiver: { wolfpackSessionId: "receiver-id", wolfpackSessionName: "receiver", projectPath: fixtureProjectRoot, agentKind: "pi" as const, createdAt: now, updatedAt: now },
      };
  }
}

__setTestBackend(new PeerBackend({ sessions: [role === "sender" ? "parent" : "receiver"] }));
const { getTaskGateway } = await import("../../../src/tasks/gateway.ts");
const { createServerInstance } = await import("../../../src/server/index.ts");
await getTaskGateway().initialize();
const { server } = createServerInstance();

server.listen(listenPort, "127.0.0.1", () => {
  const address = server.address() as AddressInfo;
  process.stdout.write(`READY:${address.port}\n`);
});

process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
