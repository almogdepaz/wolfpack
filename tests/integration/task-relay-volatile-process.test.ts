import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { MEMORY_RELAY_PROFILE as profile } from "../../src/task-relay/memory-store.ts";
import { VOLATILE_RELAY_PATH } from "../../src/task-relay/volatile-protocol.ts";
import type { VolatileBinding, VolatileResult, VolatileValue } from "../../src/task-relay/volatile-protocol.ts";

function take<K extends VolatileValue["kind"]>(result: VolatileResult, kind: K): Extract<VolatileValue, { kind: K }> {
  expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.code);
  expect(result.value.kind).toBe(kind); return result.value as Extract<VolatileValue, { kind: K }>;
}
const post = async (origin: string, body: unknown, path = VOLATILE_RELAY_PATH): Promise<VolatileResult> => {
  const response = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  return await response.json() as VolatileResult;
};

test("two isolated relay processes: worker/HTTP delivery, loss, sparse ACKs, epoch reset and preserved legacy files", async () => {
  const root = mkdtempSync(join(tmpdir(), "volatile-relay-processes-"));
  const children: { process: ReturnType<typeof Bun.spawn>; stdout: Promise<string>; stderr: Promise<string>; stopped: boolean }[] = [];
  const legacy = "historical ledger intentionally malformed; never replay or delete";
  const boot = async (name: string, loseReply = false) => {
    const directory = join(root, name); mkdirSync(directory, { recursive: true });
    const ledger = join(directory, "relay-state.json");
    if (!existsSync(ledger)) writeFileSync(ledger, legacy, { mode: 0o600 });
    const ready = join(directory, "ready.json"); rmSync(ready, { force: true });
    const process = Bun.spawn([globalThis.process.execPath, join(import.meta.dir, "fixtures/volatile-relay-process.ts"), directory, `https://${name}.tail123.ts.net`], {
      cwd: directory, env: { HOME: directory, PATH: globalThis.process.env.PATH ?? "/usr/bin:/bin", WOLFPACK_TEST: "1", LOSE_ACCEPTED_REPLY: loseReply ? "1" : "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const child = { process, stdout: new Response(process.stdout).text(), stderr: new Response(process.stderr).text(), stopped: false };
    children.push(child);
    const deadline = Date.now() + 15_000;
    while (!existsSync(ready) && Date.now() < deadline && process.exitCode === null) await Bun.sleep(20);
    if (!existsSync(ready)) throw new Error(`fixture failed to start (${process.exitCode ?? "deadline"})`);
    const port = (JSON.parse(readFileSync(ready, "utf8")) as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    const connect = async (callerSession: string): Promise<VolatileBinding> => {
      const reply = await post(origin, { operation: "connect", profile, callerSession, generation: "generation", protocolVersions: [2] });
      const connected = take(reply, "connected");
      if (!reply.ok) throw new Error("connect failed");
      return { profile, epoch: reply.epoch, callerSession, endpoint: connected.endpoint };
    };
    return { origin, connect, directory, child };
  };
  const stop = async (child: typeof children[number]) => {
    if (child.stopped) return;
    child.process.kill("SIGTERM");
    const timer = setTimeout(() => child.process.kill("SIGKILL"), 2000);
    try { await child.process.exited; await Promise.all([child.stdout, child.stderr]); child.stopped = true; }
    finally { clearTimeout(timer); }
  };
  try {
    const a = await boot("a"), b = await boot("b", true);
    await post(a.origin, { canonical: "https://b.tail123.ts.net", loopback: b.origin }, "/fixture/peer");
    const source = await a.connect("source"), destination = await b.connect("destination");
    expect(await post(a.origin, { callerSession: "old-client", generation: "old", protocolVersions: [2] }, "/fixture/legacy") as unknown)
      .toEqual({ available: false });
    expect(await post(a.origin, { operation: "connect", callerSession: "old-client", generation: "old", protocolVersions: [2] }))
      .toMatchObject({ ok: false, error: { code: "RELAY_PROFILE_REQUIRED" } });
    const target = take(await post(a.origin, { ...source, operation: "resolvePeer", origin: "https://b.tail123.ts.net", peerEpoch: destination.epoch, target: destination.endpoint }, "/fixture/topology"), "resolved").endpoint;
    const envelopes = [1, 2, 3].map(n => ({ envelopeId: randomUUID(), protocolVersion: 2, source: source.endpoint, target,
      createdAt: new Date().toISOString(), payload: { opaque: `message-${n}` } }));
    expect(await post(a.origin, { ...source, operation: "send", envelope: envelopes[0] })).toMatchObject({ ok: false, error: { code: "PEER_UNREACHABLE", retryable: true } });
    expect(take(await post(b.origin, { ...destination, operation: "health" }), "health").store.activeItems).toBe(1);
    await Bun.sleep(1050); // Actual retry cooldown; no fake process clocks.
    const accepted = take(await post(a.origin, { ...source, operation: "send", envelope: envelopes[0] }), "accepted");
    expect(accepted.duplicate).toBe(true);
    expect(take(await post(a.origin, { ...source, operation: "send", envelope: envelopes[0] }), "accepted").acceptanceId).toBe(accepted.acceptanceId);
    for (const envelope of envelopes.slice(1)) take(await post(a.origin, { ...source, operation: "send", envelope }), "accepted");
    expect(await post(a.origin, { ...source, operation: "send", envelope: { ...envelopes[0], payload: "changed" } })).toMatchObject({ ok: false, error: { code: "ENVELOPE_CONFLICT" } });
    take(await post(b.origin, { ...destination, operation: "acknowledge", envelopeId: envelopes[1]!.envelopeId }), "acknowledged");
    const page = take(await post(b.origin, { ...destination, operation: "receive", cursor: "0" }), "page");
    expect(page.deliveries.map(d => d.cursor)).toEqual(["1", "3"]); expect(page.nextCursor).toBe("3");
    expect(take(await post(a.origin, { ...source, operation: "health" }), "health").store.activeItems).toBe(0);
    for (const index of [0, 2]) take(await post(b.origin, { ...destination, operation: "acknowledge", envelopeId: envelopes[index]!.envelopeId }), "acknowledged");
    expect(take(await post(b.origin, { ...destination, operation: "health" }), "health").store.activeItems).toBe(0);
    await stop(b.child);
    const restarted = await boot("b");
    expect(await post(restarted.origin, { ...destination, operation: "receive", cursor: "3" })).toMatchObject({ ok: false, error: { code: "RELAY_RESET", retryable: false } });
    const rebound = await restarted.connect("destination");
    expect(rebound.epoch).not.toBe(destination.epoch); expect(rebound.endpoint).not.toEqual(destination.endpoint);
    expect(take(await post(restarted.origin, { ...rebound, operation: "receive", cursor: "0" }), "page").deliveries).toEqual([]);
    expect(readFileSync(join(a.directory, "relay-state.json"), "utf8")).toBe(legacy);
    expect(readFileSync(join(b.directory, "relay-state.json"), "utf8")).toBe(legacy);
  } finally {
    await Promise.all(children.map(stop));
    // Surface fixture failures rather than silently discarding child diagnostics.
    for (const child of children) expect(child.process.exitCode, await child.stderr).toBe(0);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
