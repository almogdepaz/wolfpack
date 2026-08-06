import { describe, expect, test } from "bun:test";
import { BrokerHealthMonitor, isLoopbackAddress } from "../../src/server/operability";

describe("operability contracts", () => {
  test("tracks explicit broker health transitions", () => {
    const monitor = new BrokerHealthMonitor();
    expect(monitor.snapshot(100).state).toBe("starting");
    expect(monitor.observe(true, 200)).toBe("ready");
    expect(monitor.snapshot(250).stateAgeMs).toBe(50);
    expect(monitor.observe(false, 300)).toBe("unavailable");
  });

  test("limits unauthenticated readiness to loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("100.64.0.1")).toBe(false);
  });
});
