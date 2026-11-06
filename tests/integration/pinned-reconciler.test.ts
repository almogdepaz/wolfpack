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
    await ctx.focusRuntime.ask("one");
    await ctx.focusRuntime.ask("two");
    expect(sent).toEqual(["one", "two"]);
  } finally { ctx.focusRuntime.stop(); rmSync(root, { recursive: true, force: true }); }
});

test.each(["done", "blocked"] as const)("generic runtime samples a quiet prompt with structured %s status and respects blocked questions", async state => {
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
    service.unpin("assistant");
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
