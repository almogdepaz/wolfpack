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
      expect(router.getBackendTypeForSession("new-sess")).toBe("broker");
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

  describe("setDefaultBackend()", () => {
    test("accepts 'broker' when available", () => {
      const { router } = createTestRouter();
      router.setDefaultBackend("broker");
      expect(router.getDefaultBackend()).toBe("broker");
    });

    test("throws when broker is unavailable", () => {
      const router = new BackendRouter();
      expect(() => router.setDefaultBackend("broker")).toThrow("broker is not available");
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
});
