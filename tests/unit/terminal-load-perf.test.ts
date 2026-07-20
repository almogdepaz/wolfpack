import { describe, expect, test } from "bun:test";
import {
  serverTimingsFor,
  summarizeCell,
  summarizeServerPhases,
  type ServerTiming,
  type TraceState,
} from "../../scripts/terminal-load-perf.ts";

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
});
