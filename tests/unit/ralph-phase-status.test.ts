import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRalphLog } from "../../src/server/ralph.ts";
import { startFakeRalph, stopFakeRalph, type FakeRalph } from "../helpers/fake-ralph-pid.js";

// PID stand-in for fixtures that need parseRalphLog active=true under the
// PID-reuse-safe filter (issues.md H6). See tests/helpers/fake-ralph-pid.ts.
let fakeRalphPid: number = process.pid;
let fakeRalph: FakeRalph | null = null;
beforeAll(() => { fakeRalph = startFakeRalph(); fakeRalphPid = fakeRalph.pid; });
afterAll(() => { if (fakeRalph) stopFakeRalph(fakeRalph); });

let tmpProjectDir: string;

function writePlan(content = "- [ ] task\n"): void {
  writeFileSync(join(tmpProjectDir, "PLAN.md"), content);
}

function writeLog(content: string): void {
  writeFileSync(join(tmpProjectDir, ".ralph.log"), content);
}

function buildHeader(pid: number): string {
  return [
    "🥋 ralph — 5 iterations",
    "agent: claude",
    "plan: PLAN.md",
    "progress: progress.txt",
    "phase_cleanup: on",
    "phase_audit_fix: off",
    `pid: ${pid}`,
    "started: Mon Jan 01 2024 12:00:00",
    "",
  ].join("\n");
}

describe("parseRalphLog phase status and config", () => {
  beforeEach(() => {
    tmpProjectDir = mkdtempSync(join(tmpdir(), "ralph-phase-status-"));
    writePlan();
  });

  afterEach(() => {
    rmSync(tmpProjectDir, { recursive: true, force: true });
  });

  test("parses phase config flags from log header", () => {
    const deadPid = 999999;
    writeLog(
      [
        "🥋 ralph — 5 iterations",
        "agent: claude",
        "plan: PLAN.md",
        "progress: progress.txt",
        "phase_cleanup: off",
        "phase_audit_fix: on",
        `pid: ${deadPid}`,
        "started: Mon Jan 01 2024 12:00:00",
        "finished: Mon Jan 01 2024 12:10:00",
        "",
      ].join("\n"),
    );

    const status = parseRalphLog(tmpProjectDir);
    expect(status).not.toBeNull();
    expect(status?.cleanupEnabled).toBe(false);
    expect(status?.auditFixEnabled).toBe(true);
  });

  test("audit=true while Wax Inspect is running", () => {
    writeLog(
      buildHeader(fakeRalphPid)
      + "\n=== 🥋 Wax Inspect — starting audit+fix — now ===\n"
      + "checking files...\n",
    );

    const status = parseRalphLog(tmpProjectDir);
    expect(status).not.toBeNull();
    expect(status?.active).toBe(true);
    expect(status?.audit).toBe(true);
    expect(status?.cleanup).toBe(false);
  });

  test("audit=false once Wax Inspect completes", () => {
    writeLog(
      buildHeader(fakeRalphPid)
      + "\n=== 🥋 Wax Inspect — starting audit+fix — now ===\n"
      + "checking files...\n"
      + "=== ✅ Wax Inspect complete — now ===\n",
    );

    const status = parseRalphLog(tmpProjectDir);
    expect(status).not.toBeNull();
    expect(status?.active).toBe(true);
    expect(status?.audit).toBe(false);
  });
});
