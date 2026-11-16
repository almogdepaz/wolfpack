import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerContext } from "../../src/server/context.ts";
import { MockBackend } from "../../src/server/mock-backend.ts";
import { AgentRuntimeStateStore } from "../../src/server/agent-status.ts";
import { AssistantService } from "../../src/server/assistant-service.ts";
import { CONFIG_PATH, saveConfig, type Config } from "../../src/config.ts";

test("focus summaries and acknowledgements belong to the observing context, even for the same UUID", async () => {
  const root = mkdtempSync(join(tmpdir(), "focus-context-observation-"));
  const contexts = await Promise.all(["first", "second"].map(async (text, index) => {
    const backend = new MockBackend({ capturePane: async () => `${text}\n❯` });
    await backend.createSession("same", root, "pi", () => ({ agentCmd: "pi" }), { agentKind: "pi" });
    return createServerContext({ backend, config: null, observationCacheTtlMs: 0,
      agentRuntimeStateStore: new AgentRuntimeStateStore(join(root, `${index}.json`)) });
  }));
  try {
    for (const ctx of contexts) await ctx.sessionObservation.observeDashboardSessions();
    const [first, second] = contexts;
    for (const [ctx, text] of [[first!, "first"], [second!, "second"]] as const) {
      expect(ctx.sessionObservation.observedSessionSummary("mock:same")).toEqual([text]);
      expect(ctx.sessionObservation.observedSessionLastLine("unknown-incarnation")).toBe("");
    }
    const state = first!.agentRuntimeStateStore.get("mock:same")!;
    first!.agentRuntimeStateStore.acknowledge("mock:same", state.transitionSequence);
    expect(first!.agentRuntimeStateStore.get("mock:same")!.acknowledgedSequence).toBe(state.transitionSequence);
    expect(second!.agentRuntimeStateStore.get("mock:same")!.acknowledgedSequence).toBeUndefined();
  } finally {
    await Promise.all(contexts.map(ctx => ctx.close()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("focus catch-up uses its owning context's topology reader", async () => {
  const root = mkdtempSync(join(tmpdir(), "focus-context-topology-"));
  const config: Config = { devDir: root, port: 19644, tailscaleHostname: "focus-context.example.ts.net" };
  const previousConfig = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH) : undefined;
  const assistantService = new AssistantService({ root, readConfig: () => config });
  config.pinnedSessions = [{ name: "assistant", cwd: assistantService.folder, command: ["hermes"], harness: "hermes" }];
  let reads = 0;
  const ctx = createServerContext({ backend: new MockBackend(), config, assistantService,
    readTailscaleStatus: async () => { reads++; return { Self: { ID: "focus-context", DNSName: "focus-context.example.ts.net." }, Peer: {} }; } });
  try {
    saveConfig(config);
    await ctx.focusRuntime.routines.tick({ manual: true });
    expect(reads).toBe(1);
    expect(ctx.focusRuntime.routines.status().notice).toBe("nothing new to catch up on");
  } finally {
    if (previousConfig) writeFileSync(CONFIG_PATH, previousConfig); else rmSync(CONFIG_PATH, { force: true });
    await ctx.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("context close disposes already-owned focus services", async () => {
  const ctx = createServerContext({ backend: new MockBackend(), config: null });
  const runtime = spyOn(ctx.focusRuntime, "stop");
  const recorder = spyOn(ctx.activityRecorder, "stop");
  const journal = spyOn(ctx.activityJournal, "close");
  const redraw = spyOn(ctx.viewerRedraw, "clear");
  try {
    await ctx.close();
    expect(runtime).toHaveBeenCalledTimes(1);
    expect(recorder).toHaveBeenCalledTimes(1);
    expect(journal).toHaveBeenCalledTimes(1);
    expect(redraw).toHaveBeenCalledTimes(1);
  } finally {
    ctx.focusRuntime.stop();
    ctx.activityRecorder.stop();
    ctx.activityJournal.close();
    ctx.viewerRedraw.clear();
    runtime.mockRestore(); recorder.mockRestore(); journal.mockRestore(); redraw.mockRestore();
  }
});
