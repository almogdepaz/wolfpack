import { expect, test, setSystemTime } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantService } from "../../src/server/assistant-service.ts";
import { MockBackend } from "../../src/server/mock-backend.ts";
import { ActivityJournal } from "../../src/server/activity-journal.ts";
import { createServerContext } from "../../src/server/context.ts";
import { ACTIVITY_KIND } from "../../src/activity-journal.ts";
import type { Config } from "../../src/config.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "focus-split-runtime-"));
  let config: Config = { devDir: root, port: 19643 };
  const service = new AssistantService({ root, readConfig: () => config, writeConfig: next => { config = next; },
    detectProviders: async () => [{ id: "pi", displayName: "Pi", command: "pi", status: "installed", executablePath: "/fake/pi", version: "1", authStatus: "unknown", loginCommand: "pi" }] });
  await service.enable(true);
  const backend = new MockBackend();
  const journal = new ActivityJournal({ dir: join(root, "activity") });
  const ctx = createServerContext({ backend, config, assistantService: service, activityJournal: journal, observationCacheTtlMs: 0 });
  const kills: string[] = [], sends: string[] = [];
  const kill = backend.killSessionById.bind(backend);
  backend.killSessionById = async id => { kills.push(id); return kill(id); };
  backend.sendAndObserveSubmission = async id => { sends.push(id); return { delivery: "delivered", outcome: "submitted", observedMs: 1 }; };
  ctx.focusRuntime.start();
  await ctx.focusRuntime.pins.tick();
  let at = Date.now();
  const state = (role: string, state: "done" | "working" | "blocked" = "done") => backend.setProgramStatus(role, { id: "", state, ...(state === "blocked" && { kind: "question" as const }), updatedAtMs: ++at });
  state("assistant"); state("assistant-chat");
  return { root, service, backend, journal, ctx, kills, sends, state,
    change(role: string) { writeFileSync(join(service.folder, ".pi/skills", role === "assistant" ? "wolfpack-focus" : "wolfpack-focus-chat", "SKILL.md"), "changed skill"); },
    close() { ctx.focusRuntime.stop(); journal.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("routine sends during an active chat go only to the worker; queue rejects a chat UUID", async () => {
  const t = await fixture();
  try {
    t.state("assistant-chat", "working");
    t.journal.append({ kind: ACTIVITY_KIND.TASK_UPDATED, taskId: "work", eventType: "updated" });
    await t.ctx.focusRuntime.routines.tick({ manual: true });
    await t.ctx.focusRuntime.tick();
    expect(t.sends).toEqual(["mock:assistant"]);
    t.state("assistant");
    t.ctx.focusRuntime.queue.enqueue("mock:assistant-chat", "must not send", undefined, "routine");
    await t.ctx.focusRuntime.tick();
    expect(t.sends).toEqual(["mock:assistant"]);
  } finally { t.close(); }
});

test.each(["assistant", "assistant-chat"] as const)("unproven %s is not exposed as a role or used as a routine target", async role => {
  const t = await fixture();
  try {
    await t.backend.killSessionById(`mock:${role}`);
    await t.backend.createSession(role, t.service.folder, "pi", () => ({ agentCmd: "pi" }), { agentKind: "pi", pinnedCommand: t.service.command(role === "assistant" ? "assistant-chat" : "assistant") });
    t.state(role);
    if (role === "assistant") {
      t.ctx.focusRuntime.queue.enqueue("mock:assistant", "process inbox inbox/unsafe.json", undefined, "routine");
      await t.ctx.focusRuntime.tick();
      expect(t.sends).toEqual([]);
    }
    const status = await t.ctx.focusRuntime.status();
    expect((role === "assistant" ? status : status.chat).sessionId).toBeUndefined();
  } finally { t.close(); }
});

test.each(["pi", "shell", "hermes"] as const)("custom-worker compatibility requires the matching live non-Pi harness: %s", async liveHarness => {
  const root = mkdtempSync(join(tmpdir(), "focus-custom-role-"));
  let config: Config = { devDir: root, port: 19643 };
  const service = new AssistantService({ root, readConfig: () => config, writeConfig: next => { config = next; },
    detectProviders: async () => [{ id: "pi", displayName: "Pi", command: "pi", status: "installed", executablePath: "/fake/pi", version: "1", authStatus: "unknown", loginCommand: "pi" }] });
  await service.enable(true);
  config.pinnedSessions![0] = { name: "assistant", cwd: service.folder, command: ["hermes", "--tui"], harness: "hermes" };
  const backend = new MockBackend({ capturePane: async () => "› " });
  await backend.createSession("assistant", service.folder, liveHarness, () => ({ agentCmd: liveHarness }), {
    agentKind: liveHarness, ...(liveHarness === "pi" && { pinnedCommand: service.command("assistant-chat") }),
  });
  const at = Date.now();
  backend.setProgramStatus("assistant", { id: "", state: "done", updatedAtMs: at });
  const sends: { id: string; text: string }[] = [];
  backend.sendAndObserveSubmission = async (id, options) => { sends.push({ id, text: options.text }); return { delivery: "delivered", outcome: "submitted", observedMs: 1 }; };
  const journal = new ActivityJournal({ dir: join(root, "activity") });
  const ctx = createServerContext({ backend, config, assistantService: service, activityJournal: journal, observationCacheTtlMs: 0 });
  try {
    const initial = await ctx.focusRuntime.status();
    setSystemTime(new Date(at + 6000)); // real generic-harness quiet fence, without a timer sleep
    journal.append({ kind: ACTIVITY_KIND.TASK_UPDATED, taskId: "ordinary-work", eventType: "updated" });
    await ctx.focusRuntime.routines.tick({ manual: true });
    await ctx.focusRuntime.tick();
    if (liveHarness === "hermes") {
      expect(initial.sessionId).toBe("mock:assistant");
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({ id: "mock:assistant" });
      expect(sends[0]!.text).toMatch(/process inbox inbox\/catch-up-.*\.json/);
    } else {
      expect(sends).toEqual([]);
      expect(initial.sessionId).toBeUndefined();
    }
  } finally { setSystemTime(); ctx.focusRuntime.stop(); journal.close(); await ctx.close(); rmSync(root, { recursive: true, force: true }); }
});

test("the final send fence rejects a live Pi chat even when the configured worker is custom", async () => {
  const t = await fixture();
  try {
    t.ctx.config!.pinnedSessions![0] = { name: "assistant", cwd: t.service.folder, command: ["hermes", "--tui"], harness: "hermes" };
    await t.backend.killSessionById("mock:assistant");
    await t.backend.createSession("assistant", t.service.folder, "pi", () => ({ agentCmd: "pi" }), { agentKind: "pi", pinnedCommand: t.service.command("assistant-chat") });
    t.ctx.focusRuntime.queue.enqueue("mock:assistant", "process inbox inbox/unsafe.json", undefined, "routine");
    await t.ctx.focusRuntime.queue.tick({ id: "mock:assistant", idle: true, token: "previously-sampled-idle" });
    expect(t.sends).toEqual([]);
  } finally { t.close(); }
});

test("additive chat status reports its own dialog without changing the worker status", async () => {
  const t = await fixture();
  try {
    t.state("assistant-chat", "blocked");
    const status = await t.ctx.focusRuntime.status();
    expect(status.state).not.toBe("needs-input");
    expect(status.chat).toMatchObject({ state: "needs-input", session: "assistant-chat", sessionId: "mock:assistant-chat", needsInput: true });
  } finally { t.close(); }
});

test("corrupt chat launch metadata cannot make the live worker unavailable", async () => {
  const t = await fixture();
  try {
    writeFileSync(join(t.service.folder, "conversation-chat.json"), "{broken");
    const status = await t.ctx.focusRuntime.status();
    expect(status.state).toBe("done");
    expect(status.sessionId).toBe("mock:assistant");
    expect(t.service.pins.map(pin => pin.name)).toEqual(["assistant", "assistant-chat"]);
  } finally { t.close(); }
});

test("chat rotates independently of the busy worker queue and outstanding inbox, preserving the worker family", async () => {
  const t = await fixture();
  try {
    const worker = join(t.service.folder, "sessions/20261116_focus-assistant.jsonl");
    const chat = join(t.service.folder, "sessions/20261116_focus-chat.jsonl");
    writeFileSync(worker, "worker history"); writeFileSync(chat, "chat history");
    t.state("assistant", "working");
    t.journal.append({ kind: ACTIVITY_KIND.TASK_UPDATED, taskId: "work", eventType: "updated" });
    await t.ctx.focusRuntime.routines.tick({ manual: true });
    expect(t.ctx.focusRuntime.queue.busy).toBe(true);
    t.change("assistant-chat");
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual(["mock:assistant-chat"]);
    expect(readFileSync(worker, "utf8")).toBe("worker history");
    expect(t.ctx.focusRuntime.queue.busy).toBe(true);
    expect(t.service.command("assistant-chat")).toContain("focus-chat");
  } finally { t.close(); }
});

test.each(["working", "blocked", "viewer", "pendingViewer", "recent-input"] as const)("chat rotation preserves the role-local %s guard", async guard => {
  const t = await fixture();
  const { activePtySessions } = t.ctx.terminals;
  const { default: WebSocket } = await import("ws");
  const before = activePtySessions.get("assistant-chat");
  try {
    t.change("assistant-chat");
    if (guard === "working" || guard === "blocked") t.state("assistant-chat", guard);
    else if (guard === "recent-input") t.ctx.activityRecorder.notePresence("assistant-chat", "browser");
    else activePtySessions.set("assistant-chat", { alive: true, viewer: null, pendingViewer: null, proc: null, [guard]: Object.create(WebSocket.prototype) });
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual([]);
  } finally { if (before) activePtySessions.set("assistant-chat", before); else activePtySessions.delete("assistant-chat"); t.close(); }
});

test("a worker viewer does not prevent an idle chat from rotating", async () => {
  const t = await fixture();
  const { activePtySessions } = t.ctx.terminals;
  const { default: WebSocket } = await import("ws");
  const before = activePtySessions.get("assistant");
  try {
    t.change("assistant-chat");
    activePtySessions.set("assistant", { alive: true, viewer: Object.create(WebSocket.prototype), pendingViewer: null, proc: null });
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual(["mock:assistant-chat"]);
  } finally { if (before) activePtySessions.set("assistant", before); else activePtySessions.delete("assistant"); t.close(); }
});
