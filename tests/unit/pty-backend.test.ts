import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PtyBackend } from "../../src/server/pty-backend";

// PtyBackend spawns real PTY processes — these are integration-ish tests.
// They use short-lived commands and small timeouts.

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("PtyBackend", () => {
  let backend: PtyBackend;

  beforeEach(() => {
    process.env.WOLFPACK_TEST = "1";
    backend = new PtyBackend();
  });

  afterEach(async () => {
    // Kill all sessions
    const sessions = await backend.list();
    for (const name of sessions) {
      await backend.killSession(name);
    }
  });

  test("list returns empty initially", async () => {
    expect(await backend.list()).toEqual([]);
  });

  test("hasSession returns false for nonexistent", async () => {
    expect(await backend.hasSession("nope")).toBe(false);
  });

  test("sessionDir returns undefined for nonexistent", () => {
    expect(backend.sessionDir("nope")).toBeUndefined();
  });

  test("createSession + list + hasSession + sessionDir", async () => {
    await backend.createSession("test1", "/tmp", "shell", () => ({ agentCmd: "shell" }));
    expect(await backend.list()).toEqual(["test1"]);
    expect(await backend.hasSession("test1")).toBe(true);
    expect(backend.sessionDir("test1")).toBe("/tmp");
  });

  test("duplicate session throws", async () => {
    await backend.createSession("dup", "/tmp", "shell", () => ({ agentCmd: "shell" }));
    try {
      await backend.createSession("dup", "/tmp", "shell", () => ({ agentCmd: "shell" }));
      expect(true).toBe(false); // should not reach
    } catch (e: any) {
      expect(e.code).toBe("DUPLICATE_SESSION");
    }
  });

  test("killSession removes session", async () => {
    await backend.createSession("kill-me", "/tmp", "shell", () => ({ agentCmd: "shell" }));
    expect(await backend.hasSession("kill-me")).toBe(true);
    await backend.killSession("kill-me");
    expect(await backend.hasSession("kill-me")).toBe(false);
    expect(await backend.list()).toEqual([]);
  });

  test("killSession on nonexistent is no-op", async () => {
    await backend.killSession("ghost"); // should not throw
  });

  test("capturePane returns empty for nonexistent", async () => {
    expect(await backend.capturePane("nope")).toBe("");
  });

  test("capturePane captures PTY output", async () => {
    await backend.createSession("echo-test", "/tmp", "shell", () => ({ agentCmd: "shell" }));
    // Explicitly produce output — shell prompt timing varies
    await sleep(300);
    await backend.send("echo-test", "echo PTY_CAPTURE_OK");
    await sleep(500);
    const output = await backend.capturePane("echo-test");
    expect(output).toContain("PTY_CAPTURE_OK");
  });

  test("send writes to PTY", async () => {
    await backend.createSession("send-test", "/tmp", "shell", () => ({ agentCmd: "shell" }));
    await sleep(300);
    await backend.send("send-test", "echo WOLFPACK_PTY_TEST_MARKER");
    await sleep(500);
    const output = await backend.capturePane("send-test");
    expect(output).toContain("WOLFPACK_PTY_TEST_MARKER");
  });

  test("resize does not throw", async () => {
    await backend.createSession("resize-test", "/tmp", "shell", () => ({ agentCmd: "shell" }));
    await sleep(200);
    // Should not throw
    await backend.resize("resize-test", 80, 24);
  });

  test("resize on nonexistent is no-op", async () => {
    await backend.resize("ghost", 80, 24); // should not throw
  });

  test("sendKey does not throw for known keys", async () => {
    await backend.createSession("key-test", "/tmp", "shell", () => ({ agentCmd: "shell" }));
    await sleep(200);
    await backend.sendKey("key-test", "Enter");
    await backend.sendKey("key-test", "C-c");
  });

  test("cleanupOrphans is a no-op (exit callback handles cleanup)", async () => {
    await backend.createSession("orphan", "/tmp", "shell", () => ({ agentCmd: "shell" }));
    const session = backend.__getSession("orphan");
    expect(session).toBeDefined();
    session!.alive = false;
    // cleanupOrphans is a no-op — PTY sessions are cleaned up by the exit callback.
    // Dead sessions with alive=false shouldn't exist in the map in practice.
    await backend.cleanupOrphans();
    // Session still in map (cleanup is the exit callback's job, not cleanupOrphans)
    expect(await backend.list()).toContain("orphan");
  });

  test("capturePaneForTriage caches", async () => {
    await backend.createSession("triage-test", "/tmp", "shell", () => ({ agentCmd: "shell" }));
    await sleep(300);
    const first = await backend.capturePaneForTriage("triage-test");
    // Send something to change the buffer
    await backend.send("triage-test", "echo CHANGE", true);
    // Immediate second call should return cached value
    const second = await backend.capturePaneForTriage("triage-test");
    expect(second).toBe(first);
  });
});
