import { describe, expect, test } from "bun:test";
import {
  BrokerHealthMonitor,
  classifyRequestClient,
  isLoopbackAddress,
  operationalHealth,
} from "../../src/server/operability";
import { __resetBackend, getRouter } from "../../src/server/backend";

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
    __resetBackend();
    const router = getRouter();
    (router as any)._brokerAvailable = true;
    (router as any).brokerClient = { isConnected: () => false };

    expect(operationalHealth()).toMatchObject({
      status: "degraded",
      broker: { state: "unavailable" },
    });
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
