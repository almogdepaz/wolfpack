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
import type { Config } from "../../src/config.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "focus-split-"));
  let config: Config = { devDir: root, port: 19643 };
  const service = new AssistantService({ root, readConfig: () => config, writeConfig: next => { config = next; },
    detectProviders: async () => [{ id: "pi", displayName: "Pi", command: "pi", status: "installed", executablePath: "/fake/pi", version: "1", authStatus: "unknown", loginCommand: "pi" }] });
  const backend = new MockBackend();
  const pins = new PinnedSessionService({ backend, pins: () => service.pins, prepareLaunch: pin => service.prepareLaunch(pin), managedAssistantPin: pin => service.isManagedPin(pin) });
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

test("an unmanaged chat pin does not gain permission to share the worker folder", async () => {
  const t = fixture();
  try {
    await t.service.enable(true);
    t.config.pinnedSessions![1] = { name: "assistant-chat", cwd: t.service.folder, command: ["sh"], harness: "shell" };
    await t.pins.tick();
    expect(await t.backend.list()).toEqual([]);
  } finally { t.close(); }
});

test("chat's read-first launch instruction is role-local, one-shot and survives a failed launch", async () => {
  const t = fixture();
  try {
    await t.service.enable(true);
    const create = t.backend.createSession.bind(t.backend);
    t.backend.createSession = async (...args) => { if (args[0] === "assistant-chat") throw new Error("launch unavailable"); return create(...args); };
    await t.pins.tick();
    const record = join(t.service.folder, "conversation-chat.json");
    expect(JSON.parse(readFileSync(record, "utf8")).readSkillPending).toBe(true);
    expect(t.service.command("assistant-chat").at(-1)).toStartWith("Read .pi/skills/wolfpack-focus-chat/SKILL.md first;");
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

test("both assistants are excluded from cards/counts and routine rows and own-input quiet timing", async () => {
  const t = fixture();
  let now = Date.now();
  const journal = new ActivityJournal({ dir: join(t.root, "activity"), now: () => now += 1000 });
  try {
    const rows = ["work", "assistant", "assistant-chat"].map((session, i) => journal.append({ kind: ACTIVITY_KIND.INPUT, session, source: "browser", bucket: new Date(Date.now() + i * 1000).toISOString() }));
    expect(withoutFocusAssistant(["work", "assistant", "assistant-chat"].map(name => ({ name, pinned: true }))).map(s => s.name)).toEqual(["work"]);
    const page = await localActivitySource("home", "home", journal).read(0, 100);
    expect(withoutAssistantRows(page.rows).map(r => "session" in r && r.session)).toEqual(["work"]);
    expect(page.lastInputAt).toBe(rows[0]!.at);
  } finally { journal.close(); t.close(); }
});
