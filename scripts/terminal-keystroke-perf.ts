#!/usr/bin/env bun
/**
 * Keystroke round-trip benchmark for the web terminal.
 *
 * Measures, inside the browser, the time from the /ws/pty WebSocket `send` of
 * a typed byte to the first binary WebSocket message that carries its echo.
 * That interval covers the Bun relay, the broker, the PTY line discipline,
 * and the server-side output coalescer. It deliberately stops at the socket
 * so the number is independent of ghostty's paint cadence.
 *
 * Two scenarios:
 *   idle      — the shell is quiet; every keystroke is isolated output.
 *   streaming — a background loop writes a byte every ~10ms; echoes have to
 *               share the output path with a continuous stream.
 *
 * Environment:
 *   WOLFPACK_KB_PRESSES          keystrokes per scenario (default 60)
 *   WOLFPACK_KB_GAP_MS           pause between keystrokes (default 60)
 *   WOLFPACK_KB_STREAM_SLEEP     sleep argument for the streaming loop (default 0.01)
 *   WOLFPACK_KB_SCENARIOS        comma list: idle,streaming (default both)
 *   WOLFPACK_BROKER_BIN          broker binary (falls back to broker/target/...)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { AGENT_KIND } from "../src/agent-kind";
import { SHELL } from "../src/server/shell";
import {
  cleanupCreatedSessions,
  closePerfBrowser,
  createSession,
  resolveBrokerBin,
  setupPage,
  startBroker,
  startServer,
  waitForFile,
} from "./terminal-load-perf";

type Scenario = "idle" | "streaming";

type RttStats = {
  readonly scenario: Scenario;
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly minMs: number;
  readonly timeouts: number;
};

type SocketProbe = {
  /** Incremented per /ws/pty socket; a sample is valid only when send and echo share a generation. */
  generation: number;
  sent: Array<{ t: number; generation: number; bytes: number[] }>;
  received: Array<{ t: number; generation: number; bytes: number[] }>;
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const STREAM_BYTE = ".";
const PROJECT = "kb-perf";
const SESSION = "kb-perf-shell";
const ECHO_TIMEOUT_MS = 2_000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarize(scenario: Scenario, rtts: readonly number[], timeouts: number): RttStats {
  const sorted = [...rtts].sort((a, b) => a - b);
  const round = (value: number) => +value.toFixed(2);
  return {
    scenario,
    samples: sorted.length,
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(sorted[sorted.length - 1] ?? Number.NaN),
    minMs: round(sorted[0] ?? Number.NaN),
    timeouts,
  };
}

/** Installed before any page script: wraps WebSocket so binary sends and
 * receives on the pty socket are timestamped with performance.now(). */
async function installSocketProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: SocketProbe = { generation: 0, sent: [], received: [] };
    (window as unknown as { __kbProbe: SocketProbe }).__kbProbe = probe;
    const generations = new WeakMap<WebSocket, number>();
    const toBytes = (data: unknown): number[] | null => {
      if (data instanceof ArrayBuffer) return Array.from(new Uint8Array(data));
      if (ArrayBuffer.isView(data)) return Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return null;
    };
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedSend(this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
      if (this.url.includes("/ws/pty")) {
        const t = performance.now();
        const bytes = toBytes(data);
        if (bytes) probe.sent.push({ t, generation: generations.get(this) ?? -1, bytes });
      }
      return originalSend.call(this, data);
    };
    const OriginalWebSocket = WebSocket;
    const PatchedWebSocket = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
      const socket = protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);
      if (socket.url.includes("/ws/pty")) {
        const generation = ++probe.generation;
        generations.set(socket, generation);
        socket.addEventListener("message", (event) => {
          const t = performance.now();
          const bytes = toBytes(event.data);
          if (bytes) probe.received.push({ t, generation, bytes });
        });
      }
      return socket;
    } as unknown as typeof WebSocket;
    PatchedWebSocket.prototype = OriginalWebSocket.prototype;
    Object.defineProperties(PatchedWebSocket, {
      CONNECTING: { value: OriginalWebSocket.CONNECTING },
      OPEN: { value: OriginalWebSocket.OPEN },
      CLOSING: { value: OriginalWebSocket.CLOSING },
      CLOSED: { value: OriginalWebSocket.CLOSED },
    });
    (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = PatchedWebSocket;
  });
}

async function focusTerminal(page: Page): Promise<void> {
  const textarea = page.locator("#terminal-view textarea").first();
  await textarea.waitFor({ state: "attached", timeout: 15_000 });
  await textarea.focus();
}

async function receivedCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __kbProbe: SocketProbe }).__kbProbe.received.length);
}

/** Waits until no pty bytes have arrived for `quietMs`; throws if the shell never settles. */
async function waitForQuiet(page: Page, quietMs: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = await receivedCount(page);
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await wait(20);
    const now = await receivedCount(page);
    if (now !== last) {
      last = now;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return;
    }
  }
  throw new Error(`terminal output did not go quiet for ${quietMs}ms within ${timeoutMs}ms; scenario invalid`);
}

class SocketReconnectedError extends Error {
  constructor(stage: string) {
    super(`pty socket reconnected ${stage}; a replayed snapshot could be mistaken for an echo, results invalid`);
  }
}

async function currentGeneration(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __kbProbe: SocketProbe }).__kbProbe.generation);
}

/** Presses one key and returns its echo round trip, or null on timeout.
 * The whole run is pinned to the socket that was live after settle: any
 * other generation, before or after the send, aborts the scenario. */
async function pressAndMeasure(page: Page, char: string, pinnedGeneration: number): Promise<number | null> {
  const code = char.charCodeAt(0);
  if ((await currentGeneration(page)) !== pinnedGeneration) throw new SocketReconnectedError("before a keypress");
  const sentBefore = await page.evaluate(() => (window as unknown as { __kbProbe: SocketProbe }).__kbProbe.sent.length);
  await page.keyboard.press(char);
  let outcome: number | "reconnected" | null = null;
  try {
    const handle = await page.waitForFunction(
      ({ code: wanted, sentBefore: start, pinned }) => {
        const probe = (window as unknown as { __kbProbe: SocketProbe }).__kbProbe;
        if (probe.generation !== pinned) return "reconnected";
        const sent = probe.sent.slice(start).find((entry) => entry.bytes.includes(wanted));
        if (!sent) return null;
        if (sent.generation !== pinned) return "reconnected";
        const echo = probe.received.find((entry) =>
          entry.generation === pinned && entry.t >= sent.t && entry.bytes.includes(wanted));
        return echo ? echo.t - sent.t : null;
      },
      { code, sentBefore, pinned: pinnedGeneration },
      { timeout: ECHO_TIMEOUT_MS, polling: 1 },
    );
    outcome = (await handle.jsonValue()) as number | "reconnected";
  } catch {
    outcome = null;
  }
  if (outcome === "reconnected" || (await currentGeneration(page)) !== pinnedGeneration) {
    throw new SocketReconnectedError("during a sample");
  }
  return outcome;
}

async function runScenario(page: Page, scenario: Scenario, presses: number, gapMs: number, pinnedGeneration: number): Promise<RttStats> {
  const rtts: number[] = [];
  let timeouts = 0;
  for (let i = 0; i < presses; i++) {
    const char = ALPHABET[i % ALPHABET.length];
    const rtt = await pressAndMeasure(page, char, pinnedGeneration);
    if (rtt === null) timeouts++;
    else rtts.push(rtt);
    await wait(gapMs);
  }
  return summarize(scenario, rtts, timeouts);
}

function formatStats(stats: RttStats): string {
  return `${stats.scenario.padEnd(10)} n=${stats.samples} p50=${stats.p50Ms}ms p95=${stats.p95Ms}ms p99=${stats.p99Ms}ms max=${stats.maxMs}ms min=${stats.minMs}ms timeouts=${stats.timeouts}`;
}

async function main(): Promise<void> {
  const presses = envInt("WOLFPACK_KB_PRESSES", 60);
  const gapMs = envInt("WOLFPACK_KB_GAP_MS", 60);
  const streamSleep = process.env.WOLFPACK_KB_STREAM_SLEEP || "0.01";
  const scenarios = (process.env.WOLFPACK_KB_SCENARIOS || "idle,streaming")
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is Scenario => item === "idle" || item === "streaming");

  // Always a private broker on a temp socket: the benchmark kills its own
  // session by name, which is only safe when nothing else owns the broker.
  const brokerBin = resolveBrokerBin();
  if (!brokerBin) {
    console.log("skipped: wolfpack-broker binary not found (set WOLFPACK_BROKER_BIN).");
    return;
  }
  const broker = startBroker(brokerBin);
  const brokerVersion = spawnSync(brokerBin, ["--version"], { encoding: "utf8" }).stdout?.trim() || null;

  let devDir: string | null = null;
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  const createdSessions: string[] = [];
  try {
    devDir = mkdtempSync(join(tmpdir(), "wolfpack-keystroke-perf-"));
    await waitForFile(broker.socketPath, 5_000);
    server = await startServer(broker.socketPath, devDir);
    await createSession(devDir, server.baseUrl, SESSION, PROJECT);
    createdSessions.push(SESSION);

    const results: RttStats[] = [];
    const { page, close } = await setupPage(server.baseUrl);
    try {
      await installSocketProbe(page);
      // The init script only applies to navigations after installation.
      await page.goto(server.baseUrl);
      await page.waitForSelector(".card", { timeout: 15_000 });
      await page.getByRole("button", { name: `Open ${SESSION}`, exact: true }).filter({ visible: true }).first().click();
      await focusTerminal(page);
      await waitForQuiet(page, 500, 10_000);
      // Readline echo is what we measure; disable the shell prompt noise by
      // waiting for the first prompt to settle before typing anything.
      await page.keyboard.press("Enter");
      await waitForQuiet(page, 300, 5_000);
      // Pin the live socket: prefill/replay on any later socket must never
      // be read as an echo, so a reconnect anywhere in the run aborts it.
      const pinnedGeneration = await currentGeneration(page);
      if (pinnedGeneration < 1) throw new Error("no /ws/pty socket observed after settle");

      if (scenarios.includes("idle")) {
        results.push(await runScenario(page, "idle", presses, gapMs, pinnedGeneration));
      }
      if (scenarios.includes("streaming")) {
        // Clear whatever idle typing left on the line, then start the stream.
        await page.keyboard.press("Control+U");
        await page.keyboard.type(`while :; do printf '${STREAM_BYTE}'; sleep ${streamSleep}; done &`, { delay: 5 });
        await page.keyboard.press("Enter");
        await wait(500);
        results.push(await runScenario(page, "streaming", presses, gapMs, pinnedGeneration));
        await page.keyboard.press("Control+U");
        await page.keyboard.type("kill $!", { delay: 5 });
        await page.keyboard.press("Enter");
        await wait(200);
      }
    } finally {
      await close();
    }

    console.log("keystroke ws round-trip (browser send → first echo message):");
    for (const stats of results) console.log(`  ${formatStats(stats)}`);
    console.log("\njson:");
    const environment = {
      brokerBin,
      brokerVersion,
      shellPreset: AGENT_KIND.SHELL.id,
      shellExecutable: SHELL,
      device: process.env.WOLFPACK_PERF_DEVICE ?? "desktop",
      wolfpackDebugTrace: true,
      terminalLoadDebug: true,
      hydrationMinPendingMs: process.env.WOLFPACK_PERF_HYDRATION_MIN_PENDING_MS ?? null,
      hydrationSilenceMs: process.env.WOLFPACK_PERF_HYDRATION_SILENCE_MS ?? null,
      layoutStableMode: process.env.WOLFPACK_PERF_LAYOUT_STABLE_MODE ?? null,
      ghosttyPrewarmPoolSize: process.env.WOLFPACK_PERF_GHOSTTY_PREWARM_POOL_SIZE ?? null,
      ghosttyPrewarmDelayMs: process.env.WOLFPACK_PERF_GHOSTTY_PREWARM_DELAY_MS ?? null,
      probe: "WebSocket wrapper in page; timestamps at send() entry and message-listener entry, before byte copies",
    };
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), presses, gapMs, streamSleep, environment, results }, null, 2));
  } finally {
    await closePerfBrowser();
    // Kill the shell session (and its background stream loop) before the
    // server goes away; with a caller-owned broker nothing else would.
    if (server && createdSessions.length > 0) {
      const cleanupFailures = await cleanupCreatedSessions(server.baseUrl, createdSessions);
      if (cleanupFailures.length > 0) console.warn("keystroke perf session cleanup failures", cleanupFailures);
    }
    if (server) server.proc.kill("SIGTERM");
    broker.proc.kill("SIGTERM");
    await wait(200);
    if (broker.proc.exitCode === null) broker.proc.kill("SIGKILL");
    rmSync(broker.tempDir, { recursive: true, force: true });
    if (devDir) rmSync(devDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
