import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { qualifyRemoteTaskEndpoint, unqualifiedRemoteTaskEndpoint } from "../../src/cli/task-endpoint.ts";
import { RELAY_ID } from "../../src/task-relay/domain.ts";

function fixture() {
  const origin = "https://peer.tail123.ts.net", epoch = randomUUID(), remoteEpoch = randomUUID();
  const source = { relay: RELAY_ID, id: randomUUID() }, target = { relay: RELAY_ID, id: randomUUID() }, alias = { relay: `${RELAY_ID}:peer:${randomUUID()}`, id: target.id };
  const transport = (endpoint: typeof source, epoch: string) => ({ profile: "volatile-v1", epoch, endpoint, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
  const remote = { ok: true, session: "worker", sessionId: "exact-remote-id", taskEndpoint: target, taskTransport: transport(target, remoteEpoch) };
  const local = { ok: true, sessionId: "exact-local-id", taskEndpoint: source, taskTransport: transport(source, epoch) };
  const resolved = { ok: true, profile: "volatile-v1", epoch, value: { kind: "resolved", endpoint: alias } };
  const calls: Array<{ url: string; body: unknown }> = [];
  const options = { origin, localBase: "http://127.0.0.1:1", callerSession: "parent", headers: new Headers({ "content-type": "application/json" }),
    fetch: Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error"); calls.push({ url: String(url), body: init?.body && JSON.parse(String(init.body)) });
      return Response.json(String(url).startsWith(origin) ? remote : init?.method === "POST" ? resolved : local);
    }, { preconnect: fetch.preconnect }) as typeof fetch };
  return { remote, local, resolved, calls, options, source, alias };
}

test("remote CLI endpoint selection resolves an exact session into the local epoch's opaque alias", async () => {
  const f = fixture();
  const result = await qualifyRemoteTaskEndpoint(f.remote, f.options) as any;
  expect(result.taskEndpoint).toEqual(f.alias); expect(result.remoteTaskTransport).toEqual(f.remote.taskTransport); expect(result.taskTransport).toBeUndefined();
  expect(result.taskRouting).toEqual({ profile: "volatile-v1", sourceEpoch: f.local.taskTransport.epoch, destinationOrigin: f.options.origin });
  expect(f.calls.map(call => call.url)).toEqual([f.options.origin + "/api/session-control/status?session=exact-remote-id", "http://127.0.0.1:1/api/session-control/status?session=parent", "http://127.0.0.1:1/api/task-relay/volatile-v1/resolve-peer"]);
  expect(f.calls[2]!.body).toEqual({ profile: "volatile-v1", epoch: f.local.taskTransport.epoch, callerSession: "parent", endpoint: f.source, origin: f.options.origin, target: f.remote.taskEndpoint });
  expect(f.remote.taskEndpoint.relay).toBe(RELAY_ID); // Do not mutate remote observation.
});

test("remote list/unavailable caller never presents an unqualified endpoint as locally routable", async () => {
  const f = fixture();
  for (const value of [unqualifiedRemoteTaskEndpoint(f.remote), await qualifyRemoteTaskEndpoint(f.remote, { ...f.options, callerSession: undefined })] as any[]) {
    expect(value.taskEndpoint).toBeUndefined(); expect(value.taskTransport).toBeUndefined(); expect(value.remoteTaskEndpoint).toEqual(f.remote.taskEndpoint);
    expect(value.taskEndpointError.code).toBe("REMOTE_TASK_ENDPOINT_UNAVAILABLE"); expect(value.sessionId).toBe("exact-remote-id"); expect(value.ok).toBe(true);
    expect(value.cleanup).toBeUndefined(); // Session retained, not fictional failed creation/cleanup.
  }
  expect(f.calls).toHaveLength(0);
});

test("expired/mismatched source and peer epochs or changed identities fail closed without losing remote session identity", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.local.taskTransport.leaseExpiresAt = new Date(0).toISOString(); },
    (f: ReturnType<typeof fixture>) => { f.local.taskTransport.profile = "durable-v2"; },
    (f: ReturnType<typeof fixture>) => { f.resolved.epoch = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.resolved.value.endpoint = { relay: RELAY_ID, id: randomUUID() }; },
  ]) {
    const f = fixture(); mutate(f);
    const result = await qualifyRemoteTaskEndpoint(f.remote, f.options) as any;
    expect(result.taskEndpoint).toBeUndefined(); expect(result.sessionId).toBe(f.remote.sessionId); expect(result.taskEndpointError).toBeDefined();
  }
  const f = fixture(), stale = { ...f.remote, taskEndpoint: { ...f.remote.taskEndpoint, id: randomUUID() } };
  expect((await qualifyRemoteTaskEndpoint(stale, f.options) as any).taskEndpoint).toBeUndefined(); expect(f.calls).toHaveLength(1);
});

test("qualification validates origins before credentials/network and rejects oversized remote metadata", async () => {
  const f = fixture();
  for (const options of [{ ...f.options, origin: "https://untrusted.invalid" }, { ...f.options, localBase: "https://peer.tail123.ts.net" }]) {
    expect((await qualifyRemoteTaskEndpoint(f.remote, options) as any).taskEndpointError).toBeDefined();
  }
  expect(f.calls).toHaveLength(0);
  const result = await qualifyRemoteTaskEndpoint(f.remote, { ...f.options, fetch: Object.assign(async () => new Response("x".repeat(16 * 1024 + 1)), { preconnect: fetch.preconnect }) as typeof fetch }) as any;
  expect(result.taskEndpoint).toBeUndefined(); expect(result.remoteTaskEndpoint).toEqual(f.remote.taskEndpoint);
});
