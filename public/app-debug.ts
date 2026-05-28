// ── Diagnostic Tracer (scrolldown investigation) ──
//
// Captures timestamped events per (session@machine) attach so we can
// reconstruct the WS frame timing, prefill vs replay byte distribution,
// _writeTermData call shape, and rAF cadence during the hydration window.
//
// PURE DIAGNOSTIC. Gated behind `localStorage.wolfpackDebug = "1"` so it
// doesn't expose per-session attach metadata to any JS in the page context
// (XSS, extension, bookmarklet). When disabled, all helpers are no-ops and
// `__wfTrace` / `__wf_dumpTrace` / `__wf_clearTrace` are NOT installed on
// `window`.
//
// Read with `window.__wf_dumpTrace()` or `window.__wf_dumpTrace("sess")`
// after enabling: `localStorage.wolfpackDebug = "1"; location.reload()`.

declare global {
  interface Window {
    __wfTrace?: Record<string, TraceState>;
    __wf_dumpTrace?: (sessionFilter?: string) => Record<string, TraceState> | undefined;
    __wf_clearTrace?: () => void;
    __wf_lastCrash?: CrashCapture;
  }
}

export interface TraceMeta {
  readonly session: string;
  readonly machine: string;
  readonly startWall: number;
  readonly startPerf: number;
  readonly markPrefix: string;
  readonly [extra: string]: unknown;
}

export interface TraceEvent {
  readonly t: number;
  readonly kind: string;
  readonly [field: string]: unknown;
}

export interface TraceState {
  readonly _meta: TraceMeta;
  readonly events: TraceEvent[];
  _rafCount: number;
  _rafActive: boolean;
}

export interface CrashCapture {
  readonly session: string;
  readonly cols: number | null;
  readonly rows: number | null;
  readonly len: number;
  readonly head: readonly number[];
  readonly tail: readonly number[];
  readonly err: string;
  readonly stack: string | undefined;
  readonly ts: number;
}

const __wfTraceEnabled = (() => {
  try { return localStorage.getItem("wolfpackDebug") === "1"; }
  catch { return false; }
})();

const __wfTraceMaxEvents = 5000;
let __wfTraceSeq = 0;

export const wfTraceEnabled: boolean = __wfTraceEnabled;

if (__wfTraceEnabled) window.__wfTrace = window.__wfTrace || {};

function __wfTraceKey(session: string | null | undefined, machine: string | null | undefined): string {
  return (session || "?") + "@" + (machine || "");
}

export function __wfTraceStart(
  session: string,
  machine: string | null | undefined,
  extra?: Record<string, unknown>,
): TraceState | null {
  if (!__wfTraceEnabled) return null;
  const key = __wfTraceKey(session, machine);
  const markPrefix = "wolfpack:terminal-load:" + (++__wfTraceSeq) + ":" + key;
  const trace: TraceState = {
    _meta: {
      session,
      machine: machine || "",
      startWall: Date.now(),
      startPerf: performance.now(),
      markPrefix,
      ...(extra || {}),
    },
    events: [],
    _rafCount: 0,
    _rafActive: false,
  };
  window.__wfTrace![key] = trace;
  try { performance.mark(markPrefix + ":start"); } catch {}
  return trace;
}

export function __wfTraceGet(
  session: string | null | undefined,
  machine: string | null | undefined,
): TraceState | null {
  if (!__wfTraceEnabled) return null;
  const key = __wfTraceKey(session, machine);
  return window.__wfTrace ? window.__wfTrace[key] || null : null;
}

export function __wfTraceEvent(
  trace: TraceState | null,
  kind: string,
  fields?: Record<string, unknown>,
): void {
  if (!trace) return;
  if (trace.events.length >= __wfTraceMaxEvents) return;
  const markName = trace._meta.markPrefix + ":" + kind;
  try {
    performance.mark(markName);
    performance.measure(markName, trace._meta.markPrefix + ":start", markName);
  } catch {}
  trace.events.push({
    t: +(performance.now() - trace._meta.startPerf).toFixed(3),
    kind,
    ...(fields || {}),
  });
}

export function __wfTraceRafStart(trace: TraceState | null): void {
  if (!trace || trace._rafActive) return;
  trace._rafActive = true;
  function tick() {
    if (!trace || !trace._rafActive) return;
    trace._rafCount++;
    __wfTraceEvent(trace, "raf", { n: trace._rafCount });
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

export function __wfTraceRafStop(trace: TraceState | null): void {
  if (!trace) return;
  trace._rafActive = false;
}

if (__wfTraceEnabled) {
  window.__wf_dumpTrace = function (sessionFilter?: string) {
    const all = window.__wfTrace || {};
    const keys = Object.keys(all).filter(k => !sessionFilter || k.indexOf(sessionFilter) >= 0);
    for (const key of keys) {
      const trace = all[key];
      const ev = trace.events;
      const meta = trace._meta;
      const sumByKind: Record<string, number> = {};
      let prefillBytes = 0, replayBytes = 0, prefillFrames = 0, replayFrames = 0;
      let firstPrefillT = -1, prefillDoneT = -1, firstReplayT = -1, hydratedT = -1;
      for (const e of ev) {
        sumByKind[e.kind] = (sumByKind[e.kind] || 0) + 1;
        if (e.kind === "ws.binary") {
          const size = typeof e.size === "number" ? e.size : 0;
          if (e.bucket === "prefill") { prefillBytes += size; prefillFrames++; if (firstPrefillT < 0) firstPrefillT = e.t; }
          else { replayBytes += size; replayFrames++; if (firstReplayT < 0) firstReplayT = e.t; }
        }
        if (e.kind === "prefill_done") prefillDoneT = e.t;
        if (e.kind === "hydration.finish") hydratedT = e.t;
      }
      console.group("[wf-trace] " + key);
      console.log("meta:", meta);
      console.log("counts:", sumByKind);
      console.log("prefill: " + prefillFrames + " frames, " + prefillBytes + " bytes, first @ " + firstPrefillT + "ms, prefill_done @ " + prefillDoneT + "ms");
      console.log("replay (post-prefill_done): " + replayFrames + " frames, " + replayBytes + " bytes, first @ " + firstReplayT + "ms");
      console.log("hydrated @ " + hydratedT + "ms; rAFs during attach: " + trace._rafCount);
      console.log("events:", ev);
      console.groupEnd();
    }
    return all;
  };

  window.__wf_clearTrace = function () {
    window.__wfTrace = {};
  };
}

/** Capture first WASM _term.write crash. Must NEVER throw — caller re-throws the original error. */
export function captureLastCrash(snapshot: {
  session: string;
  cols: number | null;
  rows: number | null;
  data: Uint8Array;
  err: unknown;
}): void {
  try {
    if (window.__wf_lastCrash) return;
    const { data, err } = snapshot;
    window.__wf_lastCrash = {
      session: snapshot.session,
      cols: snapshot.cols,
      rows: snapshot.rows,
      len: data.length,
      head: Array.from(data.slice(0, 64)),
      tail: Array.from(data.slice(Math.max(0, data.length - 64))),
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined,
      ts: Date.now(),
    };
    console.error("[wf-crash]", snapshot.session, err, "— captured to window.__wf_lastCrash");
  } catch {
    // Best-effort crash capture must never mask the original terminal error.
  }
}
