import { expect, test, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PinnedSessionService } from "../../src/server/pinned-session-service.ts";
import { MockBackend } from "../../src/server/mock-backend.ts";

test("fake broker restart recreates pinned session once; config removal never kills a live session", async () => {
  const root = mkdtempSync(join(tmpdir(), "focus-pins-"));
  const backend = new MockBackend();
  let pins = [{ name: "assistant", cwd: root, command: ["pi"], harness: "pi" }];
  let now = 100000;
  const service = new PinnedSessionService({ backend, pins: () => pins, now: () => now });
  try {
    await Promise.all([service.tick(), service.tick()]);
    expect(await backend.list()).toEqual(["assistant"]);
    backend.lastCreateArgs = null;
    await service.tick();
    expect(backend.lastCreateArgs).toBeNull();
    backend.setSessions([]); // broker lost all PTYs, not a server restart
    await service.tick();
    expect(await backend.list()).toEqual([]); // crash backoff, not a hot loop
    now += 1000;
    await service.tick();
    expect(await backend.list()).toEqual(["assistant"]);
    expect((backend.lastCreateArgs as { cwd: string } | null)?.cwd).toBe(root);
    pins = [];
    await service.tick();
    expect(await backend.list()).toEqual(["assistant"]);
  } finally { service.stop(); rmSync(root, { recursive: true, force: true }); }
});
test.each([false, true])("broker recovery rejects conflicting assistant-directory pins before launching either (reverse=%s)", async reverse => {
  const root = mkdtempSync(join(tmpdir(), "focus-conflicting-pins-"));
  const backend = new MockBackend();
  const assistant = { name: "assistant", cwd: root, command: ["pi"], harness: "pi" };
  const copy = { ...assistant, name: "assistant-copy" };
  let pins = [assistant];
  let now = 100000;
  const service = new PinnedSessionService({ backend, pins: () => pins, now: () => now });
  try {
    await service.tick();
    expect(await backend.list()).toEqual(["assistant"]);
    pins = reverse ? [copy, assistant] : [assistant, copy];
    backend.setSessions([]); // broker restart loses the original writer
    await service.tick();
    now += 100000;
    await Promise.all([service.tick(), service.tick()]);
    expect(await backend.list()).toEqual([]); // reject the entire conflicting ownership before launch
    expect(service.errors.assistant).toContain("assistant directory");
    expect(service.errors[copy.name]).toContain("assistant directory");
    await backend.createSession("assistant", root, "pi", () => ({ agentCmd: "pi" }));
    await service.tick();
    expect(await backend.list()).toEqual(["assistant"]); // never stop or duplicate an existing writer
  } finally { service.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("assistant runtime drains fast completed turns using broker program timestamps", async () => {
  process.env.WOLFPACK_TEST = "1";
  const root = mkdtempSync(join(tmpdir(), "focus-fast-turn-"));
  const { createServerContext } = await import("../../src/server/context.ts");
  const { AssistantService } = await import("../../src/server/assistant-service.ts");
  const folder = join(root, "assistant");
  const backend = new MockBackend();
  await backend.createSession("assistant", folder, "pi", () => ({ agentCmd: "pi" }));
  let at = 1000;
  backend.setProgramStatus("assistant", { id: "", state: "done", updatedAtMs: at });
  const sent: string[] = [];
  backend.sendAndObserveSubmission = async (_id, options) => {
    sent.push(options.text);
    backend.setProgramStatus("assistant", { id: "", state: "done", updatedAtMs: ++at });
    return { delivery: "delivered", outcome: "submitted", observedMs: 1 };
  };
  const config = { devDir: root, port: 19791, pinnedSessions: [{ name: "assistant", cwd: folder, command: ["pi"], harness: "pi" }] };
  const ctx = createServerContext({ backend, config, assistantService: new AssistantService({ root, readConfig: () => config }) });
  try {
    // routine lines reach the assistant bare: there is no ask channel, the user talks to it in its terminal
    ctx.focusRuntime.queue.enqueue((await ctx.focusRuntime.status()).sessionId!, "process inbox inbox/catch-up-1.json", undefined, "routine");
    await ctx.focusRuntime.tick();
    expect(sent).toEqual(["process inbox inbox/catch-up-1.json"]);
  } finally { ctx.focusRuntime.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("a routine send that cannot be verified or is not delivered settles failed for the routine and never sets an assistant error", async () => {
  process.env.WOLFPACK_TEST = "1";
  const root = mkdtempSync(join(tmpdir(), "focus-unverified-send-"));
  const { createServerContext } = await import("../../src/server/context.ts");
  const { AssistantService } = await import("../../src/server/assistant-service.ts");
  const folder = join(root, "assistant");
  const backend = new MockBackend();
  await backend.createSession("assistant", folder, "pi", () => ({ agentCmd: "pi" }));
  backend.setProgramStatus("assistant", { id: "", state: "done", updatedAtMs: 1000 });
  // The mock backend's default observation is `unverified`: the line was written, pi's status did not move within the window.
  const config = { devDir: root, port: 19791, pinnedSessions: [{ name: "assistant", cwd: folder, command: ["pi"], harness: "pi" }] };
  const ctx = createServerContext({ backend, config, assistantService: new AssistantService({ root, readConfig: () => config }) });
  try {
    const outcomes: string[] = [];
    const id = (await ctx.focusRuntime.status()).sessionId!;
    ctx.focusRuntime.queue.enqueue(id, "process inbox inbox/catch-up-1.json", outcome => outcomes.push(outcome), "routine");
    await ctx.focusRuntime.tick();
    // unverified: the routine reports delivery unconfirmed; the assistant status carries no error (the live "assistant failed" bug)
    expect(outcomes).toEqual(["failed"]);
    expect((await ctx.focusRuntime.status()).error).toBeUndefined();
    backend.sendObservation = { delivery: "not_delivered", outcome: "not_delivered", reason: "target_exited", observedMs: 0 };
    // a new idle token: the unverified send's slot is released without waiting for the fence
    backend.setProgramStatus("assistant", { id: "", state: "done", updatedAtMs: 2000 });
    ctx.focusRuntime.queue.enqueue(id, "process inbox inbox/catch-up-2.json", outcome => outcomes.push(outcome), "routine");
    await ctx.focusRuntime.tick();
    expect(outcomes).toEqual(["failed", "failed"]);
    expect((await ctx.focusRuntime.status()).error).toBeUndefined();
    expect(ctx.focusRuntime.queue.size).toBe(0);
  } finally { ctx.focusRuntime.stop(); rmSync(root, { recursive: true, force: true }); }
});

test.each(["done", "blocked", "working"] as const)("generic runtime samples a quiet prompt with structured %s status and respects busy state", async state => {
  process.env.WOLFPACK_TEST = "1";
  const root = mkdtempSync(join(tmpdir(), "focus-generic-runtime-"));
  const { createServerContext } = await import("../../src/server/context.ts");
  const { AssistantService } = await import("../../src/server/assistant-service.ts");
  const { __resetSessionObservationForTests } = await import("../../src/server/session-observation.ts");
  __resetSessionObservationForTests();
  const folder = join(root, "assistant");
  mkdirSync(folder);
  let captures = 0;
  const backend = new MockBackend({ capturePane: async () => { captures++; return "› "; } });
  await backend.createSession("assistant", folder, "hermes", () => ({ agentCmd: "hermes" }), { agentKind: "hermes" });
  const at = Date.now();
  backend.setProgramStatus("assistant", { id: "", state, ...(state === "blocked" && { kind: "question" as const }), updatedAtMs: at });
  const sent: string[] = [];
  backend.sendAndObserveSubmission = async (_id, options) => { sent.push(options.text); return { delivery: "delivered", outcome: "submitted", observedMs: 1 }; };
  const config = { devDir: root, port: 19864, pinnedSessions: [{ name: "assistant", cwd: folder, command: ["hermes"], harness: "hermes" }] };
  const ctx = createServerContext({ backend, config, assistantService: new AssistantService({ root, readConfig: () => config }) });
  try {
    const status = await ctx.focusRuntime.status(); // establish rendered-activity baseline
    const baselineCaptures = captures;
    ctx.focusRuntime.queue.enqueue(status.sessionId!, "queued ask");
    setSystemTime(new Date(at + 6000));
    await ctx.focusRuntime.tick();
    expect(captures).toBeGreaterThan(baselineCaptures);
    expect(sent).toEqual(state === "done" ? ["queued ask"] : []);
    expect(ctx.focusRuntime.queue.size).toBe(state === "done" ? 0 : 1);
  } finally { setSystemTime(); ctx.focusRuntime.stop(); __resetSessionObservationForTests(); rmSync(root, { recursive: true, force: true }); }
});

test("generic runtime retains an outstanding send across a fresh working timestamp with a quiet visible prompt", async () => {
  process.env.WOLFPACK_TEST = "1";
  const root = mkdtempSync(join(tmpdir(), "focus-generic-outstanding-"));
  const { createServerContext } = await import("../../src/server/context.ts");
  const { AssistantService } = await import("../../src/server/assistant-service.ts");
  const { __resetSessionObservationForTests } = await import("../../src/server/session-observation.ts");
  __resetSessionObservationForTests();
  const folder = join(root, "assistant");
  mkdirSync(folder);
  const backend = new MockBackend({ capturePane: async () => "› " });
  await backend.createSession("assistant", folder, "hermes", () => ({ agentCmd: "hermes" }), { agentKind: "hermes" });
  const at = Date.now();
  backend.setProgramStatus("assistant", { id: "", state: "done", updatedAtMs: at });
  const sent: string[] = [];
  backend.sendAndObserveSubmission = async (_id, options) => { sent.push(options.text); return { delivery: "delivered", outcome: "submitted", observedMs: 1 }; };
  const config = { devDir: root, port: 19864, pinnedSessions: [{ name: "assistant", cwd: folder, command: ["hermes"], harness: "hermes" }] };
  const ctx = createServerContext({ backend, config, assistantService: new AssistantService({ root, readConfig: () => config }) });
  try {
    const status = await ctx.focusRuntime.status();
    ctx.focusRuntime.queue.enqueue(status.sessionId!, "first turn");
    ctx.focusRuntime.queue.enqueue(status.sessionId!, "next turn must wait");
    setSystemTime(new Date(at + 6000));
    await ctx.focusRuntime.tick();
    expect(sent).toEqual(["first turn"]);
    setSystemTime(new Date(at + 6001));
    backend.setProgramStatus("assistant", { id: "", state: "working", updatedAtMs: at + 6001 });
    await ctx.focusRuntime.status(); // observe the transition, then leave the visible prompt quiet for six seconds
    setSystemTime(new Date(at + 12001));
    await ctx.focusRuntime.tick();
    expect(sent).toEqual(["first turn"]);
    expect(ctx.focusRuntime.queue.size).toBe(1);
    await ctx.focusRuntime.tick();
    expect(sent).toEqual(["first turn"]);
    setSystemTime(new Date(at + 12002));
    backend.setProgramStatus("assistant", { id: "", state: "done", updatedAtMs: at + 12002 });
    await ctx.focusRuntime.status();
    setSystemTime(new Date(at + 18002));
    await ctx.focusRuntime.tick();
    expect(sent).toEqual(["first turn", "next turn must wait"]);
  } finally { setSystemTime(); ctx.focusRuntime.stop(); __resetSessionObservationForTests(); rmSync(root, { recursive: true, force: true }); }
});

test("reconciler preserves the configured non-pi assistant's effective argv and harness", async () => {
  const root = mkdtempSync(join(tmpdir(), "focus-custom-harness-"));
  const { AssistantService } = await import("../../src/server/assistant-service.ts");
  const folder = join(root, "assistant");
  mkdirSync(folder);
  const pin = { name: "assistant", cwd: folder, command: ["hermes", "--tui", "--conversation", "focus"], harness: "hermes" };
  const config = { devDir: root, port: 19864, pinnedSessions: [pin] };
  const assistant = new AssistantService({ root, readConfig: () => config });
  const backend = new MockBackend();
  const create = backend.createSession.bind(backend);
  let launched: readonly string[] | undefined;
  backend.createSession = async (...args) => { launched = args[4]?.pinnedCommand; return create(...args); };
  const reconciler = new PinnedSessionService({ backend, pins: () => assistant.pins });
  try {
    await reconciler.tick();
    expect(launched).toEqual(pin.command);
    expect((await backend.listIdentities()).assistant?.agentKind).toBe("hermes");
    backend.setSessions([]);
    reconciler.reset("assistant");
    await reconciler.tick();
    expect(launched).toEqual(pin.command);
  } finally { reconciler.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("a pi dialog with no semantic status reports needs-input in /api/focus status, from a bounded screen sample", async () => {
  process.env.WOLFPACK_TEST = "1";
  const root = mkdtempSync(join(tmpdir(), "focus-dialog-status-"));
  const { createServerContext } = await import("../../src/server/context.ts");
  const { AssistantService } = await import("../../src/server/assistant-service.ts");
  const { __resetSessionObservationForTests } = await import("../../src/server/session-observation.ts");
  __resetSessionObservationForTests();
  const folder = join(root, "assistant");
  mkdirSync(folder);
  let captures = 0;
  const dialog = " Trust project folder?\n /x/assistant\n\n → Trust\n   Do not trust\n\n ↑↓ navigate  enter select  escape/ctrl+c cancel\n\n────\n\n\n";
  const backend = new MockBackend({ capturePane: async () => { captures++; return dialog; } });
  await backend.createSession("assistant", folder, "pi", () => ({ agentCmd: "pi" }), { agentKind: "pi" });
  const config = { devDir: root, port: 19865, pinnedSessions: [{ name: "assistant", cwd: folder, command: ["pi"], harness: "pi" }] };
  const ctx = createServerContext({ backend, config, assistantService: new AssistantService({ root, readConfig: () => config }) });
  try {
    const status = await ctx.focusRuntime.status();
    expect(status.state).toBe("needs-input");
    expect(status.idle).toBe(false);
    const after = captures;
    // every dashboard polls /api/focus; the verdict is cached for a few seconds instead of re-reading the screen per request
    await ctx.focusRuntime.status();
    await ctx.focusRuntime.status();
    expect(captures).toBe(after);
    // an ask typed now stays queued (the dialog is not idle), it is not dropped and not sent
    ctx.focusRuntime.queue.enqueue(status.sessionId!, "move ship first");
    await ctx.focusRuntime.tick();
    expect(ctx.focusRuntime.queue.size).toBe(1);
  } finally { ctx.focusRuntime.stop(); __resetSessionObservationForTests(); rmSync(root, { recursive: true, force: true }); }
});

test("a relaunched assistant never shows the previous incarnation's cached verdict", async () => {
  process.env.WOLFPACK_TEST = "1";
  const root = mkdtempSync(join(tmpdir(), "focus-verdict-incarnation-"));
  const { createServerContext } = await import("../../src/server/context.ts");
  const { AssistantService } = await import("../../src/server/assistant-service.ts");
  const { __resetSessionObservationForTests } = await import("../../src/server/session-observation.ts");
  __resetSessionObservationForTests();
  const folder = join(root, "assistant");
  mkdirSync(folder);
  let captures = 0;
  let screen = " Trust project folder?\n /x/assistant\n\n → Trust\n   Do not trust\n\n ↑↓ navigate  enter select  escape/ctrl+c cancel\n";
  const backend = new MockBackend({ capturePane: async () => { captures++; return screen; } });
  await backend.createSession("assistant", folder, "pi", () => ({ agentCmd: "pi" }), { agentKind: "pi" });
  // a disable → enable (or a crash relaunch) gives the same name a new session id
  let incarnation = 1;
  const identities = backend.listIdentities.bind(backend);
  backend.listIdentities = async () => {
    const out = await identities();
    if (out.assistant) out.assistant = { ...out.assistant, wolfpackSessionId: `mock:assistant:${incarnation}` };
    return out;
  };
  const config = { devDir: root, port: 19866, pinnedSessions: [{ name: "assistant", cwd: folder, command: ["pi"], harness: "pi" }] };
  const ctx = createServerContext({ backend, config, assistantService: new AssistantService({ root, readConfig: () => config }) });
  try {
    expect((await ctx.focusRuntime.status()).state).toBe("needs-input");
    const after = captures;
    incarnation = 2;
    screen = "\n\n";
    const relaunched = await ctx.focusRuntime.status();
    expect(relaunched.sessionId).toBe("mock:assistant:2");
    expect(relaunched.state).not.toBe("needs-input");
    expect(captures).toBeGreaterThan(after);
  } finally { ctx.focusRuntime.stop(); __resetSessionObservationForTests(); rmSync(root, { recursive: true, force: true }); }
});

test("enable requires login confirmation, seeds only focus skill, resumes by path", async () => {
  const root = mkdtempSync(join(tmpdir(), "focus-enable-success-"));
  const { AssistantService } = await import("../../src/server/assistant-service.ts");
  let config: import("../../src/config.ts").Config = { devDir: root, port: 19791 };
  const service = new AssistantService({ root, readConfig: () => config, writeConfig: next => { config = next; }, detectProviders: async () => [{ id: "pi", displayName: "Pi", command: "pi", status: "installed", executablePath: "/fake/pi", version: "1.3.0", authStatus: "unknown", loginCommand: "pi" }] });
  try {
    await expect(service.enable()).rejects.toThrow("authentication is unknown");
    expect(existsSync(service.folder)).toBe(false);
    await service.enable(true);
    expect(service.enabled).toBe(true);
    expect(service.command()).toContain("--session-id");
    // the seeded skill lives under <folder>/.pi/, which makes pi 1.3.0 ask "Trust project folder?" on every fresh
    // launch; `--no-approve` skips that dialog without trusting the folder (AGENTS.md and the explicit --skill still
    // load; nothing under <folder>/.pi is executed), so nothing the assistant writes there runs at a relaunch.
    expect(service.command()).toContain("--no-approve");
    expect(service.command()).not.toContain("--approve");
    expect(service.pins[0]?.command).toContain("--no-approve");
    expect(readFileSync(join(service.folder, "AGENTS.md"), "utf8")).toContain("Never kill/create/send");
    expect(existsSync(join(service.folder, ".pi/skills/wolfpack-tailnet-control"))).toBe(false);
    const file = join(service.folder, "sessions/2026_focus-assistant.jsonl");
    writeFileSync(file, "conversation");
    expect(service.command()).toContain(file);
    expect(service.pins[0]?.command).toContain(file);
    expect(service.command()).not.toContain("--session-id");
    writeFileSync(join(service.folder, "AGENTS.md"), "user instructions");
    await service.enable(true);
    expect(readFileSync(join(service.folder, "AGENTS.md"), "utf8")).toBe("user instructions");
    const skill = join(service.folder, ".pi/skills/wolfpack-focus/SKILL.md");
    writeFileSync(skill, "phase 1 skill");
    service.refreshSkill();
    expect(readFileSync(skill, "utf8")).toContain("process inbox");
    // no ask channel: the reseeded skill teaches no `ask: ` lines and no inline reply; the user talks to the assistant in its terminal
    expect(readFileSync(skill, "utf8")).not.toContain("## asks");
    expect(readFileSync(skill, "utf8")).not.toContain("ask: ");
    expect(readFileSync(skill, "utf8")).not.toContain("focus reply");
    service.unpin("assistant");
    writeFileSync(skill, "phase 1 skill");
    service.refreshSkill();
    expect(readFileSync(skill, "utf8")).toBe("phase 1 skill");
    expect(service.enabled).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("enable missing provider writes neither config nor assistant folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "focus-enable-"));
  const { AssistantService } = await import("../../src/server/assistant-service.ts");
  let writes = 0;
  const service = new AssistantService({ root, readConfig: () => ({ devDir: root, port: 19791 }), writeConfig: () => { writes++; }, detectProviders: async () => [{ id: "pi", displayName: "Pi", command: "pi", status: "missing", installGuidance: "install pi" }] });
  try {
    await expect(service.enable(true)).rejects.toThrow("install pi");
    expect(writes).toBe(0);
    expect(existsSync(join(root, "assistant"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
