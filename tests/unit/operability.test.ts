import { describe, expect, test } from "bun:test";
import {
  BrokerHealthMonitor,
  classifyRequestClient,
  operationalHealth,
} from "../../src/server/operability";
import { isLoopbackAddress } from "../../src/server/client-address";
import { createServerContext } from "../../src/server/context";
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
    process.env.WOLFPACK_TEST = "1";
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
    process.env.WOLFPACK_TEST = "1";
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
});
