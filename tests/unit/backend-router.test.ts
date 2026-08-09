import { describe, test, expect, beforeEach } from "bun:test";
import { MockBackend } from "../../src/server/mock-backend";
import {
  BackendRouter,
  __resetBackend,
  checkBrokerSocketExists,
} from "../../src/server/backend";

/**
 * Construct a BackendRouter with a mock broker injected. Live broker startup
 * is suppressed by WOLFPACK_TEST=1 (set in beforeEach), so the constructor
 * leaves `broker` null — we patch it in directly.
 */
function createTestRouter(opts?: { brokerMock?: MockBackend }): {
  router: BackendRouter;
  brokerMock: MockBackend;
} {
  const brokerMock = opts?.brokerMock ?? new MockBackend();
  const router = new BackendRouter();
  (router as any).broker = brokerMock;
  (router as any)._brokerAvailable = true;
  return { router, brokerMock };
}

const loadSettings = () => ({ agentCmd: "shell" });

describe("BackendRouter", () => {
  beforeEach(() => {
    process.env.WOLFPACK_TEST = "1";
    __resetBackend();
  });

  describe("list()", () => {
    test("returns broker sessions sorted", async () => {
      const { router, brokerMock } = createTestRouter();
      brokerMock.setSessions(["zebra", "alpha"]);
      expect(await router.list()).toEqual(["alpha", "zebra"]);
    });

    test("returns empty list when broker has no sessions", async () => {
      const { router } = createTestRouter();
      expect(await router.list()).toEqual([]);
    });
  });

  describe("createSession()", () => {
    test("creates session on the broker", async () => {
      const { router, brokerMock } = createTestRouter();
      await router.createSession("new-sess", "/tmp", undefined, loadSettings);
      expect(await brokerMock.hasSession("new-sess")).toBe(true);
    });

    test("rejects duplicate session names", async () => {
      const { router, brokerMock } = createTestRouter();
      brokerMock.setSessions(["existing"]);
      await expect(
        router.createSession("existing", "/tmp", undefined, loadSettings),
      ).rejects.toThrow("duplicate session");
    });
  });

  describe("routing", () => {
    test("routes operations to broker", async () => {
      const { router, brokerMock } = createTestRouter();
      brokerMock.setSessions(["sess"]);
      brokerMock.setCapturePane(async () => "broker-output");

      expect(await router.hasSession("sess")).toBe(true);
      expect(await router.capturePane("sess")).toBe("broker-output");

      await router.send("sess", "hello");
      await router.sendKey("sess", "Enter");
      await router.resize("sess", 80, 24);
      await router.killSession("sess");
      expect(await brokerMock.hasSession("sess")).toBe(false);
    });
  });

  describe("getSessionCounts()", () => {
    test("returns broker session count", async () => {
      const { router, brokerMock } = createTestRouter();
      brokerMock.setSessions(["b1", "b2"]);
      expect(await router.getSessionCounts()).toEqual({ broker: 2 });
    });

    test("returns zero when broker absent", async () => {
      const router = new BackendRouter();
      expect(await router.getSessionCounts()).toEqual({ broker: 0 });
    });
  });

  describe("cleanupOrphans()", () => {
    test("calls cleanup on broker", async () => {
      const { router, brokerMock } = createTestRouter();
      let called = false;
      (brokerMock as any).cleanupOrphans = async () => { called = true; };
      await router.cleanupOrphans();
      expect(called).toBe(true);
    });

    test("noop when broker absent", async () => {
      const router = new BackendRouter();
      await router.cleanupOrphans();
    });
  });

  describe("broker availability", () => {
    test("isBrokerAvailable reflects internal flag", () => {
      const router = new BackendRouter();
      expect(router.isBrokerAvailable()).toBe(false);
      const { router: r2 } = createTestRouter();
      expect(r2.isBrokerAvailable()).toBe(true);
    });

    test("distinguishes configured broker availability from live transport readiness", () => {
      const { router } = createTestRouter();
      (router as any).brokerClient = { isConnected: () => false };
      expect(router.isBrokerAvailable()).toBe(true);
      expect(router.isBrokerReady()).toBe(false);

      (router as any).brokerClient = { isConnected: () => true };
      expect(router.isBrokerReady()).toBe(true);
    });

    test("verifyBrokerHandshake returns false when no broker client", async () => {
      const router = new BackendRouter();
      expect(await router.verifyBrokerHandshake()).toBe(false);
    });
  });

  describe("checkBrokerSocketExists", () => {
    test("returns false for paths that don't exist", () => {
      expect(checkBrokerSocketExists("/tmp/never-was-a-broker-here.sock")).toBe(false);
    });
  });

  describe("recovery watchdog", () => {
    // The watchdog uses `checkBrokerSocketExists` (existsSync). To avoid
    // touching real filesystem state, we point `brokerSocketPath` at /tmp
    // for the "socket present" branch (existsSync("/tmp") is always true)
    // and at a guaranteed-missing path for the "socket gone" branch. The
    // expensive parts (BrokerClient startup, real handshake) are stubbed.

    test("watchdog no-ops while broker is healthy", async () => {
      const { router, brokerMock } = createTestRouter();
      // `_brokerAvailable=true` was set by createTestRouter; verify the
      // watchdog tick exits early without touching anything.
      let verifyCalls = 0;
      (router as any).verifyBrokerHandshake = async () => { verifyCalls++; return true; };
      await router._watchdogTickForTest();
      expect(verifyCalls).toBe(0);
      expect(router.isBrokerAvailable()).toBe(true);
      void brokerMock;
    });

    test("watchdog flips broker back to available when handshake succeeds", async () => {
      const router = new BackendRouter();
      // Pretend we just had a wedge: socket exists, client torn down,
      // availability flag is false.
      (router as any).brokerSocketPath = "/tmp"; // exists
      (router as any).brokerClient = null;
      (router as any).broker = null;
      (router as any)._brokerAvailable = false;

      let starts = 0;
      let verifies = 0;
      (router as any).startBrokerClient = function fakeStart() {
        starts++;
        (this as any).brokerClient = { close() {}, isConnected() { return true; }, request: async () => ({ status: "ok" }), start() {} };
        (this as any).broker = {};
      };
      (router as any).verifyBrokerHandshake = async () => { verifies++; return true; };

      await router._watchdogTickForTest();
      expect(starts).toBe(1);
      expect(verifies).toBe(1);
      expect(router.isBrokerAvailable()).toBe(true);

      // Second tick is a no-op because broker is healthy again.
      await router._watchdogTickForTest();
      expect(verifies).toBe(1);
    });

    test("watchdog keeps retrying while handshake fails", async () => {
      const router = new BackendRouter();
      (router as any).brokerSocketPath = "/tmp";
      (router as any)._brokerAvailable = false;
      (router as any).brokerClient = null;
      let verifies = 0;
      (router as any).startBrokerClient = function fakeStart() {
        (this as any).brokerClient = { close() {}, isConnected() { return true; }, request: async () => ({ status: "ok" }), start() {} };
        (this as any).broker = {};
      };
      (router as any).verifyBrokerHandshake = async () => {
        verifies++;
        // Real verify tears client down on fail.
        (router as any).brokerClient = null;
        (router as any).broker = null;
        return false;
      };

      await router._watchdogTickForTest();
      await router._watchdogTickForTest();
      await router._watchdogTickForTest();
      expect(verifies).toBe(3);
      expect(router.isBrokerAvailable()).toBe(false);
    });

    test("watchdog is a no-op when the socket file is missing", async () => {
      const router = new BackendRouter();
      (router as any).brokerSocketPath = "/tmp/wp-definitely-missing-watchdog.sock";
      (router as any)._brokerAvailable = false;
      let verifies = 0;
      (router as any).verifyBrokerHandshake = async () => { verifies++; return true; };
      await router._watchdogTickForTest();
      expect(verifies).toBe(0);
    });
  });
});
