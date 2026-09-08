import { expect, spyOn, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkerRelayGateway } from "../../src/task-relay/worker-client.ts";
import type { GatewayOptions } from "../../src/task-relay/gateway.ts";
import { AGENT_KIND } from "../../src/agent-kind.ts";

const directory = () => mkdtempSync(join(tmpdir(), "relay-bootstrap-regression-"));
const inspectSession = async (session: string) => ({ ok: true as const, session, sessionId: session, projectPath: "/tmp", harness: AGENT_KIND.PI.id, alive: true });
const registration = { callerSession: "sender", generation: "generation", protocolVersions: [2] };

test("original bootstrap accessor cannot execute in the owner acquisition gap", async () => {
  const root = directory(); let calls = 0;
  let inner: WorkerRelayGateway | undefined, outer: WorkerRelayGateway | undefined, replacement: WorkerRelayGateway | undefined;
  const options = { root, inspectSession };
  Object.defineProperty(options, "peerOrigin", { get() {
    calls++;
    inner = new WorkerRelayGateway({ root, inspectSession });
    return undefined;
  } });
  try {
    expect(() => { outer = new WorkerRelayGateway(options); }).toThrow();
    expect(calls).toBe(0);
    expect(inner).toBeUndefined();
    outer = new WorkerRelayGateway({ root, inspectSession });
    expect(await outer.connect(registration)).toMatchObject({ ok: true });
    expect(() => new WorkerRelayGateway({ root, inspectSession })).toThrow("already has a worker owner");
    await outer.close();
    replacement = new WorkerRelayGateway({ root, inspectSession });
    await outer.close(); // A previous owner's repeated close cannot free a replacement.
    expect(() => new WorkerRelayGateway({ root, inspectSession })).toThrow("already has a worker owner");
    expect(await replacement.connect(registration)).toMatchObject({ ok: true });
  } finally { await inner?.close(); await outer?.close(); await replacement?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("every original option descriptor is checked before any getter, proxy or inherited value is read", async () => {
  const root = directory(); let gateway: WorkerRelayGateway | undefined;
  try {
    for (const key of ["root", "requestTimeoutMs", "now", "peerOrigin", "retryIntervalMs", "retentionMs", "cleanupIntervalMs", "inspectSession", "peerFetch"]) {
      for (const enumerable of [false, true]) {
        let calls = 0;
        const options = { root, inspectSession };
        Object.defineProperty(options, key, { enumerable, get() { calls++; return undefined; } });
        expect(() => new WorkerRelayGateway(options)).toThrow();
        expect(calls).toBe(0);
      }
    }
    let traps = 0;
    const proxy = new Proxy({ root }, { get() { traps++; return root; }, getPrototypeOf() { traps++; return Object.prototype; }, ownKeys() { traps++; return ["root"]; } });
    expect(() => new WorkerRelayGateway(proxy)).toThrow();
    expect(traps).toBe(0);
    for (const options of [Object.create({ root }), Object.assign({ root }, { unknown: 1 }),
      Object.defineProperty({ root }, "peerOrigin", { value: undefined }), { root, [Symbol("hidden")]: 1 },
      { root, inspectSession: new Proxy(inspectSession, {}) }]) {
      expect(() => new WorkerRelayGateway(options as GatewayOptions)).toThrow();
    }
    gateway = new WorkerRelayGateway({ root, inspectSession });
    expect(await gateway.connect(registration)).toMatchObject({ ok: true });
  } finally { await gateway?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("captured plain options retain the selected callback and release the original root", async () => {
  const root = directory(), otherRoot = directory();
  const options = { root, inspectSession };
  let gateway: WorkerRelayGateway | undefined, replacement: WorkerRelayGateway | undefined;
  const other = new WorkerRelayGateway({ root: otherRoot, inspectSession });
  try {
    gateway = new WorkerRelayGateway(options);
    options.root = otherRoot;
    options.inspectSession = async session => ({ ...await inspectSession(session), alive: false });
    expect(await gateway.connect(registration)).toMatchObject({ ok: true });
    // Internal ownership must not use a caller-writable public label for release.
    (gateway as { root: string }).root = otherRoot;
    await gateway.close();
    expect(() => new WorkerRelayGateway({ root: otherRoot, inspectSession })).toThrow("already has a worker owner");
    replacement = new WorkerRelayGateway({ root, inspectSession });
    expect(await replacement.connect(registration)).toMatchObject({ ok: true });
  } finally { await gateway?.close(); await replacement?.close(); await other.close(); rmSync(root, { recursive: true, force: true }); rmSync(otherRoot, { recursive: true, force: true }); }
});

test("partially started worker is terminated and its reservation released on constructor setup failure", async () => {
  const root = directory(); let started: Worker | undefined, gateway: WorkerRelayGateway | undefined;
  let exited = false;
  let exit!: Promise<void>;
  const unref = spyOn(Worker.prototype, "unref").mockImplementationOnce(function(this: Worker) {
    started = this;
    exit = new Promise(resolve => this.once("exit", () => { exited = true; resolve(); }));
    throw new Error("injected worker setup failure");
  });
  try {
    expect(() => { gateway = new WorkerRelayGateway({ root, inspectSession }); }).toThrow("injected worker setup failure");
    unref.mockRestore();
    expect(started).toBeDefined();
    expect(() => new WorkerRelayGateway({ root, inspectSession })).toThrow("already has a worker owner");
    // Observe the gateway's termination, rather than issuing a second competing terminate().
    await exit;
    await new Promise(resolve => setTimeout(resolve, 10));
    gateway = new WorkerRelayGateway({ root, inspectSession });
    expect(await gateway.connect(registration)).toMatchObject({ ok: true });
  } finally { unref.mockRestore(); if (!exited) void started?.terminate(); await gateway?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("asynchronous startup failure permits reuse only after confirmed close", async () => {
  const root = directory(); let gateway = new WorkerRelayGateway({ root, retentionMs: -1 });
  try {
    await expect(gateway.initialize()).rejects.toThrow();
    await gateway.close();
    gateway = new WorkerRelayGateway({ root, inspectSession });
    expect(await gateway.connect(registration)).toMatchObject({ ok: true });
  } finally { await gateway.close(); rmSync(root, { recursive: true, force: true }); }
});
