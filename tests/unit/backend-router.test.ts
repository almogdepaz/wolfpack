import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlResponse } from "../../src/broker/codec";
import { MockBackend } from "../../src/server/mock-backend";
import {
  BrokerSupervisor as BackendRouter,
  checkBrokerSocketExists,
} from "../../src/server/broker-supervisor";
import { createServerContext } from "../../src/server/context";
const backendFor = (supervisor: BackendRouter) => createServerContext({ supervisor }).backend;

type Reply = (method: string) => Promise<Omit<ControlResponse, "id">>;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function createTestRouter(opts: { brokerMock?: MockBackend; backends?: MockBackend[]; respond?: Reply } = {}) {
  const brokerMock = opts.brokerMock ?? new MockBackend();
  const root = mkdtempSync(join(tmpdir(), "wolfpack-supervisor-"));
  const socketPath = join(root, "broker.sock");
  writeFileSync(socketPath, "");
  const methods: string[] = [];
  let respond: Reply = opts.respond ?? (async () => ({ status: "ok", payload: { kind: "hello", protocol_version: 2, broker_version: "fixture" } }));
  const transports: Array<{ connected: boolean; closed: boolean }> = [];
  let tick: () => Promise<void> = async () => { throw new Error("watchdog not scheduled"); };
  let interval = 0;
  let stopped = false;
  let now = 0;
  let backendIndex = 0;
  const router = new BackendRouter({
    socketPath,
    now: () => now,
    sleep: async ms => { now += ms; },
    scheduleWatchdog(callback, intervalMs) { tick = callback; interval = intervalMs; return () => { stopped = true; }; },
    createClient() {
      const transport = { connected: true, closed: false };
      transports.push(transport);
      return {
        request: async method => { methods.push(method); return { id: 0, ...await respond(method) }; },
        start() {},
        close() { transport.closed = true; transport.connected = false; },
        isConnected: () => transport.connected,
        snapshotSubscribe: async () => { throw new Error("unexpected snapshot"); },
        snapshotSubscribeAnsi: async () => { throw new Error("unexpected ANSI snapshot"); },
        writeInput() { throw new Error("unexpected input"); },
        subscribeOutput() { throw new Error("unexpected output subscription"); },
        subscribe: async () => { throw new Error("unexpected subscribe"); },
        unsubscribe: async () => {},
        cancelSubscription: async () => {},
        outputSequence: () => undefined,
      };
    },
    createBackend: () => Object.assign(opts.backends?.[backendIndex++] ?? brokerMock, {
      ingestEvent() {}, handleBrokerConnected() {}, handleBrokerDisconnected() {},
      handleReplayTruncated() {}, handleResubscribeError() {},
    }),
  });
  cleanups.push(() => { router.close(); rmSync(root, { recursive: true, force: true }); });
  return { router, brokerMock, methods, transports, tick: () => tick(), interval,
    setRespond(value: Reply) { respond = value; },
    removeSocket() { unlinkSync(socketPath); },
    now: () => now, stopped: () => stopped,
  };
}

const loadSettings = () => ({ agentCmd: "shell" });

describe("BrokerSupervisor", () => {
  beforeEach(() => {
    process.env.WOLFPACK_TEST = "1";
  });

  describe("list()", () => {
    test("returns broker sessions sorted", async () => {
      const { router, brokerMock } = createTestRouter();
      brokerMock.setSessions(["zebra", "alpha"]);
      expect(await backendFor(router).list()).toEqual(["alpha", "zebra"]);
    });

    test("returns empty list when broker has no sessions", async () => {
      const { router } = createTestRouter();
      expect(await backendFor(router).list()).toEqual([]);
    });
  });

  describe("createSession()", () => {
    test("creates session on the broker", async () => {
      const { router, brokerMock } = createTestRouter();
      await backendFor(router).createSession("new-sess", "/tmp", undefined, loadSettings);
      expect(await brokerMock.hasSession("new-sess")).toBe(true);
    });

    test("rejects duplicate session names", async () => {
      const { router, brokerMock } = createTestRouter();
      brokerMock.setSessions(["existing"]);
      await expect(
        backendFor(router).createSession("existing", "/tmp", undefined, loadSettings),
      ).rejects.toThrow("duplicate session");
    });
  });

  describe("routing", () => {
    test("routes operations to broker", async () => {
      const { router, brokerMock } = createTestRouter();
      brokerMock.setSessions(["sess"]);
      brokerMock.setCapturePane(async () => "broker-output");

      expect(await backendFor(router).hasSession("sess")).toBe(true);
      expect(await backendFor(router).capturePane("sess")).toBe("broker-output");

      await backendFor(router).send("sess", "hello");
      await backendFor(router).sendKey("sess", "Enter");
      await backendFor(router).resize("sess", 80, 24);
      await backendFor(router).killSession("sess");
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
      const router = new BackendRouter({ start: false });
      expect(await router.getSessionCounts()).toEqual({ broker: 0 });
    });
  });

  describe("cleanupOrphans()", () => {
    test("calls cleanup on broker", async () => {
      const { router, brokerMock } = createTestRouter();
      let called = false;
      (brokerMock as any).cleanupOrphans = async () => { called = true; };
      await backendFor(router).cleanupOrphans();
      expect(called).toBe(true);
    });

    test("noop when broker absent", async () => {
      const router = new BackendRouter({ start: false });
      await backendFor(router).cleanupOrphans();
    });
  });

  test("backend accessor returns the owned broker, or null when absent", () => {
    const { router, brokerMock } = createTestRouter();
    const first = router.backend();
    expect(Object.is(first, brokerMock)).toBe(true);
    expect(router.backend()).toBe(first);
    expect(new BackendRouter({ start: false }).backend()).toBeNull();
  });

  test("unavailable backend preserves empty listings, no-op cleanup, and mutation failures", async () => {
    const router = new BackendRouter({ start: false });
    expect(await backendFor(router).list()).toEqual([]);
    expect(await backendFor(router).listSessionFacts()).toEqual([]);
    expect(await backendFor(router).listIdentities()).toEqual({});
    expect(backendFor(router).sessionDir("missing")).toBeUndefined();
    await backendFor(router).cleanupOrphans();
    await expect(backendFor(router).inspectSession("missing")).rejects.toThrow("broker backend unavailable");
    await expect(backendFor(router).createSession("missing", "/tmp", undefined, loadSettings)).rejects.toThrow("broker backend unavailable");
    await expect(backendFor(router).killSession("missing")).rejects.toThrow("broker backend unavailable");
    await expect(backendFor(router).killSessionById("missing")).rejects.toThrow("broker backend unavailable");
    await expect(backendFor(router).hasSession("missing")).rejects.toThrow("broker backend unavailable");
    await expect(backendFor(router).capturePane("missing")).rejects.toThrow("broker backend unavailable");
    await expect(backendFor(router).captureSessionSnapshotById("missing")).rejects.toThrow("broker backend unavailable");
    await expect(backendFor(router).resize("missing", 80, 24)).rejects.toThrow("broker backend unavailable");
    await expect(backendFor(router).send("missing", "text")).rejects.toThrow("broker backend unavailable");
    await expect(backendFor(router).sendKey("missing", "Enter")).rejects.toThrow("broker backend unavailable");
  });

  test("session facades follow recovery while streaming backends stay pinned", async () => {
    const first = new MockBackend({ sessions: ["session"], capturePane: async () => "first" });
    const second = new MockBackend({ sessions: ["session"], capturePane: async () => "second" });
    const fixture = createTestRouter({ backends: [first, second] });
    const { router } = fixture;
    const ctx = createServerContext({ supervisor: router });
    const retained = ctx.backend;
    const streaming = router.backend()!;
    fixture.setRespond(async () => { throw new Error("disconnected"); });
    expect(await router.verifyBrokerHandshake()).toBe(false);
    fixture.setRespond(async () => ({ status: "ok", payload: { kind: "hello", protocol_version: 2, broker_version: "replacement" } }));
    await fixture.tick();
    expect(await retained.capturePane("session")).toBe("second");
    expect(await streaming.capturePane("session")).toBe("first");
    expect(ctx.backend).toBe(retained);
  });

  describe("broker availability", () => {
    test("isBrokerAvailable reflects internal flag", () => {
      const router = new BackendRouter({ start: false });
      expect(router.isBrokerAvailable()).toBe(false);
      const { router: r2 } = createTestRouter();
      expect(r2.isBrokerAvailable()).toBe(true);
    });

    test("distinguishes configured broker availability from live transport readiness", () => {
      const { router, transports } = createTestRouter();
      transports[0].connected = false;
      expect(router.isBrokerAvailable()).toBe(true);
      expect(router.isBrokerReady()).toBe(false);

      transports[0].connected = true;
      expect(router.isBrokerReady()).toBe(true);
    });

    test("verifyBrokerHandshake returns false when no broker client", async () => {
      const router = new BackendRouter({ start: false });
      expect(await router.verifyBrokerHandshake()).toBe(false);
    });

    describe("verifyBrokerHandshake hello negotiation", () => {
      function routerWithClient(respond: Reply) {
        const fixture = createTestRouter({ respond });
        return { ...fixture, closed: () => fixture.transports[0].closed };
      }

      test("records the broker and protocol version from a compatible hello", async () => {
        const { router, methods, closed } = routerWithClient(async () => ({
          status: "ok",
          payload: { kind: "hello", protocol_version: 2, broker_version: "1.6.26" },
        }));
        expect(await router.verifyBrokerHandshake()).toBe(true);
        expect(methods).toEqual(["hello"]);
        expect(router.getBrokerVersion()).toEqual({ protocolVersion: 2, brokerVersion: "1.6.26" });
        expect(closed()).toBe(false);
      });

      test("falls back to list_sessions for a pre-hello broker and leaves the version unknown", async () => {
        const { router, methods, closed } = routerWithClient(async (method) => method === "hello"
          ? { status: "error", error: { code: "unknown_method", message: "unknown method: hello" } }
          : { status: "ok", payload: { kind: "list_sessions", sessions: [] } });
        expect(await router.verifyBrokerHandshake()).toBe(true);
        expect(methods).toEqual(["hello", "list_sessions"]);
        expect(router.getBrokerVersion()).toBeNull();
        expect(closed()).toBe(false);
      });

      test("tears down a broker speaking a different protocol version", async () => {
        const { router, methods, closed } = routerWithClient(async () => ({
          status: "ok",
          payload: { kind: "hello", protocol_version: 3, broker_version: "9.0.0" },
        }));
        expect(await router.verifyBrokerHandshake()).toBe(false);
        expect(methods).toEqual(["hello"]);
        expect(closed()).toBe(true);
        expect(router.isBrokerAvailable()).toBe(false);
        expect(router.getBrokerVersion()).toBeNull();
      });

      test("tears down on a transport failure", async () => {
        const { router, closed } = routerWithClient(async () => { throw new Error("broker request timed out"); });
        expect(await router.verifyBrokerHandshake()).toBe(false);
        expect(closed()).toBe(true);
        expect(router.isBrokerAvailable()).toBe(false);
      });
    });
  });

  describe("checkBrokerSocketExists", () => {
    test("returns false for paths that don't exist", () => {
      expect(checkBrokerSocketExists("/tmp/never-was-a-broker-here.sock")).toBe(false);
    });
  });

  describe("recovery watchdog", () => {
    test("uses the production 5s interval and no-ops while healthy", async () => {
      const fixture = createTestRouter();
      expect(fixture.interval).toBe(5000);
      await fixture.tick();
      expect(fixture.methods).toEqual([]);
      expect(fixture.router.isBrokerReady()).toBe(true);
    });

    test("restarts a failed client and recovers through the real handshake", async () => {
      const fixture = createTestRouter({ respond: async () => { throw new Error("wedged"); } });
      expect(await fixture.router.verifyBrokerHandshake()).toBe(false);
      expect(fixture.transports[0].closed).toBe(true);
      fixture.setRespond(async () => ({ status: "ok", payload: { kind: "hello", protocol_version: 2, broker_version: "recovered" } }));
      await fixture.tick();
      expect(fixture.transports).toHaveLength(2);
      expect(fixture.router.isBrokerReady()).toBe(true);
      expect(fixture.router.getBrokerVersion()?.brokerVersion).toBe("recovered");
      await fixture.tick();
      expect(fixture.methods).toEqual(["hello", "hello"]);
    });

    test("keeps retrying failed handshakes without keeping failed clients", async () => {
      const fixture = createTestRouter({ respond: async () => { throw new Error("wedged"); } });
      expect(await fixture.router.verifyBrokerHandshake()).toBe(false);
      for (let i = 0; i < 3; i++) await fixture.tick();
      expect(fixture.methods).toHaveLength(4);
      expect(fixture.transports.every(client => client.closed)).toBe(true);
      expect(fixture.router.isBrokerAvailable()).toBe(false);
    });

    test("does not reconnect when the socket disappears", async () => {
      const fixture = createTestRouter({ respond: async () => { throw new Error("wedged"); } });
      expect(await fixture.router.verifyBrokerHandshake()).toBe(false);
      fixture.removeSocket();
      await fixture.tick();
      expect(fixture.transports).toHaveLength(1);
      expect(fixture.methods).toEqual(["hello"]);
    });

    test("retains the 1500ms connect deadline and disposes its scheduler", async () => {
      const fixture = createTestRouter();
      fixture.transports[0].connected = false;
      expect(await fixture.router.verifyBrokerHandshake()).toBe(false);
      expect(fixture.now()).toBe(1500);
      expect(fixture.transports[0].closed).toBe(true);
      await createServerContext({ supervisor: fixture.router }).close();
      expect(fixture.stopped()).toBe(true);
      await fixture.tick();
      expect(fixture.transports).toHaveLength(1);
    });
  });
});
