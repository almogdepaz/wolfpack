import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeStateStore, deriveAgentRuntimeState, type AgentStatusSource } from "../../src/server/agent-status.ts";
import type { AgentStatusState } from "../../src/agent-status-contract.ts";
import { stoppedUnseen, rankFocus } from "../../src/focus-ranking.ts";
import { emptyFocus } from "../../src/focus-contract.ts";

async function fixture(run: (f: ReturnType<typeof episodeFixture>) => Promise<void> | void) {
  const root = mkdtempSync(join(tmpdir(), "stop-episode-"));
  const f = episodeFixture(join(root, "runtime.json"));
  try { await run(f); } finally { await f.store.flushForShutdown(); rmSync(root, { recursive: true, force: true }); }
}
function episodeFixture(path: string) {
  let store = new AgentRuntimeStateStore(path);
  let tick = 0;
  function step(state: AgentStatusState, authority: "manifest" | "program" | "fallback" = "manifest", options: { stale?: boolean; broker?: "alive" | "unavailable"; runId?: string; signalSequence?: number; agentKind?: string } = {}) {
    const observedAt = new Date(Date.parse("2026-11-08T10:00:00Z") + tick++ * 60_000).toISOString();
    const source: AgentStatusSource = { state, authority, source: authority === "program" ? "program-status" : "local-manifest", freshness: options.stale ? "stale" : "fresh", stale: options.stale ?? false, label: state, observedAt, signalSequence: options.signalSequence, capabilities: ["semantic-state"], runId: options.runId ?? "run-1", runOrder: 1 };
    return store.reduce({ sessionKey: "episode", agentKind: options.agentKind ?? "custom", broker: { state: options.broker ?? "alive", observedAt }, sources: authority === "fallback" ? [] : [source], fallback: { rawOutputChanged: state === "output", observedAt }, currentRun: { runId: options.runId ?? "run-1", runOrder: 1 } });
  }
  return { get store() { return store; }, step,
    ack: () => store.acknowledge("episode", store.get("episode")!.transitionSequence),
    loadLegacyDone: async () => {
      step("working");
      const done = step("done");
      // The legacy schema-v1 cache has runtime facts but no episode fields.
      const { workPending: _, stoppedSequence: __, stoppedAt: ___, stopObserved: ____, ...legacy } = done;
      await store.flushForShutdown();
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, sessions: { episode: legacy } }));
      store = new AgentRuntimeStateStore(path);
    },
    reload: async () => { await store.flushForShutdown(); store = new AgentRuntimeStateStore(path); } };
}

test("reviewed manifest idle does not resurface when its TTL selects fallback idle", () => fixture(f => {
  f.step("working");
  const stop = f.step("idle");
  expect(stoppedUnseen(stop)).toBe(true);
  f.ack();
  const metadata = f.step("idle", "manifest", { stale: true });
  expect(metadata.unseen).toBe(true); // General changed-since-review semantics stay intact.
  expect(stoppedUnseen(metadata)).toBe(false);
  expect(metadata.stoppedAt).toBe(stop.changedAt);
}));
test("reviewed program done followed by idle is not another stopped turn", () => fixture(f => {
  f.step("working", "program");
  const stop = f.step("done", "program");
  f.ack();
  const idle = f.step("idle", "program");
  expect(idle.unseen).toBe(true);
  expect(stoppedUnseen(idle)).toBe(false);
  expect(idle.stoppedAt).toBe(stop.changedAt);
}));
test("reviewed fallback stop survives persistence and broker recovery without resurfacing", () => fixture(async f => {
  f.step("output", "fallback");
  const stop = f.step("idle", "fallback");
  f.ack();
  await f.reload();
  expect(stoppedUnseen(f.store.get("episode")!)).toBe(false);
  f.step("idle", "fallback", { broker: "unavailable" });
  const recovered = f.step("idle", "fallback");
  expect(recovered.unseen).toBe(true);
  expect(stoppedUnseen(recovered)).toBe(false);
  expect(recovered.stoppedAt).toBe(stop.changedAt);
}));
test("reviewed done re-reported by a different authority is not a new stopped turn", () => fixture(f => {
  f.step("working");
  const stop = f.step("done");
  f.ack();
  const metadata = f.step("done", "program");
  expect(metadata.unseen).toBe(true);
  expect(stoppedUnseen(metadata)).toBe(false);
  expect(metadata.stoppedAt).toBe(stop.changedAt);
}));
test("an unseen stop keeps its original time across metadata and run changes", () => fixture(f => {
  f.step("working");
  const stop = f.step("done");
  const metadata = f.step("done", "program", { runId: "run-2" });
  expect(metadata.changedAt).not.toBe(stop.changedAt);
  expect(stoppedUnseen(metadata)).toBe(true);
  expect(metadata.stoppedAt).toBe(stop.changedAt);
}));
test("first authoritative done discovery is a stop after acknowledged startup idle", () => fixture(async f => {
  f.step("idle", "fallback");
  f.ack();
  await f.reload();
  expect(stoppedUnseen(f.step("idle", "manifest", { runId: "run-2" }))).toBe(false);
  const first = f.step("done", "program", { runId: "run-2" });
  expect(stoppedUnseen(first)).toBe(true);
  expect(first.stoppedAt).toBe(first.changedAt);
}));
test("acknowledging while busy does not hide a later real finish, including after reload", () => fixture(async f => {
  f.step("working", "program");
  f.ack();
  await f.reload();
  const first = f.step("done", "program");
  expect(stoppedUnseen(first)).toBe(true);
  f.ack();
  f.step("working", "program");
  f.ack();
  const next = f.step("done", "program");
  expect(stoppedUnseen(next)).toBe(true);
  expect(next.stoppedAt).not.toBe(first.stoppedAt);
}));
test("reviewed main-format idle can discover a finish once, because its history is ambiguous", () => {
  const at = "2026-11-08T10:00:00.000Z";
  const input = { sessionKey: "legacy", broker: { state: "alive" as const, observedAt: at }, sources: [], fallback: { rawOutputChanged: false, observedAt: at } };
  const { workPending: _, stoppedSequence: __, stoppedAt: ___, stopObserved: ____, ...seed } = deriveAgentRuntimeState(input);
  const legacy = { ...seed, transitionSequence: 2, acknowledgedSequence: 2, unseen: false };
  const metadata = deriveAgentRuntimeState({ ...input, previous: legacy, currentRun: { runId: "new", runOrder: 2 } });
  const done: AgentStatusSource = { state: "done", authority: "program", source: "program-status", freshness: "fresh", stale: false, observedAt: at, label: "done", capabilities: ["semantic-state"] };
  const first = deriveAgentRuntimeState({ ...input, sources: [done], previous: metadata });
  expect(stoppedUnseen(first)).toBe(true);
  const reviewed = { ...first, acknowledgedSequence: first.transitionSequence, unseen: false };
  const idle = deriveAgentRuntimeState({ ...input, previous: reviewed });
  expect(stoppedUnseen(deriveAgentRuntimeState({ ...input, sources: [done], previous: idle }))).toBe(false);
});

for (const order of ["before", "after"] as const) test(`legacy done acknowledged ${order} migration never rediscovers its finish`, () => fixture(async f => {
  await f.loadLegacyDone();
  expect(f.store.get("episode")?.unseen).toBe(true);
  if (order === "before") f.ack();
  f.step("done"); // Migrate without changing the runtime transition.
  if (order === "after") f.ack();
  await f.reload();
  f.step("idle", "manifest", { stale: true });
  await f.reload(); // Persist loss of the old source as well as acknowledgement.
  const metadata = f.step("done", "program");
  expect(metadata.unseen).toBe(true);
  expect(stoppedUnseen(metadata)).toBe(false);
  expect(metadata.stoppedAt).toBeUndefined(); // Historical stop time is unknown.
  // Migration must not fence off real future work, even if it is reviewed while busy.
  f.step("working", "program");
  f.ack();
  const next = f.step("done", "program");
  expect(stoppedUnseen(next)).toBe(true);
  expect(next.stoppedAt).toBe(next.changedAt);
}));

test("a turn ending during broker loss surfaces on authoritative recovery with its stop time", () => fixture(f => {
  f.step("working");
  f.step("done");
  f.ack();
  f.step("working");
  f.step("idle", "fallback", { broker: "unavailable" });
  const recovered = f.step("done");
  expect(stoppedUnseen(recovered)).toBe(true);
  expect(recovered.stoppedAt).toBe(recovered.changedAt);
  expect(recovered.workPending).toBe(false);
  expect(f.step("done").stoppedAt).toBe(recovered.stoppedAt);
}));

test("advanced structured done is a new stop even when the busy phase was not sampled", () => fixture(f => {
  f.step("done", "manifest", { signalSequence: 1 });
  f.ack();
  const next = f.step("done", "manifest", { signalSequence: 2 });
  expect(stoppedUnseen(next)).toBe(true);
  expect(next.stoppedAt).toBe(next.changedAt);
  expect(next.workPending).toBe(false);
  f.ack();
  expect(stoppedUnseen(f.step("done", "manifest", { signalSequence: 2 }))).toBe(false);
}));

for (const agentKind of ["shell", "claude", "codex", "pi", "gemini", "cursor", "custom"]) test(`fallback bursts rank as stopped work only for agents: ${agentKind}`, () => fixture(f => {
  for (let burst = 0; burst < 2; burst++) {
    f.step("output", "fallback", { agentKind });
    const idle = f.step("idle", "fallback", { agentKind });
    expect(stoppedUnseen(idle)).toBe(agentKind !== "shell");
    expect(rankFocus(emptyFocus(), [{ ...idle, id: "episode", name: agentKind }])).toHaveLength(agentKind === "shell" ? 0 : 1);
    f.ack();
  }
  f.step("working", "program", { agentKind });
  expect(stoppedUnseen(f.step("done", "program", { agentKind }))).toBe(true);
  f.step("working", "manifest", { agentKind });
  expect(stoppedUnseen(f.step("done", "manifest", { agentKind }))).toBe(true);
}));

test("TTL loss of a busy semantic source is not an observed stop", () => fixture(f => {
  f.step("working");
  expect(stoppedUnseen(f.step("idle", "fallback"))).toBe(false);
}));
