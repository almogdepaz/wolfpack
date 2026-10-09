import { describe, expect, test } from "bun:test";
import { rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import {
  cleanupCreatedSessions,
  createPerfBrokerSocketLocation,
  describePerfHarnessEnv,
  formatPerfRunsSummary,
  parsePerfDeviceMode,
  parsePerfRunCount,
  PERF_FLASH_EVENT,
  serverTimingsFor,
  summarizeCell,
  summarizePerfRuns,
  summarizeServerPhases,
  summarizeSwitchBack,
  type PerfRunReport,
  type ServerTiming,
  type TraceState,
} from "../../scripts/terminal-load-perf.ts";

function perfRunReport(
  gridRevealMs: readonly number[],
  gridPrewarmHits: readonly boolean[],
  gridRevealFlashes: readonly (boolean | null)[] = [],
  gridRevealFlashesWithReplay: readonly (boolean | null)[] = [],
): PerfRunReport {
  return {
    pageLoads: [{
      cardVisibleMs: 100,
      domContentLoadedMs: 10,
      loadEventMs: 11,
      firstContentfulPaintMs: 12,
      longTaskCount: 0,
      longTaskTotalMs: 0,
      longTaskMaxMs: 0,
      consoleErrorCount: 0,
      prewarmScheduledDelayMs: 0,
      prewarmReadyCount: 2,
      firstPrewarmReadyMs: 20,
      secondPrewarmReadyMs: 25,
      ghosttyReadyDoneMs: 15,
      prewarmEvents: [],
    }],
    summaries: [{
      scenario: "grid:2",
      mode: "grid",
      cells: 2,
      server: [],
      sessions: gridRevealMs.map((setupToRevealMs, index) => ({
        session: `perf-${index + 1}`,
        setupToAttachMs: 1,
        setupToRevealMs,
        ghosttyCreationMs: 0,
        terminalPrewarmed: gridPrewarmHits[index] ?? false,
        isolatedGhostty: true,
        wsServerMs: 2,
        prefillMs: 3,
        hydrationRevealMs: 4,
        hydrationStartToPrefillDoneMs: 5,
        prefillDoneToRevealMs: 6,
        ptyReadyToRevealMs: 7,
        attachAckToAfterPaintLayoutStableMs: 8,
        lastWriteToRevealMs: 9,
        lastWriteDoneToRevealMs: 10,
        hydrationMinPendingMs: 80,
        hydrationSilenceMs: 32,
        layoutStableDebugMode: "after-paint",
        attachCols: 72,
        attachRows: 55,
        afterPaintCols: 72,
        afterPaintRows: 55,
        afterPaintColDelta: 0,
        attachContainerWidth: 509,
        afterPaintContainerWidth: 509,
        containerWidthDelta: 0,
        prefillBytes: 100,
        revealCanvasChanged: false,
        revealFlash: index < gridRevealFlashes.length ? gridRevealFlashes[index] : false,
        revealFlashWithReplay: index < gridRevealFlashesWithReplay.length ? gridRevealFlashesWithReplay[index] : false,
        revealToStableMs: 20,
        replayBytesDuringReveal: 0,
        liveBytesDuringReveal: 0,
      })),
    }],
  };
}

describe("terminal-load perf run options", () => {
  test("parses positive run counts and defaults to one run", () => {
    expect(parsePerfRunCount(undefined)).toBe(1);
    expect(parsePerfRunCount("3")).toBe(3);
    expect(() => parsePerfRunCount("0")).toThrow("WOLFPACK_PERF_RUNS");
  });

  test("selects desktop or emulated-mobile measurement mode", () => {
    expect(parsePerfDeviceMode(undefined)).toBe("desktop");
    expect(parsePerfDeviceMode("mobile")).toBe("mobile");
    expect(parsePerfDeviceMode("desktop")).toBe("desktop");
    expect(() => parsePerfDeviceMode("tablet")).toThrow("WOLFPACK_PERF_DEVICE");
  });

  test("summarizes repeated runs with prewarm hit counts and percentiles", () => {
    expect(summarizePerfRuns([
      perfRunReport([200, 210], [true, true]),
      perfRunReport([190, 230], [true, false]),
    ])).toMatchObject({
      runs: 2,
      pageConsoleErrorsTotal: 0,
      grid: {
        setupToRevealMs: { count: 4, p50: 200, p95: 230 },
        prewarmHits: { hits: 3, total: 4 },
      },
    });
  });

  test("formats a readable aggregate summary for terminal output", () => {
    const summary = summarizePerfRuns([
      perfRunReport([200, 210], [true, true]),
      perfRunReport([190, 230], [true, false]),
    ]);

    expect(formatPerfRunsSummary(summary)).toContain("runs: 2");
    expect(formatPerfRunsSummary(summary)).toContain("grid reveal p50/p95: 200/230ms (n=4)");
    expect(formatPerfRunsSummary(summary)).toContain("grid prewarm hits: 3/4");
  });

  test("counts reveal flashes over measured cells only", () => {
    const summary = summarizePerfRuns([
      perfRunReport([200, 210], [true, true], [true, false]),
      perfRunReport([190, 230], [true, false], [null, false]),
    ]);

    expect(summary.grid.revealFlashes).toEqual({ hits: 1, total: 3 });
    expect(formatPerfRunsSummary(summary)).toContain("grid reveal flashes: 1/3");
    expect(formatPerfRunsSummary(summary)).toContain("single reveal flashes: 0/0");
  });

  test("counts replay-driven reveal flashes separately", () => {
    const summary = summarizePerfRuns([
      perfRunReport([200, 210], [true, true], [false, false], [true, false]),
      perfRunReport([190, 230], [true, false], [false, null], [true, null]),
    ]);

    expect(summary.grid.revealFlashesWithReplay).toEqual({ hits: 2, total: 3 });
    expect(formatPerfRunsSummary(summary)).toContain("grid reveal flashes with replay: 2/3");
    expect(formatPerfRunsSummary(summary)).toContain("single reveal flashes with replay: 0/0");
  });

  test("documents perf harness environment knobs in one helper", () => {
    expect(describePerfHarnessEnv()).toEqual(expect.arrayContaining([
      "WOLFPACK_PERF_RUNS: positive integer repeated-run count (default: 1)",
      "WOLFPACK_PERF_DEVICE: desktop or mobile browser profile (default: desktop)",
      "WOLFPACK_PERF_GHOSTTY_PREWARM_POOL_SIZE: debug-only pool size override 0-2",
      "WOLFPACK_PERF_GRID_CELLS: comma-separated grid sizes 2-6 (default: 2,4,6)",
      "WOLFPACK_PERF_USE_EXISTING_BROKER: set to 1 to use WOLFPACK_BROKER_SOCKET instead of spawning a broker",
    ]));
  });
});

describe("terminal-load perf cleanup", () => {
  test("creates the spawned broker socket inside a private temporary directory", () => {
    const location = createPerfBrokerSocketLocation();
    try {
      expect(dirname(location.socketPath)).toBe(location.tempDir);
      expect(location.tempDir).not.toBe(tmpdir());
      expect(statSync(location.tempDir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(location.tempDir, { recursive: true, force: true });
    }
  });

  test("kills created perf sessions in reverse order", async () => {
    const calls: Array<{ readonly url: string; readonly body: string | undefined }> = [];
    const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, body: typeof init.body === "string" ? init.body : undefined });
      return new Response("ok", { status: 200 });
    };

    const failures = await cleanupCreatedSessions("http://perf.test", ["perf-a", "perf-b"], fetcher);

    expect(failures).toEqual([]);
    expect(calls).toEqual([
      { url: "http://perf.test/api/kill", body: JSON.stringify({ session: "perf-b" }) },
      { url: "http://perf.test/api/kill", body: JSON.stringify({ session: "perf-a" }) },
    ]);
  });

  test("continues cleanup after one session kill fails", async () => {
    const calls: string[] = [];
    const fetcher = async (_url: string, init: RequestInit): Promise<Response> => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) as { readonly session: string } : { session: "missing" };
      calls.push(body.session);
      return body.session === "perf-b"
        ? new Response("boom", { status: 500 })
        : new Response("ok", { status: 200 });
    };

    const failures = await cleanupCreatedSessions("http://perf.test", ["perf-a", "perf-b"], fetcher);

    expect(calls).toEqual(["perf-b", "perf-a"]);
    expect(failures).toEqual([{ session: "perf-b", error: "500 boom" }]);
  });
});

describe("terminal-load perf summarization", () => {
  test("filters server timings to the current scenario window", () => {
    const timings: ServerTiming[] = [
      { event: "pty_ready.send", session: "perf-a", mode: "full", sinceStartMs: 10 },
      { event: "pty_ready.send", session: "perf-b", mode: "viewport", sinceStartMs: 20 },
      { event: "snapshot_fetch.end", session: "perf-a", mode: "viewport", sinceStartMs: 30 },
      { event: "pty_ready.send", session: "perf-a", mode: "viewport", sinceStartMs: 40 },
    ];

    expect(serverTimingsFor(timings, ["perf-a"], 2)).toEqual([timings[2], timings[3]]);
  });

  test("summarizes the latest attach when a trace contains previous scenario events", () => {
    const trace: TraceState = {
      _meta: { session: "perf-a", machine: "", startWall: 0, startPerf: 0 },
      events: [
        { kind: "ghostty.ready", t: 1 },
        { kind: "terminal.instance.created", t: 2 },
        { kind: "attach.send", t: 3 },
        { kind: "prefill.first_chunk", t: 4 },
        { kind: "ws.binary", bucket: "prefill", size: 100, t: 4.5 },
        { kind: "prefill_done", t: 5 },
        { kind: "pty_ready", t: 6 },
        { kind: "hydration.start", t: 7 },
        { kind: "hydration.reveal", t: 8 },
        { kind: "ghostty.ready", t: 10 },
        { kind: "terminal.instance.created", t: 12, isolatedGhostty: true, prewarmed: true },
        { kind: "attach.send", t: 20, layoutStableDebugMode: "immediate-and-after-paint", cols: 159, rows: 47, containerWidth: 1000 },
        { kind: "attach_ack", t: 20.25 },
        { kind: "layout_stable.send", t: 20.5, reason: "after-paint", cols: 147, rows: 47, containerWidth: 924 },
        { kind: "prefill.first_chunk", t: 21 },
        { kind: "ws.binary", bucket: "prefill", size: 7, t: 22 },
        { kind: "prefill_done", t: 25 },
        { kind: "hydration.start", t: 26, minPendingMs: 12, silenceMs: 5 },
        { kind: "_writeTermData", t: 27, size: 7, hydrating: true },
        { kind: "term.writeDone", t: 29, size: 7, inFlight: 0 },
        { kind: "pty_ready", t: 30 },
        { kind: "hydration.reveal", t: 35 },
      ],
    };

    expect(summarizeCell(trace)).toEqual({
      session: "perf-a",
      setupToAttachMs: 10,
      setupToRevealMs: 25,
      ghosttyCreationMs: 2,
      terminalPrewarmed: true,
      isolatedGhostty: true,
      wsServerMs: 10,
      prefillMs: 4,
      hydrationRevealMs: 9,
      hydrationStartToPrefillDoneMs: -1,
      prefillDoneToRevealMs: 10,
      ptyReadyToRevealMs: 5,
      attachAckToAfterPaintLayoutStableMs: 0.25,
      lastWriteToRevealMs: 8,
      lastWriteDoneToRevealMs: 6,
      hydrationMinPendingMs: 12,
      hydrationSilenceMs: 5,
      layoutStableDebugMode: "immediate-and-after-paint",
      attachCols: 159,
      attachRows: 47,
      afterPaintCols: 147,
      afterPaintRows: 47,
      afterPaintColDelta: -12,
      attachContainerWidth: 1000,
      afterPaintContainerWidth: 924,
      containerWidthDelta: -76,
      prefillBytes: 7,
      revealCanvasChanged: null,
      revealFlash: null,
      revealFlashWithReplay: null,
      revealToStableMs: null,
      replayBytesDuringReveal: null,
      liveBytesDuringReveal: null,
    });
  });

  test("summarizes latest server attach phases for the requested mode", () => {
    const timings: ServerTiming[] = [
      { event: "attach.parsed", session: "perf-a", mode: "single", sinceStartMs: 10, cols: 159, rows: 47 },
      { event: "resize_settle.start", session: "perf-a", mode: "single", sinceStartMs: 20 },
      { event: "resize_settle.end", session: "perf-a", mode: "single", sinceStartMs: 100 },
      { event: "quiescence_wait.start", session: "perf-a", mode: "single", sinceStartMs: 20 },
      { event: "quiescence_wait.end", session: "perf-a", mode: "single", sinceStartMs: 140, outputDecision: "quiet", resizeStableAtMs: 80, outputStableAtMs: 120 },
      { event: "layout_stable", session: "perf-a", mode: "single", sinceStartMs: 145, reason: "after-paint", cols: 147, rows: 47 },
      { event: "snapshot_fetch.start", session: "perf-a", mode: "single", sinceStartMs: 150 },
      { event: "snapshot_fetch.end", session: "perf-a", mode: "single", sinceStartMs: 170 },
      { event: "prefill_send.start", session: "perf-a", mode: "single", sinceStartMs: 171 },
      { event: "prefill_send.end", session: "perf-a", mode: "single", sinceStartMs: 180 },
      { event: "subscribe.start", session: "perf-a", mode: "single", sinceStartMs: 181 },
      { event: "subscribe.success", session: "perf-a", mode: "single", sinceStartMs: 190 },
      { event: "pty_ready.send", session: "perf-a", mode: "single", sinceStartMs: 195 },
      { event: "attach.parsed", session: "perf-a", mode: "grid", sinceStartMs: 5 },
      { event: "pty_ready.send", session: "perf-a", mode: "grid", sinceStartMs: 50 },
    ];

    expect(summarizeServerPhases(timings, ["perf-a"], "single")).toEqual([{
      session: "perf-a",
      mode: "single",
      attachParsedMs: 10,
      resizeSettleMs: 80,
      quiescenceMs: 120,
      snapshotFetchMs: 20,
      prefillSendMs: 9,
      subscribeMs: 9,
      serverReadyMs: 195,
      outputDecision: "quiet",
      resizeStableAtMs: 80,
      outputStableAtMs: 120,
      afterPaintLayoutStableMs: 145,
      afterPaintSnapshotDeltaMs: 5,
      afterPaintColsDelta: -12,
      afterPaintRowsDelta: 0,
    }]);
  });

  test("does not carry prefill bytes across reconnect attaches without a new terminal setup", () => {
    const trace: TraceState = {
      _meta: { session: "perf-a", machine: "", startWall: 0, startPerf: 0 },
      events: [
        { kind: "ghostty.ready", t: 1 },
        { kind: "terminal.instance.created", t: 2 },
        { kind: "attach.send", t: 3 },
        { kind: "prefill.first_chunk", t: 4 },
        { kind: "ws.binary", bucket: "prefill", size: 100, t: 4.5 },
        { kind: "prefill_done", t: 5 },
        { kind: "hydration.start", t: 6 },
        { kind: "hydration.reveal", t: 7 },
        { kind: "attach.send", t: 20 },
        { kind: "prefill.first_chunk", t: 21 },
        { kind: "ws.binary", bucket: "prefill", size: 9, t: 22 },
        { kind: "prefill_done", t: 25 },
        { kind: "pty_ready", t: 30 },
        { kind: "hydration.start", t: 31 },
        { kind: "hydration.reveal", t: 40 },
      ],
    };

    expect(summarizeCell(trace)).toMatchObject({
      setupToAttachMs: 0,
      setupToRevealMs: 20,
      ghosttyCreationMs: null,
      terminalPrewarmed: null,
      isolatedGhostty: null,
      wsServerMs: 10,
      prefillMs: 4,
      hydrationRevealMs: 9,
      hydrationStartToPrefillDoneMs: -6,
      prefillDoneToRevealMs: 15,
      ptyReadyToRevealMs: 10,
      attachAckToAfterPaintLayoutStableMs: null,
      lastWriteToRevealMs: null,
      lastWriteDoneToRevealMs: null,
      layoutStableDebugMode: null,
      attachCols: null,
      attachRows: null,
      afterPaintCols: null,
      afterPaintRows: null,
      afterPaintColDelta: null,
      attachContainerWidth: null,
      afterPaintContainerWidth: null,
      containerWidthDelta: null,
      prefillBytes: 9,
    });
  });

  describe("reveal flash", () => {
    function flashTrace(afterReveal: TraceState["events"], ptyReadyAt = 40): TraceState {
      const events: TraceState["events"] = [
        { kind: "attach.send", t: 1 },
        { kind: "ws.binary", bucket: "prefill", size: 50, t: 2 },
        { kind: "prefill_done", t: 3 },
        { kind: "hydration.reveal", t: 10 },
        { kind: PERF_FLASH_EVENT.REVEAL, t: 10.5, hash: "aaa" },
        { kind: "pty_ready", t: ptyReadyAt },
        ...afterReveal,
      ];
      return {
        _meta: { session: "perf-a", machine: "", startWall: 0, startPerf: 0 },
        events: events.sort((a, b) => a.t - b.t),
      };
    }

    test("an unchanged canvas between reveal and stable is not a flash", () => {
      expect(summarizeCell(flashTrace([
        { kind: PERF_FLASH_EVENT.STABLE, t: 160.5, hash: "aaa" },
      ]))).toMatchObject({
        revealCanvasChanged: false,
        revealFlash: false,
        revealFlashWithReplay: false,
        revealToStableMs: 150,
        replayBytesDuringReveal: 0,
        liveBytesDuringReveal: 0,
      });
    });

    test("a canvas change with no bytes after reveal is a render-lag flash", () => {
      expect(summarizeCell(flashTrace([
        { kind: PERF_FLASH_EVENT.STABLE, t: 160.5, hash: "bbb" },
      ]))).toMatchObject({
        revealCanvasChanged: true,
        revealFlash: true,
        revealFlashWithReplay: false,
        replayBytesDuringReveal: 0,
        liveBytesDuringReveal: 0,
      });
    });

    test("a canvas change with only pre-pty_ready replay bytes is a replay flash", () => {
      expect(summarizeCell(flashTrace([
        { kind: "ws.binary", bucket: "replay", size: 12, t: 20 },
        { kind: PERF_FLASH_EVENT.STABLE, t: 160.5, hash: "bbb" },
        { kind: "ws.binary", bucket: "replay", size: 99, t: 170 },
      ]))).toMatchObject({
        revealCanvasChanged: true,
        revealFlash: false,
        revealFlashWithReplay: true,
        replayBytesDuringReveal: 12,
        liveBytesDuringReveal: 0,
      });
    });

    test("a canvas change with post-pty_ready output is reported but not flagged", () => {
      expect(summarizeCell(flashTrace([
        { kind: "ws.binary", bucket: "replay", size: 12, t: 20 },
        { kind: "ws.binary", bucket: "replay", size: 7, t: 50 },
        { kind: PERF_FLASH_EVENT.STABLE, t: 160.5, hash: "bbb" },
      ]))).toMatchObject({
        revealCanvasChanged: true,
        revealFlash: false,
        revealFlashWithReplay: false,
        replayBytesDuringReveal: 12,
        liveBytesDuringReveal: 7,
      });
    });

    test("a missing stable sample leaves the flash unmeasured", () => {
      expect(summarizeCell(flashTrace([]))).toMatchObject({
        revealCanvasChanged: null,
        revealFlash: null,
        revealFlashWithReplay: null,
        revealToStableMs: null,
        replayBytesDuringReveal: null,
        liveBytesDuringReveal: null,
      });
    });
  });
});

function switchTrace(events: TraceState["events"]): TraceState {
  return { _meta: { session: "perf-a", machine: "", startWall: 0, startPerf: 0 }, events };
}

function switchRunReport(switchBackToRevealMs: number | null, attached: boolean, poolHit: boolean, jsHeapUsedBytes: number | null = null): PerfRunReport {
  return {
    pageLoads: [],
    summaries: [{
      scenario: "switch:2",
      mode: "switch",
      cells: 2,
      server: [],
      sessions: [],
      switchBack: { session: "perf-a", switchBackToRevealMs, switchBackAttached: attached, poolHit, revealFlash: null, jsHeapUsedBytes },
    }],
  };
}

describe("switch scenario", () => {
  test("a pool hit reveals without attaching", () => {
    expect(summarizeSwitchBack(switchTrace([
      { t: 0, kind: "openSession.start" },
      { t: 1.5, kind: "pool.show", connected: true },
      { t: 9.25, kind: "pool.reveal" },
    ]))).toEqual({
      session: "perf-a",
      switchBackToRevealMs: 9.25,
      switchBackAttached: false,
      poolHit: true,
      revealFlash: null,
    });
  });

  test("a pool miss reports the attach and its hydration reveal", () => {
    expect(summarizeSwitchBack(switchTrace([
      { t: 0, kind: "openSession.start" },
      { t: 40, kind: "attach.send" },
      { t: 150, kind: "hydration.reveal" },
      { t: 150, kind: PERF_FLASH_EVENT.REVEAL, hash: "a" },
      { t: 300, kind: PERF_FLASH_EVENT.STABLE, hash: "a" },
    ]))).toEqual({
      session: "perf-a",
      switchBackToRevealMs: 150,
      switchBackAttached: true,
      poolHit: false,
      revealFlash: false,
    });
  });

  test("an unrevealed switch-back reports no reveal time", () => {
    expect(summarizeSwitchBack(switchTrace([{ t: 0, kind: "openSession.start" }])).switchBackToRevealMs).toBeNull();
  });

  test("aggregates switch-back separately from single-terminal opens", () => {
    const summary = summarizePerfRuns([
      switchRunReport(8, false, true, 40 * 1024 * 1024),
      switchRunReport(12, false, true, 42 * 1024 * 1024),
      switchRunReport(170, true, false),
    ]);
    expect(summary.switchBack.switchBackToRevealMs).toMatchObject({ count: 3, p50: 12, p95: 170 });
    expect(summary.switchBack.attaches).toEqual({ hits: 1, total: 3 });
    expect(summary.switchBack.poolHits).toEqual({ hits: 2, total: 3 });
    expect(summary.single.setupToRevealMs.count).toBe(0);
    const formatted = formatPerfRunsSummary(summary);
    expect(formatted).toContain("switch-back reveal p50/p95: 12/170ms (n=3)");
    expect(formatted).toContain("switch-back attaches: 1/3");
    expect(formatted).toContain("switch-back pool hits: 2/3");
    // Page-load heap never sees pooled terminals; sample after the switch.
    expect(summary.switchBack.jsHeapUsedBytes).toMatchObject({ count: 2, p50: 40 * 1024 * 1024 });
    expect(formatted).toContain("switch-back JS heap p50/p95: 40.00/42.00MiB (n=2)");
  });

  test("documents the terminal pool size override", () => {
    expect(describePerfHarnessEnv()).toContain(
      "WOLFPACK_PERF_TERMINAL_POOL_SIZE: debug-only single-terminal pool size override 1-6 (default: 3 desktop, 1 mobile)",
    );
  });
});
