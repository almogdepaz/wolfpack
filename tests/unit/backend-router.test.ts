import { describe, test, expect, beforeEach } from "bun:test";
import { MockBackend } from "../../src/server/mock-backend";
import {
  BackendRouter,
  __resetBackend,
  checkBrokerSocketExists,
  type BackendType,
} from "../../src/server/backend";

/**
 * Create a BackendRouter with mock pty + optional broker injected, bypassing
 * the real PtyBackend constructor via Object.create. tmux is no longer a
 * supported backend; the previous tmux test scenarios were removed in S5.
 */
function createTestRouter(opts?: { default?: BackendType; brokerMock?: MockBackend }): {
  router: BackendRouter;
  ptyMock: MockBackend;
  brokerMock: MockBackend | null;
} {
  const ptyMock = new MockBackend();
  const brokerMock = opts?.brokerMock ?? null;

  const router = Object.create(BackendRouter.prototype) as BackendRouter;
  (router as any).pty = ptyMock;
  (router as any).broker = brokerMock;
  (router as any).brokerClient = null;
  (router as any).brokerSocketPath = "/tmp/wolfpack-broker-test.sock";
  (router as any).ownership = new Map();
  (router as any)._brokerAvailable = !!brokerMock;
  (router as any)._defaultBackend = opts?.default ?? "pty";

  return { router, ptyMock, brokerMock };
}

const loadSettings = () => ({ agentCmd: "shell" });

describe("BackendRouter", () => {
  beforeEach(() => {
    process.env.WOLFPACK_TEST = "1";
    __resetBackend();
  });

  // ── list() ownership reconciliation ──

  describe("list()", () => {
    test("merges sessions from pty and broker", async () => {
      const brokerMock = new MockBackend();
      const { router, ptyMock } = createTestRouter({ brokerMock });
      ptyMock.setSessions(["pty-1", "pty-2"]);
      brokerMock.setSessions(["brk-1"]);
      const list = await router.list();
      expect(list).toEqual(["brk-1", "pty-1", "pty-2"]);
    });

    test("deduplicates same-named sessions, broker wins ownership", async () => {
      const brokerMock = new MockBackend();
      const { router, ptyMock } = createTestRouter({ brokerMock });
      ptyMock.setSessions(["shared"]);
      brokerMock.setSessions(["shared"]);
      const list = await router.list();
      expect(list).toEqual(["shared"]);
      expect(router.getBackendTypeForSession("shared")).toBe("broker");
    });

    test("prunes stale ownership entries", async () => {
      const { router, ptyMock } = createTestRouter();
      ptyMock.setSessions(["alive", "stale"]);
      await router.list();
      expect((router as any).ownership.has("stale")).toBe(true);

      ptyMock.setSessions(["alive"]);
      await router.list();
      expect((router as any).ownership.has("stale")).toBe(false);
    });

    test("returns sorted list", async () => {
      const brokerMock = new MockBackend();
      const { router, ptyMock } = createTestRouter({ brokerMock });
      ptyMock.setSessions(["zebra"]);
      brokerMock.setSessions(["alpha"]);
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

    test("creates session on broker when default is broker", async () => {
      const brokerMock = new MockBackend();
      const { router } = createTestRouter({ default: "broker", brokerMock });
      await router.createSession("new-sess", "/tmp", undefined, loadSettings);
      expect(await brokerMock.hasSession("new-sess")).toBe(true);
      expect(router.getBackendTypeForSession("new-sess")).toBe("broker");
    });

    test("rejects duplicate across pty backend", async () => {
      const { router, ptyMock } = createTestRouter();
      ptyMock.setSessions(["existing"]);
      await expect(
        router.createSession("existing", "/tmp", undefined, loadSettings),
      ).rejects.toThrow("duplicate session");
    });

    test("rejects duplicate across broker backend", async () => {
      const brokerMock = new MockBackend();
      const { router } = createTestRouter({ brokerMock });
      brokerMock.setSessions(["existing"]);
      await expect(
        router.createSession("existing", "/tmp", undefined, loadSettings),
      ).rejects.toThrow("duplicate session");
    });

    test("rolls back ownership on creation failure", async () => {
      const { router, ptyMock } = createTestRouter({ default: "pty" });
      (ptyMock as any).createSession = async () => { throw new Error("spawn failed"); };
      await expect(
        router.createSession("fail-sess", "/tmp", undefined, loadSettings),
      ).rejects.toThrow("spawn failed");
      expect((router as any).ownership.has("fail-sess")).toBe(false);
      const list = await router.list();
      expect(list).not.toContain("fail-sess");
    });
  });

  // ── routing delegation ──

  describe("routing", () => {
    test("routes operations to correct backend by ownership", async () => {
      const brokerMock = new MockBackend();
      const { router, ptyMock } = createTestRouter({ brokerMock });
      ptyMock.setSessions(["pty-sess"]);
      brokerMock.setSessions(["brk-sess"]);
      await router.list();

      expect(await router.hasSession("pty-sess")).toBe(true);
      expect(await router.hasSession("brk-sess")).toBe(true);

      await router.killSession("brk-sess");
      expect(await brokerMock.hasSession("brk-sess")).toBe(false);
      expect(await ptyMock.hasSession("pty-sess")).toBe(true);
    });

    test("routes capturePane to correct backend", async () => {
      const brokerMock = new MockBackend();
      const { router, ptyMock } = createTestRouter({ brokerMock });
      ptyMock.setSessions(["pty-sess"]);
      brokerMock.setSessions(["brk-sess"]);
      await router.list();

      ptyMock.setCapturePane(async (s) => s === "pty-sess" ? "pty-output" : "");
      brokerMock.setCapturePane(async (s) => s === "brk-sess" ? "brk-output" : "");
      expect(await router.capturePane("pty-sess")).toBe("pty-output");
      expect(await router.capturePane("brk-sess")).toBe("brk-output");

      await router.send("pty-sess", "hello");
      await router.send("brk-sess", "hello");
      await router.sendKey("pty-sess", "Enter");
      await router.sendKey("brk-sess", "Enter");
      await router.resize("pty-sess", 80, 24);
      await router.resize("brk-sess", 80, 24);
    });

    test("unknown session falls back to pty backend", async () => {
      const { router } = createTestRouter();
      const result = await router.capturePane("unknown");
      expect(result).toBe("");
    });
  });

  // ── setDefaultBackend ──

  describe("setDefaultBackend()", () => {
    test("switches default backend to broker when available", () => {
      const brokerMock = new MockBackend();
      const { router } = createTestRouter({ default: "pty", brokerMock });
      router.setDefaultBackend("broker");
      expect(router.getDefaultBackend()).toBe("broker");
    });

    test("throws when switching to broker if unavailable", () => {
      const { router } = createTestRouter({ default: "pty" });
      expect(() => router.setDefaultBackend("broker")).toThrow("broker is not available");
    });

    test("allows switching to pty always", () => {
      const brokerMock = new MockBackend();
      const { router } = createTestRouter({ default: "broker", brokerMock });
      router.setDefaultBackend("pty");
      expect(router.getDefaultBackend()).toBe("pty");
    });
  });

  // ── getSessionCounts ──

  describe("getSessionCounts()", () => {
    test("returns counts from pty and broker", async () => {
      const brokerMock = new MockBackend();
      const { router, ptyMock } = createTestRouter({ brokerMock });
      ptyMock.setSessions(["p1", "p2"]);
      brokerMock.setSessions(["b1"]);
      const counts = await router.getSessionCounts();
      expect(counts).toEqual({ pty: 2, broker: 1 });
    });

    test("returns zero for broker when unavailable", async () => {
      const { router, ptyMock } = createTestRouter();
      ptyMock.setSessions(["p1"]);
      const counts = await router.getSessionCounts();
      expect(counts).toEqual({ pty: 1, broker: 0 });
    });
  });

  // ── cleanupOrphans ──

  describe("cleanupOrphans()", () => {
    test("calls cleanup on pty backend", async () => {
      const { router } = createTestRouter();
      let ptyCalled = false;
      (router as any).pty.cleanupOrphans = async () => { ptyCalled = true; };
      await router.cleanupOrphans();
      expect(ptyCalled).toBe(true);
    });

    test("calls cleanup on broker backend when present", async () => {
      const brokerMock = new MockBackend();
      const { router } = createTestRouter({ brokerMock });
      let brokerCalled = false;
      (brokerMock as any).cleanupOrphans = async () => { brokerCalled = true; };
      await router.cleanupOrphans();
      expect(brokerCalled).toBe(true);
    });
  });

  // ── broker routing ──

  describe("broker backend", () => {
    test("isBrokerAvailable reflects internal flag", () => {
      const { router } = createTestRouter();
      expect(router.isBrokerAvailable()).toBe(false);
      const brokerMock = new MockBackend();
      const { router: r2 } = createTestRouter({ brokerMock });
      expect(r2.isBrokerAvailable()).toBe(true);
    });

    test("verifyBrokerHandshake returns false when no broker client", async () => {
      const { router } = createTestRouter();
      expect(await router.verifyBrokerHandshake()).toBe(false);
    });
  });

  // ── checkBrokerSocketExists helper ──

  describe("checkBrokerSocketExists", () => {
    test("returns false for paths that don't exist", () => {
      expect(checkBrokerSocketExists("/tmp/never-was-a-broker-here.sock")).toBe(false);
    });
  });
});
