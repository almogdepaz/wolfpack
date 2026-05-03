/**
 * Integration test — broker snapshot reflow with target_cols.
 *
 * Drives a real Rust broker session at 160 cols, fills the scrollback with
 * lines >80 chars, resizes to 120 cols for mixed-width history, then fetches a
 * snapshot with `target_cols=80` and asserts:
 *
 *   1. Every scrollback row has ≤ 80 cells.
 *   2. Wrap markers form a consistent paragraph structure: no `wrapped: true`
 *      row is the last row in the buffer, and every interior wrapped row is
 *      full-width (≥ 75 cells, tolerating grapheme edge cases).
 *   3. Without target_cols, visible_screen widths match the reported cols.
 *
 * Skips cleanly when the broker binary is not built.
 */
process.env.WOLFPACK_TEST = "1";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BrokerClient } from "../../src/broker/client";
import { BrokerBackend } from "../../src/server/broker-backend";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

function resolveBrokerBin(): string | null {
  const fromEnv = process.env.WOLFPACK_BROKER_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = [
    path.join(REPO_ROOT, "broker", "target", "debug", "wolfpack-broker"),
    path.join(REPO_ROOT, "broker", "target", "release", "wolfpack-broker"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const BROKER_BIN = resolveBrokerBin();

const D = BROKER_BIN ? describe : describe.skip;

if (!BROKER_BIN) {
  console.warn(
    "[broker-snapshot-reflow.integration] skipped — broker binary not found. " +
      "Run `cargo build --manifest-path broker/Cargo.toml --bin wolfpack-broker` first.",
  );
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForFile(p: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) return;
    await wait(50);
  }
  throw new Error(`timeout waiting for ${p} to appear`);
}

// ── Wire types ─────────────────────────────────────────────────────────────

interface StyledCell {
  ch?: string;
}

interface StyledLine {
  cells?: StyledCell[];
  wrapped?: boolean;
}

interface SnapshotPayload {
  session_id: string;
  seq: number;
  cols: number;
  rows: number;
  visible_screen: StyledLine[];
  scrollback?: StyledLine[];
}

// ── Suite ──────────────────────────────────────────────────────────────────

D("broker snapshot reflow (target_cols=80)", () => {
  let tmpdir: string;
  let socketPath: string;
  let proc: ChildProcess | null = null;
  let client: BrokerClient | null = null;
  let stderrBuf = "";
  let sessionId: string | null = null;

  const SESSION = "reflow-test-session";
  const ENCODER = new TextEncoder();

  // Startup script: generate 60 lines of 110 'A' chars at 160 cols.
  // 60 lines > 24 visible rows, so lines 1-36+ land in scrollback.
  // Then exec /bin/sh -i to stay alive and accept further input.
  // Passed as argv[2] to /bin/sh -c — no extra shell quoting layer.
  const STARTUP_SCRIPT =
    "for i in $(seq 60); do printf \"%110s\\n\" | tr \" \" A; done; exec /bin/sh -i";

  beforeAll(async () => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "wolfpack-broker-reflow-it-"));
    socketPath = path.join(tmpdir, "broker.sock");

    proc = spawn(BROKER_BIN!, [], {
      env: {
        ...process.env,
        WOLFPACK_BROKER_SOCKET: socketPath,
        WOLFPACK_BROKER_LOG: process.env.WOLFPACK_BROKER_LOG ?? "warn",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
      if (stderrBuf.length > 64 * 1024) stderrBuf = stderrBuf.slice(-64 * 1024);
    });
    proc.on("exit", (code, signal) => {
      stderrBuf += `\n[broker exited code=${code} signal=${signal}]\n`;
    });

    await waitForFile(socketPath, 5000);

    let resolveConnect!: () => void;
    const connected = new Promise<void>((resolve) => { resolveConnect = resolve; });
    client = new BrokerClient({
      socketPath,
      requestTimeoutMs: 10_000,
      onConnect: () => resolveConnect(),
    });
    client.start();
    await Promise.race([connected, wait(3000)]);

    // Belt-and-braces ping
    const pingDeadline = Date.now() + 5000;
    while (Date.now() < pingDeadline) {
      try {
        const resp = await client.request("list_sessions", {});
        if (resp.status === "ok") break;
      } catch {
        await wait(50);
      }
    }

    // 1. Create session at 160 cols.  The startup command generates 60 wide
    //    lines then execs an interactive shell to keep the PTY alive.
    const createResp = await client.request("create_session", {
      name: SESSION,
      cwd: tmpdir,
      command: ["/bin/sh", "-c", STARTUP_SCRIPT],
      env: [
        ["TERM", "xterm-256color"],
        ["LANG", "en_US.UTF-8"],
        ["PS1", "$ "],
      ],
      cols: 160,
      rows: 24,
    });
    expect(createResp.status).toBe("ok");
    sessionId = (createResp.payload?.session as { id: string }).id;

    // 2. Wait for all 60 lines to render and the inner shell to start
    await wait(2000);

    // 3. Resize to 120 cols — scrollback now contains 160-era lines; new
    //    content will be emitted at 120-col width.
    const resizeResp = await client.request("resize", {
      session_id: sessionId,
      cols: 120,
      rows: 24,
    });
    expect(resizeResp.status).toBe("ok");

    // 4. Send 25 more lines of 90 'B' chars at 120 cols via PTY input.
    //    90-char lines still exceed the 80-col reflow target.
    const gen120 =
      "for i in $(seq 25); do printf \"%90s\\n\" | tr ' ' B; done\r";
    client.writeInput(sessionId, ENCODER.encode(gen120));

    await wait(1500);
  }, 60_000);

  afterAll(async () => {
    if (sessionId && client) {
      try {
        await client.request("kill_session", { session_id: sessionId, signal: 1 });
      } catch { /* swallow */ }
    }
    try { client?.close(); } catch { /* swallow */ }
    try {
      if (proc && proc.exitCode === null) {
        proc.kill("SIGTERM");
        const exited = new Promise<void>((resolve) => { proc!.once("exit", () => resolve()); });
        await Promise.race([exited, wait(3000).then(() => "timeout" as const)]);
        if (proc.exitCode === null) {
          try { proc.kill("SIGKILL"); } catch { /* swallow */ }
        }
      }
    } catch { /* swallow */ }
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* swallow */ }
    if (process.env.WOLFPACK_BROKER_DEBUG && stderrBuf) {
      console.error("[broker stderr]\n" + stderrBuf);
    }
  });

  // ── Probe: stale-binary detector ──────────────────────────────────────
  // A pre-Phase-2 broker silently ignores `target_cols` and returns rows at
  // the broker's native col-width — every "reflow" assertion below would
  // then fail confusingly. This probe runs first and gives a clear repro
  // command if it trips.

  test("PROBE: broker binary supports target_cols reflow", async () => {
    expect(sessionId).toBeTruthy();
    const resp = await client!.request("snapshot", {
      session_id: sessionId!,
      scrollback_lines: 500,
      target_cols: 4, // tiny target — any reflow-aware broker emits ≤4-cell rows
    });
    expect(resp.status).toBe("ok");
    const snap = resp.payload?.snapshot as SnapshotPayload | undefined;
    expect(snap).toBeDefined();
    const rows = snap!.scrollback ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const n = r.cells?.length ?? 0;
      if (n > 4) {
        throw new Error(
          `stale broker binary — got cells=${n}, expected ≤4. ` +
          `Rebuild with: cargo build --manifest-path broker/Cargo.toml --release`,
        );
      }
    }
  }, 10_000);

  // ── Test 1: cell-count bound after reflow ─────────────────────────────

  test("all scrollback rows have ≤ 80 cells when target_cols=80", async () => {
    expect(sessionId).toBeTruthy();

    const resp = await client!.request("snapshot", {
      session_id: sessionId!,
      scrollback_lines: 500,
      target_cols: 80,
    });

    expect(resp.status).toBe("ok");
    const snap = resp.payload?.snapshot as SnapshotPayload | undefined;
    expect(snap).toBeDefined();

    const scrollback = snap!.scrollback ?? [];
    // 60+25 lines of output at 24 visible rows must produce substantial scrollback.
    expect(scrollback.length).toBeGreaterThan(30);

    const violations: Array<{ idx: number; cells: number }> = [];
    for (let i = 0; i < scrollback.length; i++) {
      const cellCount = scrollback[i].cells?.length ?? 0;
      if (cellCount > 80) violations.push({ idx: i, cells: cellCount });
    }
    expect(violations).toEqual([]);
  }, 20_000);

  // ── Test 2: wrap-marker structural invariants ─────────────────────────

  test("wrap markers form consistent paragraph structure after reflow", async () => {
    expect(sessionId).toBeTruthy();

    const resp = await client!.request("snapshot", {
      session_id: sessionId!,
      scrollback_lines: 500,
      target_cols: 80,
    });

    expect(resp.status).toBe("ok");
    const snap = resp.payload?.snapshot as SnapshotPayload | undefined;
    expect(snap).toBeDefined();

    const scrollback = snap!.scrollback ?? [];
    expect(scrollback.length).toBeGreaterThan(30);

    // Confirm reflow actually happened: lines wider than 80 cols must have
    // produced wrapped: true continuation rows.  Without this, all structural
    // invariants below pass vacuously on a buggy no-op reflow.
    expect(scrollback.some((r) => r.wrapped === true)).toBe(true);

    // A: last row must not be wrapped — there is no continuation row after it.
    expect(scrollback[scrollback.length - 1].wrapped ?? false).toBe(false);

    // B: every row marked wrapped: true must have a successor row.
    for (let i = 0; i < scrollback.length; i++) {
      if (scrollback[i].wrapped === true) {
        expect(i + 1).toBeLessThan(scrollback.length);
      }
    }

    // C: interior wrapped rows must be full-width.  A wrapped row that is
    // shorter than 75 cells would indicate the reflow broke a line without
    // actually filling the target column, which is a reflow bug.
    for (let i = 0; i < scrollback.length; i++) {
      if (scrollback[i].wrapped === true) {
        const cellCount = scrollback[i].cells?.length ?? 0;
        expect(cellCount).toBeGreaterThanOrEqual(75);
      }
    }
  }, 20_000);

  // ── Test 3: baseline — no target_cols leaves native width intact ───────

  test("without target_cols, visible_screen widths match the reported cols", async () => {
    expect(sessionId).toBeTruthy();

    const resp = await client!.request("snapshot", {
      session_id: sessionId!,
      scrollback_lines: 10,
      // no target_cols
    });

    expect(resp.status).toBe("ok");
    const snap = resp.payload?.snapshot as SnapshotPayload | undefined;
    expect(snap).toBeDefined();

    // After resize to 120, broker should report 120 cols.
    expect(snap!.cols).toBe(120);

    for (const row of snap!.visible_screen) {
      const cellCount = row.cells?.length ?? 0;
      expect(cellCount).toBeLessThanOrEqual(snap!.cols);
    }
  }, 20_000);
});

// ── Suite: attach-flow at narrower cols ────────────────────────────────────
//
// Simulates: previous client held the session at 120 cols.
// New client connects at 80 cols and requests getSessionPrefill(name, 80).
// Asserts that every scrollback line in the rendered ANSI prefill is ≤ 80
// printable chars wide (the broker reflows scrollback to target_cols before
// rendering, so the client-side terminal emulator never sees wider content).

D("broker attach: second client at cols=80 when session was cols=120", () => {
  let tmpdir: string;
  let socketPath: string;
  let proc: ChildProcess | null = null;
  let client: BrokerClient | null = null;
  let stderrBuf2 = "";
  let sessionId2: string | null = null;

  const SESSION2 = "attach-reflow-test";

  // 35 lines of 90 'C' chars at 120 cols — lines exceed 80 so the 80-col
  // reflow must split each original line into at least two rows in scrollback.
  const STARTUP2 =
    "for i in $(seq 35); do printf \"%90s\\n\" | tr \" \" C; done; exec /bin/sh -i";

  beforeAll(async () => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "wolfpack-broker-attach-it-"));
    socketPath = path.join(tmpdir, "broker.sock");

    proc = spawn(BROKER_BIN!, [], {
      env: {
        ...process.env,
        WOLFPACK_BROKER_SOCKET: socketPath,
        WOLFPACK_BROKER_LOG: process.env.WOLFPACK_BROKER_LOG ?? "warn",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf2 += chunk.toString("utf8");
      if (stderrBuf2.length > 64 * 1024) stderrBuf2 = stderrBuf2.slice(-64 * 1024);
    });
    proc.on("exit", (code, signal) => {
      stderrBuf2 += `\n[broker exited code=${code} signal=${signal}]\n`;
    });

    await waitForFile(socketPath, 5000);

    let resolveConnect!: () => void;
    const connected = new Promise<void>((resolve) => { resolveConnect = resolve; });
    client = new BrokerClient({
      socketPath,
      requestTimeoutMs: 10_000,
      onConnect: () => resolveConnect(),
    });
    client.start();
    await Promise.race([connected, wait(3000)]);

    const pingDeadline = Date.now() + 5000;
    while (Date.now() < pingDeadline) {
      try {
        const resp = await client.request("list_sessions", {});
        if (resp.status === "ok") break;
      } catch {
        await wait(50);
      }
    }

    // First "client" creates the session at 120 cols and generates wide scrollback.
    const createResp = await client.request("create_session", {
      name: SESSION2,
      cwd: tmpdir,
      command: ["/bin/sh", "-c", STARTUP2],
      env: [
        ["TERM", "xterm-256color"],
        ["LANG", "en_US.UTF-8"],
        ["PS1", "$ "],
      ],
      cols: 120,
      rows: 24,
    });
    expect(createResp.status).toBe("ok");
    sessionId2 = (createResp.payload?.session as { id: string }).id;

    // Wait for 35 lines to render + shell to start.
    await wait(2000);
  }, 60_000);

  afterAll(async () => {
    if (sessionId2 && client) {
      try {
        await client.request("kill_session", { session_id: sessionId2, signal: 1 });
      } catch { /* swallow */ }
    }
    try { client?.close(); } catch { /* swallow */ }
    try {
      if (proc && proc.exitCode === null) {
        proc.kill("SIGTERM");
        const exited = new Promise<void>((resolve) => { proc!.once("exit", () => resolve()); });
        await Promise.race([exited, wait(3000).then(() => "timeout" as const)]);
        if (proc.exitCode === null) {
          try { proc.kill("SIGKILL"); } catch { /* swallow */ }
        }
      }
    } catch { /* swallow */ }
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* swallow */ }
    if (process.env.WOLFPACK_BROKER_DEBUG && stderrBuf2) {
      console.error("[broker stderr]\n" + stderrBuf2);
    }
  });

  test("getSessionPrefill(name, 80): rendered scrollback lines are ≤ 80 printable chars", async () => {
    expect(sessionId2).toBeTruthy();

    // 1. Get raw snapshot to learn the reflowed scrollback line count and
    //    confirm the broker actually has scrollback with >80-char content.
    const snapResp = await client!.request("snapshot", {
      session_id: sessionId2!,
      scrollback_lines: 500,
      target_cols: 80,
    });
    expect(snapResp.status).toBe("ok");
    const snap = snapResp.payload?.snapshot as SnapshotPayload | undefined;
    expect(snap).toBeDefined();

    const scrollbackCount = (snap!.scrollback ?? []).length;
    // 35 lines × 90 chars reflowed to 80 must produce at least 35 rows.
    expect(scrollbackCount).toBeGreaterThan(20);

    // Raw cell-count check on the RPC result (belt-and-braces: broker reflow works).
    for (const row of snap!.scrollback ?? []) {
      expect((row.cells?.length ?? 0)).toBeLessThanOrEqual(80);
    }

    // 2. Exercise the full attach-flow code path: BrokerBackend.getSessionPrefill
    //    with cols=80, as called when a second client connects at 80 cols.
    const backend = new BrokerBackend(client!);
    // Seed the nameToId cache so resolveId doesn't need a list() RPC.
    // BrokerBackend.list() is the canonical way; call it here.
    const names = await backend.list();
    expect(names).toContain(SESSION2);

    const prefill = await backend.getSessionPrefill(SESSION2, 80);
    expect(prefill.data.byteLength).toBeGreaterThan(0);

    // 3. Parse the ANSI prefill buffer.
    //    Format: CLEAR_AND_HOME + scrollback_lines (plain, \r\n) + visible_screen + cursor.
    //    CLEAR_AND_HOME = "\x1b[2J\x1b[3J\x1b[H\x1b[0m" (all ANSI, no \r\n).
    //    Scrollback lines have NO ANSI sequences — they are emitted by plainLine().
    const CLEAR_AND_HOME = "\x1b[2J\x1b[3J\x1b[H\x1b[0m";
    const ansiStr = prefill.data.toString("utf8");
    expect(ansiStr.startsWith(CLEAR_AND_HOME)).toBe(true);
    const afterClear = ansiStr.slice(CLEAR_AND_HOME.length);

    // Split on \r\n; the first scrollbackCount entries are the scrollback.
    const allLines = afterClear.split("\r\n");
    const scrollbackLines = allLines.slice(0, scrollbackCount);

    // Scrollback lines must be plain text (no ANSI escapes — emitted by plainLine()).
    // Their byte length equals their printable width (all ASCII in this test).
    const violations: Array<{ idx: number; len: number }> = [];
    for (let i = 0; i < scrollbackLines.length; i++) {
      const line = scrollbackLines[i];
      // Sanity: scrollback lines have no ANSI in them (unlike visible_screen).
      expect(line.includes("\x1b")).toBe(false);
      if (line.length > 80) {
        violations.push({ idx: i, len: line.length });
      }
    }
    expect(violations).toEqual([]);
  }, 30_000);
});
