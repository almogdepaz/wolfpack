import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MemoryRelayStore, MEMORY_RELAY_TIMING, MemoryRelayError } from "../../src/task-relay/memory-store.ts";
import { RelayExpiryIndex } from "../../src/task-relay/expiry-index.ts";
import { RELAY_ID, RELAY_PROTOCOL_VERSION, RELAY_LIMITS } from "../../src/task-relay/domain.ts";
import type { RelayEnvelope } from "../../src/task-relay/domain.ts";

const NOW = Date.parse("2026-09-08T00:00:00Z");
function fixture(options: ConstructorParameters<typeof MemoryRelayStore>[0] = {}) {
  const store = new MemoryRelayStore(options), epoch = store.epoch;
  const registration = (sessionId: string, generation = "g", now = NOW) => store.register({ sessionId, generation, leaseMs: RELAY_LIMITS.MAX_LEASE_MS, protocolVersions: [RELAY_PROTOCOL_VERSION] }, now);
  const source = registration("source").endpoint, target = registration("target").endpoint;
  const envelope = (id: string = randomUUID(), payload: unknown = { text: "opaque" }, now = NOW): RelayEnvelope => ({
    envelopeId: id, protocolVersion: RELAY_PROTOCOL_VERSION, source, target, createdAt: new Date(now).toISOString(), payload,
  });
  return { store, epoch, source, target, envelope, registration };
}
function code(operation: () => unknown, expected: MemoryRelayError["code"]) {
  try { operation(); throw new Error("operation unexpectedly succeeded"); }
  catch (error) { expect(error).toBeInstanceOf(MemoryRelayError); expect((error as MemoryRelayError).code).toBe(expected); }
}

describe("bounded volatile relay engine", () => {
  test("ACK releases payload, preserves exact receipt, and sparse pages use real cursors", () => {
    const f = fixture();
    const first = f.envelope("1"), second = f.envelope("2"), third = f.envelope("3");
    const accepted = f.store.accept(f.epoch, first, NOW);
    f.store.accept(f.epoch, second, NOW); f.store.accept(f.epoch, third, NOW);
    expect(f.store.acknowledge(f.epoch, f.target.id, "2", NOW)).toBe("acknowledged");
    const page = f.store.inbox(f.epoch, f.target.id, "0", NOW);
    expect(page.deliveries.map(x => x.cursor)).toEqual(["1", "3"]);
    expect(page.nextCursor).toBe("3");
    const limited = f.store.inbox(f.epoch, f.target.id, "0", NOW, 1);
    expect(limited.nextCursor).toBe("1"); expect(limited.hasMore).toBe(true);
    expect(f.store.inbox(f.epoch, f.target.id, limited.nextCursor, NOW).deliveries.map(x => x.cursor)).toEqual(["3"]);
    expect(f.store.acknowledge(f.epoch, f.target.id, "1", NOW)).toBe("acknowledged");
    expect(f.store.acknowledge(f.epoch, f.target.id, "3", NOW)).toBe("acknowledged");
    expect(f.store.stats()).toMatchObject({ activeItems: 0, activeBytes: 0, receipts: 3 });
    expect(f.store.accept(f.epoch, first, NOW)).toEqual({ ...accepted, kind: "duplicate" });
    expect(f.store.acknowledge(f.epoch, f.target.id, "1", NOW)).toBe("duplicate");
    expect(f.store.inbox(f.epoch, f.target.id, "0", NOW)).toEqual({ deliveries: [], nextCursor: "0", hasMore: false });
    f.store.accept(f.epoch, f.envelope("4"), NOW);
    expect(f.store.inbox(f.epoch, f.target.id, "0", NOW).nextCursor).toBe("4");
  });

  test("genuine changed payload/timestamp conflict even after ACK; receipts are not refreshed", () => {
    const f = fixture(), original = f.envelope("stable");
    f.store.accept(f.epoch, original, NOW);
    f.store.acknowledge(f.epoch, f.target.id, "stable", NOW);
    code(() => f.store.accept(f.epoch, { ...original, payload: "changed" }, NOW), "ENVELOPE_CONFLICT");
    code(() => f.store.accept(f.epoch, { ...original, createdAt: new Date(NOW + 1).toISOString() }, NOW), "ENVELOPE_CONFLICT");
    const expiry = NOW + MEMORY_RELAY_TIMING.receiptMs;
    f.registration("source", "g", expiry - 1); f.registration("target", "g", expiry - 1);
    expect(f.store.accept(f.epoch, original, expiry - 1).kind).toBe("duplicate");
    f.store.maintenance(f.epoch, expiry);
    expect(f.store.stats().receipts).toBe(0);
    code(() => f.store.accept(f.epoch, original, expiry), "ENVELOPE_EXPIRED");
  });

  test("payload ownership and prototype-looking keys are detached in both directions", () => {
    const f = fixture();
    const payload = JSON.parse('{"__proto__":{"n":1},"constructor":[2]}');
    const envelope = f.envelope("owned", payload);
    f.store.accept(f.epoch, envelope, NOW);
    payload.__proto__.n = 9;
    const page = f.store.inbox(f.epoch, f.target.id, "0", NOW);
    expect(page.deliveries[0]!.envelope.payload).toEqual(JSON.parse('{"__proto__":{"n":1},"constructor":[2]}'));
    (page.deliveries[0]!.envelope.payload as any).__proto__.n = 100;
    expect((f.store.inbox(f.epoch, f.target.id, "0", NOW).deliveries[0]!.envelope.payload as any).__proto__.n).toBe(1);
  });

  test("rejects accessors/proxies/exotics without executing code or charging state", () => {
    const f = fixture(); let calls = 0;
    const accessor = { ...f.envelope(), get payload() { calls++; return {}; } };
    const proxy = new Proxy(f.envelope(), { ownKeys() { calls++; throw new Error("trap"); } });
    const before = f.store.stats();
    for (const envelope of [accessor, proxy, f.envelope("array-buffer", new ArrayBuffer(1024)), { ...f.envelope(), extra: "ignored?" }, f.envelope("date", new Date())]) {
      code(() => f.store.accept(f.epoch, envelope, NOW), "INVALID_REQUEST");
    }
    expect(calls).toBe(0); expect(f.store.stats()).toEqual(before);
  });

  test("global and endpoint count budgets reject BEFORE acceptance, duplicates need no credits", () => {
    for (const limits of [{ activeItems: 1 }, { mailboxItems: 1 }]) {
      const f = fixture({ limits }), first = f.envelope("first");
      const accepted = f.store.accept(f.epoch, first, NOW), before = f.store.stats();
      code(() => f.store.accept(f.epoch, f.envelope("second"), NOW), "RELAY_CAPACITY");
      expect(f.store.stats()).toEqual(before);
      expect(f.store.accept(f.epoch, first, NOW)).toEqual({ ...accepted, kind: "duplicate" });
      f.store.acknowledge(f.epoch, f.target.id, "first", NOW);
      expect(f.store.accept(f.epoch, f.envelope("second"), NOW).kind).toBe("accepted");
    }
  });

  test("byte, receipt reservation, registration and route bounds cannot be bypassed", () => {
    for (const limits of [{ activeBytes: 1 }, { mailboxBytes: 1 }, { receiptBytes: 1 }]) {
      const f = fixture({ limits }), before = f.store.stats();
      code(() => f.store.accept(f.epoch, f.envelope(), NOW), "RELAY_CAPACITY");
      expect(f.store.stats()).toEqual(before);
    }
    const f = fixture({ limits: { receipts: 1, registrations: 2, routes: 1 } });
    f.store.accept(f.epoch, f.envelope("first"), NOW);
    f.store.acknowledge(f.epoch, f.target.id, "first", NOW);
    code(() => f.store.accept(f.epoch, f.envelope("second"), NOW), "RELAY_CAPACITY");
    code(() => f.registration("third"), "RELAY_CAPACITY");
    const route = f.store.peerRoute(f.epoch, "https://one.example.ts.net");
    expect(f.store.peerRoute(f.epoch, route.origin)).toEqual(route);
    code(() => f.store.peerRoute(f.epoch, "https://two.example.ts.net"), "RELAY_CAPACITY");
    code(() => f.store.peerRoute(f.epoch, "https://untrusted.example.com"), "INVALID_REQUEST");
    const tiny = new MemoryRelayStore({ limits: { metadataBytes: 1 } });
    code(() => tiny.register({ sessionId: "s", generation: "g", leaseMs: 10, protocolVersions: [2] }, NOW), "RELAY_CAPACITY");
    expect(tiny.stats().registrations).toBe(0);
  });

  test("leases are strict; same-generation renewal keeps mail but replacement explicitly loses it", () => {
    const f = fixture();
    f.store.accept(f.epoch, f.envelope("pending"), NOW);
    f.store.maintenance(f.epoch, NOW + 10_000_000);
    expect(f.store.stats()).toMatchObject({ activeItems: 1, registrations: 2 });
    code(() => f.store.inbox(f.epoch, f.target.id, "0", NOW + RELAY_LIMITS.MAX_LEASE_MS), "REGISTRATION_EXPIRED");
    expect(f.registration("target", "g", NOW + 10_000_000).endpoint).toEqual(f.target);
    const replacement = f.registration("target", "new", NOW + 10_000_000).endpoint;
    expect(replacement.id).not.toBe(f.target.id);
    code(() => f.store.acknowledge(f.epoch, f.target.id, "pending", NOW + 10_000_000), "REGISTRATION_EXPIRED");
    expect(f.store.acknowledge(f.epoch, replacement.id, "pending", NOW + 10_000_000)).toBe("missing");
    expect(f.store.stats()).toMatchObject({ activeItems: 0, activeBytes: 0, receipts: 0, receiptBytes: 0, registrations: 2, expiryEntries: 2 });
  });

  test("repeated generation replacement reclaims mailbox, receipt, registration and expiry credits", () => {
    const f = fixture({ limits: { activeItems: 2, mailboxItems: 2, receipts: 2, registrations: 2 } });
    let target = f.target;
    for (let generation = 0; generation < 32; generation++) {
      for (let item = 0; item < 2; item++) f.store.accept(f.epoch, { ...f.envelope(`${generation}-${item}`), target }, NOW);
      const old = target;
      target = f.registration("target", `new-${generation}`).endpoint;
      code(() => f.store.inbox(f.epoch, old.id, "0", NOW), "REGISTRATION_EXPIRED");
      code(() => f.store.acknowledge(f.epoch, old.id, `${generation}-0`, NOW), "REGISTRATION_EXPIRED");
      expect(f.store.inbox(f.epoch, target.id, "0", NOW).deliveries).toEqual([]);
      expect(f.store.stats()).toMatchObject({ activeItems: 0, activeBytes: 0, receipts: 0, receiptBytes: 0, registrations: 2, sessions: 2, expiryEntries: 2 });
    }
    f.store.maintenance(f.epoch, NOW + RELAY_LIMITS.MAX_LEASE_MS);
    expect(f.store.stats()).toMatchObject({ registrations: 0, sessions: 0, metadataBytes: 0, expiryEntries: 0 });
  });

  test("sender replacement preserves another endpoint's accepted mail without retaining its registration", () => {
    const f = fixture();
    const sent = f.envelope("accepted-before-sender-loss");
    f.store.accept(f.epoch, sent, NOW);
    f.registration("source", "replacement");
    expect(f.store.registration(f.epoch, f.source.id, NOW)).toBeUndefined();
    expect(f.store.stats()).toMatchObject({ activeItems: 1, receipts: 1, registrations: 2 });
    expect(f.store.inbox(f.epoch, f.target.id, "0", NOW).deliveries[0]!.envelope).toEqual(sent);
    expect(f.store.acknowledge(f.epoch, f.target.id, sent.envelopeId, NOW)).toBe("acknowledged");
    f.store.maintenance(f.epoch, NOW + MEMORY_RELAY_TIMING.receiptMs);
    expect(f.store.stats()).toMatchObject({ activeItems: 0, activeBytes: 0, receipts: 0, receiptBytes: 0, registrations: 0, metadataBytes: 0, expiryEntries: 0 });
  });

  test("replacement retires self-mail, incoming mail, completed receipts and forwarding tokens/peer credits", () => {
    const f = fixture({ limits: { peerItems: 1 } });
    const route = f.store.peerRoute(f.epoch, "https://peer.example.ts.net");
    const outbound = { ...f.envelope("forwarding"), target: { relay: route.id, id: randomUUID() } };
    const attempt = f.store.beginForward(f.epoch, outbound, NOW);
    if (attempt.kind !== "attempt") throw new Error("no attempt");
    f.store.accept(f.epoch, { ...f.envelope("self"), target: f.source }, NOW);
    f.store.accept(f.epoch, { ...f.envelope("incoming"), source: f.target, target: f.source }, NOW);
    f.store.accept(f.epoch, f.envelope("completed"), NOW);
    f.store.acknowledge(f.epoch, f.target.id, "completed", NOW);
    const source = f.registration("source", "new").endpoint;
    expect(f.store.stats()).toMatchObject({ activeItems: 0, activeBytes: 0, receipts: 0, receiptBytes: 0, registrations: 2, expiryEntries: 2, routes: 1 });
    expect(f.store.finishForward(f.epoch, outbound.envelopeId, attempt.token, { kind: "confirmed", acceptanceId: randomUUID() }, NOW)).toBe(false);
    expect(f.store.forwardStatus(f.epoch, outbound.envelopeId, NOW)).toBeUndefined();
    expect(f.store.beginForward(f.epoch, { ...outbound, envelopeId: "new-forwarding", source }, NOW).kind).toBe("attempt");
  });

  test("failed replacement preflight preserves the old binding and accepted obligations atomically", () => {
    const f = fixture({ limits: { metadataBytes: fixture().store.stats().metadataBytes } });
    f.store.accept(f.epoch, f.envelope("owned"), NOW);
    const before = f.store.stats();
    code(() => f.registration("target", "x".repeat(512)), "RELAY_CAPACITY");
    expect(f.store.stats()).toEqual(before);
    expect(f.store.registrationForSession(f.epoch, "target", NOW)!.endpoint).toEqual(f.target);
    expect(f.store.inbox(f.epoch, f.target.id, "0", NOW).deliveries.map(item => item.envelope.envelopeId)).toEqual(["owned"]);
  });

  test("renewals update one expiry node and preserve owned registration values", () => {
    const f = fixture();
    for (let i = 0; i < 10_000; i++) f.registration("source", "g", NOW + i);
    expect(f.store.stats()).toMatchObject({ registrations: 2, expiryEntries: 2 });
    const registered = f.store.registrationForSession(f.epoch, "source", NOW)!;
    (registered.protocolVersions as number[]).push(99);
    expect(f.store.registration(f.epoch, f.source.id, NOW)!.protocolVersions).toEqual([2]);
    expect(f.store.maintenance(f.epoch, NOW + 1_000_000)).toBe(2);
    expect(f.store.stats()).toMatchObject({ registrations: 0, sessions: 0, metadataBytes: 0, expiryEntries: 0 });
  });

  test("new instances lose everything and reject old epochs, not silently reset cursors", () => {
    const f = fixture(); f.store.accept(f.epoch, f.envelope(), NOW);
    const restarted = new MemoryRelayStore();
    expect(restarted.epoch).not.toBe(f.epoch);
    expect(restarted.stats().activeItems).toBe(0);
    code(() => restarted.inbox(f.epoch, f.target.id, "0", NOW), "RELAY_RESET");
    for (const cursor of ["-1", "01", "1.1", "9007199254740993", "9".repeat(33)]) {
      code(() => f.store.inbox(f.epoch, f.target.id, cursor, NOW), "INVALID_CURSOR");
    }
  });

  test("page byte budget includes explicit cursor framing and never skips a truncated suffix", () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) f.store.accept(f.epoch, f.envelope(String(i), "x".repeat(47 * 1024)), NOW);
    const first = f.store.inbox(f.epoch, f.target.id, "0", NOW);
    expect(first.deliveries.length).toBe(5); expect(first.hasMore).toBe(true); expect(first.nextCursor).toBe("5");
    expect(first.deliveries.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0)).toBeLessThanOrEqual(RELAY_LIMITS.INBOX_PAGE_BYTES);
    expect(f.store.inbox(f.epoch, f.target.id, first.nextCursor, NOW).deliveries.map(x => x.cursor)).toEqual(["6", "7", "8"]);
  });

  test("forwarding does not accept pending work; one token owns an attempt and confirmation releases bytes", () => {
    const f = fixture(); const route = f.store.peerRoute(f.epoch, "https://peer.example.ts.net");
    const envelope = { ...f.envelope("forward"), target: { relay: route.id, id: randomUUID() } };
    const first = f.store.beginForward(f.epoch, envelope, NOW);
    expect(first.kind).toBe("attempt"); if (first.kind !== "attempt") throw new Error("no attempt");
    expect(f.store.beginForward(f.epoch, envelope, NOW)).toMatchObject({ kind: "pending" });
    expect(f.store.finishForward(f.epoch, envelope.envelopeId, "wrong", { kind: "confirmed", acceptanceId: randomUUID() }, NOW)).toBe(false);
    const acceptanceId = randomUUID();
    expect(f.store.finishForward(f.epoch, envelope.envelopeId, first.token, { kind: "confirmed", acceptanceId }, NOW)).toBe(true);
    expect(f.store.finishForward(f.epoch, envelope.envelopeId, first.token, { kind: "retryable" }, NOW)).toBe(false);
    expect(f.store.beginForward(f.epoch, envelope, NOW)).toEqual({ kind: "forwarded", acceptanceId });
    expect(f.store.stats()).toMatchObject({ activeItems: 0, activeBytes: 0, receipts: 1 });
  });

  test("four failures exhaust visibly, cooldown calls do not spend attempts and duplicates never rearm", () => {
    const f = fixture(); const route = f.store.peerRoute(f.epoch, "https://peer.example.ts.net");
    const envelope = { ...f.envelope("exhaust"), target: { relay: route.id, id: randomUUID() } };
    for (let i = 0; i < 4; i++) {
      const at = NOW + i * 1000;
      const attempt = f.store.beginForward(f.epoch, envelope, at);
      if (attempt.kind !== "attempt") throw new Error(`no attempt ${i}`);
      f.store.finishForward(f.epoch, envelope.envelopeId, attempt.token, { kind: "retryable" }, at);
      expect(f.store.beginForward(f.epoch, envelope, at + 1).kind).toBe(i < 3 ? "pending" : "unconfirmed");
    }
    expect(f.store.beginForward(f.epoch, envelope, NOW + 60_000)).toEqual({ kind: "unconfirmed", mayHaveBeenDelivered: true });
    expect(f.store.stats()).toMatchObject({ activeItems: 0, activeBytes: 0, receipts: 1 });
    code(() => f.store.beginForward(f.epoch, { ...envelope, payload: "new" }, NOW + 60_000), "ENVELOPE_CONFLICT");
  });

  test("deadline expires idle forwarding but cannot invalidate a still-owned network completion", () => {
    const f = fixture(); const route = f.store.peerRoute(f.epoch, "https://peer.example.ts.net");
    const envelope = { ...f.envelope("deadline"), target: { relay: route.id, id: randomUUID() } };
    const attempt = f.store.beginForward(f.epoch, envelope, NOW);
    if (attempt.kind !== "attempt") throw new Error("no attempt");
    f.store.maintenance(f.epoch, NOW + MEMORY_RELAY_TIMING.deadlineMs);
    expect(f.store.stats().activeItems).toBe(1);
    const confirmedAt = NOW + MEMORY_RELAY_TIMING.deadlineMs + 1;
    const acceptanceId = randomUUID();
    f.store.finishForward(f.epoch, envelope.envelopeId, attempt.token, { kind: "confirmed", acceptanceId }, confirmedAt);
    expect(f.store.beginForward(f.epoch, envelope, confirmedAt)).toEqual({ kind: "forwarded", acceptanceId });
    expect(f.store.stats().activeItems).toBe(0);

    const idle = fixture(); const idleRoute = idle.store.peerRoute(idle.epoch, "https://peer.example.ts.net");
    const queued = { ...idle.envelope("idle"), target: { relay: idleRoute.id, id: randomUUID() } };
    const started = idle.store.beginForward(idle.epoch, queued, NOW);
    if (started.kind !== "attempt") throw new Error("no idle attempt");
    idle.store.finishForward(idle.epoch, queued.envelopeId, started.token, { kind: "retryable" }, NOW + 1);
    idle.store.maintenance(idle.epoch, NOW + MEMORY_RELAY_TIMING.deadlineMs);
    expect(idle.store.stats().activeItems).toBe(0);
    expect(idle.store.beginForward(idle.epoch, queued, NOW + MEMORY_RELAY_TIMING.deadlineMs)).toMatchObject({ kind: "unconfirmed" });
  });

  test("per-peer credit recovers after terminal outcome; no credit is granted by a forged completion", () => {
    for (const limits of [{ peerItems: 1 }, { peerBytes: 1 }]) {
      const f = fixture({ limits }); const route = f.store.peerRoute(f.epoch, "https://peer.example.ts.net");
      const envelope = { ...f.envelope("a"), target: { relay: route.id, id: randomUUID() } };
      if ("peerBytes" in limits) {
        const before = f.store.stats(); code(() => f.store.beginForward(f.epoch, envelope, NOW), "RELAY_CAPACITY"); expect(f.store.stats()).toEqual(before);
        continue;
      }
      const attempt = f.store.beginForward(f.epoch, envelope, NOW);
      if (attempt.kind !== "attempt") throw new Error("no attempt");
      code(() => f.store.beginForward(f.epoch, { ...envelope, envelopeId: "b" }, NOW), "RELAY_CAPACITY");
      f.store.finishForward(f.epoch, "a", attempt.token, { kind: "rejected" }, NOW);
      expect(f.store.beginForward(f.epoch, { ...envelope, envelopeId: "b" }, NOW).kind).toBe("attempt");
    }
  });

  test("two engine instances deduplicate a lost peer response before source acceptance", () => {
    const a = fixture(), b = fixture();
    const routeB = a.store.peerRoute(a.epoch, "https://b.example.ts.net");
    const routeA = b.store.peerRoute(b.epoch, "https://a.example.ts.net");
    const outgoing = { ...a.envelope("lost-peer-response"), target: { relay: routeB.id, id: b.target.id } };
    const deliver = (attempt: ReturnType<MemoryRelayStore["beginForward"]>) => {
      if (attempt.kind !== "attempt") throw new Error("no attempt");
      // Same normalization as the trusted peer gateway: source is scoped to the
      // receiving relay's origin alias, target becomes its local endpoint.
      return b.store.accept(b.epoch, { ...attempt.envelope,
        source: { relay: routeA.id, id: attempt.envelope.source.id }, target: b.target }, NOW);
    };
    const first = a.store.beginForward(a.epoch, outgoing, NOW);
    if (first.kind !== "attempt") throw new Error("no first attempt");
    const accepted = deliver(first);
    a.store.finishForward(a.epoch, outgoing.envelopeId, first.token, { kind: "retryable" }, NOW); // response lost
    expect(a.store.beginForward(a.epoch, outgoing, NOW).kind).toBe("pending");
    const second = a.store.beginForward(a.epoch, outgoing, NOW + 1000);
    if (second.kind !== "attempt") throw new Error("no retry");
    const duplicate = deliver(second);
    expect(duplicate).toEqual({ ...accepted, kind: "duplicate" });
    a.store.finishForward(a.epoch, outgoing.envelopeId, second.token, { kind: "confirmed", acceptanceId: duplicate.acceptanceId }, NOW + 1000);
    expect(a.store.beginForward(a.epoch, outgoing, NOW + 1000)).toEqual({ kind: "forwarded", acceptanceId: accepted.acceptanceId });
    expect(b.store.inbox(b.epoch, b.target.id, "0", NOW).deliveries.length).toBe(1);
    b.store.acknowledge(b.epoch, b.target.id, outgoing.envelopeId, NOW);
    expect(a.store.stats().activeBytes).toBe(0); expect(b.store.stats().activeBytes).toBe(0);
  });

  test("completed payload volume is absent from active state while compact receipts remain bounded", () => {
    const f = fixture();
    for (let i = 0; i < 5000; i++) {
      const id = String(i);
      f.store.accept(f.epoch, f.envelope(id, "x".repeat(1024)), NOW);
      f.store.acknowledge(f.epoch, f.target.id, id, NOW);
    }
    expect(f.store.stats()).toMatchObject({ activeItems: 0, activeBytes: 0, receipts: 5000, expiryEntries: 5000 });
    expect(f.store.inbox(f.epoch, f.target.id, "0", NOW).deliveries).toEqual([]);
    f.store.accept(f.epoch, f.envelope("live"), NOW);
    expect(f.store.inbox(f.epoch, f.target.id, "0", NOW).deliveries.map(x => x.cursor)).toEqual(["5001"]);
    expect(f.store.stats().activeBytes).toBeLessThan(1024);
    expect(f.store.maintenance(f.epoch, NOW + MEMORY_RELAY_TIMING.receiptMs, 64)).toBe(64);
    expect(f.store.stats()).toMatchObject({ receipts: 4937, activeItems: 1 });
  });

  test("investigation failure never rolls back accepted state or retains completed payload", () => {
    const f = fixture({ investigation: { offer() { throw new Error("ENOSPC"); } } });
    f.store.accept(f.epoch, f.envelope("log-failure"), NOW);
    f.store.acknowledge(f.epoch, f.target.id, "log-failure", NOW);
    expect(f.store.stats()).toMatchObject({ activeItems: 0, activeBytes: 0, receipts: 1, logDrops: 4 });
  });
});

describe("indexed expiry heap", () => {
  test("updates, deletes and pops agree with a map oracle without stale nodes", () => {
    const heap = new RelayExpiryIndex(), oracle = new Map<string, number>();
    let seed = 123;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let i = 0; i < 10_000; i++) {
      const key = String(random() % 64), at = random() % 1000;
      if (i % 3) { heap.set(key, at); oracle.set(key, at); }
      else { expect(heap.delete(key)).toBe(oracle.delete(key)); }
      expect(heap.size).toBe(oracle.size);
    }
    while (oracle.size) {
      const minimum = Math.min(...oracle.values());
      expect(heap.takeDue(minimum - 1)).toBeUndefined();
      const key = heap.takeDue(minimum)!;
      expect(oracle.get(key)).toBe(minimum); oracle.delete(key);
      expect(heap.size).toBe(oracle.size);
    }
    expect(heap.takeDue(Infinity)).toBeUndefined();
  });
});
