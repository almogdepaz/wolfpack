#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Page } from "playwright";

type TraceEvent = { t: number; kind: string; [field: string]: unknown };
type TraceState = {
  _meta: { session: string; machine: string; startWall: number; startPerf: number; mode?: string };
  events: TraceEvent[];
};
type ServerTiming = {
  event: string;
  session: string;
  mode: string;
  sinceStartMs: number;
  [field: string]: unknown;
};
type ScenarioSummary = {
  scenario: string;
  mode: "single" | "grid";
  cells: number;
  sessions: CellSummary[];
  server: ServerTiming[];
};
type CellSummary = {
  session: string;
  ghosttyCreationMs: number | null;
  wsServerMs: number | null;
  prefillMs: number | null;
  hydrationRevealMs: number | null;
  prefillBytes: number;
};

const ROOT = join(import.meta.dirname, "..");
const DEV_DIR = join(ROOT, ".wolfpack", "terminal-load-perf-dev");

function resolveBrokerBin(): string | null {
  const fromEnv = process.env.WOLFPACK_BROKER_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const candidate of [
    join(ROOT, "broker", "target", "debug", "wolfpack-broker"),
    join(ROOT, "broker", "target", "release", "wolfpack-broker"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await wait(50);
  }
  throw new Error(`timeout waiting for ${path}`);
}

function startBroker(binary: string): { socketPath: string; proc: ChildProcess; stderr: () => string } {
  const socketPath = `/tmp/wp-perf-${randomUUID()}.sock`;
  let stderr = "";
  const proc = spawn(binary, [], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      WOLFPACK_BROKER_SOCKET: socketPath,
      WOLFPACK_BROKER_LOG: process.env.WOLFPACK_BROKER_LOG ?? "warn",
    },
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
  });
  return { socketPath, proc, stderr: () => stderr };
}

function existingBroker(): { socketPath: string; proc: null; stderr: () => string } | null {
  if (process.env.WOLFPACK_PERF_USE_EXISTING_BROKER !== "1") return null;
  const socketPath = process.env.WOLFPACK_BROKER_SOCKET;
  if (!socketPath) {
    throw new Error("WOLFPACK_PERF_USE_EXISTING_BROKER=1 requires WOLFPACK_BROKER_SOCKET");
  }
  if (!existsSync(socketPath)) {
    throw new Error(`existing broker socket not found: ${socketPath}`);
  }
  return { socketPath, proc: null, stderr: () => "" };
}

async function startServer(socketPath: string, opts?: { prefillDelayMs?: number }): Promise<{
  baseUrl: string;
  proc: ChildProcess;
  timings: ServerTiming[];
}> {
  const timings: ServerTiming[] = [];
  const proc = spawn("bun", [join(ROOT, "tests", "e2e", "test-server-broker.ts")], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      WOLFPACK_TEST: "1",
      WOLFPACK_BROKER_SOCKET: socketPath,
      WOLFPACK_DEV_DIR: DEV_DIR,
      WOLFPACK_LOG_LEVEL: "info",
      WOLFPACK_TERMINAL_LOAD_DEBUG: "1",
      ...(opts?.prefillDelayMs ? { WOLFPACK_TEST_PREFILL_DELAY_MS: String(opts.prefillDelayMs) } : {}),
    },
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("perf test server did not start within 15s"));
    }, 15_000);
    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      for (const line of text.split(/\n/)) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.component === "ws" && parsed?.msg === "terminal_load") {
            timings.push(parsed as ServerTiming);
          }
        } catch {}
      }
      const match = stdout.match(/READY:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString("utf8").trim();
      if (msg) process.stderr.write(`[perf-server] ${msg}\n`);
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on("exit", (code) => {
      if (!stdout.includes("READY:")) {
        clearTimeout(timeout);
        reject(new Error(`perf test server exited before ready (code ${code})`));
      }
    });
  });

  return { baseUrl: `http://127.0.0.1:${port}`, proc, timings };
}

async function createSession(baseUrl: string, name: string, project: string): Promise<void> {
  mkdirSync(join(DEV_DIR, project), { recursive: true });
  const res = await fetch(`${baseUrl}/api/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, cmd: "shell", sessionName: name }),
  });
  if (!res.ok) throw new Error(`create ${name} failed: ${res.status} ${await res.text()}`);
}

async function setupPage(baseUrl: string): Promise<{ page: Page; close(): Promise<void> }> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => localStorage.setItem("wolfpackDebug", "1"));
  await page.goto(baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  return { page, close: () => browser.close() };
}

async function readTraces(page: Page, expected: number): Promise<Record<string, TraceState>> {
  await page.waitForFunction((count) => {
    const traces = (window as unknown as { __wfTrace?: Record<string, TraceState> }).__wfTrace || {};
    const hydrated = Object.values(traces).filter((trace) =>
      trace.events.some((event) => event.kind === "hydration.reveal" || event.kind === "hydration.finish"));
    return hydrated.length >= count;
  }, expected, { timeout: 20_000 });
  await page.waitForTimeout(250);
  return await page.evaluate(() => {
    return (window as unknown as { __wfTrace?: Record<string, TraceState> }).__wfTrace || {};
  });
}

function eventTime(events: TraceEvent[], kind: string): number | null {
  return events.find((event) => event.kind === kind)?.t ?? null;
}

function delta(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return +(b - a).toFixed(3);
}

function summarizeCell(trace: TraceState): CellSummary {
  const events = trace.events;
  const prefillBytes = events
    .filter((event) => event.kind === "ws.binary" && event.bucket === "prefill")
    .reduce((sum, event) => sum + (typeof event.size === "number" ? event.size : 0), 0);
  return {
    session: trace._meta.session,
    ghosttyCreationMs: delta(eventTime(events, "ghostty.ready"), eventTime(events, "terminal.instance.created")),
    wsServerMs: delta(eventTime(events, "attach.send"), eventTime(events, "pty_ready")),
    prefillMs: delta(eventTime(events, "prefill.first_chunk"), eventTime(events, "prefill_done")),
    hydrationRevealMs: delta(eventTime(events, "hydration.start"), eventTime(events, "hydration.reveal")),
    prefillBytes,
  };
}

function serverTimingsFor(timings: ServerTiming[], sessions: string[]): ServerTiming[] {
  const set = new Set(sessions);
  return timings.filter((timing) => set.has(timing.session));
}

async function runSingle(baseUrl: string, timings: ServerTiming[], session: string): Promise<ScenarioSummary> {
  const { page, close } = await setupPage(baseUrl);
  try {
    await page.evaluate((name) => {
      (window as unknown as { openSession(name: string): void }).openSession(name);
    }, session);
    const traces = await readTraces(page, 1);
    const trace = Object.values(traces).find((item) => item._meta.session === session);
    if (!trace) throw new Error(`missing trace for ${session}`);
    return {
      scenario: "single:1",
      mode: "single",
      cells: 1,
      sessions: [summarizeCell(trace)],
      server: serverTimingsFor(timings, [session]),
    };
  } finally {
    await close();
  }
}

async function runGrid(baseUrl: string, timings: ServerTiming[], sessions: string[]): Promise<ScenarioSummary> {
  const { page, close } = await setupPage(baseUrl);
  try {
    await page.evaluate((names) => {
      const w = window as unknown as {
        openSession(name: string): void;
        addToGrid(name: string): void;
      };
      w.openSession(names[0]);
    }, sessions);
    await page.waitForSelector("#desktop-terminal-container canvas", { timeout: 10_000 });
    for (const session of sessions.slice(1)) {
      await page.evaluate((name) => {
        (window as unknown as { addToGrid(name: string): void }).addToGrid(name);
      }, session);
      await page.waitForTimeout(100);
    }
    const traces = await readTraces(page, sessions.length);
    const cells = sessions.map((session) => {
      const trace = Object.values(traces).find((item) => item._meta.session === session);
      if (!trace) throw new Error(`missing trace for ${session}`);
      return summarizeCell(trace);
    });
    return {
      scenario: `grid:${sessions.length}`,
      mode: "grid",
      cells: sessions.length,
      sessions: cells,
      server: serverTimingsFor(timings, sessions),
    };
  } finally {
    await close();
  }
}

function printSummary(summary: ScenarioSummary): void {
  console.log(`\n${summary.scenario}`);
  console.table(summary.sessions.map((cell) => ({
    session: cell.session,
    ghosttyMs: cell.ghosttyCreationMs,
    wsServerMs: cell.wsServerMs,
    prefillMs: cell.prefillMs,
    hydrationRevealMs: cell.hydrationRevealMs,
    prefillBytes: cell.prefillBytes,
  })));
  const serverEnd = summary.server.filter((event) =>
    ["snapshot_fetch.end", "prefill_send.end", "pty_ready.send"].includes(event.event));
  if (serverEnd.length) {
    console.table(serverEnd.map((event) => ({
      session: event.session,
      event: event.event,
      mode: event.mode,
      sinceStartMs: event.sinceStartMs,
      bytes: event.bytes,
    })));
  }
}

async function main(): Promise<void> {
  const brokerBin = resolveBrokerBin();
  const broker = existingBroker() || (brokerBin ? startBroker(brokerBin) : null);
  if (!broker) {
    console.log("skipped: wolfpack-broker binary not found. run `cargo build --manifest-path broker/Cargo.toml --bin wolfpack-broker` first.");
    return;
  }

  rmSync(DEV_DIR, { recursive: true, force: true });
  mkdirSync(DEV_DIR, { recursive: true });

  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    if (broker.proc) await waitForFile(broker.socketPath, 5000);
    server = await startServer(broker.socketPath, {
      prefillDelayMs: Number(process.env.WOLFPACK_PERF_SLOW_PREFILL_MS || 0) || undefined,
    });
    const runId = Date.now().toString(36);
    const sessions = Array.from({ length: 6 }, (_, i) => `perf-${runId}-${i + 1}`);
    for (const [idx, session] of sessions.entries()) {
      await createSession(server.baseUrl, session, `perf-project-${idx + 1}`);
    }

    const summaries: ScenarioSummary[] = [];
    summaries.push(await runSingle(server.baseUrl, server.timings, sessions[0]));
    for (const cells of [2, 4, 6]) {
      summaries.push(await runGrid(server.baseUrl, server.timings, sessions.slice(0, cells)));
    }
    if (process.env.WOLFPACK_PERF_SLOW_PREFILL_MS) {
      summaries.push(await runSingle(server.baseUrl, server.timings, sessions[5]));
    }
    for (const summary of summaries) printSummary(summary);
    console.log("\njson:");
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), summaries }, null, 2));
  } finally {
    if (server) server.proc.kill("SIGTERM");
    if (broker.proc) {
      broker.proc.kill("SIGTERM");
      await wait(200);
      if (broker.proc.exitCode === null) broker.proc.kill("SIGKILL");
    }
    if (process.env.WOLFPACK_BROKER_DEBUG && broker.stderr()) {
      process.stderr.write(`[broker stderr]\n${broker.stderr()}\n`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
