import { describe, expect, test } from "bun:test";
import {
  BrokerHealthMonitor,
  classifyRequestClient,
  operationalHealth,
} from "../../src/server/operability";
import { isLoopbackAddress } from "../../src/server/client-address";
import { createServerContext, defaultServerContext, resetDefaultServerContext, setDefaultServerContext } from "../../src/server/context";
import { WorkerRelayGateway } from "../../src/task-relay/worker-client";
import type { RelayGateway } from "../../src/task-relay/worker-protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getJwtAuthConfig } from "../../src/auth";
import { MockBackend } from "../../src/server/mock-backend";

describe("operability contracts", () => {
  test("tracks explicit broker health transitions", () => {
    const monitor = new BrokerHealthMonitor();
    expect(monitor.snapshot(100).state).toBe("starting");
    expect(monitor.observe(true, 200)).toBe("ready");
    expect(monitor.snapshot(250).stateAgeMs).toBe(50);
    expect(monitor.observe(false, 300)).toBe("unavailable");
  });

  test("reports degraded while the configured broker transport is disconnected", () => {
    const context = createServerContext({ startSupervisor: false });
    const router = context.supervisor!;
    (router as any)._brokerAvailable = true;
    (router as any).brokerClient = { isConnected: () => false };

    expect(operationalHealth(context)).toMatchObject({
      status: "degraded",
      broker: { state: "unavailable" },
    });
  });

  test("reports the broker release and protocol version, null until a hello succeeds", () => {
    const context = createServerContext({ startSupervisor: false });
    const router = context.supervisor!;
    (router as any)._brokerAvailable = true;
    (router as any).brokerClient = { isConnected: () => true };

    expect(operationalHealth(context)).toMatchObject({ broker: { state: "ready", version: null, protocolVersion: null } });
    (router as any).brokerVersion = { protocolVersion: 2, brokerVersion: "1.6.26" };
    expect(operationalHealth(context)).toMatchObject({ broker: { state: "ready", version: "1.6.26", protocolVersion: 2 } });
  });

  test("reports whether API authentication is configured, never the secret", async () => {
    const none = createServerContext({ backend: new MockBackend(), jwtAuthConfig: getJwtAuthConfig({}) });
    const secret = "s".repeat(40);
    const jwt = createServerContext({ backend: new MockBackend(), jwtAuthConfig: getJwtAuthConfig({ WOLFPACK_JWT_SECRET: secret }) });
    try {
      expect(operationalHealth(none).auth).toEqual({ mode: "none" });
      expect(operationalHealth(jwt).auth).toEqual({ mode: "jwt" });
      expect(JSON.stringify(operationalHealth(jwt))).not.toContain(secret);
    } finally {
      await none.close();
      await jwt.close();
    }
  });

  test("limits unauthenticated readiness to direct loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("100.64.0.1")).toBe(false);
    expect(classifyRequestClient({ remoteAddress: "127.0.0.1", tailscaleUserLogin: undefined }))
      .toEqual({ kind: "direct", clientKey: "direct:127.0.0.1", isDirectLoopback: true });
  });

  test("classifies only a scalar Tailscale Serve login as a proxied client", () => {
    expect(classifyRequestClient({ remoteAddress: "127.0.0.1", tailscaleUserLogin: " Alice@Example.test " }))
      .toEqual({ kind: "tailscale_serve", clientKey: "tailscale-serve:alice@example.test", isDirectLoopback: false });
    expect(classifyRequestClient({ remoteAddress: "127.0.0.1", tailscaleUserLogin: "  " }))
      .toEqual({ kind: "unverified", clientKey: "unverified-loopback", isDirectLoopback: false });
    expect(classifyRequestClient({ remoteAddress: "127.0.0.1", tailscaleUserLogin: ["alice@example.test"] }))
      .toEqual({ kind: "unverified", clientKey: "unverified-loopback", isDirectLoopback: false });
    expect(classifyRequestClient({ remoteAddress: "127.0.0.1", tailscaleUserLogin: "alice@example.test, bob@example.test" }))
      .toEqual({ kind: "unverified", clientKey: "unverified-loopback", isDirectLoopback: false });
    expect(classifyRequestClient({ remoteAddress: "100.64.0.1", tailscaleUserLogin: "alice@example.test" }))
      .toEqual({ kind: "direct", clientKey: "direct:100.64.0.1", isDirectLoopback: false });
  });
  // Core readiness stays broker-owned; reading relay health must never construct the lazy gateway or its worker.
  test("relay health reads context-owned gateway state without constructing a relay worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-relay-health-"));
    const cold = createServerContext({ backend: new MockBackend(), config: null, taskRoot: join(root, "tasks"), taskRelayRoot: join(root, "relay") });
    const injected = createServerContext({ backend: new MockBackend(), config: null, taskRelayGateway: {
      health: () => ({ state: "unavailable", code: "RELAY_STORAGE_INVALID", retryable: false }),
      close: async () => undefined,
    } as unknown as RelayGateway });
    // Other tests may legitimately keep unrelated roots reserved (unconfirmed termination keeps the reservation), so
    // observe only this context's own relay root: a second owner for it can be constructed exactly when no worker owns it.
    const ownerConflict = "relay root already has a worker owner; await close before replacement";
    const ownsRelayRoot = async (): Promise<boolean> => {
      let probe: WorkerRelayGateway;
      try { probe = new WorkerRelayGateway({ root: join(root, "relay") }); }
      catch (error) {
        if (error instanceof Error && error.message === ownerConflict) return true;
        throw error;
      }
      await probe.close();
      expect(probe.terminationConfirmed).toBe(true);
      return false;
    };
    try {
      expect(await ownsRelayRoot()).toBe(false);
      for (let index = 0; index < 3; index++) {
        expect(cold.relayHealth()).toEqual({ state: "starting" });
        expect(operationalHealth(cold)).toMatchObject({ status: "ready", relay: { state: "starting" } });
      }
      expect(await ownsRelayRoot()).toBe(false);
      expect(operationalHealth(injected).relay).toEqual({ state: "unavailable", code: "RELAY_STORAGE_INVALID", retryable: false });

      // The default compatibility view forwards to the installed context without creating one.
      resetDefaultServerContext();
      expect(defaultServerContext.relayHealth()).toEqual({ state: "starting" });
      setDefaultServerContext(injected);
      expect(defaultServerContext.relayHealth()).toEqual({ state: "unavailable", code: "RELAY_STORAGE_INVALID", retryable: false });
      setDefaultServerContext(cold);

      // Only explicit service access constructs the gateway; health then follows its lifecycle.
      const gateway = cold.taskRelayGateway;
      expect(await ownsRelayRoot()).toBe(true);
      await gateway.initialize();
      expect(cold.relayHealth()).toEqual({ state: "ready" });
      expect(defaultServerContext.relayHealth()).toEqual({ state: "ready" });
      await cold.close();
      expect(await ownsRelayRoot()).toBe(false);
      expect(operationalHealth(cold).relay).toEqual({ state: "unavailable", code: "RELAY_UNAVAILABLE", retryable: false });
      expect(await ownsRelayRoot()).toBe(false);
    } finally {
      resetDefaultServerContext();
      await cold.close();
      await injected.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
