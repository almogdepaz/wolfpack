import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentRuntimeStateStore, deriveAgentRuntimeState, agentStatusSources, readLocalStatusManifest, AGENT_STATUS_MANIFEST_PATH, AGENT_STATUS_TTL_MS, type AgentStatusSource } from "../../src/server/agent-status.ts";
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
  function step(state: AgentStatusState, authority: "manifest" | "program" | "fallback" = "manifest", options: { stale?: boolean; broker?: "alive" | "unavailable"; runId?: string | null; signalSequence?: number; agentKind?: string; runOrder?: number } = {}) {
    const observedAt = new Date(Date.parse("2026-11-08T10:00:00Z") + tick++ * 60_000).toISOString();
    const runId = options.runId === null ? undefined : options.runId ?? "run-1";
    const source: AgentStatusSource = { state, authority, source: authority === "program" ? "program-status" : "local-manifest", freshness: options.stale ? "stale" : "fresh", stale: options.stale ?? false, label: state, observedAt, signalSequence: options.signalSequence, capabilities: ["semantic-state"], runId, runOrder: options.runOrder ?? 1 };
    return store.reduce({ sessionKey: "episode", agentKind: options.agentKind ?? "custom", broker: { state: options.broker ?? "alive", observedAt }, sources: authority === "fallback" ? [] : [source], fallback: { rawOutputChanged: state === "output", observedAt }, currentRun: { runId, runOrder: options.runOrder ?? 1 } });
  }
  return { get store() { return store; }, step,
    ack: () => store.acknowledge("episode", store.get("episode")!.transitionSequence),
    manifest: async (signalSequence?: number, expired = false) => {
      const observedAt = new Date(Date.parse("2026-11-08T10:00:00Z") + tick++ * 60_000).toISOString();
      const project = join(dirname(path), "project");
      const file = join(project, AGENT_STATUS_MANIFEST_PATH);
      if (signalSequence !== undefined) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ state: "done", observedAt, capabilities: ["semantic-state"], runId: "run-1", runOrder: 1, signalSequence }));
      }
      if (expired) { const old = new Date(Date.now() - AGENT_STATUS_TTL_MS - 10_000); utimesSync(file, old, old); }
      const source = await readLocalStatusManifest(project);
      return { source, runtime: store.reduce({ sessionKey: "episode", agentKind: "pi", broker: { state: "alive", observedAt }, sources: agentStatusSources(source, { state: "idle", stale: false, observedAt }), fallback: { rawOutputChanged: false, observedAt }, currentRun: { runId: "run-1", runOrder: 1 } }) };
    },
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

for (const signal of [9, 10, 12]) test(`real manifest TTL recovery compares retained signal 10 with ${signal} across reload`, () => fixture(async f => {
  const first = await f.manifest(10);
  expect(first.source.freshness).toBe("fresh");
  expect(stoppedUnseen(first.runtime)).toBe(true);
  f.ack();
  await f.reload();
  const expired = await f.manifest(undefined, true);
  expect(expired.source.freshness).toBe("stale");
  expect(expired.runtime.state).toBe("idle");
  await f.reload();
  const recovered = await f.manifest(signal);
  expect(recovered.runtime.unseen).toBe(true);
  expect(stoppedUnseen(recovered.runtime)).toBe(signal > 10);
  expect(recovered.runtime.stoppedAt).toBe(signal > 10 ? recovered.source.observedAt : first.runtime.stoppedAt);
  expect(rankFocus(emptyFocus(), [{ ...recovered.runtime, id: "episode", name: "pi" }])).toHaveLength(signal > 10 ? 1 : 0);
  f.ack();
  await f.reload();
  expect(stoppedUnseen((await f.manifest(signal)).runtime)).toBe(false);
  if (signal < 10) {
    f.step("idle", "fallback");
    await f.reload();
    expect(stoppedUnseen((await f.manifest(10)).runtime)).toBe(false); // A lower recovery cannot roll the high-water mark back.
  }
}));

for (const gap of ["broker", "program", "missing-counter"] as const) for (const signal of [9, 10, 12]) test(`${gap} gap retains structured stop signal 10 versus ${signal}`, () => fixture(async f => {
  const first = f.step("done", "manifest", { signalSequence: 10 });
  f.ack();
  await f.reload();
  if (gap === "broker") f.step("idle", "fallback", { broker: "unavailable" });
  else f.step("done", gap === "program" ? "program" : "manifest");
  await f.reload();
  const recovered = f.step("done", "manifest", { signalSequence: signal });
  expect(stoppedUnseen(recovered)).toBe(signal > 10);
  expect(recovered.stoppedAt).toBe(signal > 10 ? recovered.observedAt : first.stoppedAt);
  if (signal > 10) expect(recovered.transitionSequence).toBeGreaterThan(recovered.acknowledgedSequence ?? 0);
  f.ack();
  await f.reload();
  expect(stoppedUnseen(f.step("done", "manifest", { signalSequence: signal }))).toBe(false);
}));

test("unrelated authority signals neither mint a stop nor poison retained manifest evidence", () => fixture(async f => {
  f.step("done", "manifest", { signalSequence: 10 });
  f.ack();
  f.step("idle", "fallback");
  await f.reload();
  expect(stoppedUnseen(f.step("done", "program", { signalSequence: 999 }))).toBe(false);
  await f.reload();
  expect(stoppedUnseen(f.step("done", "manifest", { signalSequence: 12 }))).toBe(true);
}));
for (const context of [{ runId: "another-run" }, { runOrder: 2 }]) test(`structured stop evidence is fenced by run identity ${JSON.stringify(context)}`, () => fixture(async f => {
  f.step("done", "manifest", { signalSequence: 10 });
  f.ack();
  f.step("idle", "fallback");
  await f.reload();
  expect(stoppedUnseen(f.step("done", "manifest", { signalSequence: 999, ...context }))).toBe(false);
  await f.reload();
  expect(f.store.get("episode")?.stopSignal).toMatchObject({ runId: "run-1", runOrder: 1, signalSequence: 10 });
  if (context.runId) expect(stoppedUnseen(f.step("done", "manifest", { signalSequence: 12 }))).toBe(true);
}));

for (const signal of [10, 12]) test(`run-order-only structured evidence survives a broker gap: ${signal}`, () => fixture(async f => {
  const run = { runId: null, runOrder: 7 };
  f.step("done", "manifest", { ...run, signalSequence: 10 });
  f.ack();
  await f.reload();
  f.step("idle", "fallback", { ...run, broker: "unavailable" });
  await f.reload();
  const recovered = f.step("done", "manifest", { ...run, signalSequence: signal });
  expect(recovered.runId).toBeUndefined();
  expect(recovered.stopSignal?.runOrder).toBe(7);
  expect(stoppedUnseen(recovered)).toBe(signal > 10);
}));

for (const signal of [10, 11]) test(`replayed done ${signal} cannot close pending work after a structured busy signal 11`, () => fixture(async f => {
  const first = f.step("done", "manifest", { signalSequence: 10 });
  f.ack();
  f.step("working", "manifest", { signalSequence: 11 });
  f.ack();
  f.step("idle", "fallback", { broker: "unavailable" });
  await f.reload();
  const replay = f.step("done", "manifest", { signalSequence: signal });
  expect(stoppedUnseen(replay)).toBe(false);
  expect(replay.workPending).toBe(true);
  expect(replay.stoppedAt).toBe(first.stoppedAt);
  await f.reload();
  const completed = f.step("done", "manifest", { signalSequence: 12 });
  expect(stoppedUnseen(completed)).toBe(true);
  expect(completed.workPending).toBe(false);
}));

test("a real non-structured stop retires earlier structured work evidence", () => fixture(async f => {
  f.step("done", "manifest", { signalSequence: 10 });
  f.ack();
  f.step("working", "manifest", { signalSequence: 11 });
  const stop = f.step("done", "program");
  expect(stoppedUnseen(stop)).toBe(true);
  expect(stop.stopSignal).toBeUndefined();
  f.ack();
  await f.reload();
  const metadata = f.step("done", "manifest", { signalSequence: 12 });
  expect(stoppedUnseen(metadata)).toBe(false);
  expect(metadata.stoppedAt).toBe(stop.stoppedAt);
  expect(stoppedUnseen(f.step("done", "manifest", { signalSequence: 13 }))).toBe(true);
}));

test("TTL loss of a busy semantic source is not an observed stop", () => fixture(f => {
  f.step("working");
  expect(stoppedUnseen(f.step("idle", "fallback"))).toBe(false);
}));
