import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerContext } from "../../src/server/context.ts";
import { MockBackend } from "../../src/server/mock-backend.ts";
import { AgentRuntimeStateStore } from "../../src/server/agent-status.ts";
import { invalidateQuietAlertPolicy } from "../../src/quiet-alert-policy-invalidation.ts";

test("contexts own ticket consumption, viewer attribution, child tracking and cleanup claims", async () => {
  const first = createServerContext({ backend: new MockBackend(), config: null });
  const second = createServerContext({ backend: new MockBackend(), config: null });
  try {
    const ticket = first.webSocketTickets.issueWebSocketTicket("viewer", 1000).ticket;
    expect(second.webSocketTickets.consumeWebSocketTicket(ticket, "viewer", 1001)).toBe(false);
    expect(first.webSocketTickets.consumeWebSocketTicket(ticket, "viewer", 1002)).toBe(true);
    first.viewerInput.noteViewerInput("same-id", 42);
    expect(second.viewerInput.lastViewerInputAt("same-id")).toBeUndefined();
    expect(first.viewerInput.lastViewerInputAt("same-id")).toBe(42);
    first.childEvents.noteChildCreated("same-id", "child", { wolfpackSessionId: "parent", wolfpackSessionName: "parent" });
    expect(first.childEvents.childTrackingMark()).toBe(1);
    expect(second.childEvents.childTrackingMark()).toBe(0);
    expect(first.sessionCascade.claimSessionCleanup("same-id")).toBe(true);
    expect(first.sessionCascade.claimSessionCleanup("same-id")).toBe(false);
    expect(second.sessionCascade.claimSessionCleanup("same-id")).toBe(true);
    const deaths: string[] = [];
    first.sessionDeath.onSessionDeath(id => deaths.push(id));
    first.sessionDeath.noteSessionAlive("same-id");
    second.sessionDeath.noteSessionExit("same-id");
    expect(deaths).toEqual([]);
    first.sessionDeath.noteSessionExit("same-id");
    expect(deaths).toEqual(["same-id"]);
  } finally {
    await first.close();
    await second.close();
  }
});

test("observation caches isolate contexts and dispose their global policy subscription", async () => {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-observation-context-"));
  const a = new MockBackend({ sessions: ["same"], capturePane: async () => "first" });
  const b = new MockBackend({ sessions: ["same"], capturePane: async () => "second" });
  const contexts = [a, b].map((backend, index) => createServerContext({
    backend, config: null, observationCacheTtlMs: 60_000,
    agentRuntimeStateStore: new AgentRuntimeStateStore(join(root, index + ".json")),
  }));
  const [first, second] = contexts;
  const line = async (ctx: typeof first) => (await ctx!.sessionObservation.observeDashboardSessions())[0]!.lastLine;
  try {
    expect(await line(first)).toBe("first");
    expect(await line(second)).toBe("second");
    a.setCapturePane(async () => "first changed");
    b.setCapturePane(async () => "second changed");
    a.setOutputSequence("same", "1");
    b.setOutputSequence("same", "1");
    expect(await line(first)).toBe("first");
    expect(await line(second)).toBe("second");
    await first!.close();
    invalidateQuietAlertPolicy();
    // Closed service no longer receives process-wide invalidation; B still does.
    expect(await line(first)).toBe("first");
    expect(await line(second)).toBe("second changed");
  } finally {
    await Promise.all(contexts.map(ctx => ctx.close()));
    rmSync(root, { recursive: true, force: true });
  }
});
