import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    config: {},
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

  test("keeps an unreadable Tailscale status distinct from logged-out", async () => {
    const { checkDoctorDependencies } = await import("../../src/cli/doctor.ts");
    const results = checkDoctorDependencies({
      ...baseProbes,
      tailscaleBinary: "/usr/bin/tailscale",
      readTailscaleVersion: (_binary) => "1.80.0",
      readTailscaleStatus: (_binary) => { throw new Error("permission denied"); },
    });
    const status = results.find((result) => result.name === "tailscale connected");

    expect(status?.fact).toBe("tailscale-query-failed");
    expect(status?.detail).toBe("unable to query status");
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

function doctorFixtureEnvironment(root: string, socketMode: "xdg" | "home"): NodeJS.ProcessEnv {
  const home = join(root, "home");
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    TMPDIR: join(root, "tmp"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
    npm_config_cache: join(root, "npm-cache"),
    npm_config_userconfig: join(root, "npmrc"),
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
  };
  if (socketMode === "xdg") environment.XDG_RUNTIME_DIR = join(root, "runtime");
  return environment;
}

describe("doctor runtime probes", () => {
  test.each(["xdg", "home"] as const)("uses the real default broker socket in an owned %s environment", (socketMode) => {
    const root = realpathSync(mkdtempSync("/tmp/wpd-"));
    const script = `
      import { createServer } from "node:net";
      import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
      import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
      import { homedir } from "node:os";

      const root = ${JSON.stringify(root)};
      const marker = join(root, ".wolfpack-test-fixture");
      const expectedHome = join(root, "home");
      const expectedSocket = ${JSON.stringify(socketMode)} === "xdg"
        ? join(root, "runtime", "wolfpack-broker.sock")
        : join(expectedHome, ".wolfpack", "broker.sock");
      const canonicalRoot = realpathSync(root);
      if (readFileSync(marker, "utf-8") !== "owned\\n") throw new Error("fixture marker missing");
      const assertOwned = (label, path) => {
        const resolved = resolve(path);
        const pathRelative = relative(canonicalRoot, resolved);
        const parentRelative = relative(canonicalRoot, realpathSync(dirname(resolved)));
        if (
          pathRelative === "" || pathRelative === ".." || pathRelative.startsWith(".." + sep) || isAbsolute(pathRelative)
          || parentRelative === ".." || parentRelative.startsWith(".." + sep) || isAbsolute(parentRelative)
        ) throw new Error("fixture escape: " + label + "=" + resolved);
        if (existsSync(resolved)) {
          const canonical = realpathSync(resolved);
          const canonicalRelative = relative(canonicalRoot, canonical);
          if (canonicalRelative === ".." || canonicalRelative.startsWith(".." + sep) || isAbsolute(canonicalRelative)) {
            throw new Error("fixture symlink escape: " + label + "=" + canonical);
          }
        }
      };

      const { FrameParser, encodeFrame, FRAME_KIND_CONTROL_REQUEST, FRAME_KIND_CONTROL_RESPONSE } = await import(${JSON.stringify(join(process.cwd(), "src", "broker", "codec.ts"))});
      const { defaultBrokerSocketPath } = await import(${JSON.stringify(join(process.cwd(), "src", "broker", "client.ts"))});
      const { WOLFPACK_DIR } = await import(${JSON.stringify(join(process.cwd(), "src", "cli", "config.ts"))});
      const homeSocket = join(expectedHome, ".wolfpack", "broker.sock");
      const defaultSocket = defaultBrokerSocketPath();
      const candidates = [join(WOLFPACK_DIR, "bin", "wolfpack-broker"), join(WOLFPACK_DIR, "wolfpack-broker")];
      assertOwned("home", homedir());
      assertOwned("config", WOLFPACK_DIR);
      assertOwned("home socket", homeSocket);
      assertOwned("default socket", defaultSocket);
      for (const candidate of candidates) assertOwned("broker candidate", candidate);
      if (homedir() !== expectedHome || defaultSocket !== expectedSocket) throw new Error("fixture resolver mismatch");

      mkdirSync(dirname(expectedSocket), { recursive: true });
      mkdirSync(dirname(candidates[0]), { recursive: true });
      writeFileSync(candidates[0], "broker");
      let received = false;
      const server = createServer((socket) => {
        const parser = new FrameParser();
        let requestBytes = 0;
        socket.on("data", (chunk) => {
          requestBytes += chunk.length;
          if (requestBytes > 4096) return socket.destroy();
          parser.push(chunk);
          const frames = parser.drain();
          if (frames.length === 0) return;
          if (frames.length !== 1 || frames[0].kind !== FRAME_KIND_CONTROL_REQUEST || parser.hasPartial()) return socket.destroy();
          const request = frames[0].value;
          if (JSON.stringify(request) !== JSON.stringify({ id: 1, method: "list_sessions", params: {} })) return socket.destroy();
          received = true;
          socket.end(encodeFrame({ kind: FRAME_KIND_CONTROL_RESPONSE, value: { id: request.id, status: "ok" } }));
        });
      });
      await new Promise((resolve, reject) => server.once("error", reject).listen(expectedSocket, resolve));
      try {
        const { checkDoctorBroker } = await import(${JSON.stringify(join(process.cwd(), "src", "cli", "doctor.ts"))});
        const results = await checkDoctorBroker();
        if (!received) throw new Error("fixture peer did not receive list_sessions");
        console.log(JSON.stringify(results));
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `;
    try {
      writeFileSync(join(root, ".wolfpack-test-fixture"), "owned\n");
      mkdirSync(join(root, "home", ".wolfpack", "bin"), { recursive: true });
      mkdirSync(join(root, "runtime"), { recursive: true });
      mkdirSync(join(root, "tmp"), { recursive: true });
      mkdirSync(join(root, "config"), { recursive: true });
      mkdirSync(join(root, "cache"), { recursive: true });
      mkdirSync(join(root, "npm-cache"), { recursive: true });
      const output = execFileSync(process.execPath, ["--eval", script], {
        cwd: root,
        encoding: "utf-8",
        env: doctorFixtureEnvironment(root, socketMode),
        timeout: 2500,
      });
      const results = JSON.parse(output) as CheckResult[];
      expect(results.find((check) => check.name === "broker handshake")?.status).toBe("pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 3000);

  test("uses the real Tailscale command boundary with an owned absolute stub", () => {
    const root = realpathSync(mkdtempSync("/tmp/wpd-"));
    const binary = join(root, "tailscale");
    const commandLog = join(root, "tailscale.log");
    const script = `
      import { homedir } from "node:os";
      import { readFileSync, realpathSync } from "node:fs";
      import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
      const root = ${JSON.stringify(root)};
      const assertOwned = (path) => {
        const canonicalRoot = realpathSync(root);
        const resolved = resolve(path);
        const relativePath = relative(canonicalRoot, resolved);
        const parentRelative = relative(canonicalRoot, realpathSync(dirname(resolved)));
        if (relativePath === "" || relativePath === ".." || relativePath.startsWith(".." + sep) || isAbsolute(relativePath) || parentRelative === ".." || parentRelative.startsWith(".." + sep) || isAbsolute(parentRelative)) throw new Error("fixture escape");
      };
      if (readFileSync(${JSON.stringify(join(root, ".wolfpack-test-fixture"))}, "utf-8") !== "owned\\n") throw new Error("fixture marker missing");
      const { WOLFPACK_DIR } = await import(${JSON.stringify(join(process.cwd(), "src", "cli", "config.ts"))});
      assertOwned(homedir());
      assertOwned(WOLFPACK_DIR);
      const { readTailscaleSelfStatus } = await import(${JSON.stringify(join(process.cwd(), "src", "cli", "doctor.ts"))});
      process.stdout.write(readTailscaleSelfStatus(${JSON.stringify(binary)}));
    `;
    try {
      writeFileSync(join(root, ".wolfpack-test-fixture"), "owned\n");
      mkdirSync(join(root, "home"), { recursive: true });
      writeFileSync(commandLog, "");
      writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(commandLog)}\nprintf '{"Self":{"DNSName":"host.tailnet.ts.net."}}'\n`);
      chmodSync(binary, 0o755);
      const output = execFileSync(process.execPath, ["--eval", script], {
        cwd: root,
        encoding: "utf-8",
        env: doctorFixtureEnvironment(root, "home"),
        timeout: 2500,
      });
      expect(output).toContain("host.tailnet.ts.net");
      // Cross-platform command-boundary evidence only; not Linux/Tailscale execution.
      expect(readFileSync(commandLog, "utf-8")).toBe("status --self --json\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 3000);
});

describe("tailscaleBin shared export", () => {
  test("tailscaleBin is exported from config", async () => {
    const { tailscaleBin } = await import("../../src/cli/config.ts");
    expect(typeof tailscaleBin).toBe("function");
    const result = tailscaleBin();
    expect(result === null || typeof result === "string").toBe(true);
  });
});
