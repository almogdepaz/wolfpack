import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerContext } from "../../src/server/context.ts";
import { MockBackend } from "../../src/server/mock-backend.ts";
import { AgentRuntimeStateStore } from "../../src/server/agent-status.ts";

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
