import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RELAY_ID, RELAY_PROTOCOL_VERSION } from "../../src/task-relay/domain.ts";
import type { RelayRegistration } from "../../src/task-relay/domain.ts";
import { TaskRelayStore } from "../../src/task-relay/store.ts";
import { TaskRelayGateway } from "../../src/task-relay/gateway.ts";

const NOW = new Date("2026-08-09T00:00:00.000Z");
function registration(sessionId: string, leaseExpiresAt = new Date(NOW.getTime() + 60_000).toISOString()): RelayRegistration {
  return { sessionId, endpoint: { relay: RELAY_ID, id: randomUUID() }, generation: randomUUID(), protocolVersions: [RELAY_PROTOCOL_VERSION], leaseExpiresAt };
}
function state(registrations: readonly RelayRegistration[]) {
  return { version: 2, registrations, envelopes: [], mailbox: [], mailboxCursors: [], peerRoutes: [], outbox: [] };
}
let root: string;
let store: TaskRelayStore;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "relay-session-batch-"));
  store = new TaskRelayStore(root);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
function seed(registrations: readonly RelayRegistration[]) {
  fs.writeFileSync(store.path, JSON.stringify(state(registrations)));
}

describe("fresh batched relay registration lookup", () => {
  for (const count of [1, 20, 100]) {
    test(`${count} lookups read/validate once and traverse registration timestamps linearly`, async () => {
      const registrations = Array.from({ length: 1_000 }, (_, i) => registration(`session-${i}`));
      seed(registrations);
      const ids = registrations.slice(0, count).map(r => r.sessionId);
      const read = spyOn(fs, "readFileSync");
      const parse = spyOn(Date, "parse");
      const write = spyOn(fs, "writeFileSync");
      try {
        const selected = await store.registrationsForSessions(ids, NOW);
        expect(selected.size).toBe(count);
        expect(read).toHaveBeenCalledTimes(1);
        expect(parse).toHaveBeenCalledTimes(1_000 + count); // Validation + requested lease checks.
        expect(write).toHaveBeenCalledTimes(0);
        for (const r of registrations.slice(0, count)) expect(selected.get(r.sessionId)).toEqual(r);
      } finally {
        read.mockRestore(); parse.mockRestore(); write.mockRestore();
      }
    });
  }

  test("matches scalar first-active selection for duplicates, expiry, missing and opaque keys", async () => {
    const expired = registration("duplicate", NOW.toISOString());
    const active = registration("duplicate");
    const later = registration("duplicate");
    seed([expired, active, later, registration("__proto__"), registration("constructor"), registration("expired", NOW.toISOString())]);
    const ids = ["constructor", "duplicate", "missing", "expired", "__proto__", "duplicate"];
    const selected = await store.registrationsForSessions(ids, NOW);
    expect(selected.get("duplicate")).toEqual(active);
    expect(selected.size).toBe(3);
    for (const id of ids) expect(selected.get(id)).toEqual(await store.registrationForSession(id, NOW));
    expect((await store.registrationsForSessions(ids, new Date(NOW.getTime() + 60_000))).size).toBe(0);
  });

  test("each call sees replacement/deletion and one store instance sees another's writes", async () => {
    const first = registration("s1");
    seed([first]);
    expect((await store.registrationsForSessions(["s1"], NOW)).get("s1")).toEqual(first);
    const replacement = registration("s1");
    fs.writeFileSync(join(root, "replacement"), JSON.stringify(state([replacement])));
    fs.renameSync(join(root, "replacement"), store.path);
    expect((await store.registrationsForSessions(["s1"], NOW)).get("s1")).toEqual(replacement);
    const secondStore = new TaskRelayStore(root);
    const next = registration("s1");
    await secondStore.register(next);
    expect((await store.registrationsForSessions(["s1"], NOW)).get("s1")).toEqual(next);
    fs.unlinkSync(store.path);
    expect((await store.registrationsForSessions(["s1"], NOW)).size).toBe(0);
    seed([first]);
    expect((await store.registrationsForSessions(["s1"], NOW)).get("s1")).toEqual(first);
  });

  test("result and input mutations cannot alter disk or subsequent batches", async () => {
    const original = registration("s1");
    seed([original]);
    const ids = ["s1"];
    const pending = store.registrationsForSessions(ids, NOW);
    ids[0] = "other";
    const selected = await pending;
    Reflect.set(selected.get("s1")!.endpoint, "id", randomUUID());
    (selected as Map<string, RelayRegistration>).clear();
    expect((await store.registrationsForSessions(["s1"], NOW)).get("s1")).toEqual(original);
    expect(JSON.parse(fs.readFileSync(store.path, "utf8"))).toEqual(state([original]));
  });

  test("empty selection does not read/reset even a malformed or legacy store", async () => {
    for (const source of ["{invalid", '{"version":1}']) {
      fs.writeFileSync(store.path, source);
      const read = spyOn(fs, "readFileSync");
      try {
        expect((await store.registrationsForSessions([], NOW)).size).toBe(0);
        expect(read).toHaveBeenCalledTimes(0);
      } finally { read.mockRestore(); }
      expect(fs.readFileSync(store.path, "utf8")).toBe(source);
    }
  });

  test("nonempty legacy lookup preserves durable v1 reset", async () => {
    fs.writeFileSync(store.path, '{"version":1}');
    expect((await store.registrationsForSessions(["s1"], NOW)).size).toBe(0);
    expect(JSON.parse(fs.readFileSync(store.path, "utf8"))).toEqual(state([]));
  });

  test("gateway projects endpoints with one clock sample and no cross-call lease cache", async () => {
    const a = registration("a");
    const b = registration("b");
    seed([a, b]);
    let clockCalls = 0;
    const gateway = new TaskRelayGateway({ root, now: () => new Date(NOW.getTime() + clockCalls++ * 60_000) });
    try {
      const endpoints = await gateway.endpointsForSessions(["b", "a", "missing"]);
      expect(clockCalls).toBe(1);
      expect(endpoints.get("a")).toEqual(a.endpoint);
      expect(endpoints.get("b")).toEqual(b.endpoint);
      expect(endpoints.has("missing")).toBe(false);
      expect((await gateway.endpointsForSessions(["a", "b"])).size).toBe(0);
      expect(clockCalls).toBe(2);
    } finally { gateway.close(); }
  });
});
