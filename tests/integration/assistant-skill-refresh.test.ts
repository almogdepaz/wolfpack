import { expect, test, setSystemTime, spyOn } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AssistantService } from "../../src/server/assistant-service.ts";
import { MockBackend } from "../../src/server/mock-backend.ts";
import { createServerContext } from "../../src/server/context.ts";
import { ActivityJournal } from "../../src/server/activity-journal.ts";
import { __resetSessionObservationForTests } from "../../src/server/session-observation.ts";
import { emptyCoverage } from "../../src/focus-coverage.ts";
import { ACTIVITY_KIND } from "../../src/activity-journal.ts";
import { writePrivateJsonFile } from "../../src/persistence.ts";
import type { Config } from "../../src/config.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "focus-skill-"));
  let config: Config = { devDir: root, port: 19876 };
  const service = (skill: string) => new AssistantService({ root, skill, readConfig: () => config, writeConfig: next => { config = next; },
    detectProviders: async () => [{ id: "pi", displayName: "Pi", command: "pi", status: "installed", executablePath: "/fake/pi", version: "1", authStatus: "unknown", loginCommand: "pi" }] });
  let assistant = service("generation one");
  await assistant.enable(true);
  const backend = new MockBackend();
  let journal = new ActivityJournal({ dir: join(root, "activity") });
  const launches: string[][] = [];
  const kills: string[] = [];
  const sends: string[] = [];
  const create = backend.createSession.bind(backend);
  backend.createSession = async (...args) => { launches.push([...(args[4]?.pinnedCommand ?? [])]); return create(...args); };
  const kill = backend.killSessionById.bind(backend);
  backend.killSessionById = async id => { kills.push(id); await kill(id); };
  backend.sendAndObserveSubmission = async (_id, options) => { sends.push(options.text); return { delivery: "delivered", outcome: "submitted", observedMs: 1 }; };
  let ctx = createServerContext({ backend, config, assistantService: assistant, activityJournal: journal });
  ctx.focusRuntime.start();
  await ctx.focusRuntime.pins.tick();
  let at = Date.now();
  const state = (state: "done" | "working" | "blocked" = "done") => backend.setProgramStatus("assistant", { id: "", state, ...(state === "blocked" && { kind: "question" as const }), updatedAtMs: ++at });
  state();
  const transcript = join(assistant.folder, "sessions/20261110_focus-assistant.jsonl");
  const record = join(assistant.folder, "conversation.json");
  const archive = join(assistant.folder, "sessions/archive");
  const archived = () => existsSync(archive) ? readdirSync(archive).flatMap(dir => readdirSync(join(archive, dir)).map(file => readFileSync(join(archive, dir, file), "utf8"))) : [];
  return {
    root, backend, launches, kills, sends, state, transcript, record, archive, archived,
    get ctx() { return ctx; }, get assistant() { return assistant; },
    async reopen(skill = "generation two", reopenJournal = false) {
      ctx.focusRuntime.stop();
      if (reopenJournal) { journal.close(); journal = new ActivityJournal({ dir: join(root, "activity") }); }
      assistant = service(skill);
      ctx = createServerContext({ backend, config, assistantService: assistant, activityJournal: journal });
      ctx.focusRuntime.start();
      await ctx.focusRuntime.pins.tick();
    },
    close() { ctx.focusRuntime.stop(); journal.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("same seeded digest survives server and broker restarts and resumes the exact file", async () => {
  const t = await fixture();
  try {
    expect(existsSync(t.record)).toBe(true);
    const record = readFileSync(t.record, "utf8");
    expect(JSON.parse(record).digest).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(t.record).mode & 0o777).toBe(0o600);
    writeFileSync(t.transcript, "same conversation");
    await t.reopen("generation one");
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual([]);
    t.backend.setSessions([]);
    t.ctx.focusRuntime.pins.reset("assistant");
    await t.ctx.focusRuntime.pins.tick();
    expect(t.launches.at(-1)).toContain(t.transcript);
    expect(readFileSync(t.record, "utf8")).toBe(record);
    expect(readFileSync(t.transcript, "utf8")).toBe("same conversation");
    expect(t.archived()).toEqual([]);
  } finally { t.close(); }
});

test("changed skill archives every old conversation without overwrite, then launches fresh", async () => {
  const t = await fixture();
  try {
    writeFileSync(t.transcript, "first conversation");
    const secondOld = join(t.assistant.folder, "sessions/20261109_focus-assistant.jsonl");
    writeFileSync(secondOld, "older conversation");
    const other = join(t.assistant.folder, "sessions/user-session.jsonl");
    writeFileSync(other, "unrelated conversation");
    await t.reopen();
    await Promise.all([t.ctx.focusRuntime.tick(), t.ctx.focusRuntime.tick()]);
    expect(t.kills).toEqual(["mock:assistant"]);
    expect(t.launches.at(-1)).toContain("--session-id");
    expect(t.launches.at(-1)).not.toContain("--session");
    expect(t.archived().sort()).toEqual(["first conversation", "older conversation"]);
    expect(existsSync(t.transcript)).toBe(false);
    expect(readFileSync(other, "utf8")).toBe("unrelated conversation");
    // Reusing the same basename on the next generation must never overwrite an archive.
    writeFileSync(t.transcript, "second conversation");
    await t.reopen("generation three");
    await t.ctx.focusRuntime.tick();
    expect(t.archived().sort()).toEqual(["first conversation", "older conversation", "second conversation"]);
    expect(statSync(t.archive).mode & 0o777).toBe(0o700);
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toHaveLength(2);
  } finally { t.close(); }
});

test.each(["working", "blocked"] as const)("skill change never interrupts %s; relaunches at the next idle sample", async state => {
  const t = await fixture();
  try {
    writeFileSync(t.transcript, "unfinished turn");
    t.state(state);
    await t.reopen();
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual([]);
    expect(readFileSync(t.transcript, "utf8")).toBe("unfinished turn");
    t.state();
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual(["mock:assistant"]);
    expect(t.archived()).toEqual(["unfinished turn"]);
  } finally { t.close(); }
});

test("pending and outstanding sends drain before a skill relaunch", async () => {
  const t = await fixture();
  try {
    writeFileSync(t.transcript, "conversation");
    await t.reopen();
    t.ctx.focusRuntime.queue.enqueue("mock:assistant", "already queued");
    await t.ctx.focusRuntime.tick();
    expect(t.sends).toEqual(["already queued"]);
    expect(t.kills).toEqual([]);
    await t.ctx.focusRuntime.tick(); // unchanged idle token cannot retire an outstanding turn
    expect(t.kills).toEqual([]);
    t.state(); // completed even if the whole turn fell between polls
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual(["mock:assistant"]);
  } finally { t.close(); }
});

test("unacknowledged persisted inbox blocks rotation until ack, even with an empty send queue", async () => {
  const t = await fixture();
  try {
    writeFileSync(t.transcript, "pending inbox conversation");
    const file = "catch-up-20261110T100000Z.json";
    const coverage = emptyCoverage();
    coverage.inbox = { file, routine: "catch-up", createdAt: "2026-11-10T10:00:00.000Z", sends: 1, lastSentAt: "2026-11-10T10:00:00.000Z", surfaced: false, through: {} };
    writePrivateJsonFile(join(t.assistant.folder, "routines.json"), coverage);
    mkdirSync(join(t.assistant.folder, "inbox"), { recursive: true });
    writeFileSync(join(t.assistant.folder, "inbox", file), "pending inbox");
    await t.reopen();
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual([]);
    await t.ctx.focusRuntime.routines.ack(file);
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual(["mock:assistant"]);
    expect(t.archived()).toEqual(["pending inbox conversation"]);
  } finally { t.close(); }
});

test("explicit disable and remote-home selection suppress deferred skill relaunch", async () => {
  const t = await fixture();
  try {
    writeFileSync(t.transcript, "keep");
    await t.reopen();
    t.ctx.config!.focus = { home: "different-installation" };
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual([]);
    delete t.ctx.config!.focus;
    t.assistant.unpin("assistant");
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual([]);
    expect(t.assistant.enabled).toBe(false);
    expect(readFileSync(t.transcript, "utf8")).toBe("keep");
  } finally { t.close(); }
});

test("legacy conversations with no digest are archived once at the next idle launch", async () => {
  const t = await fixture();
  try {
    rmSync(t.record, { force: true });
    writeFileSync(t.transcript, "legacy conversation");
    await t.reopen("generation one");
    await t.ctx.focusRuntime.tick();
    expect(t.archived()).toEqual(["legacy conversation"]);
    expect(t.launches.at(-1)).toContain("--session-id");
    const count = t.launches.length;
    await t.ctx.focusRuntime.tick();
    expect(t.launches).toHaveLength(count);
  } finally { t.close(); }
});

test("malformed conversation state fails closed without creating or removing conversations", async () => {
  const t = await fixture();
  try {
    writeFileSync(t.transcript, "keep this");
    writeFileSync(t.record, "{bad json");
    await expect(t.ctx.focusRuntime.tick()).rejects.toThrow("malformed");
    expect(t.kills).toEqual([]);
    t.backend.setSessions([]);
    t.ctx.focusRuntime.pins.reset("assistant");
    await t.ctx.focusRuntime.pins.tick();
    expect(await t.backend.list()).toEqual([]);
    expect(t.ctx.focusRuntime.pins.errors.assistant).toContain("malformed");
    expect(readFileSync(t.transcript, "utf8")).toBe("keep this");
    expect(readFileSync(t.record, "utf8")).toBe("{bad json");
  } finally { t.close(); }
});

test("custom AGENTS is preserved and digested; a missing seed is repaired and first routine says read skill first", async () => {
  const t = await fixture();
  try {
    const agents = join(t.assistant.folder, "AGENTS.md");
    const original = readFileSync(agents, "utf8");
    expect(original).toContain("Read .pi/skills/wolfpack-focus/SKILL.md before working");
    writeFileSync(t.transcript, "old AGENTS conversation");
    writeFileSync(agents, "custom user instructions");
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual(["mock:assistant"]);
    expect(readFileSync(agents, "utf8")).toBe("custom user instructions");
    rmSync(agents);
    t.assistant.refreshSkill();
    expect(readFileSync(agents, "utf8")).toBe(original);
    // Empty activity intentionally sends nothing: supply real private journal work.
    t.ctx.activityJournal.append({ kind: ACTIVITY_KIND.TASK_UPDATED, taskId: "private-work", eventType: "updated" });
    await t.ctx.focusRuntime.routines.tick({ manual: true });
    await t.ctx.focusRuntime.tick();
    expect(t.sends[0]).toMatch(/^Read \.pi\/skills\/wolfpack-focus\/SKILL\.md first; process inbox inbox\//);
  } finally { t.close(); }
});

test.each(["working", "missing"] as const)("the final broker fence rejects %s status even without a changed timestamp", async late => {
  const t = await fixture();
  try {
    writeFileSync(t.transcript, "do not interrupt");
    await t.reopen();
    const list = t.backend.listSessionFacts.bind(t.backend);
    let snapshots = 0;
    let injected = false;
    t.backend.listSessionFacts = async () => {
      // Idle sampling reads dashboard + raw facts; change the broker at its final pre-kill read.
      if (++snapshots === 3) {
        const original = (await list()).find(f => f.name === "assistant")!.programStatus!;
        t.backend.setProgramStatus("assistant", late === "missing" ? undefined : { ...original, state: "working" });
        injected = true;
      }
      return list();
    };
    await t.ctx.focusRuntime.tick();
    expect(injected).toBe(true);
    expect(t.kills).toEqual([]);
    expect(readFileSync(t.transcript, "utf8")).toBe("do not interrupt");
  } finally { t.close(); }
});

test("the rotation gate waits for routine work and sees the inbox it publishes, not an earlier empty snapshot", async () => {
  const t = await fixture();
  try {
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pull = t.ctx.focusRuntime.routines.withNoInbox(async () => {
      entered();
      await blocked;
      const coverage = emptyCoverage();
      coverage.inbox = { file: "catch-up-20261110T100000Z.json", routine: "catch-up", createdAt: "2026-11-10T10:00:00.000Z", sends: 0, lastSentAt: null, surfaced: false, through: {} };
      writePrivateJsonFile(join(t.assistant.folder, "routines.json"), coverage);
    });
    await started;
    let rotated = false;
    const rotation = t.ctx.focusRuntime.routines.withNoInbox(async () => { rotated = true; });
    release();
    await Promise.all([pull, rotation]);
    expect(rotated).toBe(false);
  } finally { t.close(); }
});

test("a changed seeded file cannot be silently resumed even if launch reseeding restores the bundled bytes", async () => {
  const t = await fixture();
  try {
    writeFileSync(t.transcript, "before seed drift");
    writeFileSync(join(t.assistant.folder, ".pi/skills/wolfpack-focus/SKILL.md"), "changed seed");
    await t.ctx.focusRuntime.tick();
    expect(t.archived()).toEqual(["before seed drift"]);
    expect(t.launches.at(-1)).toContain("--session-id");
  } finally { t.close(); }
});

test("the running server's one-second timer performs the deferred refresh without a dashboard poll", async () => {
  const t = await fixture();
  try {
    writeFileSync(t.transcript, "timer-owned refresh");
    await t.reopen();
    const deadline = Date.now() + 5000;
    while (!t.kills.length && Date.now() < deadline) await Bun.sleep(20);
    expect(t.kills).toEqual(["mock:assistant"]);
    expect(t.archived()).toEqual(["timer-owned refresh"]);
  } finally { t.close(); }
});

test.each(["unchanged", "advanced", "missing-final", "missing-sample"] as const)("SR-R1: fallback idle output fence (%s)", async output => {
  const t = await fixture();
  try {
    writeFileSync(t.transcript, "keep the active turn");
    t.backend.setProgramStatus("assistant", undefined);
    t.backend.setCapturePane(async () => "\n› ");
    if (output === "missing-sample") t.backend.setOutputSequence("assistant", undefined);
    await t.reopen();
    await t.ctx.focusRuntime.status();
    setSystemTime(new Date(Date.now() + 6000)); // establish real observer quiet history without advancing interval timers
    const list = t.backend.listSessionFacts.bind(t.backend);
    let reads = 0;
    t.backend.listSessionFacts = async () => {
      if (++reads === 3 && output !== "unchanged" && output !== "missing-sample") {
        t.backend.setOutputSequence("assistant", output === "advanced" ? "999" : undefined);
        t.backend.setCapturePane(async () => "working on the next turn…");
      }
      return list();
    };
    await t.ctx.focusRuntime.tick();
    if (output === "unchanged") {
      expect(t.kills).toEqual(["mock:assistant"]);
      expect(t.archived()).toEqual(["keep the active turn"]);
    } else {
      expect(t.kills).toEqual([]);
      expect(readFileSync(t.transcript, "utf8")).toBe("keep the active turn");
    }
  } finally { setSystemTime(); __resetSessionObservationForTests(); t.close(); }
});

test("SR-R2: stop during an awaited kill revokes archive/create; a later start can reconcile", async () => {
  const t = await fixture();
  let release!: () => void;
  let arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const killing = new Promise<void>(resolve => { arrived = resolve; });
  let flight: Promise<void> | undefined;
  try {
    writeFileSync(t.transcript, "shutdown owns this conversation");
    await t.reopen();
    const kill = t.backend.killSessionById.bind(t.backend);
    t.backend.killSessionById = async id => { await kill(id); arrived(); await held; };
    flight = t.ctx.focusRuntime.tick();
    await Promise.race([killing, flight.then(() => { throw new Error("rotation ended before reaching the held kill"); })]);
    t.ctx.focusRuntime.stop();
    const launches = t.launches.length;
    release();
    await flight;
    expect(t.launches).toHaveLength(launches);
    expect(t.archived()).toEqual([]);
    expect(readFileSync(t.transcript, "utf8")).toBe("shutdown owns this conversation");
    t.ctx.focusRuntime.pins.reset("assistant"); // explicit later start, not a crash-backoff timing assertion
    t.ctx.focusRuntime.start();
    await t.ctx.focusRuntime.pins.tick();
    expect(t.launches).toHaveLength(launches + 1);
    expect(t.archived()).toEqual(["shutdown owns this conversation"]);
  } finally { release(); await flight; t.close(); }
});

test("SR-R2: a new runtime lifetime cannot revive an old held rotation or clear new-start errors", async () => {
  const t = await fixture();
  let release!: () => void;
  let arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const killing = new Promise<void>(resolve => { arrived = resolve; });
  let flight: Promise<void> | undefined;
  try {
    writeFileSync(t.transcript, "old lifetime");
    await t.reopen();
    const kill = t.backend.killSessionById.bind(t.backend);
    t.backend.killSessionById = async id => { await kill(id); arrived(); await held; };
    flight = t.ctx.focusRuntime.tick();
    await Promise.race([killing, flight.then(() => { throw new Error("rotation ended before reaching the held kill"); })]);
    t.ctx.focusRuntime.stop();
    const create = t.backend.createSession.bind(t.backend);
    t.backend.createSession = async () => { throw new Error("new lifetime startup failure"); };
    t.ctx.focusRuntime.pins.reset("assistant");
    t.ctx.focusRuntime.start();
    await t.ctx.focusRuntime.pins.tick();
    t.backend.createSession = create;
    release();
    await flight;
    expect(await t.backend.list()).toEqual([]);
    expect(t.ctx.focusRuntime.pins.errors.assistant).toBe("new lifetime startup failure");
  } finally { release(); await flight; t.close(); }
});

test.each(["viewer", "pendingViewer"] as const)("L3: an interactive %s defers rotation until detached", async which => {
  const t = await fixture();
  const { activePtySessions } = await import("../../src/server/websocket.ts");
  const { default: WebSocket } = await import("ws");
  const before = activePtySessions.get("assistant");
  try {
    writeFileSync(t.transcript, "user draft");
    await t.reopen();
    // Only the existing registry's presence fact is used; no socket transport is constructed.
    activePtySessions.set("assistant", { alive: true, viewer: null, pendingViewer: null, proc: null, [which]: Object.create(WebSocket.prototype) });
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual([]);
    activePtySessions.delete("assistant");
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual(["mock:assistant"]);
  } finally { if (before) activePtySessions.set("assistant", before); else activePtySessions.delete("assistant"); t.close(); }
});

test("L3: every input presence refreshes the 60s gate, including repeats in one journal bucket", async () => {
  const t = await fixture();
  try {
    writeFileSync(t.transcript, "recent user input");
    await t.reopen();
    const at = Date.UTC(2026, 10, 10, 20, 0, 1);
    setSystemTime(new Date(at));
    __resetSessionObservationForTests();
    t.ctx.activityRecorder.notePresence("assistant", "browser");
    setSystemTime(new Date(at + 59_000));
    t.ctx.activityRecorder.notePresence("assistant", "cli"); // same five-minute bucket, still fresh input
    setSystemTime(new Date(at + 60_000));
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual([]);
    setSystemTime(new Date(at + 119_000));
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual(["mock:assistant"]);
  } finally { setSystemTime(); __resetSessionObservationForTests(); t.close(); }
});

test("L3: journaled recent input survives a server restart", async () => {
  const t = await fixture();
  try {
    writeFileSync(t.transcript, "recent input across restart");
    const at = Date.now();
    t.ctx.activityRecorder.notePresence("assistant", "browser");
    await t.reopen("generation two", true);
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual([]);
    setSystemTime(new Date(at + 61_000));
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual(["mock:assistant"]);
  } finally { setSystemTime(); __resetSessionObservationForTests(); t.close(); }
});

test.each(["sessions-link", "archive-link", "sessions-file", "archive-file", "family-link", "family-directory"] as const)("SR-N1/L1: refuse unsafe conversation paths (%s) without modifying them", async kind => {
  const t = await fixture();
  try {
    const sessions = join(t.assistant.folder, "sessions");
    const outside = join(t.root, "outside");
    mkdirSync(outside);
    const target = join(outside, "target.jsonl");
    writeFileSync(target, "outside conversation bytes");
    if (kind === "sessions-link" || kind === "sessions-file") {
      renameSync(sessions, join(t.root, "original-sessions"));
      if (kind === "sessions-link") symlinkSync(outside, sessions, "dir"); else writeFileSync(sessions, "not a directory");
    } else if (kind === "archive-link" || kind === "archive-file") {
      rmSync(t.archive, { recursive: true, force: true });
      if (kind === "archive-link") symlinkSync(outside, t.archive, "dir"); else writeFileSync(t.archive, "not a directory");
    } else {
      if (kind === "family-link") symlinkSync(target, t.transcript); else mkdirSync(t.transcript);
      expect(t.assistant.command()).not.toContain(t.transcript); // retain the read-only regular-file preview filter
    }
    const record = readFileSync(t.record, "utf8");
    const launches = t.launches.length;
    t.backend.setSessions([]);
    t.ctx.focusRuntime.pins.reset("assistant");
    await t.ctx.focusRuntime.pins.tick();
    expect(t.launches).toHaveLength(launches);
    expect(t.ctx.focusRuntime.pins.errors.assistant).toMatch(/real directory|regular file/);
    expect(readFileSync(t.record, "utf8")).toBe(record);
    expect(readFileSync(target, "utf8")).toBe("outside conversation bytes");
    if (kind === "family-link") expect(lstatSync(t.transcript).isSymbolicLink()).toBe(true);
    if (kind === "archive-link") expect(readdirSync(outside)).toEqual(["target.jsonl"]);
  } finally { t.close(); }
});

test("D1: the first delivered routine alone gets read-first, surviving restarts before and after it", async () => {
  const t = await fixture();
  try {
    writeFileSync(t.transcript, "resumable conversation");
    await t.reopen("generation one"); // fresh conversation, but no routine sent before server restart
    t.ctx.activityJournal.append({ kind: ACTIVITY_KIND.TASK_UPDATED, taskId: "first", eventType: "updated" });
    await t.ctx.focusRuntime.routines.tick({ manual: true });
    await t.ctx.focusRuntime.tick();
    expect(t.sends[0]).toMatch(/^Read \.pi\/skills\/wolfpack-focus\/SKILL\.md first; process inbox inbox\//);
    const inbox = JSON.parse(readFileSync(join(t.assistant.folder, "routines.json"), "utf8")).inbox;
    await t.ctx.focusRuntime.routines.ack(inbox.file);
    await t.reopen("generation one", true); // keep the same conversation and the consumed persistent flag
    setSystemTime(new Date(Date.now() + 2000)); // distinct routine filename, not a duplicate ack identity
    t.state();
    t.ctx.activityJournal.append({ kind: ACTIVITY_KIND.TASK_UPDATED, taskId: "second", eventType: "updated" });
    await t.ctx.focusRuntime.routines.tick({ manual: true });
    await t.ctx.focusRuntime.tick();
    expect(t.sends).toHaveLength(2);
    expect(t.sends[1]).toStartWith("process inbox inbox/");
    expect(JSON.parse(readFileSync(t.record, "utf8")).readSkillPending).toBe(false);
  } finally { setSystemTime(); __resetSessionObservationForTests(); t.close(); }
});

test("D1: enqueuing then discarding an undelivered routine does not consume the first-send flag", async () => {
  const t = await fixture();
  try {
    t.state("working");
    t.ctx.activityJournal.append({ kind: ACTIVITY_KIND.TASK_UPDATED, taskId: "waiting", eventType: "updated" });
    await t.ctx.focusRuntime.routines.tick({ manual: true });
    await t.ctx.focusRuntime.tick();
    expect(t.sends).toEqual([]);
    expect(t.ctx.focusRuntime.queue.size).toBe(1);
    t.ctx.focusRuntime.queue.clear();
    expect(JSON.parse(readFileSync(t.record, "utf8")).readSkillPending).toBe(true);
  } finally { t.close(); }
});

test.each(["not_delivered", "unverified"] as const)("D1: first-turn flag follows actual send outcome (%s)", async outcome => {
  const t = await fixture();
  try {
    t.backend.sendAndObserveSubmission = async () => outcome === "not_delivered"
      ? { delivery: "not_delivered", outcome, reason: "target_exited", observedMs: 0 }
      : { delivery: "delivered", outcome, observedMs: 1 };
    t.ctx.focusRuntime.queue.enqueue("mock:assistant", "process inbox inbox/test.json", undefined, "routine");
    await t.ctx.focusRuntime.tick();
    expect(JSON.parse(readFileSync(t.record, "utf8")).readSkillPending).toBe(outcome === "not_delivered");
  } finally { t.close(); }
});

test("D1: a late delivered result cannot consume a different conversation generation's pending prefix", async () => {
  const t = await fixture();
  let release!: () => void;
  let arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const sending = new Promise<void>(resolve => { arrived = resolve; });
  let flight: Promise<void> | undefined;
  try {
    writeFileSync(t.transcript, "old conversation");
    const old = JSON.parse(readFileSync(t.record, "utf8")).generation;
    t.backend.sendAndObserveSubmission = async () => { arrived(); await held; return { delivery: "delivered", outcome: "submitted", observedMs: 1 }; };
    t.ctx.focusRuntime.queue.enqueue("mock:assistant", "process inbox inbox/test.json", undefined, "routine");
    flight = t.ctx.focusRuntime.tick();
    await sending;
    t.backend.setSessions([]); // broker replacement while the old result is still in flight
    writeFileSync(join(t.assistant.folder, "AGENTS.md"), "new generation");
    t.ctx.focusRuntime.pins.reset("assistant");
    await t.ctx.focusRuntime.pins.tick();
    expect(JSON.parse(readFileSync(t.record, "utf8")).generation).not.toBe(old);
    release();
    await flight;
    expect(JSON.parse(readFileSync(t.record, "utf8")).readSkillPending).toBe(true);
  } finally { release(); await flight; t.close(); }
});

test("L5: scheduled tick warnings are latched until error change or recovery", async () => {
  const t = await fixture();
  const output: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const capture = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    output.push(String(chunk));
    // Preserve both native overloads and complete diagnostics in the private command log.
    return typeof encoding === "function" ? write(chunk, encoding) : write(chunk, encoding, callback);
  });
  try {
    const record = readFileSync(t.record, "utf8");
    const agents = join(t.assistant.folder, "AGENTS.md");
    const original = readFileSync(agents, "utf8");
    let ticks = 0;
    const tick = t.ctx.focusRuntime.tick.bind(t.ctx.focusRuntime);
    t.ctx.focusRuntime.tick = () => tick().finally(() => { ticks++; });
    const waitTicks = async (count: number) => {
      const target = ticks + count, deadline = Date.now() + 3500;
      while (ticks < target && Date.now() < deadline) await Bun.sleep(20);
      expect(ticks).toBeGreaterThanOrEqual(target);
    };
    const warnings = () => output.flatMap(s => s.split("\n")).filter(s => {
      try { return JSON.parse(s).msg === "assistant runtime unavailable"; } catch { return false; }
    });
    writeFileSync(t.record, "{bad json");
    await waitTicks(2);
    expect(warnings()).toHaveLength(1);
    writeFileSync(t.record, record);
    rmSync(agents);
    await waitTicks(2);
    expect(warnings()).toHaveLength(2);
    writeFileSync(agents, original);
    writeFileSync(t.record, "{bad json");
    await waitTicks(1);
    expect(warnings()).toHaveLength(3);
    writeFileSync(t.record, record);
    await waitTicks(1); // successful tick resets the outage latch
    writeFileSync(t.record, "{bad json");
    await waitTicks(1);
    expect(warnings()).toHaveLength(4);
  } finally { capture.mockRestore(); t.close(); }
}, 15000);

test("a configured non-Pi assistant is not rotated by the managed skill protocol", async () => {
  const t = await fixture();
  try {
    writeFileSync(t.transcript, "custom harness conversation");
    t.ctx.config!.pinnedSessions![0] = { name: "assistant", cwd: t.assistant.folder, command: ["hermes", "--tui"], harness: "hermes" };
    writeFileSync(join(t.assistant.folder, "AGENTS.md"), "changed instructions");
    await t.ctx.focusRuntime.tick();
    expect(t.kills).toEqual([]);
    expect(t.archived()).toEqual([]);
    expect(readFileSync(t.transcript, "utf8")).toBe("custom harness conversation");
  } finally { t.close(); }
});
