import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createTaskRelayGateway, getTaskRelayProfile } from "../../src/task-relay/gateway.ts";
import { RecoveryRelayGateway } from "../../src/task-relay/recovery-gateway.ts";
import { WorkerRelayGateway, hasRelayWorkerOwners } from "../../src/task-relay/worker-client.ts";
import type { RelayGateway } from "../../src/task-relay/worker-protocol.ts";

const names = ["WOLFPACK_TASK_RELAY_PROFILE", "WOLFPACK_TASK_RELAY_STORAGE"] as const;
let saved: (string | undefined)[], root: string, gateway: RelayGateway | undefined;
beforeEach(() => {
  saved = names.map(name => process.env[name]);
  root = mkdtempSync("/tmp/relay-profile-freeze-");
  process.env.WOLFPACK_TASK_RELAY_PROFILE = "volatile-v1";
  delete process.env.WOLFPACK_TASK_RELAY_STORAGE;
  expect(hasRelayWorkerOwners()).toBe(false);
});
afterEach(async () => {
  try { await gateway?.close(); }
  finally {
    gateway = undefined; rmSync(root, { recursive: true, force: true });
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  }
});

test("unsupported startup profile is still rejected when there is no relay owner", () => {
  process.env.WOLFPACK_TASK_RELAY_PROFILE = "unsupported-before-startup";
  expect(() => getTaskRelayProfile()).toThrow("unsupported task relay profile");
  expect(() => createTaskRelayGateway({ root })).toThrow("unsupported task relay profile");
  expect(hasRelayWorkerOwners()).toBe(false);
});

for (const storage of ["memory", "default-sqlite"] as const) test(`live ${storage} owner freezes the wire profile without changing endpoint or epoch`, async () => {
  const sessionId = randomUUID(), generation = randomUUID();
  const options = { root, inspectSession: async (selector: string) => ({ ok: true as const, sessionId: selector,
    session: "fixture", alive: true, projectPath: root, harness: "pi" }) };
  gateway = createTaskRelayGateway(storage === "memory" ? { ...options, storage: "memory" } : options);
  expect(gateway).toBeInstanceOf(storage === "memory" ? WorkerRelayGateway : RecoveryRelayGateway);
  await gateway.initialize();
  const request = { operation: "connect", profile: "volatile-v1", callerSession: sessionId, generation, protocolVersions: [2] };
  const first = await gateway.volatile(request);
  expect(first.ok).toBe(true);
  if (!first.ok || first.value.kind !== "connected") throw new Error("fixture did not register its live owner");
  expect(hasRelayWorkerOwners()).toBe(true);
  process.env.WOLFPACK_TASK_RELAY_PROFILE = "unsupported-after-startup";
  expect(getTaskRelayProfile()).toBe("volatile-v1");
  expect(await gateway.volatileEpoch()).toBe(first.epoch);
  expect(await gateway.volatile({ ...request, epoch: first.epoch })).toMatchObject({
    ok: true, epoch: first.epoch, value: { kind: "connected", endpoint: first.value.endpoint },
  });
});
