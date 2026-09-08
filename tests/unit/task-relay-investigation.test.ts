import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedRelayInvestigation, RotatingRelayInvestigationWriter } from "../../src/task-relay/investigation.ts";
import type { RelayInvestigationEvent } from "../../src/task-relay/investigation.ts";
import { MemoryRelayStore } from "../../src/task-relay/memory-store.ts";

const event = (envelopeId = "record"): RelayInvestigationEvent => ({ epoch: randomUUID(), at: Date.now(), kind: "acknowledged", envelopeId });
const root = () => mkdtempSync(join(tmpdir(), "wolfpack-relay-investigation-"));
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe("bounded best-effort relay investigation", () => {
  test("queue cap includes blocked in-flight write, then releases exact credits", async () => {
    const blocked = gate(), entered = gate(); const lines: string[] = [];
    const logger = new BoundedRelayInvestigation({ async append(line) { entered.resolve(); await blocked.promise; lines.push(line); } }, { items: 1 });
    try {
      const input = event("first");
      expect(logger.offer(input)).toBe(true);
      await entered.promise;
      const charged = logger.health().queuedBytes;
      expect(charged).toBeGreaterThan(0);
      expect(logger.offer(event("overflow"))).toBe(false);
      expect(logger.health()).toMatchObject({ queuedItems: 1, queuedBytes: charged, droppedRecords: 1, degraded: true });
      (input as { envelopeId: string }).envelopeId = "caller-mutation";
      blocked.resolve(); await logger.drain();
      expect(JSON.parse(lines[0]!).envelopeId).toBe("first");
      expect(logger.health()).toMatchObject({ queuedItems: 0, queuedBytes: 0, written: 1 });
      expect(logger.offer(event("after-release"))).toBe(true);
      await logger.close();
      expect(logger.offer(event("closed"))).toBe(false);
      expect(logger.health()).toMatchObject({ written: 2, droppedRecords: 2, lastFailure: "closed", closed: true });
    } finally { blocked.resolve(); await logger.close(); }
  });

  test("byte cap, exotics and getters fail without calling code or filling the queue", async () => {
    const logger = new BoundedRelayInvestigation({ async append() { throw new Error("must not write"); } }, { bytes: 1 });
    let calls = 0;
    expect(logger.offer({ ...event(), get envelopeId() { calls++; return "getter"; } })).toBe(false);
    expect(logger.offer({ ...event(), envelope: new ArrayBuffer(1024) } as any)).toBe(false);
    expect(logger.offer(new Proxy(event(), { ownKeys() { calls++; return []; } }))).toBe(false);
    expect(logger.offer(event())).toBe(false);
    expect(calls).toBe(0);
    expect(logger.health()).toMatchObject({ queuedBytes: 0, queuedItems: 0, invalidRecords: 3, droppedRecords: 4 });
    await logger.close();
  });

  test("write failure is counted and sanitized, later writes recover without replaying failed records", async () => {
    let attempts = 0;
    const logger = new BoundedRelayInvestigation({ async append() { if (++attempts === 1) throw new Error("secret disk error details"); } });
    expect(logger.offer(event("failed"))).toBe(true);
    expect(logger.offer(event("written"))).toBe(true);
    await logger.close();
    expect(logger.health()).toMatchObject({ queuedItems: 0, queuedBytes: 0, written: 1, writeFailures: 1, droppedRecords: 1, lastFailure: "write_failed" });
    expect(JSON.stringify(logger.health())).not.toContain("secret");
    expect(attempts).toBe(2);
  });

  test("offers in the pump completion microtask cannot be stranded", async () => {
    // Exercise both sides of each completion/assimilation microtask, without timers.
    for (let gap = 0; gap < 16; gap++) {
      const lines: string[] = [];
      const logger = new BoundedRelayInvestigation({ async append(line) { lines.push(line); } });
      logger.offer(event("first"));
      for (let i = 0; i < gap; i++) await Promise.resolve();
      logger.offer(event("second"));
      await logger.close();
      expect(lines.length).toBe(2);
      expect(logger.health()).toMatchObject({ queuedItems: 0, queuedBytes: 0, written: 2 });
    }
  });

  test("store ACK frees active payload while an independent, bounded log queue still owns its copy", async () => {
    const blocked = gate();
    const logger = new BoundedRelayInvestigation({ async append() { await blocked.promise; } });
    const store = new MemoryRelayStore({ investigation: logger });
    const now = Date.now();
    const connect = (sessionId: string) => store.register({ sessionId, generation: "g", leaseMs: 60_000, protocolVersions: [2] }, now).endpoint;
    try {
      const source = connect("source"), target = connect("target");
      store.accept(store.epoch, { envelopeId: "payload", protocolVersion: 2, source, target, createdAt: new Date(now).toISOString(), payload: "x".repeat(40_000) }, now);
      store.acknowledge(store.epoch, target.id, "payload", now);
      expect(store.stats()).toMatchObject({ activeItems: 0, activeBytes: 0, receipts: 1 });
      expect(logger.health().queuedBytes).toBeGreaterThan(40_000);
      blocked.resolve(); await logger.close();
      expect(logger.health()).toMatchObject({ queuedBytes: 0, queuedItems: 0, written: 4 });
    } finally { blocked.resolve(); await logger.close(); }
  });
});

describe("private fixed-slot investigation rotation", () => {
  test("rotation bounds disk without touching legacy files; files and directory remain private", async () => {
    const home = root(), logs = join(home, "investigation-volatile-v1");
    const legacy = join(home, "relay-state.json");
    writeFileSync(legacy, "legacy investigation, not recovery");
    let now = Date.now();
    const writer = new RotatingRelayInvestigationWriter(logs, { slots: 2, segmentBytes: 100, clock: () => now++ });
    try {
      for (let i = 0; i < 10; i++) {
        await writer.append(JSON.stringify({ i, body: "x".repeat(50) }) + "\n");
        const files = readdirSync(logs);
        expect(files.length).toBeLessThanOrEqual(2);
        expect(files.reduce((sum, name) => sum + lstatSync(join(logs, name)).size, 0)).toBeLessThanOrEqual(200);
        for (const name of files) expect(lstatSync(join(logs, name)).mode & 0o077).toBe(0);
      }
      expect(lstatSync(logs).mode & 0o077).toBe(0);
      expect(readFileSync(legacy, "utf8")).toBe("legacy investigation, not recovery");
      const content = readdirSync(logs).flatMap(name => readFileSync(join(logs, name), "utf8").trim().split("\n").map(line => JSON.parse(line).i)).sort((a, b) => a - b);
      expect(content).toEqual([8, 9]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("retention is from creation, not refreshed by continuous writes", async () => {
    const home = root(), logs = join(home, "logs"); let now = Date.now();
    const start = now;
    const writer = new RotatingRelayInvestigationWriter(logs, { slots: 2, segmentBytes: 1000, retentionMs: 100, clock: () => now });
    try {
      await writer.append('{"old":true}\n');
      now = start + 99; await writer.append('{"recent":true}\n');
      now = start + 100; await writer.append('{"new":true}\n');
      expect(readdirSync(logs).map(name => readFileSync(join(logs, name), "utf8"))).toEqual(['{"new":true}\n']);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("idle cleanup coalesces through the bounded queue and removes expired output without another delivery", async () => {
    const home = root(), logs = join(home, "logs"); let now = Date.now();
    const writer = new RotatingRelayInvestigationWriter(logs, { retentionMs: 100, clock: () => now });
    const logger = new BoundedRelayInvestigation(writer);
    try {
      logger.offer(event()); await logger.drain();
      expect(readdirSync(logs).length).toBe(1);
      now += 100;
      expect(logger.requestCleanup()).toBe(true);
      expect(logger.requestCleanup()).toBe(false);
      await logger.close();
      expect(readdirSync(logs)).toEqual([]);
      expect(logger.health()).toMatchObject({ written: 1, queuedItems: 0, maintenanceFailures: 0, droppedRecords: 0 });
    } finally { await logger.close(); rmSync(home, { recursive: true, force: true }); }
  });

  test("a restarted writer starts another slot, never replays or appends into partial historical JSON", async () => {
    const home = root(), logs = join(home, "logs");
    const options = { slots: 2, segmentBytes: 1000 };
    try {
      await new RotatingRelayInvestigationWriter(logs, options).append('{"partial":');
      await new RotatingRelayInvestigationWriter(logs, options).append('{"next":true}\n');
      const contents = readdirSync(logs).map(name => readFileSync(join(logs, name), "utf8"));
      expect(contents).toContain('{"partial":'); expect(contents).toContain('{"next":true}\n');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("symlinks, hardlinks and world-readable outputs fail closed in logging, not in relay delivery", async () => {
    const home = root(), logs = join(home, "logs"), outside = join(home, "outside");
    mkdirSync(logs, { mode: 0o700 }); writeFileSync(outside, "untouched", { mode: 0o600 });
    const slot = join(logs, "relay-investigation-00.jsonl");
    symlinkSync(outside, slot);
    try {
      const writer = new RotatingRelayInvestigationWriter(logs, { slots: 1 });
      await expect(writer.append("{}\n")).rejects.toThrow();
      expect(readFileSync(outside, "utf8")).toBe("untouched");
      rmSync(slot); linkSync(outside, slot);
      await expect(writer.append("{}\n")).rejects.toThrow();
      expect(readFileSync(outside, "utf8")).toBe("untouched");
      rmSync(slot); writeFileSync(slot, "private", { mode: 0o600 }); chmodSync(slot, 0o644);
      await expect(writer.append("{}\n")).rejects.toThrow();
      expect(readFileSync(slot, "utf8")).toBe("private");
      chmodSync(slot, 0o600); chmodSync(logs, 0o755);
      await expect(writer.append("{}\n")).rejects.toThrow();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
