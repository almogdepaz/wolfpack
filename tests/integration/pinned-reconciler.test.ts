import { expect, test } from "bun:test";
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
