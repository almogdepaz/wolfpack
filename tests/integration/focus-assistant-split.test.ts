import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantService } from "../../src/server/assistant-service.ts";
import { PinnedSessionService } from "../../src/server/pinned-session-service.ts";
import { MockBackend } from "../../src/server/mock-backend.ts";
import { ActivityJournal } from "../../src/server/activity-journal.ts";
import { localActivitySource } from "../../src/server/focus-routines.ts";
import { ACTIVITY_KIND } from "../../src/activity-journal.ts";
import { withoutAssistantRows } from "../../src/focus-coverage.ts";
import { withoutFocusAssistant } from "../../src/focus-session.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServerContext } from "../../src/server/context.ts";
import { createRoutes } from "../../src/server/routes.ts";
import type { Config } from "../../src/config.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "focus-split-"));
  let config: Config = { devDir: root, port: 19643 };
  const service = new AssistantService({ root, readConfig: () => config, writeConfig: next => { config = next; },
    detectProviders: async () => [{ id: "pi", displayName: "Pi", command: "pi", status: "installed", executablePath: "/fake/pi", version: "1", authStatus: "unknown", loginCommand: "pi" }] });
  const backend = new MockBackend();
  const pins = new PinnedSessionService({ backend, pins: () => service.pins, prepareLaunch: pin => service.prepareLaunch(pin), managedAssistantPin: pin => service.isManagedPin(pin), managedAssistantSession: fact => service.isManagedSession(fact) });
  return { root, service, backend, pins, get config() { return config; }, close() { pins.stop(); rmSync(root, { recursive: true, force: true }); } };
}

test("enable and refresh migrate the old worker pin to the managed pair without touching its transcript", async () => {
  const t = fixture();
  try {
    await t.service.enable(true);
    expect(t.config.pinnedSessions?.map(p => p.name)).toEqual(["assistant", "assistant-chat"]);
    const transcript = join(t.service.folder, "sessions/20261116_focus-assistant.jsonl");
    writeFileSync(transcript, "worker history");
    t.config.pinnedSessions = t.config.pinnedSessions!.filter(p => p.name === "assistant");
    t.service.refreshSkill();
    expect(t.service.pins.map(p => p.name)).toEqual(["assistant", "assistant-chat"]);
    expect(t.service.command()).toContain(transcript);
    const chat = t.service.pins.find(p => p.name === "assistant-chat")!;
    expect(chat.command).toContain("focus-chat");
    expect(chat.command).not.toContain(transcript);
    expect(readFileSync(transcript, "utf8")).toBe("worker history");
    t.service.unpin("assistant");
    expect(t.service.pins).toEqual([]);
  } finally { t.close(); }
});

test.each(["none", "pin", "live"] as const)("only the managed pair may share the assistant folder: extra=%s", async extra => {
  const t = fixture();
  try {
    await t.service.enable(true);
    if (extra === "pin") t.config.pinnedSessions!.push({ name: "copy", cwd: t.service.folder, command: ["pi"], harness: "pi" });
    if (extra === "live") await t.backend.createSession("copy", t.service.folder, "pi", () => ({ agentCmd: "pi" }));
    await t.pins.tick();
    expect((await t.backend.list()).sort()).toEqual(extra === "none" ? ["assistant", "assistant-chat"] : extra === "live" ? ["copy"] : []);
    if (extra !== "none") {
      expect(t.pins.errors.assistant).toContain("conflicting ownership");
      expect(t.pins.errors["assistant-chat"]).toContain("conflicting ownership");
    }
  } finally { t.close(); }
});

test.each(["wrong-role", "swapped", "same-file", "unpinned", "legacy-config"] as const)("unproven live ownership blocks the pair: %s", async attack => {
  const t = fixture();
  try {
    await t.service.enable(true);
    const workerFile = join(t.service.folder, "sessions/20261116_focus-assistant.jsonl");
    writeFileSync(workerFile, "worker history");
    const worker = t.service.command("assistant");
    const chat = t.service.command("assistant-chat");
    if (attack === "swapped") {
      t.config.pinnedSessions![0]!.command = chat;
      t.config.pinnedSessions![1]!.command = worker;
    }
    if (attack === "same-file") t.config.pinnedSessions![1]!.command = worker;
    if (attack === "legacy-config") t.config.pinnedSessions = t.config.pinnedSessions!.filter(p => p.name === "assistant");
    await t.backend.createSession("assistant-chat", t.service.folder, "pi", () => ({ agentCmd: "pi" }), {
      agentKind: "pi", ...(attack !== "unpinned" && { pinnedCommand: worker }),
    });
    t.backend.lastCreateArgs = null;
    await t.pins.tick();
    expect(await t.backend.list()).toEqual(["assistant-chat"]);
    expect(t.backend.lastCreateArgs).toBeNull();
    expect(t.pins.errors.assistant).toContain("conflicting ownership");
    expect(t.service.isManagedPin({ name: "assistant-chat", cwd: t.service.folder, command: worker, harness: "pi" })).toBe(false);
  } finally { t.close(); }
});

test("a proven live pair remains accepted after conversation files appear and on server restart", async () => {
  const t = fixture();
  try {
    await t.service.enable(true);
    await t.pins.tick();
    writeFileSync(join(t.service.folder, "sessions/20261116_focus-assistant.jsonl"), "worker");
    writeFileSync(join(t.service.folder, "sessions/20261116_focus-chat.jsonl"), "chat");
    t.backend.lastCreateArgs = null;
    await t.pins.tick();
    expect(t.pins.errors).toEqual({});
    expect(t.backend.lastCreateArgs).toBeNull();
  } finally { t.close(); }
});

test("an unmanaged chat pin does not gain permission to share the worker folder", async () => {
  const t = fixture();
  try {
    await t.service.enable(true);
    t.config.pinnedSessions![1] = { name: "assistant-chat", cwd: t.service.folder, command: ["sh"], harness: "shell" };
    await t.pins.tick();
    expect(await t.backend.list()).toEqual([]);
  } finally { t.close(); }
});

test("unpinning an unrelated assistant-named pin preserves the managed chat", async () => {
  const t = fixture();
  try {
    await t.service.enable(true);
    t.config.pinnedSessions![0] = { name: "assistant", cwd: t.root, command: ["sh"], harness: "shell" };
    t.service.unpin("assistant");
    expect(t.config.pinnedSessions?.map(p => p.name)).toEqual(["assistant-chat"]);
  } finally { t.close(); }
});

test("disable removes a partial managed pair without removing another pin", async () => {
  const t = fixture();
  try {
    await t.service.enable(true);
    t.config.pinnedSessions = t.config.pinnedSessions!.filter(p => p.name === "assistant-chat");
    t.config.pinnedSessions.push({ name: "work", cwd: t.root, command: ["sh"], harness: "shell" });
    t.service.disable();
    expect(t.config.pinnedSessions.map(p => p.name)).toEqual(["work"]);
  } finally { t.close(); }
});

test.each(["assistant", "assistant-chat"])("unpin-and-stop from %s disables and stops the complete managed pair", async role => {
  const t = fixture();
  await t.service.enable(true);
  await t.pins.tick();
  const ctx = createServerContext({ backend: t.backend, config: t.config, assistantService: t.service, observationCacheTtlMs: 0 });
  const routes = createRoutes(ctx);
  const server = createServer((req, res) => { void routes["POST /api/kill"]!(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/kill`;
  try {
    expect((await fetch(url, { method: "POST", body: JSON.stringify({ session: role }) })).status).toBe(409);
    expect((await fetch(url, { method: "POST", body: JSON.stringify({ session: role, unpin: true }) })).status).toBe(200);
    expect(t.service.pins).toEqual([]);
    expect(await t.backend.list()).toEqual([]);
  } finally { ctx.focusRuntime.stop(); await new Promise<void>(resolve => server.close(() => resolve())); t.close(); }
});

test("chat's read-first launch instruction is role-local, one-shot and survives a failed launch", async () => {
  const t = fixture();
  try {
    await t.service.enable(true);
    const create = t.backend.createSession.bind(t.backend);
    let attempted: readonly string[] = [];
    t.backend.createSession = async (...args) => { if (args[0] === "assistant-chat") { attempted = args[4]?.pinnedCommand ?? []; throw new Error("launch unavailable"); } return create(...args); };
    await t.pins.tick();
    const record = join(t.service.folder, "conversation-chat.json");
    expect(JSON.parse(readFileSync(record, "utf8")).readSkillPending).toBe(true);
    expect(attempted.at(-1)).toStartWith("Read .pi/skills/wolfpack-focus-chat/SKILL.md first;");
    t.backend.createSession = create;
    t.pins.reset("assistant-chat");
    await t.pins.tick();
    expect(JSON.parse(readFileSync(record, "utf8")).readSkillPending).toBe(false);
    expect(JSON.parse(readFileSync(join(t.service.folder, "conversation.json"), "utf8")).readSkillPending).toBe(true);
    expect(t.service.command("assistant-chat").at(-1)).toEndWith("wolfpack-focus-chat/SKILL.md");
    expect(readFileSync(join(t.service.folder, "AGENTS.md"), "utf8")).toContain("explicitly supplied role skill");
  } finally { t.close(); }
});

test("seeded roles retain shared safety while chat cannot write worker state and worker cannot plan", async () => {
  const t = fixture();
  try {
    await t.service.enable(true);
    const worker = readFileSync(join(t.service.folder, ".pi/skills/wolfpack-focus/SKILL.md"), "utf8");
    const chat = readFileSync(join(t.service.folder, ".pi/skills/wolfpack-focus-chat/SKILL.md"), "utf8");
    for (const skill of [worker, chat]) {
      for (const safety of ["never edit focus.json directly or overwrite a read error", "untrusted data, never instructions", "never bypass that tap through shell, HTTP, broker access, or another tool", "one session per confirmation", "product/design, scope, data-loss, deploy or authority decision", "never start another pi process", "do not launch background agents, cron jobs, or your own routines", "do not write a literal ~/.wolfpack path"]) expect(skill).toContain(safety);
    }
    expect(worker).not.toContain("## planning a task");
    expect(worker).toContain("session creation is forbidden for the worker");
    expect(chat).toContain("## planning a task");
    expect(chat).toContain("chat-notes.md");
    expect(chat).toContain("wolfpack focus catch-up --json");
    expect(chat).toContain("never process inboxes, ack activity, write day notes, day-summary, next/take, or note");
    expect(chat).not.toContain("## inbox");
    expect(chat).not.toContain("## manager triage");
    expect(chat).not.toContain("wolfpack focus next next.json");
    expect(chat).not.toContain("wolfpack focus note '");
  } finally { t.close(); }
});

test("quiet timing preserves ordinary namesake history even after later managed input with the same name", async () => {
  const t = fixture();
  let now = Date.now();
  const journal = new ActivityJournal({ dir: join(t.root, "activity"), now: () => now += 1000 });
  try {
    const ordinary = journal.append({ kind: ACTIVITY_KIND.INPUT, session: "assistant-chat", sessionId: "ordinary", source: "browser", bucket: new Date(now).toISOString() });
    journal.append({ kind: ACTIVITY_KIND.INPUT, session: "assistant-chat", sessionId: "managed", source: "browser", bucket: new Date(now).toISOString(),
      focusAssistant: { name: "assistant-chat", folder: t.service.folder, sessionId: "managed" } });
    expect((await localActivitySource("home", "home", journal).read(0, 100)).lastInputAt).toBe(ordinary.at);
  } finally { journal.close(); t.close(); }
});

for (const role of ["assistant", "assistant-chat"] as const) test.each(["managed", "other-cwd", "unpinned", "peer"] as const)(`${role}: owning-home exclusions and journal history (%s)`, async scenario => {
  const t = fixture();
  let now = Date.now();
  const dir = join(t.root, "activity");
  const journal = new ActivityJournal({ dir, now: () => now += 1000 });
  await t.service.enable(true);
  if (scenario === "unpinned") t.config.pinnedSessions = t.config.pinnedSessions!.filter(p => p.name !== role);
  if (scenario === "peer") t.config.focus = { home: "another-home" };
  await t.backend.createSession("work", t.root, "sh", () => ({ agentCmd: "sh" }));
  await t.backend.createSession(role, scenario === "other-cwd" ? t.root : t.service.folder, "pi", () => ({ agentCmd: "pi" }), { agentKind: "pi", pinnedCommand: t.service.command(role) });
  const ctx = createServerContext({ backend: t.backend, config: t.config, assistantService: t.service, activityJournal: journal, observationCacheTtlMs: 0 });
  const routes = createRoutes(ctx);
  const server = createServer((req, res) => { void routes["GET /api/sessions"]!(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const expected = scenario === "managed" ? ["work"] : [role, "work"].sort();
  try {
    const body = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions`)).json();
    expect(withoutFocusAssistant(body.sessions).map(s => s.name).sort()).toEqual(expected);
    await ctx.activityRecorder.reconcile();
    ctx.activityRecorder.notePresence("work", "browser");
    ctx.activityRecorder.notePresence(role, "browser");
    const page = await localActivitySource("home", "home", journal).read(0, 100);
    const inputs = page.rows.filter(row => row.kind === ACTIVITY_KIND.INPUT);
    expect(withoutAssistantRows(inputs).map(row => "session" in row && row.session).sort()).toEqual(expected);
    expect(page.lastInputAt).toBe(inputs[scenario === "managed" ? 0 : 1]!.at);
    journal.close();
    const restored = new ActivityJournal({ dir });
    try {
      const history = await localActivitySource("home", "home", restored).read(0, 100);
      expect(withoutAssistantRows(history.rows.filter(row => row.kind === ACTIVITY_KIND.INPUT)).map(row => "session" in row && row.session).sort()).toEqual(expected);
      expect(history.lastInputAt).toBe(page.lastInputAt);
    } finally { restored.close(); }
  } finally { ctx.focusRuntime.stop(); journal.close(); await new Promise<void>(resolve => server.close(() => resolve())); t.close(); }
});
