import { describe, test, expect, beforeEach } from "bun:test";
import { MockBackend } from "../../src/server/mock-backend";
import {
  BackendRouter,
  __resetBackend,
  type SessionBackend,
  type PtyBackendMethods,
} from "../../src/server/backend";

/**
 * Create a BackendRouter with two MockBackends injected, bypassing
 * the real PtyBackend/TmuxBackend constructors via Object.create.
 */
function createTestRouter(opts?: { default?: "pty" | "tmux" }): {
  router: BackendRouter;
  ptyMock: MockBackend;
  tmuxMock: MockBackend;
} {
  const ptyMock = new MockBackend();
  const tmuxMock = new MockBackend();

  // Skip constructor entirely — avoids spawning a real PtyBackend
  const router = Object.create(BackendRouter.prototype) as BackendRouter;
  (router as any).pty = ptyMock;
  (router as any).tmux = tmuxMock;
  (router as any).ownership = new Map();
  (router as any)._tmuxAvailable = true;
  (router as any)._defaultBackend = opts?.default ?? "pty";

  return { router, ptyMock, tmuxMock };
}

const loadSettings = () => ({ agentCmd: "shell" });

describe("BackendRouter", () => {
  beforeEach(() => {
    process.env.WOLFPACK_TEST = "1";
    __resetBackend();
  });

  // ── list() ownership reconciliation ──

  describe("list()", () => {
    test("merges sessions from both backends", async () => {
      const { router, ptyMock, tmuxMock } = createTestRouter();
      ptyMock.setSessions(["pty-1", "pty-2"]);
      tmuxMock.setSessions(["tmux-1"]);

      const list = await router.list();
      expect(list).toEqual(["pty-1", "pty-2", "tmux-1"]);
    });

    test("deduplicates same-named sessions, PTY wins ownership", async () => {
      const { router, ptyMock, tmuxMock } = createTestRouter();
      ptyMock.setSessions(["shared"]);
      tmuxMock.setSessions(["shared"]);

      const list = await router.list();
      expect(list).toEqual(["shared"]);
      expect(router.getBackendTypeForSession("shared")).toBe("pty");
    });

    test("prunes stale ownership entries", async () => {
      const { router, ptyMock, tmuxMock } = createTestRouter();
      ptyMock.setSessions(["alive", "stale"]);
      await router.list(); // establishes ownership
      expect((router as any).ownership.has("stale")).toBe(true);

      ptyMock.setSessions(["alive"]); // "stale" removed
      tmuxMock.setSessions([]);
      await router.list();

      // "stale" should be pruned from ownership map (not just falling back to default)
      expect((router as any).ownership.has("stale")).toBe(false);
    });

    test("returns sorted list", async () => {
      const { router, ptyMock, tmuxMock } = createTestRouter();
      ptyMock.setSessions(["zebra"]);
      tmuxMock.setSessions(["alpha"]);

      const list = await router.list();
      expect(list).toEqual(["alpha", "zebra"]);
    });
  });

  // ── createSession() ──

  describe("createSession()", () => {
    test("creates session on default backend (pty)", async () => {
      const { router, ptyMock } = createTestRouter({ default: "pty" });
      await router.createSession("new-sess", "/tmp", undefined, loadSettings);

      expect(await ptyMock.hasSession("new-sess")).toBe(true);
      expect(router.getBackendTypeForSession("new-sess")).toBe("pty");
    });

    test("creates session on tmux when default is tmux", async () => {
      const { router, tmuxMock } = createTestRouter({ default: "tmux" });
      await router.createSession("new-sess", "/tmp", undefined, loadSettings);

      expect(await tmuxMock.hasSession("new-sess")).toBe(true);
      expect(router.getBackendTypeForSession("new-sess")).toBe("tmux");
    });

    test("rejects duplicate across pty backend", async () => {
      const { router, ptyMock } = createTestRouter();
      ptyMock.setSessions(["existing"]);

      await expect(
        router.createSession("existing", "/tmp", undefined, loadSettings),
      ).rejects.toThrow("duplicate session");
    });

    test("rejects duplicate across tmux backend", async () => {
      const { router, tmuxMock } = createTestRouter();
      tmuxMock.setSessions(["existing"]);

      await expect(
        router.createSession("existing", "/tmp", undefined, loadSettings),
      ).rejects.toThrow("duplicate session");
    });

    test("rolls back ownership on creation failure", async () => {
      const { router, ptyMock } = createTestRouter({ default: "pty" });
      // Make createSession throw
      (ptyMock as any).createSession = async () => { throw new Error("spawn failed"); };

      await expect(
        router.createSession("fail-sess", "/tmp", undefined, loadSettings),
      ).rejects.toThrow("spawn failed");

      // Ownership entry should be deleted (not just falling back to default)
      expect((router as any).ownership.has("fail-sess")).toBe(false);
      const list = await router.list();
      expect(list).not.toContain("fail-sess");
    });
  });

  // ── routing delegation ──

  describe("routing", () => {
    test("routes operations to correct backend by ownership", async () => {
      const { router, ptyMock, tmuxMock } = createTestRouter();
      ptyMock.setSessions(["pty-sess"]);
      tmuxMock.setSessions(["tmux-sess"]);
      await router.list(); // reconcile ownership

      expect(await router.hasSession("pty-sess")).toBe(true);
      expect(await router.hasSession("tmux-sess")).toBe(true);

      // Kill from correct backend
      await router.killSession("tmux-sess");
      expect(await tmuxMock.hasSession("tmux-sess")).toBe(false);
      expect(await ptyMock.hasSession("pty-sess")).toBe(true);
    });

    test("routes send/sendKey/resize/capturePane to correct backend", async () => {
      const { router, ptyMock, tmuxMock } = createTestRouter();
      ptyMock.setSessions(["pty-sess"]);
      tmuxMock.setSessions(["tmux-sess"]);
      await router.list();

      // capturePane routes to owning backend
      ptyMock.setCapturePane(async (s) => s === "pty-sess" ? "pty-output" : "");
      tmuxMock.setCapturePane(async (s) => s === "tmux-sess" ? "tmux-output" : "");
      expect(await router.capturePane("pty-sess")).toBe("pty-output");
      expect(await router.capturePane("tmux-sess")).toBe("tmux-output");

      // send/sendKey/resize don't throw for valid sessions
      await router.send("pty-sess", "hello");
      await router.send("tmux-sess", "hello");
      await router.sendKey("pty-sess", "Enter");
      await router.sendKey("tmux-sess", "Enter");
      await router.resize("pty-sess", 80, 24);
      await router.resize("tmux-sess", 80, 24);
    });

    test("unknown session falls back to pty backend", async () => {
      const { router } = createTestRouter();
      // No list() call — ownership map empty
      // Should delegate to pty (default fallback)
      const result = await router.capturePane("unknown");
      expect(result).toBe(""); // ptyMock returns "" for unknown sessions
    });
  });

  // ── setDefaultBackend ──

  describe("setDefaultBackend()", () => {
    test("switches default backend", () => {
      const { router } = createTestRouter({ default: "pty" });
      router.setDefaultBackend("tmux");
      expect(router.getDefaultBackend()).toBe("tmux");
    });

    test("throws when switching to tmux if unavailable", () => {
      const { router } = createTestRouter({ default: "pty" });
      (router as any)._tmuxAvailable = false;
      expect(() => router.setDefaultBackend("tmux")).toThrow("tmux is not available");
    });

    test("allows switching to pty always", () => {
      const { router } = createTestRouter({ default: "tmux" });
      router.setDefaultBackend("pty");
      expect(router.getDefaultBackend()).toBe("pty");
    });
  });

  // ── getSessionCounts ──

  describe("getSessionCounts()", () => {
    test("returns counts from both backends", async () => {
      const { router, ptyMock, tmuxMock } = createTestRouter();
      ptyMock.setSessions(["p1", "p2"]);
      tmuxMock.setSessions(["t1"]);

      const counts = await router.getSessionCounts();
      expect(counts).toEqual({ pty: 2, tmux: 1 });
    });

    test("returns zero for tmux when unavailable", async () => {
      const { router, ptyMock } = createTestRouter();
      (router as any).tmux = null;
      ptyMock.setSessions(["p1"]);

      const counts = await router.getSessionCounts();
      expect(counts).toEqual({ pty: 1, tmux: 0 });
    });
  });

  // ── cleanupOrphans ──

  describe("cleanupOrphans()", () => {
    test("calls cleanup on both backends", async () => {
      const { router } = createTestRouter();
      let ptyCalled = false;
      let tmuxCalled = false;
      (router as any).pty.cleanupOrphans = async () => { ptyCalled = true; };
      (router as any).tmux.cleanupOrphans = async () => { tmuxCalled = true; };

      await router.cleanupOrphans();
      expect(ptyCalled).toBe(true);
      expect(tmuxCalled).toBe(true);
    });
  });
});
