#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, errors } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import {
  HYDRATION_DEBUG_MIN_PENDING_KEY,
  HYDRATION_DEBUG_SILENCE_KEY,
} from "../src/terminal-hydration-debug";
import {
  GHOSTTY_PREWARM_DEBUG_DELAY_KEY,
  GHOSTTY_PREWARM_DEBUG_POOL_SIZE_KEY,
} from "../src/ghostty-prewarm-debug";
import { DEFAULT_GHOSTTY_PREWARM_POOL_SIZE } from "../src/ghostty-prewarm-policy";
import { LAYOUT_STABLE_DEBUG_MODE_KEY } from "../src/terminal-layout-stable-debug";
import { CURSOR_BLINK_DEBUG_DISABLED_KEY } from "../src/terminal-cursor-blink-debug";
import { AGENT_KIND } from "../src/agent-kind";

export type TraceEvent = { t: number; kind: string; [field: string]: unknown };
export type TraceState = {
  _meta: { session: string; machine: string; startWall: number; startPerf: number; mode?: string };
  events: TraceEvent[];
};
export type ServerTiming = {
  event: string;
  session: string;
  mode: string;
  sinceStartMs: number;
  [field: string]: unknown;
};
type ScenarioMode = "single" | "grid";

/** Canvas-hash samples the init script appends to a session's trace: one at
 *  `hydration.reveal`, one after a bounded window (see installRevealFlashProbe).
 *  A changed canvas is classified by the bytes that arrived between them:
 *  - none (prefill aside): `revealFlash`, the reveal showed an unfinished paint
 *  - only non-prefill bytes before the client's `pty_ready`: `revealFlashWithReplay`.
 *    The server sends those after prefill_done and before pty_ready: replay of
 *    output that arrived during settle and attach-finalization resize redraws,
 *    i.e. the burst class the hydration floor exists to hide.
 *  - any byte after `pty_ready` (live PTY output): neither flag; the change is
 *    still visible through `revealCanvasChanged` and `liveBytesDuringReveal`.
 *  Two-point sampling misses a transient flash whose end state equals the
 *  reveal state (e.g. clear + identical repaint). */
export const PERF_FLASH_EVENT = {
  REVEAL: "perf.flash.reveal",
  STABLE: "perf.flash.stable",
} as const;
export type PerfDeviceMode = "desktop" | "mobile";

export type ScenarioSummary = {
  scenario: string;
  mode: ScenarioMode;
  cells: number;
  sessions: CellSummary[];
  server: ServerTiming[];
};

type PageLoadSetup = {
  cardVisibleMs: number;
  consoleErrors: string[];
};

type GhosttyPrewarmPerfEvent = {
  t: number;
  kind: string;
  slot?: number;
  delayMs?: number;
  readyCount?: number;
};

export type PageLoadSummary = {
  cardVisibleMs: number;
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
  firstContentfulPaintMs: number | null;
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  consoleErrorCount: number;
  prewarmScheduledDelayMs: number | null;
  prewarmReadyCount: number;
  firstPrewarmReadyMs: number | null;
  secondPrewarmReadyMs: number | null;
  ghosttyReadyDoneMs: number | null;
  jsHeapUsedBytes?: number | null;
  embedderHeapUsedBytes?: number | null;
  backingStorageBytes?: number | null;
  prewarmEvents: GhosttyPrewarmPerfEvent[];
};
export type CellSummary = {
  session: string;
  setupToAttachMs: number | null;
  setupToRevealMs: number | null;
  ghosttyCreationMs: number | null;
  terminalPrewarmed: boolean | null;
  isolatedGhostty: boolean | null;
  wsServerMs: number | null;
  prefillMs: number | null;
  hydrationRevealMs: number | null;
  hydrationStartToPrefillDoneMs: number | null;
  prefillDoneToRevealMs: number | null;
  ptyReadyToRevealMs: number | null;
  attachAckToAfterPaintLayoutStableMs: number | null;
  lastWriteToRevealMs: number | null;
  lastWriteDoneToRevealMs: number | null;
  hydrationMinPendingMs: number | null;
  hydrationSilenceMs: number | null;
  layoutStableDebugMode: string | null;
  attachCols: number | null;
  attachRows: number | null;
  afterPaintCols: number | null;
  afterPaintRows: number | null;
  afterPaintColDelta: number | null;
  attachContainerWidth: number | null;
  afterPaintContainerWidth: number | null;
  containerWidthDelta: number | null;
  prefillBytes: number;
  revealCanvasChanged: boolean | null;
  revealFlash: boolean | null;
  revealFlashWithReplay: boolean | null;
  revealToStableMs: number | null;
  replayBytesDuringReveal: number | null;
  liveBytesDuringReveal: number | null;
};

export type PerfRunReport = {
  readonly pageLoads: PageLoadSummary[];
  readonly summaries: ScenarioSummary[];
};

type MetricStats = {
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly min: number | null;
  readonly max: number | null;
};

type HitStats = {
  readonly hits: number;
  readonly total: number;
};

type PerfRunsSummary = {
  readonly runs: number;
  readonly pageConsoleErrorsTotal: number;
  readonly page: {
    readonly cardVisibleMs: MetricStats;
    readonly secondPrewarmReadyMs: MetricStats;
    readonly longTaskCount: MetricStats;
    readonly longTaskTotalMs: MetricStats;
    readonly jsHeapUsedBytes: MetricStats;
    readonly backingStorageBytes: MetricStats;
  };
  readonly single: {
    readonly setupToRevealMs: MetricStats;
    readonly ghosttyCreationMs: MetricStats;
    readonly prewarmHits: HitStats;
    readonly revealFlashes: HitStats;
    readonly revealFlashesWithReplay: HitStats;
  };
  readonly grid: {
    readonly setupToRevealMs: MetricStats;
    readonly ghosttyCreationMs: MetricStats;
    readonly wsServerMs: MetricStats;
    readonly prefillDoneToRevealMs: MetricStats;
    readonly prewarmHits: HitStats;
    readonly revealFlashes: HitStats;
    readonly revealFlashesWithReplay: HitStats;
  };
};

type ServerPhaseSummary = {
  session: string;
  mode: ScenarioMode;
  attachParsedMs: number | null;
  resizeSettleMs: number | null;
  quiescenceMs: number | null;
  snapshotFetchMs: number | null;
  prefillSendMs: number | null;
  subscribeMs: number | null;
  serverReadyMs: number | null;
  outputDecision: string | null;
  resizeStableAtMs: number | null;
  outputStableAtMs: number | null;
  afterPaintLayoutStableMs: number | null;
  afterPaintSnapshotDeltaMs: number | null;
  afterPaintColsDelta: number | null;
  afterPaintRowsDelta: number | null;
};

const ROOT = join(import.meta.dirname, "..");
const DEFAULT_GRID_CELL_COUNTS = [2, 4, 6] as const;
const PERF_HARNESS_ENV_HELP = [
  "WOLFPACK_PERF_RUNS: positive integer repeated-run count (default: 1)",
  "WOLFPACK_PERF_DEVICE: desktop or mobile browser profile (default: desktop)",
  "WOLFPACK_PERF_GHOSTTY_PREWARM_POOL_SIZE: debug-only pool size override 0-2",
  "WOLFPACK_PERF_GRID_CELLS: comma-separated grid sizes 2-6 (default: 2,4,6)",
  "WOLFPACK_PERF_USE_EXISTING_BROKER: set to 1 to use WOLFPACK_BROKER_SOCKET instead of spawning a broker",
  "WOLFPACK_PERF_ONLY_PAGE_LOAD: set to 1 to skip single/grid terminal scenarios",
  "WOLFPACK_PERF_PAGE_LOAD_WAIT_MS: extra post-load wait before page-load trace capture",
  "WOLFPACK_PERF_SLOW_PREFILL_MS: inject server-side prefill delay for slow-path measurements",
  "WOLFPACK_PERF_ENFORCE_BUDGETS: set to 1 to fail on cold/warm p95, heap, long-task, or console budgets",
] as const;

export function resolveBrokerBin(): string | null {
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
let sharedPerfBrowser: Browser | null = null;

async function getPerfBrowser(): Promise<Browser> {
  if (!sharedPerfBrowser) sharedPerfBrowser = await chromium.launch();
  return sharedPerfBrowser;
}

export async function closePerfBrowser(): Promise<void> {
  if (!sharedPerfBrowser) return;
  await Promise.race([sharedPerfBrowser.close(), wait(5_000)]);
  sharedPerfBrowser = null;
}

export async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await wait(50);
  }
  throw new Error(`timeout waiting for ${path}`);
}

export type PerfBrokerSocketLocation = {
  readonly socketPath: string;
  readonly tempDir: string;
};

export function createPerfBrokerSocketLocation(): PerfBrokerSocketLocation {
  const tempDir = mkdtempSync(join(tmpdir(), "wolfpack-perf-"));
  return { tempDir, socketPath: join(tempDir, "broker.sock") };
}

export function startBroker(binary: string): {
  socketPath: string;
  tempDir: string;
  proc: ChildProcess;
  stderr: () => string;
} {
  const { socketPath, tempDir } = createPerfBrokerSocketLocation();
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
  return { socketPath, tempDir, proc, stderr: () => stderr };
}

export function existingBroker(): { socketPath: string; tempDir: null; proc: null; stderr: () => string } | null {
  if (process.env.WOLFPACK_PERF_USE_EXISTING_BROKER !== "1") return null;
  const socketPath = process.env.WOLFPACK_BROKER_SOCKET;
  if (!socketPath) {
    throw new Error("WOLFPACK_PERF_USE_EXISTING_BROKER=1 requires WOLFPACK_BROKER_SOCKET");
  }
  if (!existsSync(socketPath)) {
    throw new Error(`existing broker socket not found: ${socketPath}`);
  }
  return { socketPath, tempDir: null, proc: null, stderr: () => "" };
}

export async function startServer(socketPath: string, devDir: string, opts?: { prefillDelayMs?: number }): Promise<{
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
      WOLFPACK_DEV_DIR: devDir,
      WOLFPACK_LOG_LEVEL: "info",
      WOLFPACK_TERMINAL_LOAD_DEBUG: "1",
      ...(opts?.prefillDelayMs ? { WOLFPACK_TEST_PREFILL_DELAY_MS: String(opts.prefillDelayMs) } : {}),
    },
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("perf test server did not start within 30s"));
    }, 30_000);
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

export async function createSession(devDir: string, baseUrl: string, name: string, project: string): Promise<void> {
  mkdirSync(join(devDir, project), { recursive: true });
  const res = await fetch(`${baseUrl}/api/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, cmd: AGENT_KIND.SHELL.id, sessionName: name }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`create ${name} failed: ${res.status} ${await res.text()}`);
}

type SessionCleanupFetch = (url: string, init: RequestInit) => Promise<Response>;

export type SessionCleanupFailure = {
  readonly session: string;
  readonly error: string;
};

export async function cleanupCreatedSessions(
  baseUrl: string,
  sessions: readonly string[],
  fetcher: SessionCleanupFetch = fetch,
): Promise<SessionCleanupFailure[]> {
  const results = await Promise.all([...sessions].reverse().map(async (session): Promise<SessionCleanupFailure | null> => {
    try {
      const request = fetcher(`${baseUrl}/api/kill`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session }),
        signal: AbortSignal.timeout(3_000),
      });
      const res = await Promise.race([
        request,
        wait(3_000).then(() => { throw new Error("cleanup request timed out"); }),
      ]);
      if (!res.ok && res.status !== 404) return { session, error: `${res.status} ${await res.text()}` };
      return null;
    } catch (error) {
      return { session, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return results.filter((result): result is SessionCleanupFailure => result !== null);
}

/** Bounded post-reveal window. A burst the floor exists to hide lands within
 *  one server settle/finalize cycle after reveal; 150ms covers the 80ms floor
 *  plus a resize-redraw burst (~150ms observed historically) starting at
 *  reveal. Longer windows mostly add live-output noise. */
export const REVEAL_FLASH_WINDOW_MS = 150;

/** Runs in the page (serialized by Playwright, so it must stay
 *  self-contained). Hashes the session's canvases at `hydration.reveal`, and
 *  again two frames (ghostty paints in its rAF loop) after the LATER of:
 *  reveal + windowMs, and the attach being complete on the client (prefill_done
 *  seen, every hydration write callback drained, `pty_ready` seen). The server's
 *  quiescence wait is not traced client-side; `pty_ready` is sent after it and
 *  after the replay subscription, so it is the nearest client-visible bound. */
function installRevealFlashProbe(kinds: { readonly reveal: string; readonly stable: string; readonly windowMs: number }): void {
  type ProbeEvent = { readonly t: number; readonly kind: string; readonly [field: string]: unknown };
  type ProbeTrace = { readonly _meta: { readonly session: string; readonly startPerf: number }; readonly events: ProbeEvent[] };
  type ProbeState = {
    inFlight: number;
    prefillDone: boolean;
    ptyReady: boolean;
    revealed: boolean;
    windowElapsed: boolean;
    sampling: boolean;
    done: boolean;
    container: Element | null;
  };
  const states = new WeakMap<ProbeTrace, ProbeState>();

  function hashCanvas(canvas: HTMLCanvasElement): string {
    // FNV-1a over 32-bit pixels; dimensions are part of the identity.
    let hash = 0x811c9dc5;
    const context = canvas.width && canvas.height ? canvas.getContext("2d") : null;
    if (context) {
      const pixels = new Uint32Array(context.getImageData(0, 0, canvas.width, canvas.height).data.buffer);
      for (let idx = 0; idx < pixels.length; idx++) hash = Math.imul(hash ^ pixels[idx], 0x01000193);
    } else {
      const url = canvas.toDataURL();
      for (let idx = 0; idx < url.length; idx++) hash = Math.imul(hash ^ url.charCodeAt(idx), 0x01000193);
    }
    return `${canvas.width}x${canvas.height}:${(hash >>> 0).toString(16)}`;
  }

  function hashContainer(container: Element | null): string | null {
    if (!container) return null;
    const canvases = Array.from(container.querySelectorAll("canvas"));
    return canvases.length ? canvases.map(hashCanvas).join("|") : null;
  }

  function findContainer(session: string): Element | null {
    return document.querySelector(`.grid-cell[data-session="${CSS.escape(session)}"]`)
      ?? document.getElementById("desktop-terminal-container");
  }

  function record(trace: ProbeTrace, kind: string, hash: string | null): void {
    trace.events.push({ t: +(performance.now() - trace._meta.startPerf).toFixed(3), kind, hash });
  }

  function ready(state: ProbeState): boolean {
    return state.revealed && state.windowElapsed && state.prefillDone && state.ptyReady && state.inFlight === 0 && !state.done;
  }

  function maybeSampleStable(trace: ProbeTrace, state: ProbeState): void {
    if (state.sampling || !ready(state)) return;
    state.sampling = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      state.sampling = false;
      // prefill_done is traced before its buffered chunks are written, so
      // the gate is re-checked once those writes have had a chance to queue.
      if (states.get(trace) !== state || !ready(state)) return;
      state.done = true;
      record(trace, kinds.stable, hashContainer(state.container));
    }));
  }

  const target = window as unknown as { __wfTraceObserver?: (trace: ProbeTrace, event: ProbeEvent) => void };
  target.__wfTraceObserver = (trace, event) => {
    if (event.kind === "attach.send") {
      states.set(trace, {
        inFlight: 0,
        prefillDone: false,
        ptyReady: false,
        revealed: false,
        windowElapsed: false,
        sampling: false,
        done: false,
        container: null,
      });
      return;
    }
    const state = states.get(trace);
    if (!state || state.done) return;
    if (event.kind === "_writeTermData" && event.hydrating === true) state.inFlight++;
    else if (event.kind === "term.writeDone" && typeof event.inFlight === "number") state.inFlight = event.inFlight;
    else if (event.kind === "prefill_done") state.prefillDone = true;
    else if (event.kind === "pty_ready") state.ptyReady = true;
    else if (event.kind === "hydration.reveal" && !state.revealed) {
      state.revealed = true;
      state.container = findContainer(trace._meta.session);
      record(trace, kinds.reveal, hashContainer(state.container));
      setTimeout(() => {
        state.windowElapsed = true;
        maybeSampleStable(trace, state);
      }, kinds.windowMs);
    } else return;
    maybeSampleStable(trace, state);
  };
}

export async function setupPage(baseUrl: string): Promise<{ page: Page; pageLoad: PageLoadSetup; close(): Promise<void> }> {
  const browser = await getPerfBrowser();
  const deviceMode = parsePerfDeviceMode(process.env.WOLFPACK_PERF_DEVICE);
  const page = await browser.newPage(deviceMode === "mobile" ? {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  } : {
    viewport: { width: 1280, height: 720 },
    isMobile: false,
    hasTouch: false,
  });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    consoleErrors.push(error.message);
  });
  await page.addInitScript((opts) => {
    const target = window as unknown as {
      __wfPerfLongTasks?: Array<{ startTime: number; duration: number }>;
    };
    target.__wfPerfLongTasks = [];
    try {
      const observer = new PerformanceObserver((list) => {
        const longTasks = target.__wfPerfLongTasks;
        if (!longTasks) return;
        for (const entry of list.getEntries()) {
          longTasks.push({
            startTime: +entry.startTime.toFixed(3),
            duration: +entry.duration.toFixed(3),
          });
        }
      });
      observer.observe({ type: "longtask", buffered: true });
    } catch {}

    localStorage.setItem("wolfpackDebug", "1");
    // The flash probe hashes canvases; a blink toggle between samples would
    // read as a flash.
    localStorage.setItem(opts.cursorBlinkDisabledKey, "1");
    if (opts.minPendingMs !== undefined) localStorage.setItem(opts.minPendingKey, opts.minPendingMs);
    if (opts.silenceMs !== undefined) localStorage.setItem(opts.silenceKey, opts.silenceMs);
    if (opts.layoutStableMode !== undefined) localStorage.setItem(opts.layoutStableModeKey, opts.layoutStableMode);
    if (opts.ghosttyPrewarmDelayMs !== undefined) localStorage.setItem(opts.ghosttyPrewarmDelayKey, opts.ghosttyPrewarmDelayMs);
    if (opts.ghosttyPrewarmPoolSize !== undefined) localStorage.setItem(opts.ghosttyPrewarmPoolSizeKey, opts.ghosttyPrewarmPoolSize);
  }, {
    minPendingKey: HYDRATION_DEBUG_MIN_PENDING_KEY,
    cursorBlinkDisabledKey: CURSOR_BLINK_DEBUG_DISABLED_KEY,
    silenceKey: HYDRATION_DEBUG_SILENCE_KEY,
    layoutStableModeKey: LAYOUT_STABLE_DEBUG_MODE_KEY,
    ghosttyPrewarmDelayKey: GHOSTTY_PREWARM_DEBUG_DELAY_KEY,
    ghosttyPrewarmPoolSizeKey: GHOSTTY_PREWARM_DEBUG_POOL_SIZE_KEY,
    minPendingMs: process.env.WOLFPACK_PERF_HYDRATION_MIN_PENDING_MS,
    silenceMs: process.env.WOLFPACK_PERF_HYDRATION_SILENCE_MS,
    layoutStableMode: process.env.WOLFPACK_PERF_LAYOUT_STABLE_MODE,
    ghosttyPrewarmDelayMs: process.env.WOLFPACK_PERF_GHOSTTY_PREWARM_DELAY_MS,
    ghosttyPrewarmPoolSize: process.env.WOLFPACK_PERF_GHOSTTY_PREWARM_POOL_SIZE,
  });
  await page.addInitScript(installRevealFlashProbe, {
    reveal: PERF_FLASH_EVENT.REVEAL,
    stable: PERF_FLASH_EVENT.STABLE,
    windowMs: REVEAL_FLASH_WINDOW_MS,
  });
  const startedAt = performance.now();
  await page.goto(baseUrl);
  try {
    await page.waitForSelector(".card", { timeout: 15_000 });
  } catch (error) {
    const diagnostic = await page.locator("body").innerText().catch(() => "<body unavailable>");
    throw new Error(`dashboard cards did not load; console=${consoleErrors.join(" | ")}; body=${diagnostic.slice(0, 500)}`, { cause: error });
  }
  const cardVisibleMs = +(performance.now() - startedAt).toFixed(3);
  return {
    page,
    pageLoad: { cardVisibleMs, consoleErrors },
    close: async () => {
      await Promise.race([page.context().close(), wait(5_000)]);
    },
  };
}

async function readPageLoadSummary(page: Page, setup: PageLoadSetup, waitMs: number): Promise<PageLoadSummary> {
  if (waitMs > 0) await page.waitForTimeout(waitMs);
  const metrics = await page.evaluate(() => {
    const target = window as unknown as {
      __wfPerfLongTasks?: Array<{ startTime: number; duration: number }>;
      __wfGhosttyPrewarm?: { events: GhosttyPrewarmPerfEvent[] };
    };
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const firstContentfulPaint = performance.getEntriesByName("first-contentful-paint")[0];
    return {
      domContentLoadedMs: nav ? +(nav.domContentLoadedEventEnd - nav.startTime).toFixed(3) : null,
      loadEventMs: nav ? +(nav.loadEventEnd - nav.startTime).toFixed(3) : null,
      firstContentfulPaintMs: firstContentfulPaint ? +firstContentfulPaint.startTime.toFixed(3) : null,
      longTasks: target.__wfPerfLongTasks || [],
      prewarmEvents: target.__wfGhosttyPrewarm?.events || [],
    };
  });
  let heapUsage: {
    readonly usedSize?: number;
    readonly embedderHeapUsedSize?: number;
    readonly backingStorageSize?: number;
  } = {};
  try {
    const cdp = await page.context().newCDPSession(page);
    heapUsage = await cdp.send("Runtime.getHeapUsage");
    await cdp.detach();
  } catch {}
  const readyEvents = metrics.prewarmEvents.filter((event) => event.kind === "prewarm.ready");
  const scheduled = metrics.prewarmEvents.find((event) => event.kind === "schedule");
  const ghosttyReadyDone = metrics.prewarmEvents.find((event) => event.kind === "ghostty_ready.done");
  const longTaskDurations = metrics.longTasks.map((task) => task.duration);
  return {
    cardVisibleMs: setup.cardVisibleMs,
    domContentLoadedMs: metrics.domContentLoadedMs,
    loadEventMs: metrics.loadEventMs,
    firstContentfulPaintMs: metrics.firstContentfulPaintMs,
    longTaskCount: metrics.longTasks.length,
    longTaskTotalMs: +longTaskDurations.reduce((sum, duration) => sum + duration, 0).toFixed(3),
    longTaskMaxMs: longTaskDurations.length ? +Math.max(...longTaskDurations).toFixed(3) : 0,
    consoleErrorCount: setup.consoleErrors.length,
    prewarmScheduledDelayMs: typeof scheduled?.delayMs === "number" ? scheduled.delayMs : null,
    prewarmReadyCount: readyEvents.length,
    firstPrewarmReadyMs: readyEvents[0]?.t ?? null,
    secondPrewarmReadyMs: readyEvents[1]?.t ?? null,
    ghosttyReadyDoneMs: ghosttyReadyDone?.t ?? null,
    jsHeapUsedBytes: heapUsage.usedSize ?? null,
    embedderHeapUsedBytes: heapUsage.embedderHeapUsedSize ?? null,
    backingStorageBytes: heapUsage.backingStorageSize ?? null,
    prewarmEvents: metrics.prewarmEvents,
  };
}

async function readTraces(page: Page, expected: number): Promise<Record<string, TraceState>> {
  await page.waitForFunction((count) => {
    const traces = (window as unknown as { __wfTrace?: Record<string, TraceState> }).__wfTrace || {};
    const hydrated = Object.values(traces).filter((trace) =>
      trace.events.some((event) => event.kind === "hydration.reveal" || event.kind === "hydration.finish"));
    return hydrated.length >= count;
  }, expected, { timeout: 20_000 });
  try {
    await page.waitForFunction(({ count, stableKind }) => {
      const traces = (window as unknown as { __wfTrace?: Record<string, TraceState> }).__wfTrace || {};
      const sampled = Object.values(traces).filter((trace) => trace.events.some((event) => event.kind === stableKind));
      return sampled.length >= count;
    }, { count: expected, stableKind: PERF_FLASH_EVENT.STABLE }, { timeout: 5_000 });
  } catch (error) {
    // A cell whose attach never completed has no stable sample; it reports
    // revealFlash: null rather than failing the whole scenario.
    if (!(error instanceof errors.TimeoutError)) throw error;
  }
  await page.waitForTimeout(250);
  return await page.evaluate(() => {
    return (window as unknown as { __wfTrace?: Record<string, TraceState> }).__wfTrace || {};
  });
}

function eventTime(events: TraceEvent[], kind: string): number | null {
  return events.find((event) => event.kind === kind)?.t ?? null;
}

function eventNumber(events: TraceEvent[], kind: string, field: string): number | null {
  const value = events.find((event) => event.kind === kind)?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function eventString(events: TraceEvent[], kind: string, field: string): string | null {
  const value = events.find((event) => event.kind === kind)?.[field];
  return typeof value === "string" ? value : null;
}

function eventNumberFrom(event: TraceEvent | undefined, field: string): number | null {
  const value = event?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function eventBoolFrom(event: TraceEvent | undefined, field: string): boolean | null {
  const value = event?.[field];
  return typeof value === "boolean" ? value : null;
}

function eventByKind(events: TraceEvent[], kind: string): TraceEvent | undefined {
  return events.find((event) => event.kind === kind);
}

function lastEventTimeBefore(events: TraceEvent[], kind: string, beforeMs: number | null): number | null {
  if (beforeMs === null) return null;
  for (let idx = events.length - 1; idx >= 0; idx--) {
    const event = events[idx];
    if (event.kind === kind && event.t <= beforeMs) return event.t;
  }
  return null;
}

function layoutStableEvent(events: TraceEvent[], reason: string): TraceEvent | undefined {
  return events.find((event) => event.kind === "layout_stable.send" && event.reason === reason);
}

function deltaNumber(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return +(b - a).toFixed(3);
}

function delta(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return +(b - a).toFixed(3);
}

function findLastEventIndex(events: TraceEvent[], predicate: (event: TraceEvent) => boolean): number {
  for (let idx = events.length - 1; idx >= 0; idx--) {
    if (predicate(events[idx])) return idx;
  }
  return -1;
}

function eventsForLatestAttach(events: TraceEvent[]): TraceEvent[] {
  const attachIndex = findLastEventIndex(events, (event) => event.kind === "attach.send");
  if (attachIndex < 0) return events;

  const setupKinds = new Set(["openSession.start", "addToGrid.start", "dom.cell.created", "ghostty.ready"]);
  let startIndex = attachIndex;
  for (let idx = attachIndex - 1; idx >= 0; idx--) {
    if (events[idx].kind === "attach.send") break;
    if (setupKinds.has(events[idx].kind)) startIndex = idx;
  }
  return events.slice(startIndex);
}

function eventHash(event: TraceEvent | undefined): string | null {
  return typeof event?.hash === "string" ? event.hash : null;
}

type RevealFlashSummary = Pick<
  CellSummary,
  "revealCanvasChanged" | "revealFlash" | "revealFlashWithReplay" | "revealToStableMs" | "replayBytesDuringReveal" | "liveBytesDuringReveal"
>;

function binaryBytes(events: TraceEvent[], predicate: (event: TraceEvent) => boolean): number {
  return events
    .filter((event) => event.kind === "ws.binary" && event.bucket !== "prefill" && predicate(event))
    .reduce((sum, event) => sum + (typeof event.size === "number" ? event.size : 0), 0);
}

function summarizeRevealFlash(events: TraceEvent[]): RevealFlashSummary {
  const reveal = eventByKind(events, PERF_FLASH_EVENT.REVEAL);
  const stable = eventByKind(events, PERF_FLASH_EVENT.STABLE);
  const revealHash = eventHash(reveal);
  const stableHash = eventHash(stable);
  if (!reveal || !stable || revealHash === null || stableHash === null) {
    return {
      revealCanvasChanged: null,
      revealFlash: null,
      revealFlashWithReplay: null,
      revealToStableMs: null,
      replayBytesDuringReveal: null,
      liveBytesDuringReveal: null,
    };
  }
  const ptyReadyAt = eventTime(events, "pty_ready") ?? Number.POSITIVE_INFINITY;
  const inWindow = (event: TraceEvent): boolean => event.t >= reveal.t && event.t <= stable.t;
  const replayBytesDuringReveal = binaryBytes(events, (event) => inWindow(event) && event.t < ptyReadyAt);
  const liveBytesDuringReveal = binaryBytes(events, (event) => inWindow(event) && event.t >= ptyReadyAt);
  const revealCanvasChanged = revealHash !== stableHash;
  return {
    revealCanvasChanged,
    revealFlash: revealCanvasChanged && replayBytesDuringReveal === 0 && liveBytesDuringReveal === 0,
    revealFlashWithReplay: revealCanvasChanged && replayBytesDuringReveal > 0 && liveBytesDuringReveal === 0,
    revealToStableMs: delta(reveal.t, stable.t),
    replayBytesDuringReveal,
    liveBytesDuringReveal,
  };
}

export function summarizeCell(trace: TraceState): CellSummary {
  const events = eventsForLatestAttach(trace.events);
  const setupStart = events[0]?.t ?? null;
  const prefillBytes = events
    .filter((event) => event.kind === "ws.binary" && event.bucket === "prefill")
    .reduce((sum, event) => sum + (typeof event.size === "number" ? event.size : 0), 0);
  const attach = eventByKind(events, "attach.send");
  const terminalCreated = eventByKind(events, "terminal.instance.created");
  const afterPaint = layoutStableEvent(events, "after-paint") ?? eventByKind(events, "layout_stable.send");
  const attachCols = eventNumberFrom(attach, "cols");
  const attachRows = eventNumberFrom(attach, "rows");
  const afterPaintCols = eventNumberFrom(afterPaint, "cols");
  const afterPaintRows = eventNumberFrom(afterPaint, "rows");
  const attachContainerWidth = eventNumberFrom(attach, "containerWidth");
  const afterPaintContainerWidth = eventNumberFrom(afterPaint, "containerWidth");
  const hydrationReveal = eventTime(events, "hydration.reveal");
  return {
    session: trace._meta.session,
    setupToAttachMs: delta(setupStart, eventTime(events, "attach.send")),
    setupToRevealMs: delta(setupStart, hydrationReveal),
    ghosttyCreationMs: delta(eventTime(events, "ghostty.ready"), eventTime(events, "terminal.instance.created")),
    terminalPrewarmed: eventBoolFrom(terminalCreated, "prewarmed"),
    isolatedGhostty: eventBoolFrom(terminalCreated, "isolatedGhostty"),
    wsServerMs: delta(eventTime(events, "attach.send"), eventTime(events, "pty_ready")),
    prefillMs: delta(eventTime(events, "prefill.first_chunk"), eventTime(events, "prefill_done")),
    hydrationRevealMs: delta(eventTime(events, "hydration.start"), hydrationReveal),
    hydrationStartToPrefillDoneMs: delta(eventTime(events, "hydration.start"), eventTime(events, "prefill_done")),
    prefillDoneToRevealMs: delta(eventTime(events, "prefill_done"), hydrationReveal),
    ptyReadyToRevealMs: delta(eventTime(events, "pty_ready"), hydrationReveal),
    attachAckToAfterPaintLayoutStableMs: delta(eventTime(events, "attach_ack"), afterPaint?.t ?? null),
    lastWriteToRevealMs: delta(lastEventTimeBefore(events, "_writeTermData", hydrationReveal), hydrationReveal),
    lastWriteDoneToRevealMs: delta(lastEventTimeBefore(events, "term.writeDone", hydrationReveal), hydrationReveal),
    hydrationMinPendingMs: eventNumber(events, "hydration.start", "minPendingMs"),
    hydrationSilenceMs: eventNumber(events, "hydration.start", "silenceMs"),
    layoutStableDebugMode: eventString(events, "attach.send", "layoutStableDebugMode"),
    attachCols,
    attachRows,
    afterPaintCols,
    afterPaintRows,
    afterPaintColDelta: deltaNumber(attachCols, afterPaintCols),
    attachContainerWidth,
    afterPaintContainerWidth,
    containerWidthDelta: deltaNumber(attachContainerWidth, afterPaintContainerWidth),
    prefillBytes,
    ...summarizeRevealFlash(events),
  };
}

export function serverTimingsFor(timings: ServerTiming[], sessions: string[], startIndex = 0): ServerTiming[] {
  const set = new Set(sessions);
  return timings.slice(startIndex).filter((timing) => set.has(timing.session));
}

function timingAt(events: ServerTiming[], event: string): number | null {
  return events.find((item) => item.event === event)?.sinceStartMs ?? null;
}

function timingDelta(events: ServerTiming[], startEvent: string, endEvent: string): number | null {
  return delta(timingAt(events, startEvent), timingAt(events, endEvent));
}

function timingNumber(events: ServerTiming[], event: string, field: string): number | null {
  const value = events.find((item) => item.event === event)?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timingString(events: ServerTiming[], event: string, field: string): string | null {
  const value = events.find((item) => item.event === event)?.[field];
  return typeof value === "string" ? value : null;
}

function timingEvent(events: ServerTiming[], event: string, predicate?: (event: ServerTiming) => boolean): ServerTiming | undefined {
  return events.find((item) => item.event === event && (!predicate || predicate(item)));
}

function timingNumberFrom(event: ServerTiming | undefined, field: string): number | null {
  const value = event?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function summarizeServerPhases(
  timings: ServerTiming[],
  sessions: string[],
  mode: ScenarioMode,
): ServerPhaseSummary[] {
  return sessions.map((session) => {
    const events = timings.filter((timing) => timing.session === session && timing.mode === mode);
    const attach = timingEvent(events, "attach.parsed");
    const afterPaintLayoutStable = timingEvent(events, "layout_stable", (event) => event.reason === "after-paint")
      ?? timingEvent(events, "layout_stable");
    const attachCols = timingNumberFrom(attach, "cols");
    const attachRows = timingNumberFrom(attach, "rows");
    const afterPaintCols = timingNumberFrom(afterPaintLayoutStable, "cols");
    const afterPaintRows = timingNumberFrom(afterPaintLayoutStable, "rows");
    return {
      session,
      mode,
      attachParsedMs: timingAt(events, "attach.parsed"),
      resizeSettleMs: timingDelta(events, "resize_settle.start", "resize_settle.end"),
      quiescenceMs: timingDelta(events, "quiescence_wait.start", "quiescence_wait.end"),
      snapshotFetchMs: timingDelta(events, "snapshot_fetch.start", "snapshot_fetch.end"),
      prefillSendMs: timingDelta(events, "prefill_send.start", "prefill_send.end"),
      subscribeMs: timingDelta(events, "subscribe.start", "subscribe.success"),
      serverReadyMs: timingAt(events, "pty_ready.send"),
      outputDecision: timingString(events, "quiescence_wait.end", "outputDecision"),
      resizeStableAtMs: timingNumber(events, "quiescence_wait.end", "resizeStableAtMs"),
      outputStableAtMs: timingNumber(events, "quiescence_wait.end", "outputStableAtMs"),
      afterPaintLayoutStableMs: afterPaintLayoutStable?.sinceStartMs ?? null,
      afterPaintSnapshotDeltaMs: delta(afterPaintLayoutStable?.sinceStartMs ?? null, timingAt(events, "snapshot_fetch.start")),
      afterPaintColsDelta: deltaNumber(attachCols, afterPaintCols),
      afterPaintRowsDelta: deltaNumber(attachRows, afterPaintRows),
    };
  });
}

async function runPageLoad(baseUrl: string): Promise<PageLoadSummary> {
  const { page, pageLoad, close } = await setupPage(baseUrl);
  try {
    return await readPageLoadSummary(page, pageLoad, Number(process.env.WOLFPACK_PERF_PAGE_LOAD_WAIT_MS || 1500));
  } finally {
    await close();
  }
}

async function runSingle(baseUrl: string, timings: ServerTiming[], session: string): Promise<ScenarioSummary> {
  const { page, close } = await setupPage(baseUrl);
  const timingStart = timings.length;
  try {
    await page.getByRole("button", { name: `Open ${session}`, exact: true }).filter({ visible: true }).first().click();
    const traces = await readTraces(page, 1);
    const trace = Object.values(traces).find((item) => item._meta.session === session);
    if (!trace) throw new Error(`missing trace for ${session}`);
    return {
      scenario: "single:1",
      mode: "single",
      cells: 1,
      sessions: [summarizeCell(trace)],
      server: serverTimingsFor(timings, [session], timingStart),
    };
  } finally {
    await close();
  }
}

function gridAddDelayMs(): number {
  const raw = process.env.WOLFPACK_PERF_GRID_ADD_DELAY_MS;
  if (!raw) return 0;
  const delay = Number(raw);
  if (!Number.isFinite(delay) || delay < 0) throw new Error("WOLFPACK_PERF_GRID_ADD_DELAY_MS must be a non-negative number");
  return delay;
}

async function runGrid(baseUrl: string, timings: ServerTiming[], sessions: string[]): Promise<ScenarioSummary> {
  const { page, close } = await setupPage(baseUrl);
  const timingStart = timings.length;
  try {
    await page.getByRole("button", { name: `Open ${sessions[0]}`, exact: true }).filter({ visible: true }).first().click();
    await page.waitForSelector("#desktop-terminal-container canvas", { state: "attached", timeout: 10_000 });
    const addDelayMs = gridAddDelayMs();
    if (addDelayMs > 0) await page.waitForTimeout(addDelayMs);
    for (const session of sessions.slice(1)) {
      await page.getByRole("button", { name: `Add to grid: ${session}`, exact: true }).filter({ visible: true }).first().click();
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
      server: serverTimingsFor(timings, sessions, timingStart),
    };
  } finally {
    await close();
  }
}

function gridCellCounts(): number[] {
  const raw = process.env.WOLFPACK_PERF_GRID_CELLS;
  if (!raw) return [...DEFAULT_GRID_CELL_COUNTS];
  const counts = raw.split(",").map((part) => Number(part.trim())).filter((count) => Number.isInteger(count) && count >= 2 && count <= 6);
  if (!counts.length) throw new Error("WOLFPACK_PERF_GRID_CELLS must contain integers between 2 and 6");
  return counts;
}

export function describePerfHarnessEnv(): readonly string[] {
  return PERF_HARNESS_ENV_HELP;
}

export function parsePerfRunCount(raw: string | undefined): number {
  if (!raw) return 1;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) throw new Error("WOLFPACK_PERF_RUNS must be a positive integer");
  return count;
}

export function parsePerfDeviceMode(raw: string | undefined): PerfDeviceMode {
  if (!raw || raw === "desktop") return "desktop";
  if (raw === "mobile") return "mobile";
  throw new Error("WOLFPACK_PERF_DEVICE must be desktop or mobile");
}

function percentile(values: readonly number[], percentileValue: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.max(0, Math.ceil(sorted.length * percentileValue / 100) - 1);
  return sorted[index] ?? null;
}

function metricStats(values: readonly number[]): MetricStats {
  const finite = values.filter(Number.isFinite);
  return {
    count: finite.length,
    p50: percentile(finite, 50),
    p95: percentile(finite, 95),
    min: finite.length ? Math.min(...finite) : null,
    max: finite.length ? Math.max(...finite) : null,
  };
}

function addMetric(target: number[], value: number | null): void {
  if (value !== null && Number.isFinite(value)) target.push(value);
}

function formatMetricPair(stats: MetricStats): string {
  if (stats.p50 === null || stats.p95 === null) return "n/a (n=0)";
  return `${stats.p50}/${stats.p95}ms (n=${stats.count})`;
}

function formatByteMetricPair(stats: MetricStats): string {
  if (stats.p50 === null || stats.p95 === null) return "n/a (n=0)";
  const toMiB = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(2);
  return `${toMiB(stats.p50)}/${toMiB(stats.p95)}MiB (n=${stats.count})`;
}

export function formatPerfRunsSummary(summary: PerfRunsSummary): string {
  return [
    "aggregate summary",
    `runs: ${summary.runs}`,
    `page card visible p50/p95: ${formatMetricPair(summary.page.cardVisibleMs)}`,
    `page second prewarm ready p50/p95: ${formatMetricPair(summary.page.secondPrewarmReadyMs)}`,
    `page JS heap p50/p95: ${formatByteMetricPair(summary.page.jsHeapUsedBytes)}`,
    `page backing storage p50/p95: ${formatByteMetricPair(summary.page.backingStorageBytes)}`,
    `page console errors: ${summary.pageConsoleErrorsTotal}`,
    `single reveal p50/p95: ${formatMetricPair(summary.single.setupToRevealMs)}`,
    `single ghostty create p50/p95: ${formatMetricPair(summary.single.ghosttyCreationMs)}`,
    `single prewarm hits: ${summary.single.prewarmHits.hits}/${summary.single.prewarmHits.total}`,
    `single reveal flashes: ${summary.single.revealFlashes.hits}/${summary.single.revealFlashes.total}`,
    `single reveal flashes with replay: ${summary.single.revealFlashesWithReplay.hits}/${summary.single.revealFlashesWithReplay.total}`,
    `grid reveal p50/p95: ${formatMetricPair(summary.grid.setupToRevealMs)}`,
    `grid ghostty create p50/p95: ${formatMetricPair(summary.grid.ghosttyCreationMs)}`,
    `grid ws server p50/p95: ${formatMetricPair(summary.grid.wsServerMs)}`,
    `grid prefill_done→reveal p50/p95: ${formatMetricPair(summary.grid.prefillDoneToRevealMs)}`,
    `grid prewarm hits: ${summary.grid.prewarmHits.hits}/${summary.grid.prewarmHits.total}`,
    `grid reveal flashes: ${summary.grid.revealFlashes.hits}/${summary.grid.revealFlashes.total}`,
    `grid reveal flashes with replay: ${summary.grid.revealFlashesWithReplay.hits}/${summary.grid.revealFlashesWithReplay.total}`,
  ].join("\n");
}

function countHit(target: { hits: number; total: number }, value: boolean | null): void {
  if (value === null) return;
  target.total++;
  if (value) target.hits++;
}

export function summarizePerfRuns(runs: readonly PerfRunReport[]): PerfRunsSummary {
  const pageCardVisibleMs: number[] = [];
  const pageSecondPrewarmReadyMs: number[] = [];
  const pageLongTaskCount: number[] = [];
  const pageLongTaskTotalMs: number[] = [];
  const pageJsHeapUsedBytes: number[] = [];
  const pageBackingStorageBytes: number[] = [];
  let pageConsoleErrorsTotal = 0;

  const singleSetupToRevealMs: number[] = [];
  const singleGhosttyCreationMs: number[] = [];
  let singlePrewarmHits = 0;
  let singlePrewarmTotal = 0;
  const singleRevealFlashes = { hits: 0, total: 0 };
  const singleRevealFlashesWithReplay = { hits: 0, total: 0 };

  const gridSetupToRevealMs: number[] = [];
  const gridGhosttyCreationMs: number[] = [];
  const gridWsServerMs: number[] = [];
  const gridPrefillDoneToRevealMs: number[] = [];
  let gridPrewarmHits = 0;
  let gridPrewarmTotal = 0;
  const gridRevealFlashes = { hits: 0, total: 0 };
  const gridRevealFlashesWithReplay = { hits: 0, total: 0 };

  for (const run of runs) {
    for (const pageLoad of run.pageLoads) {
      addMetric(pageCardVisibleMs, pageLoad.cardVisibleMs);
      addMetric(pageSecondPrewarmReadyMs, pageLoad.secondPrewarmReadyMs);
      addMetric(pageLongTaskCount, pageLoad.longTaskCount);
      addMetric(pageLongTaskTotalMs, pageLoad.longTaskTotalMs);
      addMetric(pageJsHeapUsedBytes, pageLoad.jsHeapUsedBytes ?? null);
      addMetric(pageBackingStorageBytes, pageLoad.backingStorageBytes ?? null);
      pageConsoleErrorsTotal += pageLoad.consoleErrorCount;
    }
    for (const summary of run.summaries) {
      const isGrid = summary.mode === "grid";
      for (const cell of summary.sessions) {
        countHit(isGrid ? gridRevealFlashes : singleRevealFlashes, cell.revealFlash);
        countHit(isGrid ? gridRevealFlashesWithReplay : singleRevealFlashesWithReplay, cell.revealFlashWithReplay);
        if (isGrid) {
          addMetric(gridSetupToRevealMs, cell.setupToRevealMs);
          addMetric(gridGhosttyCreationMs, cell.ghosttyCreationMs);
          addMetric(gridWsServerMs, cell.wsServerMs);
          addMetric(gridPrefillDoneToRevealMs, cell.prefillDoneToRevealMs);
          if (cell.terminalPrewarmed !== null) {
            gridPrewarmTotal++;
            if (cell.terminalPrewarmed) gridPrewarmHits++;
          }
        } else {
          addMetric(singleSetupToRevealMs, cell.setupToRevealMs);
          addMetric(singleGhosttyCreationMs, cell.ghosttyCreationMs);
          if (cell.terminalPrewarmed !== null) {
            singlePrewarmTotal++;
            if (cell.terminalPrewarmed) singlePrewarmHits++;
          }
        }
      }
    }
  }

  return {
    runs: runs.length,
    pageConsoleErrorsTotal,
    page: {
      cardVisibleMs: metricStats(pageCardVisibleMs),
      secondPrewarmReadyMs: metricStats(pageSecondPrewarmReadyMs),
      longTaskCount: metricStats(pageLongTaskCount),
      longTaskTotalMs: metricStats(pageLongTaskTotalMs),
      jsHeapUsedBytes: metricStats(pageJsHeapUsedBytes),
      backingStorageBytes: metricStats(pageBackingStorageBytes),
    },
    single: {
      setupToRevealMs: metricStats(singleSetupToRevealMs),
      ghosttyCreationMs: metricStats(singleGhosttyCreationMs),
      prewarmHits: { hits: singlePrewarmHits, total: singlePrewarmTotal },
      revealFlashes: singleRevealFlashes,
      revealFlashesWithReplay: singleRevealFlashesWithReplay,
    },
    grid: {
      setupToRevealMs: metricStats(gridSetupToRevealMs),
      ghosttyCreationMs: metricStats(gridGhosttyCreationMs),
      wsServerMs: metricStats(gridWsServerMs),
      prefillDoneToRevealMs: metricStats(gridPrefillDoneToRevealMs),
      prewarmHits: { hits: gridPrewarmHits, total: gridPrewarmTotal },
      revealFlashes: gridRevealFlashes,
      revealFlashesWithReplay: gridRevealFlashesWithReplay,
    },
  };
}

async function runMeasured(summaryPromise: Promise<ScenarioSummary>): Promise<ScenarioSummary> {
  const summary = await summaryPromise;
  printSummary(summary);
  return summary;
}

async function runMeasuredPageLoad(baseUrl: string): Promise<PageLoadSummary> {
  const summary = await runPageLoad(baseUrl);
  printPageLoadSummary(summary);
  return summary;
}

function printPageLoadSummary(summary: PageLoadSummary): void {
  console.log("\npage-load");
  console.table([{
    cardVisibleMs: summary.cardVisibleMs,
    domContentLoadedMs: summary.domContentLoadedMs,
    loadEventMs: summary.loadEventMs,
    firstContentfulPaintMs: summary.firstContentfulPaintMs,
    longTaskCount: summary.longTaskCount,
    longTaskTotalMs: summary.longTaskTotalMs,
    longTaskMaxMs: summary.longTaskMaxMs,
    consoleErrorCount: summary.consoleErrorCount,
    prewarmScheduledDelayMs: summary.prewarmScheduledDelayMs,
    prewarmReadyCount: summary.prewarmReadyCount,
    firstPrewarmReadyMs: summary.firstPrewarmReadyMs,
    secondPrewarmReadyMs: summary.secondPrewarmReadyMs,
    ghosttyReadyDoneMs: summary.ghosttyReadyDoneMs,
    jsHeapUsedMiB: summary.jsHeapUsedBytes === null || summary.jsHeapUsedBytes === undefined
      ? null
      : +(summary.jsHeapUsedBytes / (1024 * 1024)).toFixed(2),
    backingStorageMiB: summary.backingStorageBytes === null || summary.backingStorageBytes === undefined
      ? null
      : +(summary.backingStorageBytes / (1024 * 1024)).toFixed(2),
  }]);
}

function printSummary(summary: ScenarioSummary): void {
  console.log(`\n${summary.scenario}`);
  console.table(summary.sessions.map((cell) => ({
    session: cell.session,
    setupToAttachMs: cell.setupToAttachMs,
    setupToRevealMs: cell.setupToRevealMs,
    ghosttyMs: cell.ghosttyCreationMs,
    terminalPrewarmed: cell.terminalPrewarmed,
    isolatedGhostty: cell.isolatedGhostty,
    wsServerMs: cell.wsServerMs,
    prefillMs: cell.prefillMs,
    hydrationRevealMs: cell.hydrationRevealMs,
    hydrationStartToPrefillDoneMs: cell.hydrationStartToPrefillDoneMs,
    prefillDoneToRevealMs: cell.prefillDoneToRevealMs,
    ptyReadyToRevealMs: cell.ptyReadyToRevealMs,
    attachAckToAfterPaintLayoutStableMs: cell.attachAckToAfterPaintLayoutStableMs,
    lastWriteToRevealMs: cell.lastWriteToRevealMs,
    lastWriteDoneToRevealMs: cell.lastWriteDoneToRevealMs,
    hydrationMinPendingMs: cell.hydrationMinPendingMs,
    hydrationSilenceMs: cell.hydrationSilenceMs,
    layoutStableDebugMode: cell.layoutStableDebugMode,
    attachCols: cell.attachCols,
    afterPaintCols: cell.afterPaintCols,
    afterPaintColDelta: cell.afterPaintColDelta,
    attachContainerWidth: cell.attachContainerWidth,
    afterPaintContainerWidth: cell.afterPaintContainerWidth,
    containerWidthDelta: cell.containerWidthDelta,
    prefillBytes: cell.prefillBytes,
    revealCanvasChanged: cell.revealCanvasChanged,
    revealFlash: cell.revealFlash,
    revealFlashWithReplay: cell.revealFlashWithReplay,
    revealToStableMs: cell.revealToStableMs,
    replayBytesDuringReveal: cell.replayBytesDuringReveal,
    liveBytesDuringReveal: cell.liveBytesDuringReveal,
  })));
  const serverPhases = summarizeServerPhases(
    summary.server,
    summary.sessions.map((cell) => cell.session),
    summary.mode,
  );
  console.table(serverPhases.map((phase) => ({
    session: phase.session,
    mode: phase.mode,
    serverReadyMs: phase.serverReadyMs,
    resizeSettleMs: phase.resizeSettleMs,
    quiescenceMs: phase.quiescenceMs,
    snapshotFetchMs: phase.snapshotFetchMs,
    prefillSendMs: phase.prefillSendMs,
    subscribeMs: phase.subscribeMs,
    outputDecision: phase.outputDecision,
    resizeStableAtMs: phase.resizeStableAtMs,
    outputStableAtMs: phase.outputStableAtMs,
    afterPaintLayoutStableMs: phase.afterPaintLayoutStableMs,
    afterPaintSnapshotDeltaMs: phase.afterPaintSnapshotDeltaMs,
    afterPaintColsDelta: phase.afterPaintColsDelta,
    afterPaintRowsDelta: phase.afterPaintRowsDelta,
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

async function runPerfMeasurement(
  server: Awaited<ReturnType<typeof startServer>>,
  devDir: string,
  runIndex: number,
): Promise<PerfRunReport> {
  const createdSessions: string[] = [];
  try {
    if (process.env.WOLFPACK_PERF_ONLY_PAGE_LOAD === "1") {
      return { pageLoads: [await runMeasuredPageLoad(server.baseUrl)], summaries: [] };
    }

    const runId = `${Date.now().toString(36)}-${runIndex + 1}`;
    const sessions = Array.from({ length: 6 }, (_, i) => `perf-${runId}-${i + 1}`);
    for (const [idx, session] of sessions.entries()) {
      await createSession(devDir, server.baseUrl, session, `perf-project-${runIndex + 1}-${idx + 1}`);
      createdSessions.push(session);
    }

    const pageLoads: PageLoadSummary[] = [await runMeasuredPageLoad(server.baseUrl)];
    const summaries: ScenarioSummary[] = [];
    summaries.push(await runMeasured(runSingle(server.baseUrl, server.timings, sessions[0])));
    if (parsePerfDeviceMode(process.env.WOLFPACK_PERF_DEVICE) === "desktop") {
      for (const cells of gridCellCounts()) {
        summaries.push(await runMeasured(runGrid(server.baseUrl, server.timings, sessions.slice(0, cells))));
      }
    }
    if (process.env.WOLFPACK_PERF_SLOW_PREFILL_MS) {
      summaries.push(await runMeasured(runSingle(server.baseUrl, server.timings, sessions[5])));
    }
    return { pageLoads, summaries };
  } finally {
    if (createdSessions.length > 0) {
      const cleanupFailures = await cleanupCreatedSessions(server.baseUrl, createdSessions);
      if (cleanupFailures.length > 0) console.warn("perf session cleanup failures", cleanupFailures);
    }
  }
}

export function perfBudgetFailures(summary: PerfRunsSummary, device: PerfDeviceMode): string[] {
  const limits = device === "mobile"
    ? { coldP95: 3_000, warmP95: 3_500, heap: 128 * 1024 * 1024, longTasks: 8, longTaskMs: 750 }
    : { coldP95: 2_000, warmP95: 2_500, heap: 192 * 1024 * 1024, longTasks: 6, longTaskMs: 500 };
  const failures: string[] = [];
  const check = (label: string, value: number | null, limit: number) => {
    if (value !== null && value > limit) failures.push(`${label} ${value.toFixed(1)} exceeds ${limit}`);
  };
  check("cold dashboard p95 ms", summary.page.cardVisibleMs.p95, limits.coldP95);
  check("warm terminal reveal p95 ms", summary.single.setupToRevealMs.p95, limits.warmP95);
  check("JS heap p95 bytes", summary.page.jsHeapUsedBytes.p95, limits.heap);
  check("long-task count p95", summary.page.longTaskCount.p95, limits.longTasks);
  check("long-task total p95 ms", summary.page.longTaskTotalMs.p95, limits.longTaskMs);
  if (summary.pageConsoleErrorsTotal > 0) failures.push(`console errors ${summary.pageConsoleErrorsTotal} exceeds 0`);
  return failures;
}

async function main(): Promise<void> {
  if (process.env.WOLFPACK_PERF_HELP === "1") {
    console.log("terminal-load perf environment:");
    for (const line of describePerfHarnessEnv()) console.log(`- ${line}`);
    return;
  }

  const brokerBin = resolveBrokerBin();
  const broker = existingBroker() || (brokerBin ? startBroker(brokerBin) : null);
  if (!broker) {
    console.log("skipped: wolfpack-broker binary not found. run `cargo build --manifest-path broker/Cargo.toml --bin wolfpack-broker` first.");
    return;
  }

  let devDir: string | null = null;
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    devDir = mkdtempSync(join(tmpdir(), "wolfpack-terminal-load-perf-"));
    if (broker.proc) await waitForFile(broker.socketPath, 5000);
    server = await startServer(broker.socketPath, devDir, {
      prefillDelayMs: Number(process.env.WOLFPACK_PERF_SLOW_PREFILL_MS || 0) || undefined,
    });

    const runCount = parsePerfRunCount(process.env.WOLFPACK_PERF_RUNS);
    const runs: PerfRunReport[] = [];
    for (let runIndex = 0; runIndex < runCount; runIndex++) {
      if (runCount > 1) console.log(`\nperf run ${runIndex + 1}/${runCount}`);
      runs.push(await runPerfMeasurement(server, devDir, runIndex));
    }

    const summary = summarizePerfRuns(runs);
    const device = parsePerfDeviceMode(process.env.WOLFPACK_PERF_DEVICE);
    const prewarmPoolSize = process.env.WOLFPACK_PERF_GHOSTTY_PREWARM_POOL_SIZE
      ?? String(DEFAULT_GHOSTTY_PREWARM_POOL_SIZE);
    const report = runCount === 1
      ? { generatedAt: new Date().toISOString(), device, prewarmPoolSize, ...runs[0], summary }
      : { generatedAt: new Date().toISOString(), device, prewarmPoolSize, runs, summary };
    console.log(`\n${formatPerfRunsSummary(summary)}`);
    if (process.env.WOLFPACK_PERF_ENFORCE_BUDGETS === "1") {
      const failures = perfBudgetFailures(summary, device);
      if (failures.length > 0) throw new Error(`terminal performance budgets failed:\n- ${failures.join("\n- ")}`);
      console.log(`terminal performance budgets passed (${device})`);
    }
    console.log("\njson:");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (sharedPerfBrowser) {
      await Promise.race([sharedPerfBrowser.close(), wait(5_000)]);
      sharedPerfBrowser = null;
    }
    if (server) server.proc.kill("SIGTERM");
    if (broker.proc) {
      broker.proc.kill("SIGTERM");
      await wait(200);
      if (broker.proc.exitCode === null) broker.proc.kill("SIGKILL");
    }
    if (broker.tempDir) rmSync(broker.tempDir, { recursive: true, force: true });
    if (devDir) rmSync(devDir, { recursive: true, force: true });
    if (process.env.WOLFPACK_BROKER_DEBUG && broker.stderr()) {
      process.stderr.write(`[broker stderr]\n${broker.stderr()}\n`);
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
