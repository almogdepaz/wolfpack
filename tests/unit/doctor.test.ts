import { describe, expect, test, spyOn } from "bun:test";
import type { CheckResult } from "../../src/cli/doctor.ts";

/**
 * Doctor tests — we test the exported `doctor()` function end-to-end.
 * Since doctor probes real system state, these tests just verify:
 * 1. It returns 0 or 1 (not throws)
 * 2. Output format is correct
 * 3. The --fix flag is exercised via the exported applyFixes helper
 *
 * For unit-level isolation we test the CheckResult type contract and
 * the applyFixes runner with synthetic results.
 */

describe("doctor CheckResult contract", () => {
  test("pass result shape", () => {
    const r: CheckResult = { name: "tmux", group: "Dependencies", status: "pass", detail: "3.5a" };
    expect(r.status).toBe("pass");
    expect(r.fixHint).toBeUndefined();
    expect(r.fix).toBeUndefined();
  });

  test("fail result with fixHint", () => {
    const r: CheckResult = {
      name: "tmux", group: "Dependencies", status: "fail",
      detail: "not found", fixHint: "brew install tmux",
    };
    expect(r.status).toBe("fail");
    expect(r.fixHint).toBe("brew install tmux");
  });

  test("fail result with fix function", () => {
    let called = false;
    const r: CheckResult = {
      name: "binary", group: "Binary", status: "fail",
      detail: "missing",
      fix: () => { called = true; },
    };
    r.fix!();
    expect(called).toBe(true);
  });

  test("warn result shape", () => {
    const r: CheckResult = {
      name: "PATH", group: "Environment", status: "warn",
      detail: "/usr/local/bin missing",
    };
    expect(r.status).toBe("warn");
  });
});

describe("applyFixes()", () => {
  test("calls fix functions on failed results", async () => {
    const { applyFixes } = await import("../../src/cli/doctor.ts");
    let called = false;
    const results: CheckResult[] = [
      { name: "devDir", group: "Config", status: "fail", detail: "missing", fix: () => { called = true; } },
    ];
    const count = applyFixes(results);
    expect(count).toBe(1);
    expect(called).toBe(true);
  });

  test("skips pass and warn results", async () => {
    const { applyFixes } = await import("../../src/cli/doctor.ts");
    let called = false;
    const results: CheckResult[] = [
      { name: "tmux", group: "Dependencies", status: "pass", detail: "ok" },
      { name: "PATH", group: "Environment", status: "warn", detail: "missing" },
      { name: "devDir", group: "Config", status: "fail", detail: "missing", fix: () => { called = true; } },
    ];
    const count = applyFixes(results);
    expect(count).toBe(1);
    expect(called).toBe(true);
  });

  test("returns 0 when nothing to fix", async () => {
    const { applyFixes } = await import("../../src/cli/doctor.ts");
    const results: CheckResult[] = [
      { name: "tmux", group: "Dependencies", status: "pass", detail: "ok" },
    ];
    expect(applyFixes(results)).toBe(0);
  });

  test("skips fail results with no fix function", async () => {
    const { applyFixes } = await import("../../src/cli/doctor.ts");
    const results: CheckResult[] = [
      { name: "tailscale", group: "Dependencies", status: "fail", detail: "not found", fixHint: "brew install --cask tailscale" },
    ];
    expect(applyFixes(results)).toBe(0);
  });

  test("continues after a fix function throws", async () => {
    const { applyFixes } = await import("../../src/cli/doctor.ts");
    let secondCalled = false;
    const results: CheckResult[] = [
      { name: "first", group: "Config", status: "fail", detail: "x", fix: () => { throw new Error("boom"); } },
      { name: "second", group: "Config", status: "fail", detail: "y", fix: () => { secondCalled = true; } },
    ];
    const count = applyFixes(results);
    expect(count).toBe(2);
    expect(secondCalled).toBe(true);
  });
});

describe("doctor result rendering", () => {
  test("does not count log excerpt continuation lines as warnings", async () => {
    const { printResults } = await import("../../src/cli/doctor.ts");
    const counts = printResults([
      { name: "recent errors", group: "Logs", status: "warn", detail: "1 error(s) in last 100 lines" },
      { name: "", group: "Logs", status: "warn", detail: "matching log excerpt" },
    ]);

    expect(counts).toEqual({ pass: 0, fail: 0, warn: 1 });
  });
});

describe("doctor() hermetic runner", () => {
  const checks = [() => [
    { name: "fixture", group: "Fixture", status: "pass" as const, detail: "isolated" },
    { name: "warning", group: "Fixture", status: "warn" as const, detail: "expected" },
  ]];

  test("runs only injected checks and returns success", async () => {
    const { doctor } = await import("../../src/cli/doctor.ts");
    expect(await doctor({ checkGroups: checks, fix: false })).toBe(0);
  });

  test("supports machine-readable results without host inspection", async () => {
    const { doctor } = await import("../../src/cli/doctor.ts");
    expect(await doctor({ checkGroups: checks, json: true, fix: false })).toBe(0);
  });

  test("returns failure for an injected failing check", async () => {
    const { doctor } = await import("../../src/cli/doctor.ts");
    const failing = [() => [{ name: "fixture", group: "Fixture", status: "fail" as const, detail: "broken" }]];
    expect(await doctor({ checkGroups: failing, fix: false })).toBe(1);
  });
});

function foregroundResults(tailscaleFact: "tailscale-unavailable" | "tailscale-disconnected" = "tailscale-unavailable"): CheckResult[] {
  return [
    {
      name: "tailscale",
      group: "Dependencies",
      status: "warn",
      detail: "not found",
      fact: tailscaleFact,
    },
    {
      name: "service installed",
      group: "Service",
      status: "fail",
      detail: "not installed",
      fixHint: "wolfpack service install",
      fact: "service-absent",
    },
    {
      name: "localhost",
      group: "Connectivity",
      status: "pass",
      detail: "v1.0.0",
      fact: "localhost-healthy",
    },
    {
      name: "broker handshake",
      group: "Broker",
      status: "pass",
      detail: "list_sessions ok",
      fact: "broker-healthy",
    },
  ];
}

async function captureDoctorOutput(run: () => Promise<number>): Promise<{ exitCode: number; output: string }> {
  let output = "";
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    return { exitCode: await run(), output };
  } finally {
    stdout.mockRestore();
  }
}

describe("doctor foreground and managed-service health", () => {
  test("accepts healthy foreground operation in text mode without requiring service installation", async () => {
    const { doctor } = await import("../../src/cli/doctor.ts");
    const observed = await captureDoctorOutput(() => doctor({
      checkGroups: [() => foregroundResults()],
      fix: false,
    }));

    expect(observed.exitCode).toBe(0);
    expect(observed.output).toContain("foreground mode supported");
    expect(observed.output).not.toContain("→ wolfpack service install");
  });

  test("accepts healthy foreground operation in JSON mode without leaking internal facts", async () => {
    const { doctor } = await import("../../src/cli/doctor.ts");
    const observed = await captureDoctorOutput(() => doctor({
      checkGroups: [() => foregroundResults()],
      json: true,
      fix: false,
    }));
    const payload = JSON.parse(observed.output);

    expect(observed.exitCode).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.counts.fail).toBe(0);
    expect(payload.checks.some((check: Record<string, unknown>) => "fact" in check)).toBe(false);
  });

  test("keeps a configured stopped service failed and restarts it under --fix", async () => {
    const { doctor } = await import("../../src/cli/doctor.ts");
    let running = false;
    let starts = 0;
    const checkGroups = [() => [
      {
        name: "service running",
        group: "Service",
        status: running ? "pass" as const : "fail" as const,
        detail: running ? "active" : "not running",
        fact: running ? "service-running" as const : "service-stopped" as const,
        fix: running ? undefined : () => { starts++; running = true; },
      },
      {
        name: "localhost",
        group: "Connectivity",
        status: running ? "pass" as const : "fail" as const,
        detail: running ? "v1.0.0" : "not responding",
        fact: running ? "localhost-healthy" as const : "localhost-unhealthy" as const,
      },
      {
        name: "broker handshake",
        group: "Broker",
        status: "pass" as const,
        detail: "list_sessions ok",
        fact: "broker-healthy" as const,
      },
    ]];

    expect(await doctor({ checkGroups, fix: false })).toBe(1);
    expect(await doctor({ checkGroups, fix: true })).toBe(0);
    expect(starts).toBe(1);
  });

  test("fails an offline foreground server with foreground start guidance", async () => {
    const { doctor } = await import("../../src/cli/doctor.ts");
    const results = foregroundResults().map((result) => result.fact === "localhost-healthy"
      ? {
          ...result,
          status: "fail" as const,
          detail: "localhost:3000 not responding",
          fact: "localhost-unhealthy" as const,
        }
      : result);
    const observed = await captureDoctorOutput(() => doctor({
      checkGroups: [() => results],
      fix: true,
    }));

    expect(observed.exitCode).toBe(1);
    expect(observed.output).toContain("start the foreground server: wolfpack");
    expect(observed.output).not.toContain("→ wolfpack service install");
  });

  test("accepts a healthy managed service", async () => {
    const { doctor } = await import("../../src/cli/doctor.ts");
    const managedResults: CheckResult[] = [
      { name: "service running", group: "Service", status: "pass", detail: "active", fact: "service-running" },
      { name: "localhost", group: "Connectivity", status: "pass", detail: "v1.0.0", fact: "localhost-healthy" },
      { name: "broker handshake", group: "Broker", status: "pass", detail: "list_sessions ok", fact: "broker-healthy" },
    ];

    expect(await doctor({ checkGroups: [() => managedResults], fix: false })).toBe(0);
  });

  test.each([
    ["missing", "tailscale-unavailable"],
    ["disconnected", "tailscale-disconnected"],
  ] as const)("keeps %s Tailscale nonfatal for healthy local-only use", async (_state, fact) => {
    const { doctor } = await import("../../src/cli/doctor.ts");
    expect(await doctor({ checkGroups: [() => foregroundResults(fact)], fix: false })).toBe(0);
  });

  test.each([
    ["missing", null],
    ["disconnected", "/usr/bin/tailscale"],
  ] as const)("keeps %s Tailscale fatal when production config expects remote access", async (_state, tailscaleBinary) => {
    const { checkDoctorDependencies, doctor } = await import("../../src/cli/doctor.ts");
    const dependencyResults = checkDoctorDependencies({
      config: { tailscaleHostname: "host.tailnet.ts.net" },
      tailscaleBinary,
      readTailscaleVersion: (_binary) => "1.80.0",
      readTailscaleStatus: (_binary) => JSON.stringify({ Self: {} }),
      shellPath: "/bin/sh",
      pathExists: (_path) => true,
    });
    const foregroundHealth = foregroundResults().filter((result) => result.group !== "Dependencies");

    expect(await doctor({ checkGroups: [() => [...dependencyResults, ...foregroundHealth]], fix: false })).toBe(1);
  });
});

describe("doctor dependency probe wiring", () => {
  const baseProbes = {
    config: { devDir: "/tmp", port: 3000 },
    tailscaleBinary: null,
    readTailscaleVersion: (_binary: string) => "",
    readTailscaleStatus: (_binary: string) => "",
    shellPath: "/bin/sh",
    pathExists: (_path: string) => true,
  };

  test.each([
    ["local-only", undefined, "warn"],
    ["configured remote", "host.tailnet.ts.net", "fail"],
  ] as const)("classifies missing Tailscale from %s production config", async (_case, tailscaleHostname, expectedStatus) => {
    const { checkDoctorDependencies } = await import("../../src/cli/doctor.ts");
    const results = checkDoctorDependencies({
      ...baseProbes,
      config: { ...baseProbes.config, tailscaleHostname },
    });
    const tailscale = results.find((result) => result.fact === "tailscale-unavailable");

    expect(tailscale?.status).toBe(expectedStatus);
  });

  test.each([
    ["local-only", undefined, "warn"],
    ["configured remote", "host.tailnet.ts.net", "fail"],
  ] as const)("classifies disconnected Tailscale from %s production config", async (_case, tailscaleHostname, expectedStatus) => {
    const { checkDoctorDependencies } = await import("../../src/cli/doctor.ts");
    const results = checkDoctorDependencies({
      ...baseProbes,
      config: { ...baseProbes.config, tailscaleHostname },
      tailscaleBinary: "/usr/bin/tailscale",
      readTailscaleVersion: (_binary) => "1.80.0",
      readTailscaleStatus: (_binary) => JSON.stringify({ Self: {} }),
    });
    const connected = results.find((result) => result.fact === "tailscale-disconnected");

    expect(connected?.status).toBe(expectedStatus);
  });
});

describe("tailscaleBin shared export", () => {
  test("tailscaleBin is exported from config", async () => {
    const { tailscaleBin } = await import("../../src/cli/config.ts");
    expect(typeof tailscaleBin).toBe("function");
    const result = tailscaleBin();
    expect(result === null || typeof result === "string").toBe(true);
  });
});
