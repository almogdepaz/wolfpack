import { describe, expect, test } from "bun:test";
import { serverTimingsFor, summarizeCell, type ServerTiming, type TraceState } from "../../scripts/terminal-load-perf.ts";

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
        { kind: "terminal.instance.created", t: 12 },
        { kind: "attach.send", t: 20 },
        { kind: "prefill.first_chunk", t: 21 },
        { kind: "ws.binary", bucket: "prefill", size: 7, t: 22 },
        { kind: "prefill_done", t: 25 },
        { kind: "hydration.start", t: 26 },
        { kind: "pty_ready", t: 30 },
        { kind: "hydration.reveal", t: 35 },
      ],
    };

    expect(summarizeCell(trace)).toEqual({
      session: "perf-a",
      setupToAttachMs: 10,
      setupToRevealMs: 25,
      ghosttyCreationMs: 2,
      wsServerMs: 10,
      prefillMs: 4,
      hydrationRevealMs: 9,
      prefillBytes: 7,
    });
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
      wsServerMs: 10,
      prefillMs: 4,
      hydrationRevealMs: 9,
      prefillBytes: 9,
    });
  });
});
