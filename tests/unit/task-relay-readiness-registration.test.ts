import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { waitForTaskWorkerReadiness } from "../../src/server/task-worker-readiness.ts";
import { VolatileRelayGateway } from "../../src/task-relay/volatile-gateway.ts";
import { RELAY_ID } from "../../src/task-relay/domain.ts";
import type { TaskRelayRegistration } from "../../src/task-relay/registration.ts";

function fixture() {
  let alive = true;
  const killed: string[] = [];
  const registration: TaskRelayRegistration = { profile: "volatile-v1", epoch: randomUUID(), endpoint: { relay: RELAY_ID, id: randomUUID() }, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
  const input = {
    backend: {
      inspectSession: async () => ({ ok: true as const, session: "worker", sessionId: "exact-id", projectPath: "/fixture", harness: "pi", alive }),
      killSessionById: async (id: string) => { killed.push(id); alive = false; },
    },
    sessionId: "exact-id", projectDir: "/fixture", timeoutMs: 100, pollIntervalMs: 0,
    relayProfile: "volatile-v1" as const,
    endpointForSession: async () => { throw new Error("legacy lookup must not be used"); },
  };
  return { input, registration, killed };
}

test("readiness confirms the same profile, epoch and endpoint after exact broker liveness; renewal may extend lease", async () => {
  const f = fixture(); let calls = 0;
  const result = await waitForTaskWorkerReadiness({ ...f.input, registrationForSession: async id => {
    expect(id).toBe("exact-id"); calls++;
    return { ...f.registration, leaseExpiresAt: new Date(Date.now() + 60_000 + calls).toISOString() };
  } });
  expect(result).toEqual(f.registration.endpoint); expect(calls).toBe(2); expect(f.killed).toEqual([]);
});

for (const change of ["epoch", "endpoint", "profile", "expired", "missing"] as const) test(`readiness rejects ${change} after broker confirmation and cleans only the created ID`, async () => {
  const f = fixture(); let calls = 0;
  await expect(waitForTaskWorkerReadiness({ ...f.input, registrationForSession: async () => {
    if (++calls === 1) return f.registration;
    switch (change) {
      case "epoch": return { ...f.registration, epoch: randomUUID() };
      case "endpoint": return { ...f.registration, endpoint: { relay: RELAY_ID, id: randomUUID() } };
      case "profile": return { ...f.registration, profile: "durable-v2" };
      case "expired": return { ...f.registration, leaseExpiresAt: new Date(0).toISOString() };
      case "missing": return undefined;
    }
  } })).rejects.toMatchObject({ code: "TASK_WORKER_NOT_READY", cleanup: "completed" });
  expect(f.killed).toEqual(["exact-id"]);
});

test("profile metadata alone, malformed epochs and expired leases never prove readiness", async () => {
  for (const malformed of [
    { profile: "volatile-v1", epoch: randomUUID() },
    { ...fixture().registration, epoch: "invalid" },
    { ...fixture().registration, leaseExpiresAt: new Date(0).toISOString() },
    { ...fixture().registration, profile: "durable-v2" },
  ]) {
    const f = fixture();
    await expect(waitForTaskWorkerReadiness({ ...f.input, registrationForSession: async () => malformed as TaskRelayRegistration })).rejects.toMatchObject({ code: "TASK_WORKER_NOT_READY", cleanup: "completed" });
    expect(f.killed).toEqual(["exact-id"]);
  }
});

test("memory registration discovery is request-local, lease-bound, epoch-tagged, and exposes no generation", async () => {
  let now = Date.now();
  const gateway = new VolatileRelayGateway({ now: () => now, inspectSession: async selector => ({ ok: true, session: selector, sessionId: "exact-id", projectPath: "/fixture", harness: "pi", alive: true }) });
  try {
    const connected = await gateway.request({ operation: "connect", profile: "volatile-v1", callerSession: "worker", generation: "private-generation", protocolVersions: [2], leaseMs: 1000 });
    if (!connected.ok || connected.value.kind !== "connected") throw new Error("registration failed");
    const first = await gateway.registrationsForSessions(["exact-id", "missing"]);
    expect(first.size).toBe(1);
    expect(first.get("exact-id")).toEqual({ profile: "volatile-v1", epoch: connected.epoch, endpoint: connected.value.endpoint, leaseExpiresAt: connected.value.leaseExpiresAt });
    now += 1000;
    expect((await gateway.registrationsForSessions(["exact-id"])).size).toBe(0);
  } finally { await gateway.close(); }
  await expect(gateway.registrationsForSessions(["exact-id"])).rejects.toBeDefined();
});
