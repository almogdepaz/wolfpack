import { describe, expect, test, beforeEach, afterEach } from "bun:test";
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

describe("doctor() integration", () => {
  test("returns 0 or 1 without throwing (no --fix)", async () => {
    const { doctor } = await import("../../src/cli/doctor.ts");
    const code = await doctor();
    expect(code === 0 || code === 1).toBe(true);
  });

  test("returns number type", async () => {
    const { doctor } = await import("../../src/cli/doctor.ts");
    expect(typeof await doctor()).toBe("number");
  });

  test("accepts { fix: true } without throwing", async () => {
    const { doctor } = await import("../../src/cli/doctor.ts");
    const code = await doctor({ fix: true });
    expect(code === 0 || code === 1).toBe(true);
  });

  test("accepts { fix: false } explicitly", async () => {
    const { doctor } = await import("../../src/cli/doctor.ts");
    const code = await doctor({ fix: false });
    expect(code === 0 || code === 1).toBe(true);
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
