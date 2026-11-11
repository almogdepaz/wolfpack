import { expect, test } from "bun:test";
import { MemoryRelayStore } from "../../src/task-relay/memory-store.ts";
import { VolatileRelayGateway } from "../../src/task-relay/volatile-gateway.ts";

test("gateway carries the live-owner retry delay without replacing its endpoint", async () => {
  let clock = Date.now();
  const gateway = new VolatileRelayGateway({ now: () => clock, inspectSession: async () => ({ ok: true,
    session: "session", sessionId: "session-id", projectPath: "/fixture", harness: "pi", alive: true }) });
  const request = { operation: "connect", profile: "volatile-v1", callerSession: "session", generation: "owner", protocolVersions: [2], leaseMs: 60_000 };
  try {
    const first = await gateway.request(request);
    clock += 1000;
    expect(await gateway.request({ ...request, generation: "copy" })).toMatchObject({ ok: false,
      error: { code: "SESSION_ALREADY_REGISTERED", retryable: true, retryAfterMs: 59_000 } });
    expect(await gateway.request(request)).toMatchObject({ ok: true, value: { endpoint: (first as any).value.endpoint } });
  } finally { await gateway.close(); }
});

const now = Date.parse("2026-11-11T00:00:00Z");
const input = { sessionId: "session", generation: "owner", leaseMs: 60_000, protocolVersions: [2] };
for (const recoverable of [false, true]) {
  test(`first live generation owns the session (recoverable=${recoverable})`, () => {
    const store = new MemoryRelayStore({ recoverable });
    const first = store.register(input, now);
    const before = store.stats();
    expect(() => store.register({ ...input, generation: "copy" }, now + 1000)).toThrow("SESSION_ALREADY_REGISTERED");
    try { store.register({ ...input, generation: "copy" }, now + 1000); }
    catch (error) { expect(error).toMatchObject({ code: "SESSION_ALREADY_REGISTERED", retryable: true, retryAfterMs: 59_000 }); }
    expect(store.stats()).toEqual(before);
    expect(store.register(input, now + 2000, "renew").endpoint).toEqual(first.endpoint);
    expect(() => store.register({ ...input, generation: "copy" }, now + 60_000)).toThrow("SESSION_ALREADY_REGISTERED");
    expect(store.register({ ...input, generation: "copy" }, now + 62_000).endpoint).not.toEqual(first.endpoint);
  });
  test(`disconnect permits a fresh owner (recoverable=${recoverable})`, () => {
    const store = new MemoryRelayStore({ recoverable });
    const first = store.register(input, now);
    expect(store.disconnect(store.epoch, input.sessionId, first.endpoint.id, now + 1)).toBe(true);
    expect(store.register({ ...input, generation: "next" }, now + 1).endpoint).not.toEqual(first.endpoint);
  });
}
