import {
  esc, escAttr, loadStoredJson, isDesktop, formatSnapshotTtl,
  getTerminalFontFamily,
  wpDefaults, wpSettings, TERM_PRESETS, toggleSetting, applySetting,
  applyTermToXterm, initSettings, haptic, requestNotifications,
  QC_STORAGE_KEY, loadQuickCmds, RECENTS_STORAGE_KEY, MAX_RECENTS,
  state, setState,
  SNAPSHOT_KEY_PREFIX, SNAPSHOT_MAX_BYTES, SNAPSHOT_SAVE_INTERVAL,
  DESKTOP_TERMINAL_SCROLLBACK, GRID_TERMINAL_SCROLLBACK,
} from "./app-state";

import {
  initRalphDeps,
  getRalphStatus, renderRalphCardHtml, sidebarRalphCardHtml,
  openRalphDetail, refreshRalphDetail, parseIterations, toggleRawLog,
  cancelRalph, loadRalphStartForm, onIsolationChange,
  startRalph, continueRalph, discardRalph, showRalphStart, dismissRalph,
  checkRalphTransitions,
} from "./app-ralph";

import {
  initGridDeps,
  isGridActive, updateGridLayout, renderGridCells, getGridCellElement,
  hasPreservedGrid, clearPreservedGrid, setCurrentSessionFromGridFocus,
  returnToTerminalView, setGridFocus, suspendGridMode, restorePreservedGrid,
  backFromRalph, backFromSettings, addToGrid, removeFromGrid, exitGridMode,
  hideGridCellsForTransition, revealGridCellsWithoutResize,
  scheduleGridStabilizedFit, isSessionInGrid, toggleGrid,
  canOpenMultiTerminalGrid, collapseIdleDelegationSessions, disposeDelegationGrid,
  expandDelegationSessions, renderDelegationGridCells,
  setDelegationGridMembers, suspendDelegationGridTerminals,
} from "./app-grid";
import type { DelegationGridMember } from "./app-grid";

import { setupTouchScrollHandler } from "./app-touch";
import { filterProjectNames } from "./project-picker";
import {
  GhosttyPrewarmPool,
  scheduleGhosttyPrewarmRefill,
} from "./ghostty-prewarm-pool";

import {
  __wfTraceStart, __wfTraceGet, __wfTraceEvent, __wfTraceRafStart, __wfTraceRafStop,
  captureLastCrash, wfTraceEnabled,
} from "./app-debug";
import type { TraceState } from "./app-debug";
import {
  CACHED_TERMINAL_PLACEHOLDER_CLASS,
  cachedSnapshotPlaceholderText,
} from "./terminal-placeholder";
import {
  createTerminalSlowPathIndicator,
  setTerminalLoadVisualState,
} from "./terminal-loading-ui";
import { scheduleTakeControlFallback } from "./take-control-coordinator";
import { resolveHydrationDebugTiming } from "../src/terminal-hydration-debug";
import { resolveGhosttyPrewarmDebugTiming } from "../src/ghostty-prewarm-debug";
import {
  resolveLayoutStableDebugMode,
  shouldSendImmediateLayoutStable,
  type LayoutStablePrefillMode,
} from "../src/terminal-layout-stable-debug";
import { AGENT_KIND } from "../src/agent-kind";
import { sessionRuntimeUi } from "../src/agent-runtime-ui";
import {
  delegationChildSummaryText,
  delegationGridMembers,
  delegationRootSession,
  projectDelegationSessions,
} from "./delegation-sessions";
import type {
  DelegationSessionLike,
  DelegationSessionRow,
} from "./delegation-sessions";
import { AGENT_STATUS_STATE } from "../src/agent-status-contract";
import { TERMINAL_PREFILL_MODE } from "../src/terminal-prefill";
import type { TerminalPrefillMode } from "../src/terminal-prefill";

// ── WASM capability guard ──

const GHOSTTY_PREWARM_POOL_SIZE = 2;
const GHOSTTY_PREWARM_DELAY_MS = 0;
const ATTACH_DIMENSION_RETRY_DELAY_MS = 50;
const ATTACH_DIMENSION_MAX_ATTEMPTS = 20;
const RESIZE_SEND_DEBOUNCE_MS = 120;

function safeLocalStorage(): Pick<Storage, "getItem"> | null {
  try { return window.localStorage; }
  catch { return null; }
}

interface GhosttyPrewarmDebugEvent {
  readonly t: number;
  readonly kind: string;
  readonly slot?: number;
  readonly delayMs?: number;
  readonly readyCount?: number;
}

interface GhosttyPrewarmDebugState {
  readonly startPerf: number;
  readonly events: GhosttyPrewarmDebugEvent[];
  readyCount: number;
}

function ghosttyPrewarmDebugState(): GhosttyPrewarmDebugState | null {
  if (!wfTraceEnabled) return null;
  const target = window as unknown as { __wfGhosttyPrewarm?: GhosttyPrewarmDebugState };
  target.__wfGhosttyPrewarm ??= { startPerf: 0, events: [], readyCount: 0 };
  return target.__wfGhosttyPrewarm;
}

function recordGhosttyPrewarmEvent(kind: string, fields?: Omit<GhosttyPrewarmDebugEvent, "kind" | "t">): void {
  const state = ghosttyPrewarmDebugState();
  if (!state) return;
  state.events.push({
    t: +(performance.now() - state.startPerf).toFixed(3),
    kind,
    ...(fields || {}),
  });
}

const ghosttyPrewarmPool = new GhosttyPrewarmPool<unknown>({
  maxSize: GHOSTTY_PREWARM_POOL_SIZE,
  create: async () => {
    if (typeof window.createIsolatedGhostty !== "function") {
      throw new Error("createIsolatedGhostty unavailable");
    }
    return window.createIsolatedGhostty();
  },
  onReady: () => {
    const state = ghosttyPrewarmDebugState();
    if (!state) return;
    state.readyCount++;
    recordGhosttyPrewarmEvent("prewarm.ready", { readyCount: state.readyCount });
  },
  onError: (error) => {
    recordGhosttyPrewarmEvent("prewarm.error");
    console.debug("[wf] ghostty prewarm failed:", error);
  },
});

function canUseWasmTerminal(): boolean {
  return !window.wasmFailed;
}

function scheduleGhosttyPrewarm(): void {
  if (typeof window.createIsolatedGhostty !== "function") return;
  const timing = resolveGhosttyPrewarmDebugTiming({
    debugEnabled: wfTraceEnabled,
    storage: safeLocalStorage(),
    defaults: { delayMs: GHOSTTY_PREWARM_DELAY_MS },
  });
  recordGhosttyPrewarmEvent("schedule", { delayMs: timing.delayMs });
  window.setTimeout(() => {
    recordGhosttyPrewarmEvent("ghostty_ready.wait");
    void window.ghosttyReady
      ?.then(() => {
        recordGhosttyPrewarmEvent("ghostty_ready.done");
        for (let i = 0; i < GHOSTTY_PREWARM_POOL_SIZE; i++) {
          const task = ghosttyPrewarmPool.prewarm();
          recordGhosttyPrewarmEvent(task ? "prewarm.start" : "prewarm.skip", { slot: i + 1 });
        }
      })
      .catch((error) => {
        recordGhosttyPrewarmEvent("ghostty_ready.error");
        console.debug("[wf] ghostty prewarm skipped:", error);
      });
  }, timing.delayMs);
}

function scheduleGhosttyPrewarmRefillForConsumedInstance(): void {
  if (typeof window.createIsolatedGhostty !== "function") return;
  scheduleGhosttyPrewarmRefill({
    prewarm: () => ghosttyPrewarmPool.prewarm(),
    schedule: (task) => { window.setTimeout(task, 0); },
    waitUntilReady: () => window.ghosttyReady,
    onError: (error) => console.debug("[wf] ghostty prewarm refill skipped:", error),
  });
}

// ── Performance Metrics (UX-16) ──

const wpMetrics = {
  latencySamples: [],     // rolling window of render times (ms)
  maxLatencySamples: 200,
  reconnectCount: 0,
  sendFailCount: 0,
  sendCount: 0,
  wsMessagesReceived: 0,
  sessionOpenedAt: 0,
  lastUpdateAt: 0,
  recordLatency(ms) {
    this.latencySamples.push(ms);
    if (this.latencySamples.length > this.maxLatencySamples) this.latencySamples.shift();
    this.lastUpdateAt = Date.now();
  },
  percentile(p) {
    const s = this.latencySamples.slice().sort((a, b) => a - b);
    if (!s.length) return 0;
    const i = Math.ceil(s.length * p / 100) - 1;
    return s[Math.max(0, i)];
  },
  avg() {
    if (!this.latencySamples.length) return 0;
    return this.latencySamples.reduce((a, b) => a + b, 0) / this.latencySamples.length;
  },
  reset() {
    this.latencySamples = [];
    this.reconnectCount = 0;
    this.sendFailCount = 0;
    this.sendCount = 0;
    this.wsMessagesReceived = 0;
    this.sessionOpenedAt = Date.now();
    this.lastUpdateAt = 0;
  }
};

let debugPanelTimer = null;

function toggleDebugPanel() {
  const panel = document.getElementById("debug-panel");
  if (!panel) return;
  if (wpSettings.debugPanel) {
    panel.style.display = "block";
    renderDebugPanel();
    if (!debugPanelTimer) debugPanelTimer = setInterval(renderDebugPanel, 1000);
  } else {
    panel.style.display = "none";
    if (debugPanelTimer) { clearInterval(debugPanelTimer); debugPanelTimer = null; }
  }
}

function renderDebugPanel() {
  if (!wpSettings.debugPanel) return;
  const fmt = (v) => v > 0 ? v.toFixed(2) + "ms" : "—";
  const el = (id) => document.getElementById(id);
  const p50 = el("dbg-p50"); if (p50) p50.textContent = fmt(wpMetrics.percentile(50));
  const p95 = el("dbg-p95"); if (p95) p95.textContent = fmt(wpMetrics.percentile(95));
  const avg = el("dbg-avg"); if (avg) avg.textContent = fmt(wpMetrics.avg());
  const samples = el("dbg-samples"); if (samples) samples.textContent = String(wpMetrics.latencySamples.length);
  const wsMsgs = el("dbg-ws-msgs"); if (wsMsgs) wsMsgs.textContent = String(wpMetrics.wsMessagesReceived);
  const reconnects = el("dbg-reconnects"); if (reconnects) reconnects.textContent = String(wpMetrics.reconnectCount);
  const sends = el("dbg-sends"); if (sends) sends.textContent = String(wpMetrics.sendCount);
  const fails = el("dbg-send-fails"); if (fails) {
    fails.textContent = String(wpMetrics.sendFailCount);
    fails.style.color = wpMetrics.sendFailCount > 0 ? "#ff4444" : "#00ff41";
  }
  const uptime = el("dbg-uptime");
  if (uptime) {
    if (wpMetrics.sessionOpenedAt > 0) {
      const sec = Math.floor((Date.now() - wpMetrics.sessionOpenedAt) / 1000);
      const m = Math.floor(sec / 60), s = sec % 60;
      uptime.textContent = m > 0 ? m + "m " + s + "s" : s + "s";
    } else {
      uptime.textContent = "—";
    }
  }
}

// ── Quick Commands (UX-08) ──

function saveQuickCmds() {
  localStorage.setItem(QC_STORAGE_KEY, JSON.stringify(state.quickCmds));
}

function renderCmdPalette() {
  const el = document.getElementById("cmd-palette");
  if (!el) return;
  if (state.quickCmds.length === 0) {
    el.classList.remove("visible");
    el.innerHTML = "";
    return;
  }
  el.innerHTML = state.quickCmds.map((c, i) =>
    `<button class="cmd-chip" onclick="sendQuickCmd(${i})">${esc(c.label)}</button>`
  ).join("");
  el.classList.toggle("visible", state.kbAccessoryOpen);
}

function sendQuickCmd(index: number): void {
  const cmd = state.quickCmds[index];
  if (!cmd || !state.currentSession) return;
  haptic([30]);
  wpMetrics.sendCount++;
  if (!_sendTerminalInput(_textEncoder.encode(cmd.cmd + "\r"))) {
    wpMetrics.sendFailCount++;
  }
}

function renderQuickCmdSettings() {
  const list = document.getElementById("quick-cmds-list");
  if (!list) return;
  list.innerHTML = state.quickCmds.map((c, i) => `
    <div class="qc-item">
      <span class="qc-label">${esc(c.label)}</span>
      <span class="qc-cmd">${esc(c.cmd)}</span>
      ${i > 0 ? `<button onclick="moveQuickCmd(${i},-1)" class="qc-btn move" title="Move up">&#9650;</button>` : '<span class="qc-spacer"></span>'}
      ${i < state.quickCmds.length - 1 ? `<button onclick="moveQuickCmd(${i},1)" class="qc-btn move" title="Move down">&#9660;</button>` : '<span class="qc-spacer"></span>'}
      <button onclick="editQuickCmd(${i})" class="qc-btn edit" title="Edit">&#9998;</button>
      <button onclick="deleteQuickCmd(${i})" class="qc-btn delete" title="Delete">&#10005;</button>
    </div>
  `).join("");
}

function addQuickCmd() {
  const label = prompt("Label (shown on chip):");
  if (!label || !label.trim()) return;
  const cmd = prompt("Command (sent to terminal):");
  if (!cmd || !cmd.trim()) return;
  state.quickCmds.push({ label: label.trim(), cmd: cmd.trim() });
  saveQuickCmds();
  renderQuickCmdSettings();
  renderCmdPalette();
}

function editQuickCmd(index: number): void {
  const c = state.quickCmds[index];
  if (!c) return;
  const label = prompt("Label:", c.label);
  if (!label || !label.trim()) return;
  const cmd = prompt("Command:", c.cmd);
  if (!cmd || !cmd.trim()) return;
  state.quickCmds[index] = { label: label.trim(), cmd: cmd.trim() };
  saveQuickCmds();
  renderQuickCmdSettings();
  renderCmdPalette();
}

function deleteQuickCmd(index: number): void {
  state.quickCmds.splice(index, 1);
  saveQuickCmds();
  renderQuickCmdSettings();
  renderCmdPalette();
}

function moveQuickCmd(index: number, direction: 1 | -1): void {
  const target = index + direction;
  if (target < 0 || target >= state.quickCmds.length) return;
  const tmp = state.quickCmds[index];
  state.quickCmds[index] = state.quickCmds[target];
  state.quickCmds[target] = tmp;
  saveQuickCmds();
  renderQuickCmdSettings();
  renderCmdPalette();
}

async function showGitStatus(): Promise<void> {
  if (!state.currentSession) return;
  haptic([30]);
  const overlay = document.getElementById("git-status-overlay");
  overlay.innerHTML = '<pre>loading...</pre>';
  overlay.classList.add("visible");
  try {
    const data = await api<{ readonly status?: string }>("/git-status?session=" + encodeURIComponent(state.currentSession), {}, state.currentMachine);
    overlay.innerHTML = `<div><pre>${esc(data.status || "(clean)")}</pre><div class="overlay-hint">tap to dismiss</div></div>`;
  } catch (e) {
    overlay.innerHTML = `<div><pre class="error-pre">${esc(errorMessage(e))}</pre><div class="overlay-hint">tap to dismiss</div></div>`;
  }
}

function dismissGitStatus() {
  document.getElementById("git-status-overlay").classList.remove("visible");
}

async function copySessionToClipboard(): Promise<void> {
  if (!state.currentSession) return;
  haptic([20]);
  const overlay = document.getElementById("git-status-overlay");
  overlay.innerHTML = '<pre>copying...</pre>';
  overlay.classList.add("visible");
  try {
    // /api/copy-text returns text/plain — fetch raw, then write to clipboard.
    const path = "/api/copy-text?session=" + encodeURIComponent(state.currentSession);
    const base = (state.currentMachine || "").replace(/\/$/, "");
    const headers: Record<string, string> = {};
    const jwt = localStorage.getItem("wpJwt");
    if (jwt) headers["Authorization"] = "Bearer " + jwt;
    const r = await fetch(base + path, { headers });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const text = await r.text();
    await navigator.clipboard.writeText(text);
    overlay.innerHTML = `<div><pre>copied ${text.length} chars</pre><div class="overlay-hint">tap to dismiss</div></div>`;
  } catch (e) {
    overlay.innerHTML = `<div><pre class="error-pre">copy failed: ${esc(errorMessage(e))}</pre><div class="overlay-hint">tap to dismiss</div></div>`;
  }
}

// ── Session Recents ──

function sessionKey(machine: string | null | undefined, name: string): string {
  return (machine || "") + "|" + name;
}

function saveRecents() {
  localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(state.sessionRecents));
}

function recordRecent(machine: string | null | undefined, name: string): void {
  const key = sessionKey(machine, name);
  state.sessionRecents = state.sessionRecents.filter(r => r.key !== key);
  state.sessionRecents.unshift({ key, name, machine: machine || "", ts: Date.now() });
  if (state.sessionRecents.length > MAX_RECENTS) state.sessionRecents.length = MAX_RECENTS;
  saveRecents();
}
const RECONNECT_BUDGET_MS = 2 * 60 * 1000;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 5000;

/**
 * Shared reconnect backoff engine used by both desktop PTY and mobile WS paths.
 * @param {object} opts
 * @param {() => boolean} [opts.shouldReconnect] - guard; returning false skips scheduling
 * @param {() => void} [opts.onReconnecting] - called when a reconnect attempt is scheduled
 * @param {() => void} [opts.onExhausted] - called when the retry budget is spent
 * @returns {{ schedule, cancel, reset, block, connected, isBlocked: boolean, pending: boolean }}
 */
interface ReconnectorOpts {
  shouldReconnect?: () => boolean;
  onReconnecting?: () => void;
  onExhausted?: () => void;
}

interface Reconnector {
  schedule(connectFn: () => void): void;
  cancel(): void;
  reset(): void;
  block(): void;
  connected(): void;
  readonly isBlocked: boolean;
  readonly pending: boolean;
}

function createReconnector(opts: ReconnectorOpts = {}): Reconnector {
  let _timer: ReturnType<typeof setTimeout> | null = null;
  let _delay = RECONNECT_BASE_DELAY_MS;
  let _startedAt = 0;
  let _blocked = false;

  function schedule(connectFn: () => void): void {
    if (_timer) return;
    if (_blocked) return;
    if (opts.shouldReconnect && !opts.shouldReconnect()) return;
    const now = Date.now();
    if (!_startedAt) _startedAt = now;
    const elapsed = now - _startedAt;
    const remaining = RECONNECT_BUDGET_MS - elapsed;
    if (remaining <= 0) {
      _blocked = true;
      if (opts.onExhausted) opts.onExhausted();
      return;
    }
    if (opts.onReconnecting) opts.onReconnecting();
    const jitterMs = Math.floor(Math.random() * 200);
    const delayMs = Math.min(_delay + jitterMs, RECONNECT_MAX_DELAY_MS, remaining);
    _timer = setTimeout(() => {
      _timer = null;
      if (opts.shouldReconnect && !opts.shouldReconnect()) return;
      connectFn();
    }, delayMs);
    _delay = Math.min(Math.floor(_delay * 1.8), RECONNECT_MAX_DELAY_MS);
  }

  function cancel() {
    if (_timer) { clearTimeout(_timer); _timer = null; }
  }

  function reset() {
    _blocked = false;
    _startedAt = 0;
    _delay = RECONNECT_BASE_DELAY_MS;
  }

  function block() { _blocked = true; }

  /** Call on successful connect. Returns true if this was a reconnect (budget was active). */
  function connected() {
    const wasReconnecting = _startedAt > 0;
    _delay = RECONNECT_BASE_DELAY_MS;
    _startedAt = 0;
    _blocked = false;
    return wasReconnecting;
  }

  return {
    schedule,
    cancel,
    reset,
    block,
    connected,
    get isBlocked() { return _blocked; },
    get pending() { return !!_timer; },
  };
}

/**
 * Creates a configured ghostty-web Terminal with addons, copy/paste, and stdin wired up.
 * @param {object} opts
 * @param {number} opts.fontSize
 * @param {number} opts.scrollback
 * @param {boolean} [opts.cursorBlink=true]
 * @param {boolean} [opts.disableStdin=false]
 * @param {(data: Uint8Array) => void} opts.sendInput - send raw bytes to the backend
 * @param {(msg: string) => void} opts.sendMessage - send a string message (e.g. resize JSON)
 * @param {() => boolean} opts.canAcceptInput - guard for stdin (may include focus check)
 * @param {() => boolean} [opts.canSendResize] - guard for resize messages (defaults to canAcceptInput)
 * @param {boolean} [opts.forwardResizeEvents=true] - whether terminal onResize events directly forward backend resize messages
 * @returns {{ term: Terminal, fitAddon: FitAddon }}
 */
async function createTerminalInstance({ fontSize, scrollback, cursorBlink = true, disableStdin = false, sendInput, sendMessage, canAcceptInput, canSendResize, forwardResizeEvents = true, onWheelScroll = null, alwaysForwardWheel = false, trace = null }) {
  const shouldSendResize = canSendResize || canAcceptInput;
  const tp = TERM_PRESETS[wpSettings.termFontSize] || TERM_PRESETS.medium;
  const termFontFamily = wpSettings.termFont === "alt"
    ? '"JetBrains Mono", "Fira Code", "Source Code Pro", "Cascadia Code", monospace'
    : '"SF Mono", "Menlo", "Consolas", "DejaVu Sans Mono", "Liberation Mono", monospace';
  // Per-Terminal WASM isolation — each Terminal gets its own Ghostty instance
  // (separate WebAssembly.Memory) to avoid shared-allocator OOB across grid cells.
  // See scripts/bundle-ghostty.ts for context. Falls back to shared singleton if
  // createIsolatedGhostty isn't available (e.g. older bundle).
  //
  // When isolation is unavailable AND grid mode is in use, concurrent
  // fit()/write() across cells can OOB on the shared WebAssembly.Memory.
  // addToGrid() refuses to enter grid mode in that state, so any path
  // reaching here without isolation is a single-cell terminal where the
  // shared singleton is safe.
  let isolatedGhostty: unknown = null;
  let usedPrewarmedGhostty = false;
  const prewarmedGhostty = ghosttyPrewarmPool.take();
  if (prewarmedGhostty.instance) {
    isolatedGhostty = prewarmedGhostty.instance;
    usedPrewarmedGhostty = true;
    scheduleGhosttyPrewarmRefillForConsumedInstance();
  } else if (typeof window.createIsolatedGhostty === "function") {
    try { isolatedGhostty = await window.createIsolatedGhostty(); }
    catch (e) { console.error("[wf] createIsolatedGhostty failed, falling back to shared singleton (grid mode will be disabled):", e); }
  } else {
    console.error("[wf] createIsolatedGhostty is not available — falling back to shared singleton (grid mode will be disabled). This usually means the ghostty-web bundle is out of date.");
  }
  const term = new Terminal({
    cursorBlink,
    disableStdin,
    macOptionClickForcesSelection: true,
    fontSize: fontSize != null ? fontSize : tp.fontSize,
    lineHeight: tp.lineHeight,
    fontFamily: termFontFamily,
    ...(isolatedGhostty ? { ghostty: isolatedGhostty } : {}),
    theme: {
      background: "#0a0a0a",
      foreground: "#e0e0e0",
      cursor: "#e0e0e0",
      selectionBackground: "rgba(255,255,255,0.2)",
    },
    scrollback,
  });
  __wfTraceEvent(trace, "terminal.instance.created", { isolatedGhostty: !!isolatedGhostty, prewarmed: usedPrewarmedGhostty });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  // Ghostty-web's FitAddon hardcodes a 15px right-edge scrollbar reservation,
  // but ghostty-web renders its scrollbar onto the canvas itself — so that's
  // dead space, visible as a ~15-20px gap on the right of every terminal
  // (especially obvious framed inside grid cells). Override proposeDimensions
  // to drop the reservation.
  fitAddon.proposeDimensions = function () {
    const t = this._terminal;
    if (!t?.element) return;
    const r = t.renderer;
    if (!r || typeof r.getMetrics !== "function") return;
    const m = r.getMetrics();
    if (!m || m.width === 0 || m.height === 0) return;
    const el = t.element;
    if (typeof el.clientWidth === "undefined") return;
    const cs = window.getComputedStyle(el);
    const pT = parseInt(cs.paddingTop) || 0;
    const pB = parseInt(cs.paddingBottom) || 0;
    const pL = parseInt(cs.paddingLeft) || 0;
    const pR = parseInt(cs.paddingRight) || 0;
    const w = el.clientWidth, h = el.clientHeight;
    if (w === 0 || h === 0) return;
    return {
      cols: Math.max(1, Math.floor((w - pL - pR) / m.width)),
      rows: Math.max(1, Math.floor((h - pT - pB) / m.height)),
    };
  };
  // Copy (ghostty renders to canvas, so native copy doesn't work)
  // ghostty-web: true = "handled, stop", false = "not handled, continue"
  term.attachCustomKeyEventHandler((e) => {
    if (WP.shouldInterceptCopy(e, term.hasSelection())) {
      navigator.clipboard.writeText(term.getSelection()).catch((e) => { console.debug("[clipboard] copy failed:", e); });
      return true;
    }
    return false;
  });

  // Mouse wheel routing. Two destinations:
  //   (a) TUIs with mouse mode (1000/1002/1003) on — forward as SGR scroll
  //       sequences over stdin so the app (vim/htop/claude UI/etc) handles
  //       scrollback in its own buffer. Client-side scrollback would just
  //       fight the app's redraws.
  //   (b) Plain shell — scroll ghostty's client-side scrollback.
  //
  // Both paths accumulate trackpad delta into integer line counts BEFORE
  // dispatching, so we never trigger ghostty's smoothScrollTo with a
  // fractional viewportY (the renderer has an off-by-one at fractional g
  // that paints stale pixels at the boundary row — visible as a duplicate
  // first row when scrolling up by less than a full line).
  let _mouseModeScrollAccum = 0;
  let _clientScrollAccum = 0;
  const MOUSE_MODE_THRESHOLD = 60; // px per emitted scroll-line sequence (trackpad-tuned)
  term.attachCustomWheelEventHandler((ev) => {
    // Notify scroll-lock controller before ghostty-web would process the
    // wheel. We always consume the event below, so this is the only place
    // the scroll-lock controller sees the gesture.
    if (onWheelScroll) onWheelScroll(ev);

    let forwardToApp = alwaysForwardWheel;
    if (!forwardToApp) {
      try { forwardToApp = !!(term.getMode(1000) || term.getMode(1002) || term.getMode(1003)); }
      catch { forwardToApp = false; }
    }

    if (forwardToApp) {
      _mouseModeScrollAccum += ev.deltaY;
      const lines = Math.trunc(_mouseModeScrollAccum / MOUSE_MODE_THRESHOLD);
      if (lines === 0) return true; // accumulate more before emitting
      _mouseModeScrollAccum -= lines * MOUSE_MODE_THRESHOLD;
      const btn = lines > 0 ? 65 : 64;
      const seq = `\x1b[<${btn};1;1M`;
      const encoded = new TextEncoder().encode(seq);
      const count = Math.min(Math.abs(lines), 5);
      for (let i = 0; i < count; i++) {
        if (canAcceptInput()) sendInput(encoded);
      }
      return true;
    }

    // Client-side scrollback. Accumulate pixel delta until it crosses one
    // char-row, then dispatch `term.scrollLines(±N)` directly with an
    // integer. This bypasses ghostty's wheel handler entirely so we never
    // reach the smoothScrollTo path that converges to a fractional viewportY.
    const metrics = term.renderer && typeof term.renderer.getMetrics === "function"
      ? term.renderer.getMetrics()
      : null;
    const charHeight = metrics && metrics.height > 0 ? metrics.height : 17;
    _clientScrollAccum += ev.deltaY;
    const lines = Math.trunc(_clientScrollAccum / charHeight);
    if (lines === 0) return true; // consume + accumulate, don't let ghostty smooth-scroll
    _clientScrollAccum -= lines * charHeight;
    // term.scrollLines(A) sets viewportY := viewportY - A. Positive deltaY
    // (scroll down) shrinks viewportY toward 0; negative deltaY grows it
    // into scrollback. Sign matches.
    if (typeof term.scrollLines === "function") term.scrollLines(lines);
    return true;
  });

  // Stdin forwarding
  let _terminalInputAccepted = false;
  term.onData((data) => {
    if (canAcceptInput()) {
      if (!_terminalInputAccepted) {
        _terminalInputAccepted = true;
        __wfTraceEvent(trace, "first.input.accepted", { source: "onData" });
      }
      sendInput(new TextEncoder().encode(data));
    }
  });
  if (term.onBinary) {
    term.onBinary((data) => {
      if (canAcceptInput()) {
        if (!_terminalInputAccepted) {
          _terminalInputAccepted = true;
          __wfTraceEvent(trace, "first.input.accepted", { source: "onBinary" });
        }
        const buf = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) buf[i] = data.charCodeAt(i) & 0xff;
        sendInput(buf);
      }
    });
  }

  // Resize forwarding (debounced to prevent resize storms). Controlled
  // terminal instances disable this path because their controller calls
  // sendFitResize() after fit(); forwarding both doubles backend resize churn.
  let _termResizeTimer = null;
  if (forwardResizeEvents) {
    term.onResize(({ cols, rows }) => {
      if (!shouldSendResize()) return;
      if (_termResizeTimer) clearTimeout(_termResizeTimer);
      _termResizeTimer = setTimeout(() => {
        _termResizeTimer = null;
        if (shouldSendResize()) sendMessage(JSON.stringify({ type: "resize", cols, rows }));
      }, RESIZE_SEND_DEBOUNCE_MS);
    });
  }

  return { term, fitAddon };
}
const DESKTOP_INITIAL_PREFILL_TIMEOUT_MS = 1000;
const PREFILL_PROTOCOL_TIMEOUT_MS = 15_000;
const INITIAL_HYDRATION_SETTLE_MS = 16;
const INITIAL_HYDRATION_SILENCE_MS = 32;

/**
 * Shared hydration controller for ghostty-web terminals.
 * Owns: pending state, timeout fallback, visibility reveal, scrollToBottom,
 * optional focus, and a short quiet-period debounce so initial history bursts
 * can settle before the terminal becomes visible.
 *
 * `minPendingMs` floor: workaround for the post-attach resize-redraw flash
 * (see comment at the call site for the full root-cause writeup). When set,
 * `finish()` won't reveal the canvas until at least this many ms have
 * elapsed since `start()`, even if the settle/canFinish conditions are met.
 * This keeps the canvas hidden during the gap between prefill_done and the
 * arrival of the resize-induced redraw stream that follows it.
 *
 */

interface InitialHydrationControllerOpts {
  getElement: () => HTMLElement | null;
  getTerm: () => GhosttyTerminal | null;
  shouldFocus: () => boolean;
  isInitialContentComplete?: () => boolean;
  canFinish?: () => boolean;
  onReveal?: () => void;
  timeoutMs?: number;
  settleMs?: number;
  maxPendingMs?: number;
  minPendingMs?: number;
  silenceMs?: number;
  session?: string | null;
  machine?: string;
}

function createInitialHydrationController(opts: InitialHydrationControllerOpts): InitialHydrationController {
  let _pending = false;
  let _fallbackTimer = null;
  let _settleTimer = null;
  let _startedAt = 0;
  // Last time data arrived at the terminal. Reveal is gated on N ms of
  // silence after the most recent write — catches late-arriving SIGWINCH
  // redraws after grid attach (server coalesces these into single big
  // writes; without the silence gate, canvas reveals BEFORE the redraw
  // arrives and the user sees the post-snapshot burst paint).
  let _lastDataAt = 0;
  const timeoutMs = opts.timeoutMs || DESKTOP_INITIAL_PREFILL_TIMEOUT_MS;
  const settleMs = opts.settleMs || 80;
  const maxPendingMs = opts.maxPendingMs || 4000;
  const minPendingMs = opts.minPendingMs || 0;
  // Min silence (no data writes) before reveal. 0 = disabled (legacy behavior).
  const silenceMs = opts.silenceMs || 0;
  // Diag: trace key for emitting hydration milestones into the per-attach
  // event log. Pure-passthrough; falsy when caller didn't wire it up.
  const _diagSession = opts.session || null;
  const _diagMachine = opts.machine || "";
  function _diagEvent(kind: string, fields?: Record<string, unknown>): void {
    if (!_diagSession) return;
    __wfTraceEvent(__wfTraceGet(_diagSession, _diagMachine), kind, fields);
  }

  function finish(force = false) {
    if (!_pending) return;
    // minPendingMs floor: keep canvas hidden through the post-prefill
    // resize-redraw burst (~150-300ms after prefill_done). See call site.
    const elapsed = Date.now() - _startedAt;
    if (!force && minPendingMs > 0 && elapsed < minPendingMs) {
      if (_settleTimer) clearTimeout(_settleTimer);
      _settleTimer = setTimeout(finish, Math.max(settleMs, minPendingMs - elapsed));
      _diagEvent("hydration.holdMinPending", { elapsed, minPendingMs });
      return;
    }
    // silenceMs: stay hidden until last data write was at least silenceMs ago.
    // Captures the post-attach SIGWINCH redraw burst (server coalesces it into
    // ~1 ws frame, but it can arrive 100-300ms AFTER prefill_done). Without
    // this, canvas reveals empty/partial and the burst paints visibly.
    if (!force && silenceMs > 0 && _lastDataAt > 0) {
      const sinceLastData = Date.now() - _lastDataAt;
      if (sinceLastData < silenceMs && elapsed < maxPendingMs) {
        if (_settleTimer) clearTimeout(_settleTimer);
        _settleTimer = setTimeout(finish, silenceMs - sinceLastData);
        _diagEvent("hydration.holdSilence", { sinceLastData, silenceMs });
        return;
      }
    }
    // Protocol completion is a hard reveal gate. maxPendingMs may override
    // write quiescence below, but must never expose a partial full prefill.
    if (!force && opts.isInitialContentComplete && !opts.isInitialContentComplete()) {
      if (_settleTimer) { clearTimeout(_settleTimer); _settleTimer = null; }
      _diagEvent("hydration.holdInitialContent", { elapsed });
      return;
    }
    if (!force && opts.canFinish && !opts.canFinish()) {
      if (elapsed >= maxPendingMs) {
        // Safety valve: avoid infinite loader on very high-throughput sessions.
        _diagEvent("hydration.maxPendingHit", { elapsed });
      } else {
        if (_settleTimer) clearTimeout(_settleTimer);
        _settleTimer = setTimeout(finish, settleMs);
        _diagEvent("hydration.holdCanFinish", { elapsed });
        return;
      }
    }
    _pending = false;
    if (_fallbackTimer) { clearTimeout(_fallbackTimer); _fallbackTimer = null; }
    if (_settleTimer) { clearTimeout(_settleTimer); _settleTimer = null; }
    const term = opts.getTerm();
    if (term) {
      // Keep terminal hidden while positioning to avoid visible top->bottom jump.
      try { term.scrollToBottom(); } catch {}
    }
    _diagEvent("hydration.finish", { elapsed });
    requestAnimationFrame(() => {
      if (!_pending) {
        const el = opts.getElement();
        if (el) {
          el.classList.remove("hydrating");
          el.classList.add("hydrated");
        }
        if (term && opts.shouldFocus()) term.focus();
        // ghostty-web's dirty-cell tracking may think it already painted while
        // the canvas was hidden (opacity:0 during hydration). Force a full
        // canvas repaint so the revealed terminal isn't stale/blank.
        if (opts.onReveal) opts.onReveal();
        _diagEvent("hydration.reveal");
      }
    });
  }

  function start() {
    _pending = true;
    _startedAt = Date.now();
    if (_fallbackTimer) clearTimeout(_fallbackTimer);
    if (_settleTimer) { clearTimeout(_settleTimer); _settleTimer = null; }
    _fallbackTimer = setTimeout(finish, timeoutMs);
    _diagEvent("hydration.start", { minPendingMs, silenceMs, timeoutMs });
  }

  function scheduleFinish() {
    if (!_pending) return;
    if (_settleTimer) clearTimeout(_settleTimer);
    _settleTimer = setTimeout(finish, settleMs);
  }

  // Notify the controller that data arrived (resets silence clock). Caller
  // wires this to onBinaryData so even non-hydrating writes (which don't
  // bump _hydrationWritesInFlight) keep the canvas hidden until quiet.
  function notifyData() {
    _lastDataAt = Date.now();
    if (_pending && _settleTimer) {
      clearTimeout(_settleTimer);
      _settleTimer = setTimeout(finish, settleMs);
    }
  }

  function forceFinish() {
    finish(true);
  }

  function cancel() {
    _pending = false;
    if (_fallbackTimer) { clearTimeout(_fallbackTimer); _fallbackTimer = null; }
    if (_settleTimer) { clearTimeout(_settleTimer); _settleTimer = null; }
  }

  return {
    get pending() { return _pending; },
    start,
    scheduleFinish,
    notifyData,
    finish,
    forceFinish,
    cancel,
  };
}
/**
 * Shared PTY WebSocket client for ghostty-web terminals.
 * Owns: URL construction, socket lifecycle, binary/text frame dispatch,
 *       initial attach handshake, reconnect backoff, control message parsing.
 * @param {object} opts
 * @param {string} opts.session - broker session name
 * @param {string} opts.machine - remote machine URL ("" for local)
 * @param {boolean} [opts.resetPty] - append &reset=1 on first connect
 * @param {string} [opts.prefillMode] - "full" (default), "viewport", or "none"
 * @param {() => {cols:number, rows:number}|null} opts.getTermDimensions
 * @param {() => void} opts.fitTerminal
 * @param {(Uint8Array) => void} opts.onBinaryData
 * @param {() => void} [opts.onAttach]
 * @param {() => void} [opts.onOpen]
 * @param {() => void} [opts.onPtyReady]
 * @param {() => void} [opts.onPrefillDone]
 * @param {() => void} [opts.onViewerConflict]
 * @param {() => void} [opts.onControlGranted]
 * @param {(parentSession: string, session: string) => void} [opts.onSubSessionOpened]
 * @param {() => void} [opts.onReplacePrefill]
 * @param {(number, string) => void} opts.onDisconnected
 * @param {() => void} [opts.onReconnecting]
 * @param {() => void} [opts.onReconnectExhausted]
 * @param {() => boolean} [opts.shouldReconnect]
 */
interface TermDimensions {
  readonly cols: number;
  readonly rows: number;
}

interface TerminalLayoutMetrics {
  readonly containerWidth: number;
  readonly containerClientWidth: number;
  readonly viewportWidth: number;
}

interface PtySocketClientOpts {
  readonly session: string;
  readonly machine?: string;
  readonly resetPty?: boolean;
  readonly prefillMode?: LayoutStablePrefillMode;
  readonly takeControlOnAttach?: boolean;
  readonly getTermDimensions: () => TermDimensions | null;
  readonly getLayoutMetrics?: () => TerminalLayoutMetrics | null;
  readonly fitTerminal: () => void;
  readonly onBinaryData?: (data: Uint8Array) => void;
  readonly onAttach?: () => void;
  readonly onOpen?: (wasReconnect: boolean) => void;
  readonly onPtyReady?: () => void;
  readonly onPrefillDone?: () => void;
  readonly onViewerConflict?: () => void;
  readonly onControlGranted?: () => void;
  readonly onSubSessionOpened?: (parentSession: string, session: string) => void;
  readonly onReplacePrefill?: () => void;
  readonly onDisconnected?: (code: number, reason: string) => void;
  readonly onReconnecting?: () => void;
  readonly onReconnectExhausted?: () => void;
  readonly shouldReconnect?: () => boolean;
}

interface PtySocketClient {
  connect(): void;
  reconnect(reconnectOpts?: { readonly takeControl?: boolean }): void;
  scheduleReconnect(): void;
  sendFitResize(options?: { readonly force?: boolean; readonly fit?: boolean }): void;
  sendResize(cols: number, rows: number): void;
  sendTakeControl(): void;
  send(data: string | Blob | BufferSource): void;
  close(): void;
  resetRetry(): void;
  readonly ws: WebSocket | null;
  readonly isOpen: boolean;
  readonly retryBlocked: boolean;
}

function createPtySocketClient(opts: PtySocketClientOpts): PtySocketClient {
  let ws: WebSocket | null = null;
  const _rc = createReconnector({
    shouldReconnect: opts.shouldReconnect,
    onReconnecting: opts.onReconnecting,
    onExhausted: opts.onReconnectExhausted,
  });
  let hasConnected = false;
  let consumeReset = !!opts.resetPty;
  let _initialPrefillMode = opts.prefillMode || TERMINAL_PREFILL_MODE.FULL;
  let _attachAckTimer = null;
  let _attachAckReceived = false;
  let _awaitingAttachAck = false;
  let _prefillChunks: Uint8Array[] = [];
  let _awaitingPrefillDone = false;
  let _sawViewportPrefill = false;
  let _currentAttachPrefillMode = _initialPrefillMode;
  let _prefillDoneTimeout = null;
  let _attachDimensionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let _attachDimensionRetryAttempt = 0;
  const _layoutStableDebugMode = resolveLayoutStableDebugMode(safeLocalStorage(), wfTraceEnabled);
  // Diagnostic tracer (scrolldown investigation). Created per attach in
  // sendAttachHandshake. Read via window.__wf_dumpTrace().
  let _trace: TraceState | null = null;

  function buildUrl() {
    const resetSuffix = consumeReset ? "&reset=1" : "";
    consumeReset = false;
    const session = encodeURIComponent(opts.session);
    if (opts.machine) {
      const remote = new URL(opts.machine);
      const proto = remote.protocol === "https:" ? "wss:" : "ws:";
      return proto + "//" + remote.host + "/ws/pty?session=" + session + resetSuffix;
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + location.host + "/ws/pty?session=" + session + resetSuffix;
  }

  /** Send one attach handshake to bootstrap PTY spawn on fresh WS open. */
  let _takeControlOnAttach = !!opts.takeControlOnAttach;

  function sendAttachHandshake() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { opts.fitTerminal(); } catch {}
    const dims = opts.getTermDimensions();
    const dimensionAction = WP.nextAttachDimensionAction(
      dims,
      _attachDimensionRetryAttempt,
      ATTACH_DIMENSION_MAX_ATTEMPTS,
    );
    if (dimensionAction.kind === "retry") {
      _attachDimensionRetryAttempt = dimensionAction.nextAttempt;
      if (!_attachDimensionRetryTimer) {
        _attachDimensionRetryTimer = setTimeout(() => {
          _attachDimensionRetryTimer = null;
          sendAttachHandshake();
        }, ATTACH_DIMENSION_RETRY_DELAY_MS);
      }
      return;
    }
    if (dimensionAction.kind === "fail") {
      ws.close(WP.CLOSE_CODE_SERVER_ERROR, "attach dimensions unavailable");
      return;
    }
    _attachDimensionRetryAttempt = 0;
    const attachDims = dims;
    if (!attachDims) return;
    if (_prefillDoneTimeout) { clearTimeout(_prefillDoneTimeout); _prefillDoneTimeout = null; }
    if (opts.onAttach) opts.onAttach();
    const prefillMode = _initialPrefillMode;
    _currentAttachPrefillMode = prefillMode;
    _lastSentResize = attachDims.cols + "x" + attachDims.rows;
    _awaitingAttachAck = true;
    _attachAckReceived = false;
    _prefillChunks = [];
    _awaitingPrefillDone = prefillMode !== TERMINAL_PREFILL_MODE.NONE;
    _sawViewportPrefill = false;
    const msg: { type: "attach"; cols: number; rows: number; prefillMode: string; takeControl?: true } = { type: "attach", cols: attachDims.cols, rows: attachDims.rows, prefillMode };
    if (_takeControlOnAttach) { msg.takeControl = true; _takeControlOnAttach = false; }
    // Diag: start a fresh trace per attach so reconnects/take-controls show up
    // as separate sessions in the dump.
    _trace = __wfTraceGet(opts.session, opts.machine || "") || __wfTraceStart(opts.session, opts.machine || "", {
      cols: attachDims.cols, rows: attachDims.rows, prefillMode,
      takeControl: !!msg.takeControl, reset: !!opts.resetPty,
    });
    const layoutMetrics = opts.getLayoutMetrics?.() ?? null;
    __wfTraceEvent(_trace, "attach.send", {
      ...(layoutMetrics ?? {}),
      cols: attachDims.cols,
      rows: attachDims.rows,
      prefillMode,
      layoutStableDebugMode: _layoutStableDebugMode,
    });
    __wfTraceRafStart(_trace);
    if (prefillMode !== TERMINAL_PREFILL_MODE.NONE) {
      const attachedSocket = ws;
      _prefillDoneTimeout = setTimeout(() => {
        _prefillDoneTimeout = null;
        if (!_awaitingPrefillDone || ws !== attachedSocket || attachedSocket.readyState !== WebSocket.OPEN) return;
        __wfTraceEvent(_trace, "prefill.timeout", { timeoutMs: PREFILL_PROTOCOL_TIMEOUT_MS });
        attachedSocket.close(WP.CLOSE_CODE_PREFILL_TIMEOUT, WP.WS_CLOSE_REASONS.PREFILL_TIMEOUT);
      }, PREFILL_PROTOCOL_TIMEOUT_MS);
    }
    ws.send(JSON.stringify(msg));
    if (shouldSendImmediateLayoutStable(_layoutStableDebugMode, prefillMode)) {
      sendLayoutStable("immediate");
    }
    if (_attachAckTimer) clearTimeout(_attachAckTimer);
    // Compatibility fallback: older servers don't implement attach_ack.
    _attachAckTimer = setTimeout(() => {
      _attachAckTimer = null;
      if (_attachAckReceived) return;
      if (!_awaitingAttachAck) return;
      _awaitingAttachAck = false;
      _lastSentResize = "";
      sendFitResize();
    }, 300);
  }

  function sendLayoutStable(reason: "after-paint" | "immediate" = "after-paint"): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { opts.fitTerminal(); } catch {}
    const dims = opts.getTermDimensions();
    if (!dims) return;
    const key = dims.cols + "x" + dims.rows;
    if (key !== _lastSentResize) {
      _lastSentResize = key;
      ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
    }
    ws.send(JSON.stringify({ type: "layout_stable", cols: dims.cols, rows: dims.rows, reason }));
    const layoutMetrics = opts.getLayoutMetrics?.() ?? null;
    __wfTraceEvent(_trace, "layout_stable.send", {
      ...(layoutMetrics ?? {}),
      cols: dims.cols,
      rows: dims.rows,
      reason,
    });
  }

  function sendLayoutStableAfterPaint(): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { sendLayoutStable("after-paint"); });
    });
  }

  /** Fit terminal + send resize dimensions over the socket (debounced). */
  let _lastSentResize = "";
  let _resizeDebounceTimer = null;
  function sendFitResize(options?: { force?: boolean; fit?: boolean }) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (options?.fit !== false) {
      try { opts.fitTerminal(); } catch {}
    }
    const dims = opts.getTermDimensions();
    if (!dims) return;
    const key = dims.cols + "x" + dims.rows;
    if (!options?.force && key === _lastSentResize) return; // same dimensions, skip
    // Debounce: collapse rapid resize calls into one
    if (_resizeDebounceTimer) clearTimeout(_resizeDebounceTimer);
    _resizeDebounceTimer = setTimeout(() => {
      _resizeDebounceTimer = null;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const d = opts.getTermDimensions();
      if (!d) return;
      const nextKey = d.cols + "x" + d.rows;
      if (!options?.force && nextKey === _lastSentResize) return;
      const msg = JSON.stringify({ type: "resize", cols: d.cols, rows: d.rows });
      _lastSentResize = nextKey;
      ws.send(msg);
    }, RESIZE_SEND_DEBOUNCE_MS);
  }

  type SocketControlMessage = Readonly<Record<string, unknown>> & { readonly type: string };
  type SocketControlHandler = (message: SocketControlMessage) => void;

  function handleAttachAck(): void {
    __wfTraceEvent(_trace, "attach_ack");
    _attachAckReceived = true;
    _awaitingAttachAck = false;
    if (_attachAckTimer) { clearTimeout(_attachAckTimer); _attachAckTimer = null; }
    // Re-check dimensions after layout settles — catches stale initial dims on
    // mobile where layout isn't finalized at connect time. Same-dimension acks
    // are skipped to avoid a duplicate resize cycle immediately after attach.
    sendLayoutStableAfterPaint();
  }

  function handlePtyReady(): void {
    __wfTraceEvent(_trace, "pty_ready");
    if (opts.onPtyReady) opts.onPtyReady();
  }

  function handlePrefillViewport(): void {
    // Phase 1 complete: viewport content already written as binary.
    const viewportChunks = _prefillChunks;
    _prefillChunks = [];
    const viewportBytes = viewportChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    __wfTraceEvent(_trace, "prefill_viewport", {
      viewportFrames: viewportChunks.length,
      viewportBytes,
    });
    if (opts.onBinaryData) {
      for (const chunk of viewportChunks) opts.onBinaryData(chunk);
    }
    // Stay in prefill mode for phase 2 scrollback (if server sends it). Keep
    // buffering until the authoritative prefill_done boundary. The attach-level
    // protocol deadline closes/reconnects rather than revealing partial output.
    _awaitingPrefillDone = true;
    _sawViewportPrefill = true;
  }

  function handlePrefillDone(): void {
    // Phase 2 complete (or single-phase legacy): flush remaining chunks.
    _awaitingPrefillDone = false;
    if (_prefillDoneTimeout) { clearTimeout(_prefillDoneTimeout); _prefillDoneTimeout = null; }
    const chunks = _prefillChunks;
    _prefillChunks = [];
    const bufferedBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    __wfTraceEvent(_trace, "prefill_done", {
      bufferedFrames: chunks.length,
      bufferedBytes,
      sawViewportPrefill: _sawViewportPrefill,
    });
    if (_sawViewportPrefill && chunks.length && opts.onReplacePrefill) {
      opts.onReplacePrefill();
    }
    _sawViewportPrefill = false;
    if (opts.onBinaryData) {
      for (const chunk of chunks) opts.onBinaryData(chunk);
    }
    if (opts.onPrefillDone) opts.onPrefillDone();
  }

  function handleViewerConflict(): void {
    __wfTraceEvent(_trace, "viewer_conflict");
    console.log("[pty-ws]", opts.session, "viewer_conflict");
    _awaitingAttachAck = false;
    _awaitingPrefillDone = false;
    _prefillChunks = [];
    _sawViewportPrefill = false;
    if (_prefillDoneTimeout) { clearTimeout(_prefillDoneTimeout); _prefillDoneTimeout = null; }
    if (_attachAckTimer) { clearTimeout(_attachAckTimer); _attachAckTimer = null; }
    if (opts.onViewerConflict) opts.onViewerConflict();
  }

  function handleControlGranted(): void {
    __wfTraceEvent(_trace, "control_granted");
    console.log("[pty-ws]", opts.session, "control_granted — sending re-attach");
    // Fresh viewer takeover needs a fresh attach bootstrap.
    sendAttachHandshake();
    if (opts.onControlGranted) opts.onControlGranted();
  }

  function handleSubSessionOpened(message: SocketControlMessage): void {
    if (typeof message.parentSession !== "string" || typeof message.session !== "string") return;
    if (opts.onSubSessionOpened) opts.onSubSessionOpened(message.parentSession, message.session);
  }

  const terminalControlHandlers: Readonly<Record<string, SocketControlHandler>> = {
    attach_ack: handleAttachAck,
    pty_ready: handlePtyReady,
    prefill_viewport: handlePrefillViewport,
    prefill_done: handlePrefillDone,
    viewer_conflict: handleViewerConflict,
    control_granted: handleControlGranted,
  };
  const applicationControlHandlers: Readonly<Record<string, SocketControlHandler>> = {
    sub_session_opened: handleSubSessionOpened,
  };

  function handleTextFrame(raw: string): void {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const message = parsed as Readonly<Record<string, unknown>>;
      if (typeof message.type !== "string") return;
      const typedMessage = message as SocketControlMessage;
      const handler = terminalControlHandlers[typedMessage.type] ?? applicationControlHandlers[typedMessage.type];
      if (handler) handler(typedMessage);
    } catch (error: unknown) {
      console.warn("[pty-ws] failed to handle control message:", error);
    }
  }

  function handleBinaryFrame(data: ArrayBuffer): void {
    if (_awaitingPrefillDone) {
      const bytes = new Uint8Array(data);
      if (_prefillChunks.length === 0) __wfTraceEvent(_trace, "prefill.first_chunk", { size: bytes.length });
      const streamHiddenFullPrefill = _currentAttachPrefillMode === TERMINAL_PREFILL_MODE.FULL && !_sawViewportPrefill;
      __wfTraceEvent(_trace, "ws.binary", {
        bucket: "prefill",
        size: bytes.length,
        buffered: streamHiddenFullPrefill ? 0 : _prefillChunks.length + 1,
      });
      if (streamHiddenFullPrefill) {
        if (opts.onBinaryData) opts.onBinaryData(bytes);
        return;
      }
      _prefillChunks.push(bytes);
      return;
    }
    const bytes = new Uint8Array(data);
    __wfTraceEvent(_trace, "ws.binary", { bucket: "replay", size: bytes.length });
    if (opts.onBinaryData) opts.onBinaryData(bytes);
  }

  function connect() {
    _rc.cancel();
    if (ws && ws.readyState <= WebSocket.OPEN) return;

    const sock = new WebSocket(buildUrl());
    sock.binaryType = "arraybuffer";
    ws = sock;

    sock.onopen = () => {
      console.log("[pty-ws]", opts.session, "ws.onopen, readyState=", sock.readyState);
      const wasReconnect = hasConnected;
      hasConnected = true;
      _rc.connected();
      sendAttachHandshake();
      // attach trace was created inside sendAttachHandshake above
      __wfTraceEvent(_trace, "ws.open", { wasReconnect });
      if (opts.onOpen) opts.onOpen(wasReconnect);
    };

    sock.onmessage = (event) => {
      if (typeof event.data === "string") {
        handleTextFrame(event.data);
        return;
      }
      handleBinaryFrame(event.data as ArrayBuffer);
    };

    sock.onclose = (ev) => {
      // Ignore stale close events from sockets replaced by reconnect().
      if (ws !== sock) return;
      __wfTraceEvent(_trace, "ws.close", { code: ev.code, reason: String(ev.reason || "") });
      __wfTraceRafStop(_trace);
      ws = null;
      _awaitingAttachAck = false;
      _awaitingPrefillDone = false;
      _prefillChunks = [];
      _sawViewportPrefill = false;
      if (_prefillDoneTimeout) { clearTimeout(_prefillDoneTimeout); _prefillDoneTimeout = null; }
      if (_attachAckTimer) { clearTimeout(_attachAckTimer); _attachAckTimer = null; }
      if (opts.onDisconnected) opts.onDisconnected(ev.code, ev.reason);
    };

    sock.onerror = () => {};
  }

  function scheduleReconnect() {
    _rc.schedule(() => {
      if (!ws || ws.readyState === WebSocket.CLOSED) connect();
    });
  }

  function sendResize(cols: number, rows: number): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  }

  function sendTakeControl() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "take_control" }));
    }
  }

  function send(data: string | Blob | BufferSource): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (typeof data === "string" || data instanceof Blob) {
      ws.send(data);
      return;
    }
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    for (const frame of WP.splitTerminalInputBytes(bytes)) {
      const copy = new ArrayBuffer(frame.byteLength);
      new Uint8Array(copy).set(frame);
      ws.send(copy);
    }
  }

  function close() {
    if (_attachDimensionRetryTimer) {
      clearTimeout(_attachDimensionRetryTimer);
      _attachDimensionRetryTimer = null;
    }
    _rc.cancel();
    _rc.block();
    _awaitingAttachAck = false;
    _awaitingPrefillDone = false;
    _prefillChunks = [];
    _sawViewportPrefill = false;
    if (_prefillDoneTimeout) { clearTimeout(_prefillDoneTimeout); _prefillDoneTimeout = null; }
    if (_attachAckTimer) { clearTimeout(_attachAckTimer); _attachAckTimer = null; }
    if (ws) { ws.close(); ws = null; }
  }

  function resetRetry() {
    _rc.reset();
  }

  // Force-close a potentially zombie socket and reconnect. iOS/Android background
  // tabs kill TCP silently while readyState still reports OPEN — connect() guards
  // against this and bails. reconnect() bypasses that guard. See PR #89 review / df4180c.
  function reconnect(reconnectOpts?: { takeControl?: boolean }) {
    _rc.cancel();
    _awaitingAttachAck = false;
    _awaitingPrefillDone = false;
    _prefillChunks = [];
    _sawViewportPrefill = false;
    if (_prefillDoneTimeout) { clearTimeout(_prefillDoneTimeout); _prefillDoneTimeout = null; }
    if (_attachAckTimer) { clearTimeout(_attachAckTimer); _attachAckTimer = null; }
    _takeControlOnAttach = !!(reconnectOpts && reconnectOpts.takeControl);
    if (ws) { try { ws.close(); } catch {} ws = null; }
    connect();
  }

  return {
    connect,
    reconnect,
    scheduleReconnect,
    sendFitResize,
    sendResize,
    sendTakeControl,
    send,
    close,
    resetRetry,
    get ws() { return ws; },
    get isOpen() { return !!(ws && ws.readyState === WebSocket.OPEN); },
    get retryBlocked() { return _rc.isBlocked; },
  };
}

/**
 * createPtyTerminalController — composes terminal, hydration, and WebSocket
 * helpers into a single PTY terminal lifecycle controller.
 *
 * @param {object} opts
 * @param {string} opts.session - broker session name
 * @param {string} [opts.machine=""] - remote machine URL ("" for local)
 * @param {number} [opts.fontSize] - override font size
 * @param {number} opts.scrollback - terminal scrollback lines
 * @param {boolean} [opts.cursorBlink=true]
 * @param {boolean} [opts.disableStdin=false]
 * @param {() => boolean} [opts.shouldFocus] - hydration focus decision
 * @param {number} [opts.hydrationTimeoutMs] - hydration reveal timeout
 * @param {() => HTMLElement|null} [opts.getHydrationElement] - element to show/hide for hydration (defaults to mount container)
 * @param {boolean} [opts.resetPty] - append &reset=1 on first connect
 * @param {string} [opts.prefillMode] - "full" (default), "viewport", or "none"
 * @param {() => boolean} [opts.shouldReconnect] - guard for reconnect attempts
 * @param {() => boolean} [opts.canAcceptInput] - override stdin guard (default: ptyClient.isOpen)
 * @param {() => boolean} [opts.canSendResize] - override resize guard (default: canAcceptInput)
 * @param {(Uint8Array) => void} [opts.onOutput] - called after data written to term
 */

interface PtyTerminalControllerOpts {
  readonly session: string;
  readonly machine?: string;
  readonly fontSize?: number;
  readonly scrollback?: number;
  readonly cursorBlink?: boolean;
  readonly disableStdin?: boolean;
  readonly resetPty?: boolean;
  readonly prefillMode?: LayoutStablePrefillMode;
  readonly hydrationTimeoutMs?: number;
  readonly hydrationMinPendingMs?: number;
  readonly hydrationSettleMs?: number;
  readonly hydrationSilenceMs?: number;
  readonly shouldFocus?: () => boolean;
  readonly shouldReconnect?: () => boolean;
  readonly canAcceptInput?: () => boolean;
  readonly canSendResize?: () => boolean;
  readonly getHydrationElement?: () => HTMLElement | null;
  readonly onOpen?: (wasReconnect: boolean) => void;
  readonly onPtyReady?: () => void;
  readonly onOutput?: (data: Uint8Array) => void;
  readonly onViewerConflict?: () => void;
  readonly onControlGranted?: () => void;
  readonly onSubSessionOpened?: (parentSession: string, session: string) => void;
  readonly onDisconnected?: (code: number, reason: string) => void;
  readonly onReconnecting?: () => void;
  readonly onReconnectExhausted?: () => void;
  readonly onHydrationStart?: () => void;
  readonly onHydrated?: () => void;
}
interface InitialHydrationController {
  readonly pending: boolean;
  start(): void;
  scheduleFinish(): void;
  notifyData(): void;
  finish(): void;
  forceFinish(): void;
  cancel(): void;
}

interface PtyTerminalController {
  mount(container: HTMLElement, mountOpts?: { readonly cached?: string | null }): Promise<void>;
  connect(connectOpts?: { readonly takeControl?: boolean }): void;
  focus(): void;
  scrollToBottom(): void;
  resize(): void;
  dispose(): void;
  scheduleReconnect(): void;
  sendTakeControl(): void;
  sendFitResize(options?: { readonly force?: boolean; readonly fit?: boolean }): void;
  forceRepaint(): void;
  syncLayout(options?: { readonly forceSend?: boolean; readonly repaint?: boolean; readonly reason?: string }): void;
  send(data: string | Blob | BufferSource): void;
  resetRetry(): void;
  reconnect(reconnectOpts?: { readonly takeControl?: boolean }): void;
  readonly term: GhosttyTerminal | null;
  readonly fitAddon: GhosttyFitAddon | null;
  readonly ptyClient: PtySocketClient | null;
  readonly hydration: InitialHydrationController | null;
  readonly isConnected: boolean;
  readonly retryBlocked: boolean;
}

function createPtyTerminalController(opts: PtyTerminalControllerOpts): PtyTerminalController {
  let _container = null;
  let _term = null;
  let _fitAddon = null;
  let _hydration = null;
  let _ptyClient = null;
  let _hydrationStarted = false;
  let _hydrationWritesInFlight = 0;
  let _initialPrefillComplete = opts.prefillMode === TERMINAL_PREFILL_MODE.NONE;
  let _connectEpoch = 0;
  let _reconnectPendingReset = false;
  let _replacementPrefillPending = false;
  let _postResetBuffer: Uint8Array[] | null = null;
  let _mounting = false;
  let _userScrolledUp = false;
  let _userRequestedScrollback = false;
  // Scrollback length snapshot captured when user enters scroll-lock. Used by
  // the patched scrollToBottom to compute per-write scrollback growth and bump
  // viewportY accordingly, so the visible window stays anchored to the same
  // absolute rows as new output streams in. -1 = no baseline (not scroll-locked).
  let _lastScrollbackLength = -1;
  let _scrollLockKeydownHandler = null;
  let _browserShortcutKeydownHandler = null;
  let _resizeObserver = null;
  let _layoutSyncRaf = null;
  let _resizeRehydrateTimer = null;
  let _pendingResizeScrollRestore: { oldScrollbackLength: number; oldViewportY: number } | null = null;
  let _firstFitSeen = false;
  let _firstInputAccepted = false;

  const _canAcceptInput = opts.canAcceptInput || (() => !!(_ptyClient && _ptyClient.isOpen));
  const _canSendResize = opts.canSendResize || _canAcceptInput;
  const _getHydrationElement = opts.getHydrationElement || (() => _container);

  /** Full terminal reset, then flush buffered writes next frame.
   *  reset() wipes both viewport and scrollback — clear() only wiped
   *  scrollback and preserved the cursor line, which caused duplicate
   *  content on reconnect (banner replayed over leftover viewport) and
   *  broken scrollback history (cursor pinned at bottom of old viewport).
   *  Canvas is hidden across the rAF gap so the brief blank frame from
   *  reset() isn't visible. Writes are deferred because ghostty-web WASM
   *  crashes with "memory access out of bounds" if write() follows
   *  reset()/clear() in the same tick. */
  function _scheduleBufferedClear() {
    if (!_postResetBuffer) _postResetBuffer = [];
    const canvas = _container ? _container.querySelector('canvas') : null;
    if (canvas) canvas.style.visibility = 'hidden';
    _term.reset();
    requestAnimationFrame(() => {
      if (!_term || !_postResetBuffer) {
        if (canvas) canvas.style.visibility = '';
        return;
      }
      const buf = _postResetBuffer;
      _postResetBuffer = null;
      for (const chunk of buf) _writeTermData(chunk);
      // Restore — fresh data is now in the buffer, safe to show.
      if (canvas) canvas.style.visibility = '';
    });
  }

  function _writeTermData(data: Uint8Array) {
    if (!_term) return;
    // Diag: capture wasm OOB on first crash so we can inspect bytes/dims
    // post-mortem via window.__wf_lastCrash. No behavioral change.
    const _diagTrace = __wfTraceGet(opts.session, opts.machine || "");
    const _diagPending = !!(_hydration && _hydration.pending);
    __wfTraceEvent(_diagTrace, "_writeTermData", { size: data.length, hydrating: _diagPending });
    // Notify hydration controller so the silenceMs gate sees this write
    // even when we're not in the hydrating-with-callback branch.
    if (_hydration) _hydration.notifyData();
    try {
      if (_hydration && _hydration.pending) {
        const writeEpoch = _connectEpoch;
        _hydrationWritesInFlight++;
        _term.write(data, () => {
          // Ignore stale callbacks from a prior connect/dispose epoch.
          if (writeEpoch !== _connectEpoch) return;
          _hydrationWritesInFlight = Math.max(0, _hydrationWritesInFlight - 1);
          __wfTraceEvent(_diagTrace, "term.writeDone", { size: data.length, inFlight: _hydrationWritesInFlight });
          if (_hydration) _hydration.scheduleFinish();
          if (opts.onOutput) opts.onOutput(data);
        });
      } else {
        _term.write(data);
        if (opts.onOutput) opts.onOutput(data);
      }
    } catch (err) {
      captureLastCrash({
        session: opts.session,
        cols: _term ? _term.cols : null,
        rows: _term ? _term.rows : null,
        data,
        err,
      });
      throw err;
    }
  }

  function fitTerminalPreserveScroll() {
    if (!_fitAddon || !_term) return;
    const trace = __wfTraceGet(opts.session, opts.machine || "");
    // ghostty-web semantics: scrollToLine(A) clamps A to [0, scrollbackLength]
    // and assigns to viewportY. viewportY === 0 means "at bottom"; increasing
    // viewportY moves the view up into history. To preserve the visual position
    // across a refit, we compensate for scrollback length changes (the broker's
    // reflow can lengthen or shorten scrollback when cols change).
    const vp = _term.viewportY ?? 0;
    const oldScrollback = typeof _term.getScrollbackLength === "function"
      ? _term.getScrollbackLength() : 0;
    const wasAtBottom = vp === 0;
    _fitAddon.fit();
    if (!_firstFitSeen) {
      _firstFitSeen = true;
      __wfTraceEvent(trace, "first.fit", { cols: _term.cols, rows: _term.rows });
    }
    if (!wasAtBottom && vp > 0) {
      const newScrollback = typeof _term.getScrollbackLength === "function"
        ? _term.getScrollbackLength() : oldScrollback;
      // Invariant: oldScrollback - oldVp == newScrollback - newVp.
      const target = Math.max(0, newScrollback - (oldScrollback - vp));
      try { _term.scrollToLine(target); } catch {}
    }
  }

  function forceRepaint() {
    if (!_term) return;
    const t = _term as GhosttyTerminal;
    // renderer.render(buffer, forceAll, viewportY, scrollbackProvider) bypasses
    // Terminal.resize()'s same-dimension guard and FitAddon.fit()'s _lastCols guard.
    // This is the only way to force a full canvas repaint without changing dimensions.
    try { t.renderer?.render?.(t.wasmTerm, true, t.viewportY, t); } catch { /* private API — may drift between ghostty versions */ }
  }

  function syncLayout(options?: { forceSend?: boolean; repaint?: boolean; reason?: string }) {
    if (!_fitAddon || !_term || !_container) return;
    const before = { cols: _term.cols, rows: _term.rows };
    fitTerminalPreserveScroll();
    const after = { cols: _term.cols, rows: _term.rows };
    if (WP.shouldForceRepaintAfterFit(before, after, options?.repaint !== false)) forceRepaint();
    const dimensionsChanged = WP.shouldSendResizeAfterGridFit(before, after);
    if (_ptyClient && dimensionsChanged) _ptyClient.sendFitResize({ force: !!options?.forceSend, fit: false });
    if (dimensionsChanged) {
      const viewportY = _term.viewportY ?? 0;
      if (WP.shouldResizeRehydrate(viewportY, _userRequestedScrollback)) scheduleResizeRehydrate();
    }
  }

  function shouldSuppressContainerResize() {
    return isDesktop() &&
      !state.sidebarPinned &&
      !state.sessionsExpanded &&
      (state.sidebarTransitionIsHover || state.sidebarAutoExpanded);
  }

  /**
   * After a column-count change, the scrollback the client has on screen was
   * painted from a prefill rendered at the OLD width — line wraps fall at
   * the wrong columns. The broker reflows scrollback as part of its `resize`
   * RPC + `snapshot` (with `target_cols`) path, but xterm.js exposes no
   * "replace scrollback only" API; the only way to apply a re-flowed
   * scrollback is a full reconnect that re-fetches the snapshot.
   *
   * Cost: ~ one snapshot RPC + prefill stream per actual resize event
   * (350ms debounce collapses bursty resize-during-drag into one). Resizes
   * are infrequent (sidebar pin/unpin, window drag, mobile rotate) so this
   * is an acceptable price for correct scrollback wrap geometry.
   *
   * Gated on `prefillMode: "full"` because viewport-only attaches don't
   * paint scrollback at all — there's nothing to re-flow.
   *
   * Suppressed while the sidebar is in a hover-driven transient state
   * (`shouldSuppressContainerResize`) so a mouseover+mouseout doesn't
   * trigger a reconnect for a layout that's about to revert.
   */
  function scheduleResizeRehydrate() {
    if (opts.prefillMode !== TERMINAL_PREFILL_MODE.FULL) return;
    if (!_ptyClient || !_ptyClient.isOpen) return;
    if (shouldSuppressContainerResize()) return;
    if (_resizeRehydrateTimer) clearTimeout(_resizeRehydrateTimer);
    _resizeRehydrateTimer = setTimeout(() => {
      _resizeRehydrateTimer = null;
      if (!_term || !_ptyClient || !_ptyClient.isOpen) return;
      if (shouldSuppressContainerResize()) return;
      const viewportY = _term.viewportY ?? 0;
      if (!WP.shouldResizeRehydrate(viewportY, _userRequestedScrollback)) return;
      _pendingResizeScrollRestore = { oldScrollbackLength: _term.getScrollbackLength?.() ?? 0, oldViewportY: viewportY };
      _ptyClient.reconnect();
    }, 350);
  }

  function scheduleLayoutSync(options?: { forceSend?: boolean; repaint?: boolean; reason?: string }) {
    if (_layoutSyncRaf) cancelAnimationFrame(_layoutSyncRaf);
    _layoutSyncRaf = requestAnimationFrame(() => {
      _layoutSyncRaf = null;
      syncLayout(options);
    });
  }

  function startHydration() {
    if (!_hydration) return;
    _hydration.start();
    if (opts.onHydrationStart) opts.onHydrationStart();
  }

  /** Begin replacement prefill while retaining the old canvas until its first
   * authoritative byte. The first byte promotes this to CSS-hidden hydration,
   * preventing later snapshot chunks from painting progressively. */
  function beginReplacementHydration(hideImmediately = false) {
    if (!_hydration || !_term) return;
    _hydrationWritesInFlight = 0;
    _reconnectPendingReset = true;
    _replacementPrefillPending = !hideImmediately;
    if (hideImmediately) activateReplacementHydration();
  }

  function activateReplacementHydration() {
    if (!_replacementPrefillPending && _hydration?.pending) return;
    _replacementPrefillPending = false;
    startHydration();
    const el = _getHydrationElement();
    if (el) { el.classList.remove("hydrated"); el.classList.add("hydrating"); }
  }

  /**
   * mount(container, { cached }?) — create terminal, open in container, load
   * CanvasAddon, fit, create hydration controller (not yet started).
   * Cached plaintext is not written here; restored history must come from
   * broker prefill or an explicit/gated fast-mode replay path.
   */
  async function mount(container, mountOpts) {
    if (_term || _mounting) return; // already mounted or in progress
    const trace = __wfTraceGet(opts.session, opts.machine || "");
    _mounting = true;
    try { await window.ghosttyReady; } catch (err) {
      console.error("[ghostty-web] WASM init failed:", err);
      _mounting = false;
      return;
    }
    __wfTraceEvent(trace, "ghostty.ready");
    if (_term || !_mounting) { _mounting = false; return; } // double-mount or disposed during async gap
    _container = container;

    const result = await createTerminalInstance({
      fontSize: opts.fontSize,
      scrollback: opts.scrollback,
      cursorBlink: opts.cursorBlink,
      disableStdin: opts.disableStdin,
      sendInput: (data) => _ptyClient && _ptyClient.send(data),
      sendMessage: (msg) => _ptyClient && _ptyClient.send(msg),
      canAcceptInput: _canAcceptInput,
      canSendResize: _canSendResize,
      forwardResizeEvents: false,
      alwaysForwardWheel: false,
      trace,
      onWheelScroll: (ev) => {
        if (!_term) return;
        try {
          const hasMouse = _term.getMode(1000) || _term.getMode(1002) || _term.getMode(1003);
          if (hasMouse) return;
        } catch { /* getMode may not exist on older builds */ }
        // This callback fires BEFORE ghostty-web updates the viewport, so
        // viewportY is stale. For scroll-up we trust deltaY direction (user
        // wants to read scrollback). For scroll-down we defer the viewportY
        // check to next frame when ghostty has finished processing.
        if (ev.deltaY < 0) {
          // Snapshot scrollback length at the moment we enter scroll-lock so
          // the patched scrollToBottom can compute the per-write delta and
          // bump viewportY to keep the visible window anchored.
          if (!_userScrolledUp) {
            _lastScrollbackLength = _term.getScrollbackLength?.() ?? -1;
          }
          _userScrolledUp = true;
          _userRequestedScrollback = true;
        } else if (ev.deltaY > 0) {
          requestAnimationFrame(() => {
            if (_term && _term.viewportY === 0) {
              _userScrolledUp = false;
              _userRequestedScrollback = false;
              _lastScrollbackLength = -1;
            }
          });
        }
      },
    });
    // Guard: dispose() may have run during the createTerminalInstance() await
    // (isolated WASM load is async). If so, drop the freshly-created terminal.
    if (!_mounting || _term) {
      try { result.term && result.term.dispose && result.term.dispose(); } catch {}
      _mounting = false;
      return;
    }
    _term = result.term;
    _fitAddon = result.fitAddon;

    // Mark hydrating before terminal mounts to avoid first-frame flicker.
    const hydrationEl = _getHydrationElement();
    if (hydrationEl) { hydrationEl.classList.add("hydrating"); hydrationEl.classList.remove("hydrated"); }
    if (opts.onHydrationStart) opts.onHydrationStart();

    _term.open(container);
    __wfTraceEvent(trace, "dom.terminal.opened");
    if (typeof ResizeObserver !== "undefined") {
      _resizeObserver = new ResizeObserver((entries) => {
        if (!entries.length) return;
        if (!_container || !_term) return;
        if (_container.clientWidth === 0 || _container.clientHeight === 0) return;
        if (shouldSuppressContainerResize()) return;
        scheduleLayoutSync({ forceSend: true, repaint: true, reason: "container-resize" });
      });
      _resizeObserver.observe(container);
    }

    // WORKAROUND: ghostty-web v0.4.0 WASM state retention
    // The WASM allocator reuses freed page memory without zeroing, so new
    // Terminal instances inherit stale screen content from previous ones.
    // reset() frees+recreates the WASM handle but renderer.clear() doesn't
    // repaint the Canvas 2D framebuffer. Direct fillRect is the only fix.
    // Upstream: github.com/coder/ghostty-web/issues/138, /141, /142
    const _openCanvas = container.querySelector('canvas');
    if (_openCanvas) {
      const ctx = _openCanvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#0a0a0a'; // match terminal background
        ctx.fillRect(0, 0, _openCanvas.width, _openCanvas.height);
      }
    }

    // Monkey-patch scrollToBottom to prevent auto-scroll when user has scrolled up.
    // ghostty-web calls scrollToBottom() on EVERY write when viewportY !== 0,
    // which makes it impossible to read scrollback while the agent is producing output.
    // We suppress it when the user has intentionally scrolled up (via wheel/trackpad),
    // and re-enable when they scroll back to the bottom.
    {
      // Scroll-lock: scroll up → keep viewport anchored to the same absolute
      // scrollback rows even as new output pushes lines off the live screen.
      // Any key → snap back to bottom.
      //
      // ghostty-web's writeInternal() calls this.scrollToBottom() on every
      // write when viewportY !== 0. A single write can push N rows from the
      // live screen into scrollback (scrollbackLength grows by N). If we
      // simply swallow scrollToBottom, viewportY stays the same numeric
      // value but now points to a DIFFERENT absolute scrollback row — the
      // user's visible window drifts by N rows per write. Visually that
      // presents as "the first line in the window keeps changing" while
      // the user is trying to read scrollback.
      //
      // Fix: track scrollbackLength delta between successive scrollToBottom
      // calls and bump viewportY by that delta. Net effect: the same
      // absolute scrollback rows stay at the same visual viewport rows.
      //
      // Wheel events are intercepted via onWheelScroll callback passed to
      // createTerminalInstance (fires inside ghostty-web's capture-phase
      // custom wheel handler — the ONLY place we can see wheel events before
      // ghostty-web consumes them with {capture:true, passive:false}).
      const origScrollToBottom = _term.scrollToBottom.bind(_term);
      _term.scrollToBottom = () => {
        if (!_userScrolledUp) {
          origScrollToBottom();
          return;
        }
        const sb = _term.getScrollbackLength?.() ?? 0;
        if (_lastScrollbackLength >= 0) {
          const delta = sb - _lastScrollbackLength;
          if (delta > 0) {
            // scrollToLine clamps and fires scrollEmitter so the renderer
            // does a full repaint at the new viewportY. Direct mutation
            // would leave dirty-row tracking stale.
            _term.scrollToLine(_term.viewportY + delta);
          }
        }
        _lastScrollbackLength = sb;
      };
      // Intercept scrollLines (used by mobile touch scroll + momentum).
      // When viewport moves away from bottom, set _userScrolledUp + snapshot
      // baseline. When it reaches bottom, clear both.
      const origScrollLines = _term.scrollLines.bind(_term);
      _term.scrollLines = (n) => {
        const wasScrolledUp = _userScrolledUp;
        origScrollLines(n);
        if (_term.viewportY > 0) {
          if (!wasScrolledUp) {
            _lastScrollbackLength = _term.getScrollbackLength?.() ?? -1;
          }
          _userScrolledUp = true;
          _userRequestedScrollback = true;
        } else {
          _userScrolledUp = false;
          _userRequestedScrollback = false;
          _lastScrollbackLength = -1;
        }
      };
      _scrollLockKeydownHandler = (event: KeyboardEvent) => {
        if (!WP.shouldReleaseScrollLockOnKeydown(event)) return;
        if (_userScrolledUp) {
          _userScrolledUp = false;
          _userRequestedScrollback = false;
          _lastScrollbackLength = -1;
          origScrollToBottom();
        }
      };
      container.addEventListener("keydown", _scrollLockKeydownHandler, true);
    }

    // Let browser shortcuts through — ghostty-web's keydown handler
    // calls preventDefault() on everything, swallowing Cmd+R etc.
    _browserShortcutKeydownHandler = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if ("rwtlnq".includes(k) || (e.shiftKey && k === "r")) {
          e.stopImmediatePropagation();
        }
      }
    };
    container.addEventListener("keydown", _browserShortcutKeydownHandler, true);

    // Create hydration controller (started in connect())
    //
    // ─── WHY minPendingMs=200 ────────────────────────────────────────────────
    // Background: when opening a session, the user could briefly see
    // scrollback streaming upward through the viewport before the cursor
    // settled. The flash was from the post-attach resize-redraw burst:
    //
    //   - WS opens → attach handshake at initial dims
    //   - server snapshotted broker state immediately at those dims
    //   - attach_ack → client schedules force-resize next rAF
    //   - by then CSS layout had settled to different dims (sidebar
    //     transition 200ms, view transform 280ms)
    //   - broker reflowed scrollback at new dims → emitted streaming
    //     redraw burst (1000+ chunks over ~150ms)
    //   - each chunk = separate WS macrotask → ghostty rAF rendered
    //     intermediate states between them = visible flash
    //
    // PROPER FIX (now in place): src/server/websocket.ts holds the snapshot
    // until client resizes settle (PRE_SNAPSHOT_RESIZE_SETTLE_MS=100ms quiet
    // window, 400ms hard cap). Snapshot now happens at the FINAL dims so the
    // post-attach refit becomes a no-op and the redraw burst doesn't fire.
    //
    // Why minPendingMs is still non-zero: server settle isn't perfect.
    // Scenarios that can still produce a small post-prefill burst:
    //   - mobile keyboard slide-in causes a late layout shift > settle window
    //   - subscription replay (sinceSeq) catches output that arrived during
    //     the settle wait — typically tiny but can paint as a tail of writes
    //   - rAF jitter between writes
    // 200ms is a small cushion to absorb these without revealing mid-burst.
    // Total cost on desktop: ~200ms reveal time (down from 800ms).
    // ─────────────────────────────────────────────────────────────────────────
    const hydrationTiming = resolveHydrationDebugTiming({
      debugEnabled: wfTraceEnabled,
      storage: safeLocalStorage(),
      defaults: {
        minPendingMs: opts.hydrationMinPendingMs ?? 80,
        silenceMs: opts.hydrationSilenceMs ?? INITIAL_HYDRATION_SILENCE_MS,
      },
    });

    _hydration = createInitialHydrationController({
      getElement: _getHydrationElement,
      getTerm: () => _term,
      shouldFocus: opts.shouldFocus || (() => true),
      isInitialContentComplete: () => _initialPrefillComplete,
      canFinish: () => _hydrationWritesInFlight === 0,
      onReveal: () => {
        if (_pendingResizeScrollRestore && _term) {
          const target = WP.resizeRehydrateScrollTarget({
            ..._pendingResizeScrollRestore,
            newScrollbackLength: _term.getScrollbackLength?.() ?? 0,
          });
          _pendingResizeScrollRestore = null;
          if (target !== null) {
            try { _term.scrollToLine(target); } catch {}
            _userScrolledUp = target > 0;
            _userRequestedScrollback = target > 0;
            _lastScrollbackLength = _term.getScrollbackLength?.() ?? -1;
          }
        }
        forceRepaint();
        if (opts.onHydrated) opts.onHydrated();
      },
      timeoutMs: opts.hydrationTimeoutMs,
      settleMs: opts.hydrationSettleMs ?? INITIAL_HYDRATION_SETTLE_MS,
      minPendingMs: hydrationTiming.minPendingMs,
      // Stay hidden briefly after the last terminal write. This catches late
      // post-attach redraw chunks without paying the old fixed 50ms settle
      // after prefill_done when the stream is already quiet.
      silenceMs: hydrationTiming.silenceMs,
      // Diag-only: lets the controller emit milestones into the per-attach trace.
      session: opts.session,
      machine: opts.machine || "",
    });

    syncLayout({ forceSend: false, repaint: true, reason: "mount" });
    _mounting = false;
  }

  /**
   * connect() — start hydration (first time only), create PTY WebSocket
   * client, and open the connection.
   */
  function connect(connectOpts?: { takeControl?: boolean }) {
    if (_ptyClient && _ptyClient.isOpen) return;
    if (_ptyClient) _ptyClient.close();
    _connectEpoch++;

    // Start hydration on first connect
    if (!_hydrationStarted && _hydration) {
      startHydration();
      _hydrationStarted = true;
    }

    // Capture reference to detect stale callbacks from replaced ptyClients
    let thisClient = null;
    const isCurrent = () => _ptyClient === thisClient;

    thisClient = _ptyClient = createPtySocketClient({
      takeControlOnAttach: !!(connectOpts && connectOpts.takeControl),
      session: opts.session,
      machine: opts.machine || "",
      resetPty: opts.resetPty,
      prefillMode: opts.prefillMode,
      getTermDimensions: () => _term ? { cols: _term.cols, rows: _term.rows } : null,
      getLayoutMetrics: () => {
        if (!_container) return null;
        const rect = _container.getBoundingClientRect();
        return {
          containerWidth: rect.width,
          containerClientWidth: _container.clientWidth,
          viewportWidth: window.innerWidth,
        };
      },
      fitTerminal: fitTerminalPreserveScroll,
      shouldReconnect: opts.shouldReconnect,
      onAttach: () => {
        _initialPrefillComplete = opts.prefillMode === TERMINAL_PREFILL_MODE.NONE;
      },
      onOpen: (wasReconnect) => {
        console.log("[pty-ctrl]", opts.session, "onOpen, isCurrent=", isCurrent(), "wasReconnect=", wasReconnect);
        if (!isCurrent()) return;
        // Always reset on first connect — ghostty-web's WASM retains the
        // previous terminal's screen buffer across Terminal instances.
        // Without this, new sessions with sparse prefill show stale content.
        // The WASM buffer must be cleared regardless of prefill mode.
        if (!wasReconnect && _term) {
          _term.reset();
        }
        // On reconnect, clear stale content and restart hydration —
        // server sends fresh prefill scrollback on the new connection.
        const rehydrate = WP.shouldRehydrate(wasReconnect, _hydrationStarted, opts.prefillMode !== TERMINAL_PREFILL_MODE.NONE);
        if (rehydrate && _term) {
          _hydrationWritesInFlight = 0;
          if (wasReconnect) {
            // Retain the old frame until replacement bytes arrive, then hide
            // every subsequent prefill/replay write behind hydration.
            beginReplacementHydration();
          } else {
            startHydration();
            const el = _getHydrationElement();
            if (el) { el.classList.add("hydrating"); el.classList.remove("hydrated"); }
          }
        }
        if (!_pendingResizeScrollRestore) {
          _userScrolledUp = false;
          _userRequestedScrollback = false;
        } // reset scroll-lock on ordinary reconnect
        if (opts.onOpen) opts.onOpen(wasReconnect);
      },
      onPtyReady: () => { if (isCurrent() && opts.onPtyReady) opts.onPtyReady(); },
      onPrefillDone: () => {
        if (!isCurrent()) return;
        // An empty authoritative prefill still replaces old state; clear it
        // behind hydration instead of leaving a stale reconnect frame visible.
        if (_replacementPrefillPending) {
          activateReplacementHydration();
          if (_reconnectPendingReset) {
            _reconnectPendingReset = false;
            _scheduleBufferedClear();
          }
        }
        _initialPrefillComplete = true;
        if (_hydration) _hydration.scheduleFinish();
      },
      onReplacePrefill: () => {
        // Phase 2 scrollback replaces phase 1 viewport. The full scrollback
        // is a superset that contains the viewport content, so we skip the
        // clear() entirely — just let the chunks write directly over the
        // existing buffer. This avoids any visible flash. The terminal ends
        // up with correct content; the viewport portion is overwritten in-place
        // and scrollback history appears above.
        if (!_term) return;
        _reconnectPendingReset = false;
        _hydrationWritesInFlight = 0;
      },
      onBinaryData: (data) => {
        if (!_term) return;
        // Buffer writes while WASM settles after clear — ghostty-web crashes
        // with "memory access out of bounds" if write() follows clear() in the
        // same tick.
        if (_postResetBuffer) {
          _postResetBuffer.push(data);
          return;
        }
        if (_reconnectPendingReset) {
          activateReplacementHydration();
          _reconnectPendingReset = false;
          _postResetBuffer = [data];
          _scheduleBufferedClear();
          return;
        }
        _writeTermData(data);
      },
      onViewerConflict: () => { if (isCurrent() && opts.onViewerConflict) opts.onViewerConflict(); },
      onSubSessionOpened: (parentSession, session) => {
        if (isCurrent() && opts.onSubSessionOpened) opts.onSubSessionOpened(parentSession, session);
      },
      onControlGranted: () => {
        if (!isCurrent()) return;
        // control_granted triggers a fresh attach handshake over the existing
        // socket (sendAttachHandshake() in the ws-client control_granted
        // handler). That's another full prefill + post-attach resize-redraw
        // burst — same shape as initial connect. Without restarting hydration
        // here, the canvas is already `hydrated` from the original mount, so
        // those writes paint live and the user sees the scrollback flash.
        // Restart hydration so the minPendingMs floor hides the burst window.
        if (_hydration && _term) {
          beginReplacementHydration(true);
        }
        if (opts.onControlGranted) opts.onControlGranted();
      },
      onDisconnected: (code, reason) => { if (isCurrent() && opts.onDisconnected) opts.onDisconnected(code, reason); },
      onReconnecting: () => { if (isCurrent() && opts.onReconnecting) opts.onReconnecting(); },
      onReconnectExhausted: () => { if (isCurrent() && opts.onReconnectExhausted) opts.onReconnectExhausted(); },
    });
    _ptyClient.connect();
  }

  function focus() {
    if (_term) _term.focus();
  }

  function scrollToBottom() {
    _userScrolledUp = false;
    _userRequestedScrollback = false;
    _lastScrollbackLength = -1;
    if (_term) _term.scrollToBottom();
  }

  function resize() {
    syncLayout({ forceSend: true, repaint: true, reason: "resize" });
  }

  /**
   * dispose() — close socket, cancel hydration, dispose addons and terminal.
   * Removes keydown listeners from container before disposing terminal.
   */
  function dispose() {
    _connectEpoch++;
    if (_ptyClient) { _ptyClient.close(); _ptyClient = null; }
    if (_hydration) { _hydration.cancel(); _hydration = null; }
    _hydrationStarted = false;
    _hydrationWritesInFlight = 0;
    _reconnectPendingReset = false;
    _replacementPrefillPending = false;
    _postResetBuffer = null;
    if (_layoutSyncRaf) { cancelAnimationFrame(_layoutSyncRaf); _layoutSyncRaf = null; }
    if (_resizeObserver) { try { _resizeObserver.disconnect(); } catch {} _resizeObserver = null; }
    if (_resizeRehydrateTimer) { clearTimeout(_resizeRehydrateTimer); _resizeRehydrateTimer = null; }
    _pendingResizeScrollRestore = null;
    _mounting = false;
    _userScrolledUp = false;
    _userRequestedScrollback = false;
    if (_container) {
      if (_scrollLockKeydownHandler) _container.removeEventListener("keydown", _scrollLockKeydownHandler, true);
      if (_browserShortcutKeydownHandler) _container.removeEventListener("keydown", _browserShortcutKeydownHandler, true);
    }
    _scrollLockKeydownHandler = null;
    _browserShortcutKeydownHandler = null;
    if (_term) { try { _term.dispose(); } catch {} _term = null; }
    _fitAddon = null;
    _container = null;
  }

  return {
    mount,
    connect,
    focus,
    scrollToBottom,
    resize,
    dispose,
    // Delegation to pty client
    scheduleReconnect: () => { if (_ptyClient) _ptyClient.scheduleReconnect(); },
    sendTakeControl: () => { if (_ptyClient) _ptyClient.sendTakeControl(); },
    sendFitResize: (options?: { force?: boolean; fit?: boolean }) => { if (_ptyClient) _ptyClient.sendFitResize(options); },
    forceRepaint,
    syncLayout,
    send: (data) => {
      if (_ptyClient && _ptyClient.isOpen) {
        if (!_firstInputAccepted) {
          _firstInputAccepted = true;
          __wfTraceEvent(__wfTraceGet(opts.session, opts.machine || ""), "first.input.accepted", { source: "controller.send" });
        }
        _ptyClient.send(data);
      }
    },
    resetRetry: () => { if (_ptyClient) _ptyClient.resetRetry(); },
    reconnect: (reconnectOpts?: { takeControl?: boolean }) => { if (_ptyClient) _ptyClient.reconnect(reconnectOpts); },
    // Accessors
    get term() { return _term; },
    get fitAddon() { return _fitAddon; },
    get ptyClient() { return _ptyClient; },
    get hydration() { return _hydration; },
    get isConnected() { return !!(_ptyClient && _ptyClient.isOpen); },
    get retryBlocked() { return _ptyClient ? _ptyClient.retryBlocked : false; },
  };
}


const KEY_TO_ESCAPE = {
  Enter: "\r", Tab: "\t", Escape: "\x1b",
  Up: "\x1b[A", Down: "\x1b[B", Right: "\x1b[C", Left: "\x1b[D",
  Home: "\x1b[H", End: "\x1b[F", PPage: "\x1b[5~", NPage: "\x1b[6~",
  BTab: "\x1b[Z", BSpace: "\x7f", DC: "\x1b[3~",
  y: "y", n: "n",
  "C-a": "\x01", "C-b": "\x02", "C-c": "\x03", "C-d": "\x04",
  "C-e": "\x05", "C-f": "\x06", "C-g": "\x07", "C-h": "\x08",
  "C-k": "\x0b", "C-l": "\x0c", "C-n": "\x0e", "C-p": "\x10",
  "C-r": "\x12", "C-u": "\x15", "C-w": "\x17", "C-z": "\x1a",
};
const _textEncoder = new TextEncoder();

function _sendTerminalInput(bytes) {
  // In grid mode, route to the focused grid cell's controller
  if (isGridActive()) {
    const gs = state.gridSessions[state.gridFocusIndex];
    if (gs?.controller?.isConnected) {
      gs.controller.send(bytes);
      return true;
    }
    return false;
  }
  if (state.terminalController?.isConnected) {
    state.terminalController.send(bytes);
    return true;
  }
  return false;
}

function syncMobileGhosttyKeyboardUi(open: boolean): void {
  state.kbAccessoryOpen = open;
  document.getElementById("kb-open-btn")?.classList.toggle("active", open);
  const cmd = document.getElementById("cmd-palette");
  if (cmd && cmd.innerHTML) cmd.classList.toggle("visible", open);
}

function setMobileGhosttyKeyboardOpen(open: boolean): boolean {
  const term = state.terminalController?.term;
  const input = term?.textarea;
  if (!term || !input) return false;

  if (open) {
    state.terminalController?.scrollToBottom();
    term.options.disableStdin = false;
    input.readOnly = false;
    input.tabIndex = 0;
    input.setAttribute("inputmode", "text");
    input.blur();
    input.focus({ preventScroll: true });
  } else {
    input.blur();
    input.readOnly = true;
    input.tabIndex = -1;
    input.setAttribute("inputmode", "none");
    term.options.disableStdin = true;
  }

  syncMobileGhosttyKeyboardUi(open);
  return true;
}

function createConflictOverlay(message, buttonLabel, onClick) {
  const overlay = document.createElement("div");
  overlay.className = "viewer-conflict-overlay";
  overlay.innerHTML = '<div class="conflict-msg">' + esc(message) + '</div><button class="conflict-btn" type="button">' + esc(buttonLabel) + "</button>";
  overlay.querySelector(".conflict-btn").addEventListener("click", onClick);
  overlay.addEventListener("click", (e) => e.stopPropagation());
  return overlay;
}




// ── Per-session draft persistence (UX-03) ──

function draftKey(machine, session) {
  return "wp-draft|" + (machine || "") + "|" + session;
}
function saveDraft() {
  if (!state.currentSession) return;
  const val = (document.getElementById("msg-input") as HTMLTextAreaElement).value;
  const key = draftKey(state.currentMachine, state.currentSession);
  if (val) localStorage.setItem(key, val);
  else localStorage.removeItem(key);
}
function restoreDraft() {
  if (!state.currentSession) return;
  const val = localStorage.getItem(draftKey(state.currentMachine, state.currentSession)) || "";
  const input = document.getElementById("msg-input") as HTMLTextAreaElement;
  input.value = val;
  autoResizeInput();
}
function clearDraft() {
  if (!state.currentSession) return;
  localStorage.removeItem(draftKey(state.currentMachine, state.currentSession));
}

// ── Recovery snapshots (UX-14) ──

let snapshotPending = null;

function snapshotKey(machine, session) {
  return SNAPSHOT_KEY_PREFIX + (machine || "") + "|" + session;
}
function saveSnapshot(machine, session, text) {
  if (!session || !text) return;
  const trimmed = text.length > SNAPSHOT_MAX_BYTES ? text.slice(-SNAPSHOT_MAX_BYTES) : text;
  try { localStorage.setItem(snapshotKey(machine, session), JSON.stringify({ d: trimmed, ts: Date.now() })); } catch { /* quota/private-mode */ }
}
function loadSnapshot(machine, session) {
  if (!session) return null;
  try {
    const raw = localStorage.getItem(snapshotKey(machine, session));
    if (!raw) return null;
    const snap = JSON.parse(raw);
    const age = (Date.now() - snap.ts) / 1000;
    if (age > (wpSettings.snapshotTtl || 900)) {
      localStorage.removeItem(snapshotKey(machine, session));
      return null;
    }
    return snap.d;
  } catch { return null; }
}
function cleanStaleSnapshots() {
  const ttl = (wpSettings.snapshotTtl || 900) * 1000;
  const now = Date.now();
  const toRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(SNAPSHOT_KEY_PREFIX)) continue;
    try {
      const snap = JSON.parse(localStorage.getItem(key));
      if (now - snap.ts > ttl) toRemove.push(key);
    } catch { toRemove.push(key); }
  }
  toRemove.forEach(k => localStorage.removeItem(k));
}
function scheduleSnapshotSave(text) {
  snapshotPending = text;
  if (state.snapshotTimer) return;
  state.snapshotTimer = setTimeout(flushSnapshot, SNAPSHOT_SAVE_INTERVAL);
}
function flushSnapshot() {
  state.snapshotTimer = null;
  if (!state.currentSession) { snapshotPending = null; return; }
  let text;
  if (state.terminalController?.term) {
    text = serializeXtermTail(state.terminalController.term, 200);
  } else {
    text = snapshotPending;
  }
  snapshotPending = null;
  if (text) saveSnapshot(state.currentMachine, state.currentSession, text);
  flushGridSnapshots();
}
function serializeXtermTail(term, maxLines) {
  return WP.serializeBufferTail(term.buffer.active, maxLines);
}
function flushGridSnapshots() {
  for (const gs of state.gridSessions) {
    if (!gs.controller?.term) continue;
    const text = serializeXtermTail(gs.controller.term, 200);
    if (text) saveSnapshot(gs.machine || "", gs.session, text);
  }
}

// ── Machine registry ──

/**
 * Validate a peer URL before any code uses it for `fetch` / WS construction.
 * An XSS payload could write attacker-controlled URLs into localStorage;
 * without this guard those URLs would receive every API call and the
 * bearer JWT in the next page session.
 *
 * Accept only http(s) URLs whose hostname looks tailnet-shaped
 * (`*.ts.net`), is a literal IP, or is localhost. Port is NOT pinned —
 * the wolfpack server port is operator-configurable; we only require it
 * to be numeric and in 1–65535. Reject opaque schemes (javascript:,
 * data:, etc.), userinfo (creds smuggling), and non-numeric/out-of-range
 * ports.
 */
function isValidMachineUrl(u: unknown): boolean {
  if (typeof u !== "string" || u.length === 0 || u.length > 256) return false;
  let parsed;
  try { parsed = new URL(u); } catch { return false; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  // Allow tailnet host suffix, bare IPv4, or localhost (peer discovery
  // and dev setups all show up as one of these).
  const host = parsed.hostname;
  const isTailnet = /\.ts\.net$/i.test(host);
  const isIPv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  const isLocal = host === "localhost" || host === "127.0.0.1";
  if (!isTailnet && !isIPv4 && !isLocal) return false;
  // Port: empty (scheme default) is fine. Otherwise must be a positive
  // integer in the legal TCP range. URL constructor already rejects most
  // garbage but be explicit.
  const port = parsed.port;
  if (port) {
    if (!/^\d+$/.test(port)) return false;
    const n = Number(port);
    if (n < 1 || n > 65535) return false;
  }
  return true;
}

function getMachines() {
  try {
    const raw = JSON.parse(localStorage.getItem("wolfpack-machines") || "[]");
    if (!Array.isArray(raw)) return [];
    // Drop any entry whose URL fails validation. Names are echoed into the
    // UI; clamp length and strip control chars so an XSS payload in name
    // can't widen the blast radius via DOM injection.
    return raw.filter((m) => m && isValidMachineUrl(m.url)).map((m) => ({
      url: m.url,
      name: typeof m.name === "string" ? m.name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 128) : "",
    }));
  } catch { return []; }
}

function saveMachines(list: Array<{ url: string; name: string }>): void {
  // Mirror getMachines() validation on the write side so future code paths
  // that bypass the discover-source can't poison localStorage either.
  const safe = (Array.isArray(list) ? list : []).filter((m) => m && isValidMachineUrl(m.url));
  localStorage.setItem("wolfpack-machines", JSON.stringify(safe));
}

function removeMachine(url: string): Array<{ url: string; name: string }> {
  const machines = getMachines().filter(m => m.url !== url);
  saveMachines(machines);
  return machines;
}

// Self info, fetched once
(async () => {
  try {
    const resp = await fetch("/api/info");
    const info = await resp.json();
    state.selfName = info.name || "this machine";
    state.selfVersion = info.version || "";
    // Show version in header
    const vEl = document.getElementById("settings-version");
    if (vEl && state.selfVersion) vEl.textContent = "wolfpack v" + state.selfVersion;
  } catch { state.selfName = "this machine"; }
  // Auto-discover wolfpack peers on tailnet
  try {
    const d = await api<DiscoverResponse>("/discover");
    const peers = d.peers || [];
    if (peers.length) {
      const peerUrls = new Set(peers.map(p => p.url));
      // Start from peers as source of truth, preserve any non-tailnet manual entries
      let machines = getMachines();
      let changed = false;
      // Prune stale tailnet machines no longer in peer list
      const before = machines.length;
      machines = machines.filter(m => peerUrls.has(m.url));
      if (machines.length !== before) changed = true;
      // Add/update from peer list
      for (const p of peers) {
        const existing = machines.find(m => m.url === p.url);
        if (!existing) {
          machines.push({ url: p.url, name: p.name || p.hostname });
          changed = true;
        } else if (existing.name !== (p.name || p.hostname)) {
          existing.name = p.name || p.hostname;
          changed = true;
        }
      }
      if (changed) { saveMachines(machines); loadSessions(); }
    }
  } catch {}
})();

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === "string" && msg) return msg;
  }
  return String(err || "unknown error");
}

interface DiscoverPeer {
  readonly url: string;
  readonly name?: string;
  readonly hostname?: string;
}

interface DiscoverResponse {
  readonly peers?: readonly DiscoverPeer[];
}

interface InfoResponse {
  readonly version?: string;
  readonly name?: string;
}

interface SessionsResponse {
  readonly sessions?: Array<Record<string, unknown>>;
}

interface RalphResponse {
  readonly loops?: Array<Record<string, unknown>>;
}

interface ProjectsResponse {
  readonly projects?: string[];
}

interface AgentCommandSetting {
  readonly cmd: string;
  readonly enabled: boolean;
}

interface SettingsResponse {
  readonly settings?: {
    readonly cmds?: AgentCommandSetting[];
  };
  readonly effective?: {
    readonly cmds?: string[];
    readonly agentCmd?: string;
  };
}

interface InstalledProviderReadiness {
  readonly id: string;
  readonly displayName: string;
  readonly command: string;
  readonly status: "installed";
  readonly executablePath: string;
  readonly version: string | null;
  readonly authStatus: "unknown";
  readonly loginCommand: string;
}

interface MissingProviderReadiness {
  readonly id: string;
  readonly displayName: string;
  readonly command: string;
  readonly status: "missing";
  readonly installGuidance: string;
}

type ProviderReadiness = InstalledProviderReadiness | MissingProviderReadiness;

interface ProviderReadinessResponse {
  readonly providers?: ProviderReadiness[];
}

interface NextSessionNameResponse {
  readonly name?: string;
}

interface CreateSessionResponse {
  readonly session?: string;
}

async function api<TResponse = unknown>(path: string, opts?: RequestInit, machineUrl?: string): Promise<TResponse> {
  const base = machineUrl ? new URL("/api" + path, machineUrl).href : "/api" + path;
  const res = await fetch(base, opts);
  const body = await res.text();
  let data: unknown = {};
  if (body) {
    try { data = JSON.parse(body); } catch { /* non-json response body */ }
  }
  if (!res.ok) {
    const errorText = data && typeof data === "object" && "error" in data
      ? (data as Record<string, unknown>).error
      : undefined;
    const message = typeof errorText === "string"
      ? errorText
      : (body ? body.slice(0, 200) : `HTTP ${res.status}`);
    const err = new Error(message) as Error & { status: number; data: unknown };
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data as TResponse;
}

// set by swipe engine so showView() skips animation after gesture already handled it

// navigation hierarchy — higher depth = "deeper" (forward = left, back = right)
const VIEW_DEPTH = {
  sessions: 0,
  projects: 1,
  agent: 2,
  settings: 1,
  terminal: 1,
  "ralph-detail": 1,
  "ralph-start": 1,
};

function showView(name: string, skipAnimation?: boolean): void {
  const prevView = state.currentView;
  const prevEl = document.getElementById(prevView + "-view");
  const isMobile = !isDesktop();

  // Desktop: "sessions" view is hidden — redirect to terminal if active (unless sessions expanded)
  const effectiveName = (!isMobile && name === "sessions" && state.currentSession && !state.sessionsExpanded) ? "terminal" : name;

  const nextEl = document.getElementById(effectiveName + "-view");
  const wasSwipe = state.swipeNavigated;
  if (state.swipeNavigated) { skipAnimation = true; state.swipeNavigated = false; }
  const animate = isMobile && !skipAnimation && prevView !== effectiveName && prevEl && nextEl;
  const animateHeader = isMobile && prevView !== effectiveName && !skipAnimation || wasSwipe;
  const goingForward = (VIEW_DEPTH[effectiveName] || 0) > (VIEW_DEPTH[prevView] || 0);

  // Stop debug panel refresh when leaving settings
  if (prevView === "settings" && effectiveName !== "settings" && debugPanelTimer) {
    clearInterval(debugPanelTimer); debugPanelTimer = null;
  }

  // Tear down terminal connections when navigating away from terminal view
  // Prevents background WS from auto-reconnecting and stealing control from other instances
  if (prevView === "terminal" && effectiveName !== "terminal") {
    if (state.activeDelegationRoot) {
      destroyTerminal();
      teardownDelegationWorkspace();
      if (isGridActive()) suspendGridMode();
    } else if (isGridActive()) {
      suspendGridMode();
    } else {
      destroyTerminal();
    }
  }

  setState({ currentView: effectiveName });

  if (animate) {
    const fg = goingForward ? nextEl : prevEl;
    const bg = goingForward ? prevEl : nextEl;

    bg.style.transition = "none";
    bg.style.transform = goingForward ? "translate3d(0,0,0)" : "translate3d(-30%,0,0)";
    bg.classList.add("visible");
    bg.style.zIndex = "0";

    fg.style.transition = "none";
    fg.style.transform = goingForward ? "translate3d(100%,0,0)" : "translate3d(0,0,0)";
    fg.classList.add("visible", "swiping");
    fg.style.zIndex = "2";

    fg.offsetHeight;

    const dur = "0.3s";
    const ease = "cubic-bezier(0.2, 0.9, 0.3, 1)";
    fg.style.transition = `transform ${dur} ${ease}`;
    bg.style.transition = `transform ${dur} ${ease}`;

    fg.style.transform = goingForward ? "translate3d(0,0,0)" : "translate3d(100%,0,0)";
    bg.style.transform = goingForward ? "translate3d(-30%,0,0)" : "translate3d(0,0,0)";

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      [fg, bg].forEach(el => {
        el.style.transition = "";
        el.style.zIndex = "";
        el.style.transform = "";
        el.classList.remove("swiping");
      });
      document.querySelectorAll(".view").forEach(v => {
        if (v !== nextEl) v.classList.remove("visible");
      });
      nextEl.classList.add("visible");
    };
    fg.addEventListener("transitionend", cleanup, { once: true });
    setTimeout(cleanup, 350);
  } else {
    // never remove .visible from target — prevents black flash
    document.querySelectorAll(".view").forEach(v => {
      if (v !== nextEl) v.classList.remove("visible", "animating", "swiping");
    });
    nextEl.classList.add("visible");
    nextEl.style.transform = "";
  }

  const back = document.getElementById("back-btn");
  const title = document.getElementById("header-title");

  const gear = document.getElementById("gear-btn");

  const chip = document.getElementById("session-chip");
  const headerCenter = document.getElementById("header-center");

  // Stop timers immediately (don't defer these)
  if (state.sessionRefreshTimer) { clearInterval(state.sessionRefreshTimer); state.sessionRefreshTimer = null; }
  if (state.ralphLogPollTimer) { clearInterval(state.ralphLogPollTimer); state.ralphLogPollTimer = null; }

  // Desktop: skip all header manipulation, handle view-specific logic only
  if (!isMobile) {
    // Exit expanded sessions mode when navigating away from sessions
    if (effectiveName !== "sessions" && state.sessionsExpanded) {
      state.sessionsExpanded = false;
      document.body.classList.remove("sessions-expanded");
      const expandBtn = document.getElementById("sidebar-expand-btn");
      if (expandBtn) expandBtn.classList.remove("active");
      // Restore sidebar based on pin state
      if (state.sidebarPinned) {
        const sb = document.getElementById("desktop-sidebar");
        if (sb) { sb.classList.remove("collapsed"); state.sidebarCollapsed = false; }
      }
    }
    const settingsBackBtn = document.getElementById("settings-back-btn");
    if (settingsBackBtn) settingsBackBtn.style.display = effectiveName === "settings" ? "block" : "none";
    const ralphDetailBackBtn = document.getElementById("ralph-detail-back-btn");
    if (ralphDetailBackBtn) ralphDetailBackBtn.style.display = effectiveName === "ralph-detail" ? "inline-block" : "none";
    const ralphStartBackBtn = document.getElementById("ralph-start-back-btn");
    if (ralphStartBackBtn) ralphStartBackBtn.style.display = effectiveName === "ralph-start" ? "inline-block" : "none";
    if (effectiveName === "settings") {
      renderQuickCmdSettings();
      loadAgentsSettings();
    } else if (effectiveName === "ralph-detail") {
      refreshRalphDetail();
      state.ralphLogPollTimer = setInterval(refreshRalphDetail, 2000);
    } else if (effectiveName === "ralph-start") {
      loadRalphStartForm();
    }
    // Update sidebar active highlight
    renderSidebar();
    return;
  }

  // Mobile: full header management
  const applyHeader = () => {
    // Always start with kb-accessory closed on view change
    document.getElementById("kb-accessory").classList.remove("visible");
    state.kbAccessoryOpen = false;
    chip.style.display = "none";
    closeDrawer(true);
    title.style.display = "";
    title.style.cursor = "";
    title.onclick = null;
    document.getElementById("header-machine-label").style.display = "none";
    headerCenter.style.transform = "";

    if (name === "sessions") {
      back.style.display = "none";
      back.onclick = null;
      gear.style.display = "";
      title.textContent = "wolfpack";
      loadSessions(); // immediate refresh on entering sessions view
      state.sessionRefreshTimer = setInterval(loadSessions, 5000);
    } else if (name === "projects") {
      back.style.display = "block";
      back.onclick = () => { returnFromProjectPicker(); };
      gear.style.display = "none";
      title.textContent = "select project";

    } else if (name === "agent") {
      back.style.display = "block";
      back.onclick = () => { showView("projects"); };
      gear.style.display = "none";
      title.textContent = "select agent";

    } else if (name === "settings") {
      back.style.display = "block";
      back.onclick = () => { showView("sessions"); loadSessions(); };
      gear.style.display = "none";
      title.textContent = "settings";

      renderQuickCmdSettings();
      loadAgentsSettings();
    } else if (name === "terminal") {
      back.style.display = "block";
      back.onclick = () => {
        destroyTerminal();
        setState({ currentSession: null, currentMachine: "" });
        showView("sessions");
        loadSessions();
      };
      gear.style.display = "none";
      title.style.display = "none";
      loadSessionSwitcher();
      chip.style.display = "flex";
      headerCenter.style.transform = "";
      const hml = document.getElementById("header-machine-label");
      if (getMachines().length > 0) {
        const mName = state.currentMachine
          ? (getMachines().find(m => m.url === state.currentMachine)?.name || "remote")
          : (state.selfName || "local");
        hml.textContent = mName;
        hml.style.display = "block";
      }
    } else if (name === "ralph-detail") {
      back.style.display = "block";
      back.onclick = () => { backFromRalph(); };
      gear.style.display = "none";
      const ralphMachineSuffix = state.currentRalphMachine
        ? " @ " + (getMachines().find(m => m.url === state.currentRalphMachine)?.name || "remote")
        : "";
      title.textContent = (state.currentRalphProject || "ralph") + ralphMachineSuffix;

      refreshRalphDetail();
      state.ralphLogPollTimer = setInterval(refreshRalphDetail, 2000);
    } else if (name === "ralph-start") {
      back.style.display = "block";
      back.onclick = () => { backFromRalph(); };
      gear.style.display = "none";
      title.textContent = "start ralph";

      loadRalphStartForm();
    }
  };

  applyHeader();
}


// ── Sessions ──

function triageUi(session): ReturnType<typeof sessionRuntimeUi> {
  return sessionRuntimeUi(session && typeof session === "object" ? session : { triage: session });
}

function delegationCardAttributes(row: DelegationSessionRow<DelegationSessionLike>): { readonly className: string; readonly dataAttribute: string } {
  const classes: string[] = [];
  if (row.childSummary) classes.push("delegation-parent-card");
  if (row.role === "child") classes.push("sub-session-card");
  if (row.role === "orphan") classes.push("orphan-session-card");
  const dataAttribute = row.parent
    ? ` data-parent-session="${esc(row.parent.wolfpackSessionName)}"`
    : "";
  return {
    className: classes.length ? " " + classes.join(" ") : "",
    dataAttribute,
  };
}

function delegationParentSummaryHtml(row: DelegationSessionRow<DelegationSessionLike>): string {
  if (!row.childSummary) return "";
  return `<div class="delegation-summary">${esc(delegationChildSummaryText(row.childSummary))}</div>`;
}

function delegationParentMissingHtml(row: DelegationSessionRow<DelegationSessionLike>): string {
  if (row.role === "orphan" && row.parent) {
    return `<div class="delegation-parent-missing">missing parent: ${esc(row.parent.wolfpackSessionName)}</div>`;
  }
  return "";
}

// Shared session groups cache for switcher reuse
function renderMachineGroupHtml(g, multiMachine) {
  const mUrl = multiMachine ? esc(g.machine.url) : "";
  const mUrlAttr = multiMachine ? escAttr(g.machine.url) : "";
  const mName = esc(g.machine.name);
  const statusDot = !multiMachine ? "green" : g.online ? "green" : (g.pending ? "gray" : "red");
  const statusTitle = !multiMachine ? "online" : g.online ? "online" : (g.pending ? "connecting" : "offline");
  const versionWarning = multiMachine && g.outdated ? `<span class="version-warning" onclick="event.stopPropagation();alert('Running v${escAttr(g.machine.version || "?")} — newer version available on another machine')">⚠ UPDATE</span>` : "";
  let html = multiMachine ? `<div class="machine-group" data-machine="${mUrlAttr}">` : `<div class="machine-group">`;
  html += `<div class="machine-header"><div class="dot ${statusDot}" title="${statusTitle}"></div>${mName}${versionWarning}<div class="machine-header-btns"><button class="machine-ralph-btn" onclick="showRalphStart('${mUrlAttr}')">&#129355;</button><button class="machine-add-btn" onclick="showProjectPicker('${mUrlAttr}')">+</button></div></div>`;
  if (multiMachine && g.pending) {
    html += `<div class="group-status">Connecting...</div>`;
  } else if (g.online) {
    if (g.sessions.length) {
      html += projectDelegationSessions(g.sessions).map((row, i) => {
        const s = row.session;
        const lastLine = s.lastLine || "";
        const ui = triageUi(s);
        const anim = state.firstLoad ? "animate-in" : "";
        const grouping = delegationCardAttributes(row);
        return `<div class="card card-stagger ${anim} ${ui.card}${grouping.className}"${grouping.dataAttribute} style="${state.firstLoad ? 'animation-delay:' + i * 30 + 'ms' : ''}" onclick="openSession('${escAttr(s.name)}'${mUrlAttr ? ", '" + mUrlAttr + "'" : ''})">
          <div class="dot ${ui.dot}" title="${ui.title}"></div>
          <div class="card-info">
            <div class="card-name">${esc(s.name)}<span class="triage-badge ${ui.badge}">${ui.label}</span></div>
            ${delegationParentSummaryHtml(row)}
            ${delegationParentMissingHtml(row)}
            <div class="card-preview">${esc(lastLine)}</div>
          </div>
          <button class="kill-btn" onclick="killSession('${escAttr(s.name)}', event${mUrlAttr ? ", '" + mUrlAttr + "'" : ''})">&times;</button>
        </div>`;
      }).join("");
    }
    if (g.loops && g.loops.length) {
      // TRUST BOUNDARY: g.loops from remote peers is untrusted — all fields are
      // escaped via esc()/escAttr() in renderRalphCardHtml; status classes are
      // hardcoded enum values from getRalphStatus(). Server-side validation in
      // validatePeerLoops() strips unexpected keys and enforces types.
      html += g.loops.map(loop => renderRalphCardHtml(loop, g.machine.url || "")).join("");
    }
  } else if (multiMachine) {
    html += `<div class="group-status">Offline</div>`;
  }
  html += `</div>`;
  return html;
}

interface DelegationWorkspaceContext {
  readonly root: DelegationSessionLike;
  readonly members: DelegationSessionRow<DelegationSessionLike>[];
}

function delegationWorkspaceContext(sessionName: string, machineUrl: string): DelegationWorkspaceContext | null {
  const group = state.lastSessionGroups.find(candidate => (candidate.machine.url || "") === (machineUrl || ""));
  if (!group) return null;
  const target = group.sessions.find(session => session.name === sessionName);
  if (!target) return null;
  const root = delegationRootSession(group.sessions, target);
  if (!root) return null;
  const members = delegationGridMembers(group.sessions, root);
  return members.length > 1 ? { root, members } : null;
}

function delegationGridMember(row: DelegationSessionRow<DelegationSessionLike>, machine: string): DelegationGridMember {
  const ui = triageUi(row.session);
  const runtimeState = row.session.runtimeState?.state;
  const idle = runtimeState === AGENT_STATUS_STATE.IDLE
    || (!runtimeState && row.session.triage !== AGENT_STATUS_STATE.RUNNING);
  return {
    session: row.session.name,
    machine,
    role: row.role === "root" ? "root" : "child",
    statusClass: ui.badge,
    statusLabel: ui.label,
    idle,
  };
}

function updateDelegationGridHeader(context: DelegationWorkspaceContext): void {
  const title = document.getElementById("delegation-grid-title");
  const summary = document.getElementById("delegation-grid-summary");
  if (title) title.textContent = `${context.root.name} grid`;
  if (summary) {
    const childSummary = context.members[0]?.childSummary;
    summary.textContent = childSummary
      ? delegationChildSummaryText(childSummary)
      : `${Math.max(0, context.members.length - 1)} child agents`;
  }
}

function setDelegationWorkspaceDisplay(mode: "grid" | "focus" | "off"): void {
  document.body.classList.toggle("delegation-workspace", mode !== "off");
  document.body.classList.toggle("delegation-grid-active", mode === "grid");
  document.body.classList.toggle("delegation-focus-active", mode === "focus");
}

function teardownDelegationWorkspace(): void {
  disposeDelegationGrid();
  setDelegationWorkspaceDisplay("off");
  setState({
    activeDelegationRoot: null,
    focusedDelegationSession: null,
    delegationMachine: "",
  });
}

function leaveDelegationWorkspaceForManualGrid(): void {
  if (state.terminalController) destroyTerminal();
  teardownDelegationWorkspace();
}

function syncDelegationWorkspace(): void {
  if (!state.activeDelegationRoot) return;
  const context = delegationWorkspaceContext(state.activeDelegationRoot, state.delegationMachine || "");
  if (!context) {
    if (state.focusedDelegationSession) destroyTerminal();
    teardownDelegationWorkspace();
    setState({ currentSession: null, currentMachine: "" });
    if (state.currentView === "terminal") backToSessions();
    return;
  }

  const members = context.members.map(row => delegationGridMember(row, state.delegationMachine || ""));
  const focusedStillExists = !state.focusedDelegationSession
    || members.some(member => member.session === state.focusedDelegationSession);
  setDelegationGridMembers(members);
  updateDelegationGridHeader(context);

  if (!focusedStillExists) {
    destroyTerminal();
    setState({
      focusedDelegationSession: null,
      currentSession: context.root.name,
      currentMachine: state.delegationMachine || "",
    });
    setDelegationWorkspaceDisplay("grid");
  }
  if (!state.focusedDelegationSession) renderDelegationGridCells();
}

function prepareDelegationWorkspace(rootSession: string, machineUrl: string): DelegationWorkspaceContext | null {
  const context = delegationWorkspaceContext(rootSession, machineUrl);
  if (!context) return null;
  if (state.activeDelegationRoot !== context.root.name || state.delegationMachine !== machineUrl) {
    disposeDelegationGrid();
  }
  setState({
    activeDelegationRoot: context.root.name,
    delegationMachine: machineUrl,
  });
  setDelegationGridMembers(context.members.map(row => delegationGridMember(row, machineUrl)));
  updateDelegationGridHeader(context);
  return context;
}

function openDelegationGrid(rootSession: string, machineUrl = ""): void {
  if (!canOpenMultiTerminalGrid()) return;
  if (isGridActive()) suspendGridMode();
  const context = prepareDelegationWorkspace(rootSession, machineUrl);
  if (!context) return;
  if (state.terminalController) destroyTerminal();
  setState({
    focusedDelegationSession: null,
    currentSession: context.root.name,
    currentMachine: machineUrl,
  });
  setDelegationWorkspaceDisplay("grid");
  showView("terminal", true);
  renderDelegationGridCells();
  renderSidebar();
}

function focusDelegationSession(sessionName: string, machineUrl = ""): void {
  if (isGridActive()) suspendGridMode();
  const context = prepareDelegationWorkspace(sessionName, machineUrl);
  if (!context || !context.members.some(row => row.session.name === sessionName)) return;
  if (state.terminalController) destroyTerminal();
  suspendDelegationGridTerminals();
  setState({
    focusedDelegationSession: sessionName,
    currentSession: sessionName,
    currentMachine: machineUrl,
  });
  const label = document.getElementById("delegation-focus-label");
  if (label) label.textContent = `${sessionName} terminal`;
  setDelegationWorkspaceDisplay("focus");
  showView("terminal", true);
  const cached = loadSnapshot(machineUrl, sessionName);
  void initTerminal(cached, TERMINAL_PREFILL_MODE.FULL);
  renderSidebar();
}

function returnToDelegationGrid(): void {
  if (!state.activeDelegationRoot) return;
  openDelegationGrid(state.activeDelegationRoot, state.delegationMachine || "");
}

function exitDelegationWorkspace(): void {
  if (!state.activeDelegationRoot) return;
  if (state.terminalController) destroyTerminal();
  teardownDelegationWorkspace();
  if (hasPreservedGrid()) {
    showView("terminal", true);
    restorePreservedGrid();
    return;
  }
  if (state.gridSessions.length >= 2) {
    setCurrentSessionFromGridFocus(state.gridSessions, state.gridFocusIndex);
    updateGridLayout();
    showView("terminal", true);
    renderSidebar();
    return;
  }
  setState({ currentSession: null, currentMachine: "" });
  backToSessions();
}

function fetchMachine(machineUrl, machineMeta) {
  // Timeout remote machines so one unreachable host can't block the entire UI.
  // Peers that fail repeatedly get a shorter timeout — see WP.peerHealth* helpers.
  const timeoutMs = machineUrl ? WP.peerHealthTimeoutMs(state.peerHealth, machineUrl) : 0;
  const remoteOpts = machineUrl ? { signal: AbortSignal.timeout(timeoutMs) } : undefined;
  const ralphFetch = wpSettings.ralphEnabled ? api<RalphResponse>("/ralph", remoteOpts, machineUrl || undefined).catch(() => ({ loops: [] })) : Promise.resolve({ loops: [] });
  return Promise.all([api<SessionsResponse>("/sessions", remoteOpts, machineUrl || undefined), api<InfoResponse>("/info", remoteOpts, machineUrl || undefined), ralphFetch])
    .then(([d, info, ralph]) => {
      if (machineUrl) state.peerHealth = WP.peerHealthRecordSuccess(state.peerHealth, machineUrl);
      return {
        machine: { ...machineMeta, url: machineUrl, version: info.version || "", name: info.name || machineMeta.name },
        sessions: d.sessions || [], loops: ralph.loops || [], online: true, pending: false,
      };
    })
    .catch(() => {
      if (machineUrl) state.peerHealth = WP.peerHealthRecordFailure(state.peerHealth, machineUrl);
      return {
        machine: { ...machineMeta, url: machineUrl, version: "" },
        sessions: [], loops: [], online: false, pending: false,
      };
    });
}

async function loadSessions() {
  const myEpoch = ++state.loadSessionsEpoch;
  const el = document.getElementById("session-list");
  const machines = getMachines();
  const multiMachine = machines.length > 0;

  // Single-machine: just fetch and render
  if (!multiMachine) {
    const g = await fetchMachine("", { name: state.selfName || "this machine" });
    if (myEpoch !== state.loadSessionsEpoch) return; // stale call, discard
    state.lastSessionGroups = [g];
    state.allSessions = g.sessions.map(s => ({ ...s, machineUrl: "", machineName: g.machine.name }));
    const html = renderMachineGroupHtml(g, false);
    if (html !== state.lastSessionsHtml) { el.innerHTML = html; state.lastSessionsHtml = html; }
    syncDelegationWorkspace();
    checkStateTransitions([g]);
    state.firstLoad = false;
    return;
  }

  // Multi-machine
  const allMachines = [
    { url: "", meta: { name: state.selfName || "this machine" } },
    ...machines.map(m => ({ url: m.url, meta: m })),
  ];

  // Show placeholders on first load
  if (state.firstLoad) {
    el.innerHTML = allMachines.map(m =>
      renderMachineGroupHtml({ machine: { ...m.meta, url: m.url }, sessions: [], online: false, pending: true }, true)
    ).join("");
  }

  const groups = new Array(allMachines.length);
  // Previous cycle's groups by url — used as fallback for unresolved slots
  // during refresh so sidebar order stays stable (add-order) and peers don't
  // flicker to "pending" each poll.
  const prevByUrl = new Map((state.lastSessionGroups || []).map(g => [g.machine.url, g]));
  const pendingPlaceholder = m => ({
    machine: { ...m.meta, url: m.url, version: "" },
    sessions: [], loops: [], online: false, pending: true,
  });
  const groupsInOrder = () => allMachines.map((m, i) => groups[i] || prevByUrl.get(m.url) || pendingPlaceholder(m));

  // Render each machine group as its fetch resolves — a slow/dead peer can't
  // delay rendering of machines that responded quickly.
  const renderGroup = (i, g) => {
    const m = allMachines[i];
    const existing = el.querySelector(`[data-machine="${escAttr(m.url)}"]`);
    if (!existing) return;
    const newHtml = renderMachineGroupHtml(g, true);
    if (existing.outerHTML !== newHtml) {
      const tmp = document.createElement("div");
      tmp.innerHTML = newHtml;
      existing.replaceWith(tmp.firstElementChild);
    }
  };

  const promises = allMachines.map((m, i) =>
    fetchMachine(m.url, m.meta).then(g => {
      if (myEpoch !== state.loadSessionsEpoch) return; // stale call, discard
      groups[i] = g;
      state.lastSessionGroups = groupsInOrder();
      renderGroup(i, g);
      // Sidebar reads from state.lastSessionGroups — refresh it now so the
      // local machine's card appears without waiting for slow peers.
      renderSidebar();
    })
  );

  await Promise.all(promises);
  if (myEpoch !== state.loadSessionsEpoch) return; // stale call, discard

  // Version-outdated check requires all machines resolved. Re-render only
  // groups whose outdated flag actually changed — avoids flicker.
  const versions = groups.filter(g => g && g.online && g.machine.version).map(g => g.machine.version);
  const newestVersion = versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] || "";
  if (newestVersion) {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (!g) continue;
      const nowOutdated = g.online && g.machine.version !== newestVersion;
      if (nowOutdated !== !!g.outdated) {
        g.outdated = nowOutdated;
        renderGroup(i, g);
      }
    }
  }

  state.firstLoad = false;
  state.lastSessionGroups = groupsInOrder();
  const out = [];
  for (const g of groups) {
    if (!g) continue;
    for (const s of g.sessions) out.push({ ...s, machineUrl: g.machine.url, machineName: g.machine.name });
  }
  state.allSessions = out;
  syncDelegationWorkspace();
  checkStateTransitions(groups);
}

async function openSession(name, machineUrl) {
  const targetMachine = machineUrl || "";
  if (isDesktop()) {
    const delegation = delegationWorkspaceContext(name, targetMachine);
    if (delegation) {
      if (delegation.root.name === name) openDelegationGrid(name, targetMachine);
      else focusDelegationSession(name, targetMachine);
      return;
    }
  }
  const trace = __wfTraceStart(name, targetMachine, { mode: "single" });
  __wfTraceEvent(trace, "openSession.start");
  if (state.activeDelegationRoot) teardownDelegationWorkspace();
  if (state.currentView !== "terminal" && hasPreservedGrid()) clearPreservedGrid();
  // Exit expanded sessions mode when opening a session
  if (state.sessionsExpanded) {
    state.sessionsExpanded = false;
    document.body.classList.remove("sessions-expanded");
    const expandBtn = document.getElementById("sidebar-expand-btn");
    if (expandBtn) expandBtn.classList.remove("active");
    // Restore sidebar based on pin state
    if (state.sidebarPinned) {
      const sb = document.getElementById("desktop-sidebar");
      if (sb) { sb.classList.remove("collapsed"); state.sidebarCollapsed = false; }
    }
  }
  // On desktop with grid active, clicking a card focuses or exits grid
  if (isDesktop() && isGridActive()) {
    const gridIdx = state.gridSessions.findIndex(gs => gs.session === name && (gs.machine || "") === (machineUrl || ""));
    if (gridIdx !== -1) {
      setGridFocus(gridIdx);
      return;
    }
    // Not in grid — exit grid mode and open normally
    exitGridMode();
  }
  // On desktop, if already in terminal view, do a session switch
  if (isDesktop() && state.currentView === "terminal" && state.currentSession) {
    if (name !== state.currentSession || (machineUrl || "") !== state.currentMachine) {
      hideTerminalCanvasForTeardown();
    }
    // If sidebar is auto-expanded (hover), instantly collapse it before
    // switching so the new terminal fits to full width. Without this,
    // initTerminal() fits to the narrow width, triggering a PTY
    // resize that causes Claude Code's TUI to redraw with · fill dots.
    if (state.sidebarAutoExpanded) {
      const sb = document.getElementById("desktop-sidebar");
      if (sb) {
        sb.style.transition = "none";
        sb.classList.add("collapsed");
        sb.offsetHeight; // force reflow
        sb.style.transition = "";
      }
      state.sidebarCollapsed = true;
      state.sidebarAutoExpanded = false;
      if (sidebarAutoCollapseTimer) { clearTimeout(sidebarAutoCollapseTimer); sidebarAutoCollapseTimer = null; }
    }
    await switchSession(machineUrl ? machineUrl + "|" + name : name);
    renderSidebar();
    return;
  }
  // Destroy BEFORE changing state — flushSnapshot() inside destroyTerminal()
  // reads state.currentSession to key the snapshot. If we set state first,
  // the OLD terminal's content gets saved under the NEW session's key.
  destroyTerminal();
  setState({ currentSession: name, currentMachine: machineUrl || "" });
  recordRecent(state.currentMachine, name);
  wpMetrics.reset();
  restoreDraft();
  const cached = loadSnapshot(state.currentMachine, name);
  showView("terminal");
  __wfTraceEvent(trace, "dom.view.created", { cached: !!cached });
  void initTerminal(cached, TERMINAL_PREFILL_MODE.FULL);
  renderSidebar();
}


// ── Project picker ──

let projectNames: readonly string[] | null = null;

function renderProjectNames(projects: readonly string[]): void {
  const list = document.getElementById("project-list");
  if (!projects.length) {
    list.innerHTML = '<div class="empty">No matching projects</div>';
    return;
  }
  list.innerHTML = projects
    .map(
      (project) => `
<div class="card" onclick="selectProject('${escAttr(project)}')">
  <div class="dot brand" title="project"></div>
  <div class="card-name">${esc(project)}</div>
</div>
    `,
    )
    .join("");
}

function returnFromProjectPicker(): void {
  if (state.viewBeforePicker === "sessions") {
    backToSessions();
    return;
  }
  if (state.viewBeforePicker === "terminal") {
    if (isDesktop() && hasPreservedGrid() && returnToTerminalView()) return;
    if (state.currentSession) {
      void openSession(state.currentSession, state.currentMachine || undefined);
      return;
    }
  }
  showView(state.viewBeforePicker || "sessions");
}

async function showProjectPicker(machineUrl?: string): Promise<void> {
  state.projectMachine = machineUrl || "";
  setState({ viewBeforePicker: state.currentView });
  showView("projects");
  const projectNameInput = document.getElementById("new-project-name") as HTMLInputElement;
  projectNameInput.value = "";
  projectNameInput.focus({ preventScroll: true });
  const list = document.getElementById("project-list");
  projectNames = null;
  list.innerHTML = '<div class="empty">Loading...</div>';

  try {
    const data = await api<ProjectsResponse>("/projects", undefined, state.projectMachine);
    projectNames = data.projects ?? [];
    if (!projectNames.length) {
      list.innerHTML = '<div class="empty">No projects in ~/Dev</div>';
      return;
    }
    renderProjectNames(projectNames);
  } catch {
    list.innerHTML = '<div class="empty">Failed to load projects</div>';
  }
}

function showTerminalLoading(label: string): void {
  clearPreservedGrid();
  showView("terminal");
  const dtc = document.getElementById("desktop-terminal-container");
  dtc.style.display = "block";
  dtc.innerHTML = '<span class="loading-text">Starting session in ' + esc(label) + '\u2026</span>';
}

function selectProject(project: string): void {
  state.selectedProject = project;
  state.isNewProject = false;
  showAgentPicker();
}

function selectNewProject() {
  const input = document.getElementById("new-project-name") as HTMLInputElement;
  const name = input.value.trim();
  if (!name) return;
  state.selectedProject = name;
  state.isNewProject = true;
  showAgentPicker();
}

async function showAgentPicker() {
  showView("agent");
  const el = document.getElementById("agent-list");
  el.innerHTML = '<div class="empty">Loading...</div>';
  const nameInput = document.getElementById("session-name-input") as HTMLInputElement;
  const nameError = document.getElementById("session-name-error");
  nameInput.value = "";
  nameInput.classList.remove("invalid");
  nameError.classList.remove("visible");
  try {
    const [data, nameData] = await Promise.all([
      api<SettingsResponse>("/settings", undefined, state.projectMachine),
      api<NextSessionNameResponse>("/next-session-name?project=" + encodeURIComponent(state.selectedProject), undefined, state.projectMachine),
    ]);
    nameInput.value = nameData.name || state.selectedProject;
    // /api/settings now returns { settings, effective } — effective.cmds is
    // the list to render (already filtered to enabled, with ["shell"] fallback
    // when nothing's on). Manage which cmds appear via the Settings page.
    const cmds = data.effective?.cmds || [AGENT_KIND.SHELL];
    const defaultCmd = data.effective?.agentCmd;
    const html = cmds.map(cmd => `
      <div class="card" onclick="createSessionWithAgent('${escAttr(cmd)}')">
        <div class="dot ${cmd === defaultCmd ? "brand" : "green"}" title="${cmd === defaultCmd ? "default" : "agent"}"></div>
        <div class="card-name">${esc(cmd)}</div>
      </div>
    `).join("");
    el.innerHTML = html;
  } catch {
    el.innerHTML = '<div class="empty">Failed to load agents</div>';
  }
}

// Session name input validation
(function() {
  const input = document.getElementById("session-name-input") as HTMLInputElement;
  const error = document.getElementById("session-name-error");
  input.addEventListener("input", () => {
    const val = input.value.trim();
    if (val && !/^[a-zA-Z0-9_-]+$/.test(val)) {
      input.classList.add("invalid");
      error.textContent = "letters, numbers, hyphens, underscores only";
      error.classList.add("visible");
    } else {
      input.classList.remove("invalid");
      error.classList.remove("visible");
    }
  });
  input.addEventListener("focus", () => input.select());
})();

// ── Agents settings panel ──
//
// Renders the editable agents list on the Settings page. Distinct from
// `showAgentPicker` (which renders the read-only picker shown when creating
// a session). This is where the user toggles enabled/disabled, adds new
// commands, and removes them. All ops hit /api/settings on the local
// machine — agent settings are per-machine, not synced across peers.
let latestSettingsResponse: SettingsResponse | null = null;
let providerReadinessCache: ProviderReadiness[] = [];

async function loadAgentsSettings(): Promise<void> {
  const list = document.getElementById("agents-list");
  if (!list) return;
  list.innerHTML = '<div class="empty">Loading...</div>';
  latestSettingsResponse = null;
  providerReadinessCache = [];
  void loadProviderReadiness();
  try {
    applySettingsResponse(await api<SettingsResponse>("/settings"));
  } catch (e) {
    list.innerHTML = `<div class="empty">Failed to load: ${esc(errorMessage(e))}</div>`;
  }
}

async function loadProviderReadiness(): Promise<void> {
  const list = document.getElementById("provider-readiness-list");
  if (!list) return;
  list.innerHTML = '<div class="empty">Checking providers...</div>';
  try {
    const data = await api<ProviderReadinessResponse>("/providers");
    providerReadinessCache = data.providers || [];
    renderProviderReadiness(providerReadinessCache, latestSettingsResponse);
  } catch (e) {
    list.innerHTML = `<div class="empty">Provider check failed: ${esc(errorMessage(e))}</div>`;
  }
}

function applySettingsResponse(data: SettingsResponse): void {
  latestSettingsResponse = data;
  renderAgentsList(data);
  if (providerReadinessCache.length > 0) {
    renderProviderReadiness(providerReadinessCache, data);
  }
}

function renderAgentsList(data: SettingsResponse): void {
  const list = document.getElementById("agents-list");
  if (!list) return;
  const cmds = data.settings?.cmds || [];
  const defaultCmd = data.effective?.agentCmd;
  if (cmds.length === 0) {
    list.innerHTML = '<div class="empty">No agents — add one below.</div>';
    return;
  }
  list.innerHTML = cmds.map(c => {
    const isDefault = c.cmd === defaultCmd && c.enabled;
    return `<div class="agent-row${c.enabled ? "" : " disabled"}">
      <input type="checkbox" class="agent-row-checkbox"
        ${c.enabled ? "checked" : ""}
        onchange="toggleAgentEnabled('${escAttr(c.cmd)}', this.checked)"
        aria-label="Enable ${escAttr(c.cmd)}">
      <span class="agent-row-cmd">${esc(c.cmd)}</span>
      ${isDefault ? '<span class="agent-row-default">default</span>' : ""}
      <button class="agent-row-delete"
        onclick="removeAgent('${escAttr(c.cmd)}')"
        title="Remove" aria-label="Remove ${escAttr(c.cmd)}">&times;</button>
    </div>`;
  }).join("");
}

function renderProviderReadiness(
  providers: readonly ProviderReadiness[],
  settings: SettingsResponse | null,
): void {
  const list = document.getElementById("provider-readiness-list");
  if (!list) return;
  const configured = new Set((settings?.settings?.cmds || []).map((entry) => entry.cmd));
  const shellAdded = configured.has(AGENT_KIND.SHELL);
  const shell = `<div class="provider-row installed" data-provider-id="${escAttr(AGENT_KIND.SHELL)}">
    <div class="provider-row-header">
      <span class="provider-name">Shell</span>
      <span class="provider-badge installed">built-in</span>
      <button class="provider-add-btn" data-provider-command="${escAttr(AGENT_KIND.SHELL)}"
        aria-label="${shellAdded ? "Shell added" : "Add Shell"}"
        ${shellAdded ? "disabled" : ""}>${shellAdded ? "added" : "+ add"}</button>
    </div>
    <div class="provider-guidance">Always available as Wolfpack's local terminal fallback.</div>
  </div>`;
  list.innerHTML = shell + providers.map((provider) => {
    if (provider.status === "missing") {
      return `<div class="provider-row missing" data-provider-id="${escAttr(provider.id)}">
        <div class="provider-row-header">
          <span class="provider-name">${esc(provider.displayName)}</span>
          <span class="provider-badge missing">missing</span>
        </div>
        <div class="provider-guidance">install: <code>${esc(provider.installGuidance)}</code></div>
      </div>`;
    }
    const added = configured.has(provider.command);
    const version = provider.version || "version unavailable";
    return `<div class="provider-row installed" data-provider-id="${escAttr(provider.id)}">
      <div class="provider-row-header">
        <span class="provider-name">${esc(provider.displayName)}</span>
        <span class="provider-badge installed">installed</span>
        <button class="provider-add-btn" data-provider-command="${escAttr(provider.command)}"
          aria-label="${escAttr(added ? `${provider.displayName} added` : `Add ${provider.displayName}`)}"
          ${added ? "disabled" : ""}>${added ? "added" : "+ add"}</button>
      </div>
      <div class="provider-version">${esc(version)}</div>
      <div class="provider-path">${esc(provider.executablePath)}</div>
      <div class="provider-guidance">auth unknown · run <code>${esc(provider.loginCommand)}</code> to authenticate or confirm access</div>
    </div>`;
  }).join("");
}

async function updateAgentSettings(body: Record<string, unknown>): Promise<SettingsResponse> {
  return api<SettingsResponse>("/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function toggleAgentEnabled(cmd, enabled) {
  try {
    applySettingsResponse(await updateAgentSettings({ setCmdEnabled: { cmd, enabled } }));
  } catch (e) {
    showAgentAddError("Failed to toggle: " + errorMessage(e));
    loadAgentsSettings();  // refetch to undo optimistic checkbox flip
  }
}

async function removeAgent(cmd) {
  try {
    applySettingsResponse(await updateAgentSettings({ removeCmd: cmd }));
  } catch (e) {
    showAgentAddError("Failed to remove: " + errorMessage(e));
  }
}

async function addDetectedProvider(command: string): Promise<void> {
  showAgentAddError("");
  try {
    applySettingsResponse(await updateAgentSettings({ addCmd: command }));
  } catch (e) {
    showAgentAddError("Could not add provider: " + errorMessage(e));
  }
}

async function addAgent() {
  const input = document.getElementById("agent-add-input") as HTMLInputElement;
  const cmd = (input.value || "").trim();
  if (!cmd) return;
  showAgentAddError("");
  try {
    applySettingsResponse(await updateAgentSettings({ addCmd: cmd }));
    input.value = "";
  } catch (e) {
    // Server returns 400 for invalid characters; surface inline rather than alert.
    showAgentAddError("Could not add: " + errorMessage(e));
  }
}

function showAgentAddError(msg: string): void {
  const el = document.getElementById("agent-add-error");
  if (el) el.textContent = msg;
}

// Wire up provider and custom-command actions when the settings page mounts.
(function bindAgentSettings() {
  const btn = document.getElementById("agent-add-btn");
  const input = document.getElementById("agent-add-input");
  const providers = document.getElementById("provider-readiness-list");
  const refresh = document.getElementById("provider-refresh-btn");
  if (btn) btn.addEventListener("click", () => addAgent());
  if (input) input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addAgent(); }
  });
  if (providers) providers.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const addButton = target.closest<HTMLButtonElement>("[data-provider-command]");
    const command = addButton?.dataset.providerCommand;
    if (command && !addButton.disabled) void addDetectedProvider(command);
  });
  if (refresh) refresh.addEventListener("click", () => { void loadProviderReadiness(); });
})();

// Legacy compatibility: older versions of the picker used these names.
// Keep them as no-op aliases so any cached HTML/inline handlers don't crash
// after upgrade. Safe to remove after a release cycle.
async function deleteCustomCmd(cmd, e) {
  if (e) e.stopPropagation();
  try {
    await api("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ removeCmd: cmd }),
    }, state.projectMachine);
    showAgentPicker();
  } catch (e) {
    alert("Failed to delete command: " + errorMessage(e));
  }
}

async function createSessionWithAgent(cmd) {
  const nameInput = document.getElementById("session-name-input") as HTMLInputElement;
  const sessionName = (nameInput.value || "").trim();
  if (sessionName && !/^[a-zA-Z0-9_-]+$/.test(sessionName)) return;
  const machine = state.projectMachine;
  showTerminalLoading(sessionName || state.selectedProject);
  try {
    const body = state.isNewProject
      ? { newProject: state.selectedProject, cmd, sessionName: sessionName || undefined }
      : { project: state.selectedProject, cmd, sessionName: sessionName || undefined };
    const data = await api<CreateSessionResponse>("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, machine);
    if (data.session) {
      setState({ currentSession: data.session, currentMachine: machine });
      // Refresh session list in background so it doesn't block terminal init
      loadSessions().then(() => { loadSessionSwitcher(); renderSidebar(); });
      if (isGridActive()) {
        // Grid is active — add new session to grid instead of single-terminal
        addToGrid(data.session, machine);
      } else {
        destroyTerminal();
        initTerminal();
      }
    } else {
      alert("Failed to create session: Server returned no session (is wolfpack up to date?)");
      showView("sessions");
      loadSessions();
    }
  } catch (e) {
    alert("Failed to create session: " + errorMessage(e));
    showView("sessions");
    loadSessions();
  }
}

// ── Desktop Terminal (ghostty-web + /ws/pty binary WS) ──

function connectDesktopWs() {
  if (!state.terminalController) return;
  state.terminalController.connect();
}

// Take-control state for single-terminal mode — mirrors grid's gs._displaced / gs._autoTakeControl
var _tcState = { displaced: false, autoTakeControl: false };
let _desktopTakeControlTimer: number | null = null;

function clearDesktopTakeControlTimer(): void {
  if (_desktopTakeControlTimer === null) return;
  clearTimeout(_desktopTakeControlTimer);
  _desktopTakeControlTimer = null;
}

function startDesktopTakeControlFallback(): void {
  clearDesktopTakeControlTimer();
  _desktopTakeControlTimer = scheduleTakeControlFallback({
    getTransport: () => state.terminalController,
    isPending: () => !!document.getElementById("desktop-conflict-overlay"),
    prepareRetry: () => {
      _desktopTakeControlTimer = null;
      _tcState = WP.prepareAutoTakeControl(_tcState);
    },
  });
}

function showDesktopConflictOverlay() {
  const container = document.getElementById("desktop-terminal-container");
  if (!container) return;
  // Force hydration complete so overlay is visible (container may be opacity:0)
  if (state.terminalController && state.terminalController.hydration) state.terminalController.hydration.forceFinish();
  removeDesktopConflictOverlay();
  const overlay = createConflictOverlay("Session active on another device", "Take Control", () => {
    if (!state.terminalController) return;
    var clickAction = WP.handleTakeControlClick(state.terminalController.isConnected);
    if (clickAction === "send-take-control") {
      state.terminalController.sendTakeControl();
      startDesktopTakeControlFallback();
    } else {
      _tcState = WP.prepareAutoTakeControl(_tcState);
      state.terminalController.reconnect({ takeControl: true });
    }
    // Don't remove overlay here — wait for control_granted to confirm
  });
  overlay.id = "desktop-conflict-overlay";
  container.appendChild(overlay);
}

function removeDesktopConflictOverlay() {
  clearDesktopTakeControlTimer();
  const el = document.getElementById("desktop-conflict-overlay");
  if (el) el.remove();
}

function renderCachedTerminalPlaceholder(container: HTMLElement, cached?: string | null): void {
  const text = cachedSnapshotPlaceholderText(cached || "");
  if (!text) return;
  const pre = document.createElement("pre");
  pre.className = CACHED_TERMINAL_PLACEHOLDER_CLASS;
  pre.textContent = text;
  pre.setAttribute("aria-hidden", "true");
  container.appendChild(pre);
}

function removeCachedTerminalPlaceholder(): void {
  document.querySelectorAll("." + CACHED_TERMINAL_PLACEHOLDER_CLASS).forEach((el) => el.remove());
}

function mobileKeyboardShiftElements(): HTMLElement[] {
  return [
    document.getElementById("conn-status"),
    document.getElementById("desktop-terminal-container"),
    document.getElementById("desktop-grid-container"),
    document.getElementById("cmd-palette"),
    document.getElementById("kb-accessory"),
  ].filter((el): el is HTMLElement => !!el);
}

function setMobileKeyboardShift(offsetPx: number): void {
  const transform = offsetPx > 0 ? `translateY(-${offsetPx}px)` : "";
  for (const el of mobileKeyboardShiftElements()) el.style.transform = transform;
}

async function initTerminal(cached?: string, prefillModeOverride?: TerminalPrefillMode): Promise<void> {
  if (state.terminalController) return;
  // Defensive: clear stale timer from a prior session that wasn't properly destroyed
  if (state._cachedFallbackTimer) { clearTimeout(state._cachedFallbackTimer); state._cachedFallbackTimer = null; }
  const isMobile = !isDesktop();
  const container = document.getElementById("desktop-terminal-container");
  document.getElementById("terminal-view")?.classList.remove("terminal-swipe-peek");
  const soloPrefillMode = prefillModeOverride ?? (isMobile
    ? (wpSettings.soloPrefillMode === TERMINAL_PREFILL_MODE.FULL ? TERMINAL_PREFILL_MODE.FULL : TERMINAL_PREFILL_MODE.VIEWPORT)
    : TERMINAL_PREFILL_MODE.FULL);
  const showCachedPlaceholder = false;
  container.style.display = "block";
  container.innerHTML = "";
  if (showCachedPlaceholder) {
    container.classList.add("cached-visible");
    container.classList.remove("hydrating", "hydrated");
    setTerminalLoadVisualState(container, "cached");
    renderCachedTerminalPlaceholder(container, cached);
  } else {
    container.classList.add("hydrating");
    container.classList.remove("hydrated", "cached-visible");
    setTerminalLoadVisualState(container, "prefill-loading");
  }
  const slowLoad = createTerminalSlowPathIndicator(container);
  slowLoad.start("waiting for terminal snapshot");
  document.getElementById("kb-accessory").classList.remove("visible");
  state.kbAccessoryOpen = false;
  document.getElementById("input-bar").style.display = "none";
  document.getElementById("cmd-palette").classList.remove("visible");
  document.getElementById("msg-preview").style.display = "none";

  _tcState = { displaced: false, autoTakeControl: false };
  let _cachedPendingReset = showCachedPlaceholder;
  // Cached placeholders are currently disabled for solo full because stale
  // plaintext can flash at the wrong width before broker prefill hydrates.
  // Keep the fallback timer wired to the flag so this path stays safe if a
  // future gated placeholder policy re-enables it.
  state._cachedFallbackTimer = showCachedPlaceholder ? setTimeout(() => {
    state._cachedFallbackTimer = null;
    const el = document.getElementById("desktop-terminal-container");
    if (el) el.classList.add("hydrated");
  }, 5000) : null;

  state.terminalController = createPtyTerminalController({
    session: state.currentSession,
    machine: state.currentMachine || "",
    scrollback: DESKTOP_TERMINAL_SCROLLBACK,
    prefillMode: soloPrefillMode,
    hydrationMinPendingMs: 80,
    hydrationSettleMs: INITIAL_HYDRATION_SETTLE_MS,
    hydrationSilenceMs: INITIAL_HYDRATION_SILENCE_MS,
    disableStdin: isMobile,
    getHydrationElement: () => document.getElementById("desktop-terminal-container"),
    shouldFocus: () => !isMobile,
    shouldReconnect: () => !!state.terminalController?.term,
    onOpen: (wasReconnect) => {
      if (wasReconnect) wpMetrics.reconnectCount++;
      // Successful WS open clears stale conflict overlay. If the server
      // sees a conflict, onViewerConflict fires after onOpen and re-shows it.
      _tcState = WP.handleControlGranted(_tcState);
      removeDesktopConflictOverlay();
      setTerminalLoadVisualState(container, "prefill-loading");
      slowLoad.start("waiting for terminal prefill");
      setConnState("live");
    },
    onPtyReady: () => {
      // Force a full canvas repaint after prefill completes. FitAddon.fit() and
      // Terminal.resize() both no-op when dimensions haven't changed, so sendFitResize
      // does nothing if the terminal is the same size as before the session switch.
      // renderer.render(forceAll=true) bypasses both guards and repaints every cell.
      if (state.terminalController) state.terminalController.forceRepaint();
    },
    onOutput: (data) => {
      if (_cachedPendingReset) {
        _cachedPendingReset = false;
        if (state._cachedFallbackTimer) { clearTimeout(state._cachedFallbackTimer); state._cachedFallbackTimer = null; }
        // Drop cached-visible on first live data, but DO NOT add `hydrated`
        // here — that's the hydration controller's job, gated on minPendingMs.
        // Adding `hydrated` here used to bypass hydration's hide window and
        // exposed the canvas during the post-prefill resize-redraw burst (the
        // "scrollback flash"). Without `hydrated` the canvas falls back to
        // its default hidden state until hydration finish() runs.
        const el = document.getElementById("desktop-terminal-container");
        if (el) el.classList.remove("cached-visible");
        removeCachedTerminalPlaceholder();
      }
      if (state.enterRetryTimer) { clearTimeout(state.enterRetryTimer); state.enterRetryTimer = null; }
      wpMetrics.wsMessagesReceived++;
      scheduleSnapshotSave(null);
    },
    onSubSessionOpened: (parentSession, session) => {
      if (!isDesktop()) return;
      if (state.currentView !== "terminal") return;
      if (state.currentSession !== parentSession) return;
      if (state.gridSessions.length > 0) return;
      if (session === parentSession) return;
      addToGrid(session, state.currentMachine || "");
    },
    onViewerConflict: () => {
      var r = WP.handleViewerConflict(_tcState);
      _tcState = r.newState;
      slowLoad.stop();
      setTerminalLoadVisualState(container, _tcState.displaced ? "displaced" : "viewer-conflict");
      if (r.action === "auto-take-control") {
        state.terminalController.sendTakeControl();
      } else {
        showDesktopConflictOverlay();
      }
    },
    onControlGranted: () => {
      _tcState = WP.handleControlGranted(_tcState);
      removeDesktopConflictOverlay();
      setTerminalLoadVisualState(container, "hydrating");
      slowLoad.start("restoring terminal control");
      if (isMobile) setMobileGhosttyKeyboardOpen(state.kbAccessoryOpen);
      else if (state.terminalController) state.terminalController.focus();
    },
    onDisconnected: (code, reason) => {
      removeDesktopConflictOverlay();
      var action = WP.classifyDisconnect(code, reason || "");
      if (action === "displaced") {
        _tcState = WP.handleDisplaced(_tcState);
        slowLoad.stop();
        setTerminalLoadVisualState(container, "displaced");
        showDesktopConflictOverlay();
        return;
      }
      if (action === "session-ended") {
        slowLoad.stop();
        setTerminalLoadVisualState(container, "failed");
        setConnState("session-ended");
        const statusEl = document.getElementById("conn-status");
        if (statusEl) statusEl.textContent = "session unavailable \u2014 use \u2190 to go back";
        return;
      }
      if (action === "pty-exited") {
        slowLoad.stop();
        setTerminalLoadVisualState(container, "failed");
        setConnState("session-ended");
        return;
      }
      state.terminalController.scheduleReconnect();
    },
    onReconnecting: () => {
      setTerminalLoadVisualState(container, "reconnecting");
      slowLoad.start("reconnecting terminal");
      setConnState("reconnecting");
    },
    onReconnectExhausted: () => {
      slowLoad.stop();
      setTerminalLoadVisualState(container, "failed");
      setConnState("offline");
    },
    onHydrationStart: () => {
      setTerminalLoadVisualState(container, "hydrating");
      slowLoad.start("hydrating terminal");
    },
    onHydrated: () => {
      slowLoad.stop();
      setTerminalLoadVisualState(container, "live");
      scheduleGhosttyPrewarm();
    },
  });

  await state.terminalController.mount(container, { cached });
  if (!state.terminalController) return; // disposed while awaiting WASM init
  if (!state.terminalController.term) {
    // WASM init failed — show error instead of blank screen
    slowLoad.stop();
    setTerminalLoadVisualState(container, "failed");
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:13px;padding:20px;text-align:center">Terminal unavailable — WebAssembly not supported in this browser</div>';
    return;
  }

  // Mobile: Ghostty owns input semantics; Wolfpack only gates whether its
  // native textarea is allowed to open the virtual keyboard.
  if (isMobile && state.terminalController.term) {
    container.setAttribute("inputmode", "none");
    setMobileGhosttyKeyboardOpen(false);
    state._touchCleanup = setupTouchScrollHandler(
      container, state.terminalController.term,
      (data) => state.terminalController && state.terminalController.send(data),
      () => !!(state.terminalController && state.terminalController.isConnected),
      () => {
        setMobileGhosttyKeyboardOpen(false);
      },
    );
  }

  if (window.visualViewport && isMobile) {
    const vvHandler = () => {
      const kbHeight = window.innerHeight - window.visualViewport.height;
      const kbOpen = kbHeight > 150;
      // Shift terminal sub-elements without changing their layout height.
      // ghostty-web sees no container resize → no reflow → no scroll-through.
      // Keep #terminal-view transform reserved for mobile view/swipe navigation.
      setMobileKeyboardShift(kbOpen ? kbHeight : 0);
      // Viewport is authoritative for collapse only. Opening remains an
      // explicit keyboard-button action so layout changes cannot enable stdin.
      if (!kbOpen && state.kbAccessoryOpen) setMobileGhosttyKeyboardOpen(false);
    };
    window.visualViewport.addEventListener("resize", vvHandler);
    state.visualViewportHandler = vvHandler;
    // Fire once to catch keyboard already open from previous session
    vvHandler();
  }

  connectDesktopWs();
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForTerminalSwitchPaint(): Promise<void> {
  if (!isDesktop()) return;
  // First rAF observes the queued loading styles; second resumes after that
  // frame had a paint opportunity, before teardown/mount blocks the main thread.
  await waitForAnimationFrame();
  await waitForAnimationFrame();
}

function hideTerminalCanvasForTeardown(): void {
  const container = document.getElementById("desktop-terminal-container");
  if (!container || container.style.display === "none") return;
  if (!container.classList.contains("hydrating")) container.classList.add("hydrating");
  container.classList.remove("hydrated", "cached-visible");
  setTerminalLoadVisualState(container, "prefill-loading");
  removeCachedTerminalPlaceholder();
  void container.offsetHeight;
}

function destroyTerminal() {
  hideTerminalCanvasForTeardown();
  if (state._cachedFallbackTimer) { clearTimeout(state._cachedFallbackTimer); state._cachedFallbackTimer = null; }
  if (state.snapshotTimer) { clearTimeout(state.snapshotTimer); state.snapshotTimer = null; }
  // Always flush snapshot before disposing terminal — even if no timer was
  // pending, the terminal has content worth persisting for instant restore.
  flushSnapshot();
  if (state._touchCleanup) { state._touchCleanup(); state._touchCleanup = null; }
  if (!isDesktop()) setMobileGhosttyKeyboardOpen(false);
  if (state.terminalController) { state.terminalController.dispose(); state.terminalController = null; }
  // Clean up visualViewport handler
  if (state.visualViewportHandler && window.visualViewport) {
    window.visualViewport.removeEventListener("resize", state.visualViewportHandler);
    state.visualViewportHandler = null;
  }
  // Reset terminal positioning
  const termView = document.getElementById("terminal-view");
  if (termView) { termView.style.bottom = ""; termView.style.transform = ""; }
  setMobileKeyboardShift(0);
  if (state.kbResizeTimer) { clearTimeout(state.kbResizeTimer); state.kbResizeTimer = null; }
  const container = document.getElementById("desktop-terminal-container");
  container.removeAttribute("inputmode");
  container.style.display = "none";
  container.classList.remove("hydrating", "hydrated");
  container.innerHTML = "";
  document.getElementById("input-bar").style.display = "";
  renderCmdPalette();
}

// ── Terminal ──

function terminalSessionKey() {
  return (state.currentMachine || "") + "|" + (state.currentSession || "");
}

function setConnState(connState: string): void {
  const statusEl = document.getElementById("conn-status");
  if (!statusEl) return;
  const active = !!state.terminalController?.term;
  if (state.currentView !== "terminal" || !active || connState === "live") {
    statusEl.style.display = "none";
    statusEl.style.background = "#cc3333";
    return;
  }
  if (connState === "reconnecting") {
    statusEl.style.display = "block";
    statusEl.style.background = "#8a5a00";
    statusEl.innerHTML = '<img src="/wolfpack-icon.svg" class="conn-icon">reconnecting\u2026';
    return;
  }
  if (connState === "offline") {
    statusEl.style.display = "block";
    statusEl.style.background = "#cc3333";
    statusEl.innerHTML = '<img src="/wolfpack-icon.svg" class="conn-icon">connection lost \u2014 <button type="button" id="conn-retry-btn" class="conn-retry-btn">Reconnect</button>';
    const retryBtn = document.getElementById("conn-retry-btn");
    if (retryBtn) retryBtn.onclick = retryConnection;
    return;
  }
  statusEl.style.display = "block";
  statusEl.style.background = "#cc3333";
  statusEl.textContent = "session ended \u2014 use \u2190 to go back";
}



function retryConnection() {
  if (!state.terminalController?.term) return;
  setConnState("reconnecting");
  connectDesktopWs();
}

function sendMsg() {
  const input = document.getElementById("msg-input") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text || !state.currentSession) return;
  const saved = text;
  input.value = "";
  clearDraft();
  autoResizeInput();
  document.getElementById("msg-preview").style.display = "none";

  // Flash send button
  const btn = document.getElementById("send-btn");
  btn.classList.remove("send-flash");
  void btn.offsetWidth; // force reflow
  btn.classList.add("send-flash");

  wpMetrics.sendCount++;
  if (_sendTerminalInput(_textEncoder.encode(text.replace(/\n/g, " ") + "\r"))) {
    // No Enter-retry timer here. The previous 800ms retry submitted a
    // duplicate Enter on any command that took >800ms to produce output
    // (slow grep, network request, interactive prompt waiting for input),
    // potentially triggering an unintended second command or corrupting
    // TUI confirm prompts. The send-success branch trusts
    // _sendTerminalInput's return: if the WS layer reports success, the
    // bytes are queued; broker drops surface as reconnects, not silent
    // input loss. enterRetryTimer is still cleared on output dispatch in
    // case any older path schedules one.
  } else {
    wpMetrics.sendFailCount++;
    input.value = saved;
    saveDraft();
    autoResizeInput();
    updatePreview();
  }
}

function updatePreview() {
  const input = document.getElementById("msg-input") as HTMLTextAreaElement;
  const preview = document.getElementById("msg-preview");
  if (input.scrollWidth > input.clientWidth) {
    preview.textContent = input.value;
    preview.style.display = "block";
  } else {
    preview.style.display = "none";
  }
}

function sendTerminalText(text: string): void {
  if (!state.currentSession) return;
  wpMetrics.sendCount++;
  if (_sendTerminalInput(_textEncoder.encode(text))) return;
  wpMetrics.sendFailCount++;
}

function sendKey(key: string): void {
  const esc = KEY_TO_ESCAPE[key];
  if (!esc) return;
  sendTerminalText(esc);
}

function sendAccessoryKey(key: string): void {
  if (key === "Enter") {
    sendTerminalText("\n");
    return;
  }
  sendKey(key);
}

async function killSession(name, e, machineUrl) {
  e.stopPropagation();
  if (!confirm(`Kill session "${name}"?`)) return;
  try {
    await api("/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: name }),
    }, machineUrl || "");
  } catch (e) {
    alert("Failed to kill session: " + errorMessage(e));
    return;
  }
  const wasCurrentSession = name === state.currentSession && (machineUrl || "") === state.currentMachine;
  if (wasCurrentSession && state.currentView === "terminal") {
    destroyTerminal();
    setState({ currentSession: null, currentMachine: "" });
    showView("sessions");
  }
  loadSessions().then(renderSidebar);
}

// ── Session drawer ──

function renderDrawerList() {
  const groups = state.lastSessionGroups;
  const list = document.getElementById("drawer-list");
  const multiMachine = getMachines().length > 0;

  // Build flat session list
  const all = [];
  for (const g of groups) {
    for (const s of g.sessions) {
      all.push({ ...s, machineUrl: g.machine.url, machineName: g.machine.name });
    }
  }

  let html = "";
  html += all.map(s => drawerItemHtml(s, multiMachine)).join("");
  if (!all.length) {
    html += `<div class="sidebar-empty">No active sessions</div>`;
  }

  list.innerHTML = html;
  list.querySelectorAll(".drawer-item").forEach(el => {
    const item = el as HTMLElement;
    item.onclick = () => {
      switchSession(item.dataset.val); closeDrawer();
    };
  });
  const chipLabel = document.getElementById("chip-label");
  if (chipLabel) chipLabel.textContent = state.currentSession || "";
}

function drawerItemHtml(s, multiMachine) {
  const val = s.machineUrl ? s.machineUrl + "|" + s.name : s.name;
  const isCurrent = s.name === state.currentSession && s.machineUrl === state.currentMachine;
  const machineLbl = multiMachine ? `<span class="drawer-item-machine">${esc(s.machineName)}</span>` : "";
  return `<div class="drawer-item${isCurrent ? " current" : ""}" data-val="${escAttr(val)}">
    <div class="dot ${isCurrent ? "active" : "inactive"}" title="${isCurrent ? "current session" : "other session"}"></div>
    <span class="drawer-item-name">${esc(s.name)}</span>
    ${machineLbl}
  </div>`;
}

function loadSessionSwitcher() {
  renderDrawerList();
}

var lastToggleT = 0;
function toggleDrawer() {
  if (isDesktop()) return; // sidebar handles session switching on desktop
  var now = Date.now();
  if (now - lastToggleT < 300) return;
  lastToggleT = now;
  if (state.drawerOpen) closeDrawer();
  else openDrawer();
}

function openDrawer() {
  if (isDesktop()) return; // sidebar handles session switching on desktop
  if (state.drawerOpen) return;
  state.drawerOpen = true;
  loadSessions().then(renderDrawerList); // fresh data on open
  const drawer = document.getElementById("session-drawer");
  const backdrop = document.getElementById("drawer-backdrop");
  const chip = document.getElementById("session-chip");
  // remove transition for instant position, then add for animation
  drawer.classList.remove("animating");
  drawer.style.transform = "translate3d(0, -100%, 0)";
  backdrop.classList.add("visible");
  backdrop.style.opacity = "0";
  drawer.offsetHeight; // force reflow
  drawer.classList.add("animating");
  drawer.classList.add("open");
  drawer.style.transform = "";
  backdrop.style.transition = "opacity 0.25s ease";
  backdrop.style.opacity = "1";
  chip.classList.add("open");
  haptic(5);
}

function closeDrawer(instant?: boolean): void {
  if (!state.drawerOpen) return;
  state.drawerOpen = false;
  const drawer = document.getElementById("session-drawer");
  const backdrop = document.getElementById("drawer-backdrop");
  const chip = document.getElementById("session-chip");
  chip.classList.remove("open");
  if (instant) {
    drawer.classList.remove("animating", "open");
    drawer.style.transform = "";
    backdrop.classList.remove("visible");
    backdrop.style.opacity = "";
    backdrop.style.transition = "";
    return;
  }
  drawer.classList.add("animating");
  drawer.classList.remove("open");
  drawer.style.transform = "translate3d(0, -100%, 0)";
  backdrop.style.transition = "opacity 0.25s ease";
  backdrop.style.opacity = "0";
  const cleanup = () => {
    backdrop.classList.remove("visible");
    backdrop.style.opacity = "";
    backdrop.style.transition = "";
    drawer.style.transform = "";
    drawer.classList.remove("animating");
  };
  drawer.addEventListener("transitionend", cleanup, { once: true });
  setTimeout(cleanup, 300);
}

// Drag gesture for drawer — header (open) + drawer itself (close)
(function initDrawerDrag() {
  const hdr = document.querySelector("header");
  const drawer = document.getElementById("session-drawer");
  const backdrop = document.getElementById("drawer-backdrop");
  let startY = 0, startX = 0, startTime = 0, dragging = false, maxDrag = 0;
  let touchTarget = null;

  function onStart(e) {
    if (state.currentView !== "terminal") return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startTime = Date.now();
    dragging = false;
    touchTarget = e.target;
    maxDrag = Math.min(drawer.scrollHeight, window.innerHeight * 0.5);
  }

  function onMove(e) {
    if (state.currentView !== "terminal") return;
    const dy = e.touches[0].clientY - startY;
    // opening: drag down when closed (header only)
    if (!state.drawerOpen && dy > 5) {
      if (!dragging) {
        dragging = true;
        drawer.classList.remove("animating", "open");
        drawer.style.pointerEvents = "none";
        backdrop.classList.add("visible");
      }
      const progress = Math.min(dy / maxDrag, 1);
      drawer.style.transform = `translate3d(0, ${-100 + progress * 100}%, 0)`;
      backdrop.style.opacity = String(progress);
      backdrop.style.transition = "none";
    }
    // closing: drag up when open (header or drawer)
    if (state.drawerOpen && dy < -5) {
      if (!dragging) {
        dragging = true;
        drawer.classList.remove("animating");
      }
      const progress = Math.min(Math.abs(dy) / maxDrag, 1);
      drawer.style.transform = `translate3d(0, ${-progress * 100}%, 0)`;
      backdrop.style.opacity = String(1 - progress);
      backdrop.style.transition = "none";
    }
  }

  function onEnd(e) {
    if (!dragging) {
      // Tap detection: if touch was short + small movement, fire tap on chip/drawer items
      const dt = Date.now() - startTime;
      const ex = e.changedTouches[0].clientX, ey = e.changedTouches[0].clientY;
      const dist = Math.abs(ex - startX) + Math.abs(ey - startY);
      if (dt < 300 && dist < 15 && touchTarget) {
        const chip = document.getElementById("session-chip");
        if (chip && chip.contains(touchTarget)) { toggleDrawer(); return; }
        const item = touchTarget.closest(".drawer-item");
        if (item && state.drawerOpen) { item.click(); return; }
      }
      return;
    }
    dragging = false;
    const dy = e.changedTouches[0].clientY - startY;
    const elapsed = Date.now() - startTime;
    const velocity = Math.abs(dy) / Math.max(elapsed, 1) * 1000;
    const threshold = maxDrag * 0.25;

    if (!state.drawerOpen) {
      // was dragging to open
      if (dy > threshold || (velocity > 300 && dy > 10)) {
        const baseDur = 0.22;
        const speedFactor = Math.min(velocity / 1500, 1);
        const dur = Math.max(0.1, baseDur * (1 - speedFactor * 0.6));
        drawer.style.transition = `transform ${dur.toFixed(2)}s cubic-bezier(0.2, 0.9, 0.3, 1)`;
        drawer.style.transform = "translate3d(0, 0, 0)";
        backdrop.style.transition = `opacity ${dur.toFixed(2)}s ease`;
        backdrop.style.opacity = "1";
        state.drawerOpen = true;
        document.getElementById("session-chip").classList.add("open");
        haptic(5);
        drawer.addEventListener("transitionend", () => {
          drawer.style.transition = "";
          drawer.style.pointerEvents = "";
          drawer.classList.add("open");
        }, { once: true });
      } else {
        drawer.style.transition = "transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1)";
        drawer.style.transform = "translate3d(0, -100%, 0)";
        backdrop.style.transition = "opacity 0.2s ease";
        backdrop.style.opacity = "0";
        drawer.addEventListener("transitionend", () => {
          drawer.style.transition = ""; drawer.style.transform = ""; drawer.style.pointerEvents = "";
          backdrop.classList.remove("visible"); backdrop.style.opacity = ""; backdrop.style.transition = "";
        }, { once: true });
      }
    } else {
      // was dragging to close
      if (Math.abs(dy) > threshold || (velocity > 300 && dy < -10)) {
        closeDrawer();
      } else {
        drawer.style.transition = "transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1)";
        drawer.style.transform = "translate3d(0, 0, 0)";
        backdrop.style.transition = "opacity 0.2s ease";
        backdrop.style.opacity = "1";
        drawer.addEventListener("transitionend", () => {
          drawer.style.transition = ""; drawer.classList.add("open");
        }, { once: true });
      }
    }
  }

  // Header: drag down to open, drag up to close
  hdr.addEventListener("touchstart", onStart, { passive: true });
  hdr.addEventListener("touchmove", onMove, { passive: true });
  hdr.addEventListener("touchend", onEnd, { passive: true });
  // Drawer: drag up to close
  drawer.addEventListener("touchstart", onStart, { passive: true });
  drawer.addEventListener("touchmove", onMove, { passive: true });
  drawer.addEventListener("touchend", onEnd, { passive: true });
})();

async function switchSession(val) {
  state.sidebarResizeDone = false;
  let name, machineUrl;
  // Values with | are remote: "url|sessionName"
  const pipeIdx = val.indexOf("|");
  if (pipeIdx !== -1) {
    machineUrl = val.substring(0, pipeIdx);
    name = val.substring(pipeIdx + 1);
  } else {
    machineUrl = "";
    name = val;
  }
  if (name === state.currentSession && machineUrl === state.currentMachine) {
    // Same session — reconnect or reinitialize if the terminal is not active.
    if (state.terminalController) {
      if (!state.terminalController.isConnected) connectDesktopWs();
    } else if (state.currentView === "terminal") {
      initTerminal();
    }
    return;
  }
  hideTerminalCanvasForTeardown();
  await waitForTerminalSwitchPaint();
  closeDrawer(true);
  // Exit grid mode if active
  if (isGridActive()) exitGridMode();
  // Suspend current mode (cache terminal state)
  destroyTerminal();
  setState({ currentSession: name, currentMachine: machineUrl });
  recordRecent(machineUrl, name);
  restoreDraft();
  const cached = loadSnapshot(machineUrl, name);
  loadSessionSwitcher();
  // Update machine label in header (showView sets it, but drawer bypasses showView)
  const hml = document.getElementById("header-machine-label");
  if (getMachines().length > 0) {
    const mName = machineUrl
      ? (getMachines().find(m => m.url === machineUrl)?.name || "remote")
      : (state.selfName || "local");
    hml.textContent = mName;
    hml.style.display = "block";
  }
  void initTerminal(cached, TERMINAL_PREFILL_MODE.FULL);
  renderSidebar();
}


// ── Notifications ──
// Push notifications are handled server-side. Frontend only tracks state for haptic feedback.

const prevSessionStates = {};  // "machineUrl|sessionName" → triage
function checkStateTransitions(groups) {
  if (!wpSettings.notifications) return;

  for (const g of groups) {
    if (!g.online) continue;
    const mUrl = g.machine.url || "";

    for (const s of g.sessions) {
      const key = mUrl + "|" + s.name;
      const prev = prevSessionStates[key];
      const cur = s.triage || "idle";
      prevSessionStates[key] = cur;
      if (prev === "running" && cur === "idle") {
        haptic([200, 100, 200]);
      }
    }

    checkRalphTransitions(g.loops, mUrl, g.machine.name || "local");
  }
}

// Recover terminal stream on foreground; manage session refresh
var _hiddenAt = 0;
const DESKTOP_STALE_THRESHOLD_MS = 60_000;

function activeGridTerminalSessions(): typeof state.gridSessions | null {
  if (state.activeDelegationRoot && !state.focusedDelegationSession) return state.delegationGridSessions;
  return isGridActive() ? state.gridSessions : null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    const hiddenDuration = _hiddenAt ? Date.now() - _hiddenAt : 0;
    _hiddenAt = 0;
    if (isDesktop() && !sidebarRefreshTimer) {
      startSidebarRefresh();
    }
    // Restart session refresh if on sessions view
    if (state.currentView === "sessions" && !state.sessionRefreshTimer) {
      loadSessions();
      state.sessionRefreshTimer = setInterval(loadSessions, 5000);
    }
    if (state.currentSession && state.currentView === "terminal") {
      if (!isDesktop()) {
        // Mobile: always force-reconnect — iOS/Android background tabs kill
        // TCP silently while readyState still reports OPEN.
        const gridSessions = activeGridTerminalSessions();
        if (gridSessions) {
          for (const gs of gridSessions) {
            if (!gs.controller || gs._displaced) continue;
            gs.controller.resetRetry();
            gs.controller.reconnect();
          }
        } else if (state.terminalController?.term) {
          state.terminalController.resetRetry();
          state.terminalController.reconnect();
        }
      } else if (hiddenDuration > DESKTOP_STALE_THRESHOLD_MS) {
        // Desktop: force-reconnect if tab was backgrounded >60s.
        // Browser throttling / App Nap can silently kill TCP while
        // readyState still reports OPEN (zombie socket). Force-close
        // and reconnect to get fresh data, matching mobile behavior.
        // Force-reconnect unconditionally — zombie sockets report readyState=OPEN
        // so isConnected would be true even though the socket is dead.
        const gridSessions = activeGridTerminalSessions();
        if (gridSessions) {
          for (const gs of gridSessions) {
            if (!gs.controller || gs._displaced) continue;
            gs.controller.resetRetry();
            gs.controller.reconnect();
          }
        } else if (state.terminalController?.term) {
          state.terminalController.resetRetry();
          state.terminalController.reconnect();
        }
      } else {
        // Short background (<60s): no reconnect needed, but canvas backing store
        // may have been invalidated by browser compositor (App Nap, power saving).
        // A forced repaint recovers without re-streaming any data.
        const gridSessions = activeGridTerminalSessions();
        if (gridSessions) {
          for (const gs of gridSessions) {
            if (gs.controller) gs.controller.forceRepaint?.();
          }
        } else if (state.terminalController?.term) {
          state.terminalController.forceRepaint();
        }
      }
    }
  } else {
    _hiddenAt = Date.now();
    // Stop session refresh when backgrounded
    if (state.sessionRefreshTimer) {
      clearInterval(state.sessionRefreshTimer);
      state.sessionRefreshTimer = null;
    }
    if (sidebarRefreshTimer) {
      clearInterval(sidebarRefreshTimer);
      sidebarRefreshTimer = null;
    }
  }
});

// ── Canvas backing-store recovery ──
//
// macOS App Nap and Chrome's tab-freeze can reclaim the 2D canvas backing
// store while the tab is technically "visible" (window unfocused, switched
// to another app). visibilitychange does NOT fire for these cases. Ghostty's
// render loop only repaints dirty rows, so cells written before the freeze
// stay invisible after resume — user sees stale/black backgrounds where
// SGR-styled cells used to be.
//
// Fix: trigger forceRepaint on additional events that catch the resume
// without requiring a full reconnect.
//   - window focus: user alt-tabs back to the browser window
//   - pageshow with persisted=true: bfcache restore (e.g. iOS swipe-back)
//   - periodic heartbeat (30s): catches App Nap that doesn't fire any event
function _wfRepaintAllTerminals() {
  if (state.currentView !== "terminal") return;
  const gridSessions = activeGridTerminalSessions();
  if (gridSessions) {
    for (const gs of gridSessions) {
      if (gs.controller && !gs._displaced) gs.controller.forceRepaint?.();
    }
  } else if (state.terminalController?.term) {
    state.terminalController.forceRepaint();
  }
}

window.addEventListener("focus", _wfRepaintAllTerminals);
window.addEventListener("pageshow", (e: PageTransitionEvent) => {
  if (e.persisted) _wfRepaintAllTerminals();
});
// 30s heartbeat: cheap (one canvas draw call) and only runs while visible.
// Cleared/recreated by the visibilitychange handler isn't necessary because
// background tabs throttle setInterval anyway — no wasted work.
setInterval(() => {
  if (document.visibilityState === "visible") _wfRepaintAllTerminals();
}, 30_000);

// Dismiss preview when tapping terminal area
document.getElementById("desktop-terminal-container").addEventListener("click", () => {
  document.getElementById("msg-preview").style.display = "none";
});

// Auto-resize textarea as content grows
function autoResizeInput() {
  const ta = document.getElementById("msg-input") as HTMLTextAreaElement;
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
}

const msgInput = document.getElementById("msg-input") as HTMLTextAreaElement;
msgInput.addEventListener("input", () => {
  autoResizeInput();
  updatePreview();
  saveDraft();
});
// Textarea Enter behavior follows enterSends; the mobile accessory row handles
// focused-textarea Enter separately so it can insert a newline.

msgInput.addEventListener("keydown", (e) => {
  if (state.currentView !== "terminal") return;
  const empty = !msgInput.value.trim();
  if (e.key === "Enter") {
    if (WP.shouldSubmitMessageInputOnEnter({
      key: e.key,
      shiftKey: e.shiftKey,
      enterSends: wpSettings.enterSends,
      isDesktop: isDesktop(),
    })) {
      e.preventDefault();
      if (empty) sendKey("Enter"); else sendMsg();
    }
  } else if (e.key === "ArrowUp" && empty) {
    e.preventDefault();
    sendKey("Up");
  } else if (e.key === "ArrowDown" && empty) {
    e.preventDefault();
    sendKey("Down");
  }
});

// ── Hold-to-send on send button (UX-07) ──
// When holdToSend enabled and message is large (>50 chars), require 400ms hold.
// Short messages or holdToSend disabled → instant send on tap.
(function setupSendButton() {
  const btn = document.getElementById("send-btn");
  const HOLD_MS = 400;
  const LARGE_THRESHOLD = 50;
  let holdTimer = null;
  let holdStarted = false;

  function needsHold() {
    if (!wpSettings.holdToSend) return false;
    const text = (document.getElementById("msg-input") as HTMLTextAreaElement).value.trim();
    return text.length > LARGE_THRESHOLD;
  }

  function startHold(e) {
    if (!needsHold()) { sendMsg(); return; }
    e.preventDefault();
    holdStarted = true;
    btn.classList.add("holding");
    btn.style.setProperty("--hold-duration", HOLD_MS + "ms");
    holdTimer = setTimeout(() => {
      btn.classList.remove("holding");
      btn.classList.add("hold-complete");
      haptic([10, 30, 10]);
      sendMsg();
      setTimeout(() => btn.classList.remove("hold-complete"), 300);
      holdStarted = false;
    }, HOLD_MS);
  }

  function cancelHold() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    btn.classList.remove("holding", "hold-complete");
    holdStarted = false;
  }

  // Touch events for mobile
  btn.addEventListener("touchstart", (e) => { startHold(e); }, {passive: false});
  btn.addEventListener("touchend", cancelHold);
  btn.addEventListener("touchcancel", cancelHold);

  // Mouse events for desktop
  btn.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    startHold(e);
  });
  btn.addEventListener("mouseup", cancelHold);
  btn.addEventListener("mouseleave", cancelHold);
})();

// ── Keyboard accessory row (UX-15) ──
// Toggle-based: user taps ⌨ button in input bar to show/hide.
// Always starts closed on session entry.
function toggleKbAccessory() {
  const acc = document.getElementById("kb-accessory");
  const cmd = document.getElementById("cmd-palette");
  if (!acc) return;
  state.kbAccessoryOpen = !state.kbAccessoryOpen;
  acc.classList.toggle("visible", state.kbAccessoryOpen);
  if (cmd && cmd.innerHTML) cmd.classList.toggle("visible", state.kbAccessoryOpen);
  haptic([10]);
}

function insertMessageInputNewline(): void {
  const input = document.getElementById("msg-input") as HTMLTextAreaElement;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  input.value = input.value.slice(0, start) + "\n" + input.value.slice(end);
  input.selectionStart = start + 1;
  input.selectionEnd = start + 1;
  autoResizeInput();
  updatePreview();
  saveDraft();
}

(function setupKbAccessory() {
  const acc = document.getElementById("kb-accessory");
  if (!acc) return;

  // Wire up all keys — prevent blur with mousedown/touchstart preventDefault
  acc.querySelectorAll(".kb-key").forEach((btn) => {
    const key = (btn as HTMLElement).dataset.key;
    // Skip buttons with their own onclick (e.g. git button)
    if (!key) return;
    let touchFired = false;

    function fire() {
      haptic([15]);
      const messageInput = document.getElementById("msg-input") as HTMLTextAreaElement;
      if (WP.shouldInsertMessageNewlineFromAccessoryKey({
        key,
        isMessageInputActive: document.activeElement === messageInput,
        hasMessageInputDraft: messageInput.value.length > 0,
      })) {
        insertMessageInputNewline();
        return;
      }
      sendAccessoryKey(key);
    }

    // Prevent focus steal (keeps keyboard open)
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("touchstart", (e) => {
      e.preventDefault();
      touchFired = true;
      fire();
    }, { passive: false });

    // Click handler for non-touch devices only
    btn.addEventListener("click", () => {
      if (touchFired) { touchFired = false; return; }
      fire();
    });
  });
})();

(function setupMobileGhosttyKeyboard() {
  const kbOpenBtn = document.getElementById("kb-open-btn");
  if (!kbOpenBtn) return;
  kbOpenBtn.addEventListener("mousedown", (event) => event.preventDefault());
  kbOpenBtn.addEventListener("touchstart", () => {
    haptic([15]);
  }, { passive: true });
  kbOpenBtn.addEventListener("click", () => {
    setMobileGhosttyKeyboardOpen(!state.kbAccessoryOpen);
  });
})();


// Navigate back to fully expanded sessions view (desktop: expand mode, mobile: just sessions)
function backToSessions() {
  if (isDesktop()) {
    state.sessionsExpanded = true;
    document.body.classList.add("sessions-expanded");
    const expandBtn = document.getElementById("sidebar-expand-btn");
    if (expandBtn) expandBtn.classList.add("active");
    const sb = document.getElementById("desktop-sidebar");
    if (sb) { sb.classList.add("collapsed"); state.sidebarCollapsed = true; state.sidebarAutoExpanded = false; }
  }
  showView("sessions");
  loadSessions();
}

// Escape to back out of project/agent picker and ralph views
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (state.focusedDelegationSession) {
    e.preventDefault();
    e.stopPropagation();
    returnToDelegationGrid();
  }
  if (state.currentView === "agent") { e.preventDefault(); showView("projects"); }
  else if (state.currentView === "projects") { e.preventDefault(); returnFromProjectPicker(); }
  else if (state.currentView === "ralph-start" || state.currentView === "ralph-detail") { e.preventDefault(); backFromRalph(); }
  else if (state.currentView === "settings") { e.preventDefault(); backFromSettings(); }
});

// ── Desktop keyboard shortcuts (capture phase, before terminal) ──
document.addEventListener("keydown", (e) => {
  if (!isDesktop()) return;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;

  // Cmd+ArrowUp / Cmd+ArrowDown — previous/next session (grid focus or sidebar)
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    e.stopPropagation();
    if (isGridActive()) {
      const count = state.gridSessions.length;
      const next = e.key === "ArrowDown"
        ? (state.gridFocusIndex + 1) % count
        : (state.gridFocusIndex - 1 + count) % count;
      setGridFocus(next);
      return;
    }
    if (!state.allSessions.length) return;
    let curIdx = state.allSessions.findIndex(s => s.name === state.currentSession && (s.machineUrl || "") === state.currentMachine);
    if (curIdx === -1) curIdx = e.key === "ArrowDown" ? -1 : state.allSessions.length;
    const next = e.key === "ArrowDown"
      ? (curIdx + 1) % state.allSessions.length
      : (curIdx - 1 + state.allSessions.length) % state.allSessions.length;
    const s = state.allSessions[next];
    openSession(s.name, s.machineUrl || undefined);
    return;
  }

  // Cmd+T — new session (project picker)
  if (e.key === "t") {
    e.preventDefault();
    e.stopPropagation();
    showProjectPicker();
    return;
  }

  // Cmd+K — clear terminal (focused grid cell or single terminal)
  if (e.key === "k") {
    e.preventDefault();
    e.stopPropagation();
    if (isGridActive()) {
      const gs = state.gridSessions[state.gridFocusIndex];
      if (gs && gs.controller && gs.controller.term) gs.controller.term.clear();
    } else if (state.terminalController?.term) {
      state.terminalController.term.clear();
    }
    return;
  }

  // Cmd+ArrowLeft/Right — grid cell navigation (left/right within row)
  if (isGridActive() && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    e.preventDefault();
    e.stopPropagation();
    const count = state.gridSessions.length;
    let newIdx = state.gridFocusIndex;
    if (e.key === "ArrowLeft") newIdx = Math.max(0, state.gridFocusIndex - 1);
    else if (e.key === "ArrowRight") newIdx = Math.min(count - 1, state.gridFocusIndex + 1);
    if (newIdx !== state.gridFocusIndex) setGridFocus(newIdx);
    return;
  }
}, true);

const newProjectNameInput = document.getElementById("new-project-name") as HTMLInputElement;
newProjectNameInput.addEventListener("input", () => {
  if (projectNames === null) return;
  renderProjectNames(filterProjectNames(projectNames, newProjectNameInput.value));
});
newProjectNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") selectNewProject();
});

// ── Settings ──

async function showSettings() {
  setState({ viewBeforeSettings: state.currentView });
  showView("settings");
  renderMachinesList();
  toggleDebugPanel();
}

async function renderMachinesList() {
  const machines = getMachines();
  const el = document.getElementById("machines-list");
  if (!machines.length) {
    el.innerHTML = '<div class="no-machines">No remote machines added</div>';
    return;
  }
  // Check status of each machine
  const checks = await Promise.all(machines.map(m =>
    fetch(new URL("/api/info", m.url).href, { signal: AbortSignal.timeout(3000) })
      .then(() => true).catch(() => false)
  ));
  el.innerHTML = machines.map((m, i) => {
    const dot = checks[i] ? "green" : "red";
    const dotTitle = checks[i] ? "online" : "offline";
    return `<div class="machine-item">
      <div class="dot ${dot}" title="${dotTitle}"></div>
      <span class="machine-item-name">${esc(m.name)}<span class="machine-item-url">${esc(m.url)}</span></span>
      <button class="machine-remove-btn" onclick="removeMachineUI('${escAttr(m.url)}')">&times;</button>
    </div>`;
  }).join("");
}

function removeMachineUI(url: string): void {
  removeMachine(url);
  renderMachinesList();
}

async function discoverMachines() {
  const statusEl = document.getElementById("discover-status");
  statusEl.textContent = "Scanning tailnet...";
  statusEl.style.color = "#555";
  try {
    const data = await api<DiscoverResponse>("/discover");
    const peers = data.peers || [];
    if (!peers.length) {
      statusEl.textContent = "No wolfpack instances found on tailnet";
      statusEl.style.color = "#555";
      return;
    }
    const peerUrls = new Set(peers.map(p => p.url));
    let machines = getMachines();
    // Prune stale machines no longer in peer list
    const before = machines.length;
    machines = machines.filter(m => peerUrls.has(m.url));
    const pruned = before - machines.length;
    // Add new / update existing
    let added = 0;
    for (const p of peers) {
      const existing = machines.find(m => m.url === p.url);
      if (!existing) {
        machines.push({ url: p.url, name: p.name || p.hostname });
        added++;
      } else if (existing.name !== (p.name || p.hostname)) {
        existing.name = p.name || p.hostname;
      }
    }
    if (added > 0 || pruned > 0) {
      saveMachines(machines);
      renderMachinesList();
    }
    const parts = [`Found ${peers.length}`];
    if (added > 0) parts.push(`added ${added}`);
    if (pruned > 0) parts.push(`pruned ${pruned} stale`);
    if (!added && !pruned) parts.push("all up to date");
    statusEl.textContent = parts.join(", ");
    statusEl.style.color = "#00ff41";
  } catch (e) {
    statusEl.textContent = errorMessage(e);
    statusEl.style.color = "#cc3333";
  }
}



// ── Swipe Gesture Engine (mobile only) ──
if (!isDesktop()) {
  const vc = document.getElementById("view-container");
  let sx = 0, sy = 0, st = 0, dx = 0;
  let locked = false, scrolling = false, rafId = 0;
  let isBack = false;
  let fgEl = null, bgEl = null;
  let swipeCard = null;
  let forwardTargetView: string | null = null;
  const W = () => window.innerWidth;

  const BACK_TARGET = {
    terminal: "sessions", "ralph-detail": "sessions",
    projects: "sessions", agent: "projects", settings: "sessions",
    "ralph-start": "sessions",
  };

  function applySwipe() {
    if (!fgEl) return;
    const progress = Math.min(Math.abs(dx) / W(), 1);
    if (isBack) {
      fgEl.style.transform = `translate3d(${Math.max(0, dx)}px, 0, 0)`;
      bgEl.style.transform = `translate3d(${-30 + progress * 30}%, 0, 0)`;
    } else {
      // card follows finger, terminal peeks in from right
      if (swipeCard) swipeCard.style.transform = `translate3d(${Math.min(0, dx)}px, 0, 0)`;
      bgEl.style.transform = `translate3d(${100 - progress * 100}%, 0, 0)`;
    }
  }

  vc.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    st = Date.now(); dx = 0;
    locked = false; scrolling = false;
    fgEl = null; bgEl = null; swipeCard = null; forwardTargetView = null;
  }, { passive: true });

  vc.addEventListener("touchmove", (e) => {
    if (e.touches.length !== 1 || scrolling) return;
    const cx = e.touches[0].clientX, cy = e.touches[0].clientY;
    dx = cx - sx;
    const dy = cy - sy;

    if (!locked) {
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      if (Math.abs(dy) > Math.abs(dx) * 0.7) { scrolling = true; return; }
      locked = true;

      const backTarget = BACK_TARGET[state.currentView];
      // terminal view: only allow back swipe from left edge (40px) to avoid stealing terminal interaction
      const edgeOnly = state.currentView === "terminal";
      if (dx > 0 && backTarget && (!edgeOnly || sx < 40)) {
        isBack = true;
        fgEl = document.getElementById(state.currentView + "-view");
        bgEl = document.getElementById(backTarget + "-view");
      } else if (dx < 0) {
        const card = (e.target as Element | null)?.closest(".card, .ralph-card") ?? null;
        if (!card) { scrolling = true; return; }
        swipeCard = card;
        isBack = false;
        fgEl = document.getElementById(state.currentView + "-view");
        const isRalphCard = card.classList.contains("ralph-card");
        forwardTargetView = state.currentView === "sessions" ? (isRalphCard ? "ralph-detail" : "terminal") : null;
        if (!forwardTargetView) { scrolling = true; return; }
        bgEl = document.getElementById(forwardTargetView + "-view");
      } else { scrolling = true; return; }

      vc.classList.add("swipe-active");

      if (isBack) {
        fgEl.style.zIndex = "2";
        fgEl.classList.add("swiping");
        bgEl.style.transform = "translate3d(-30%, 0, 0)";
        bgEl.classList.add("visible");
        bgEl.style.zIndex = "0";
      } else {
        // forward: card drags independently, terminal peeks behind
        bgEl.style.transform = "translate3d(100%, 0, 0)";
        bgEl.classList.add("visible");
        if (forwardTargetView === "terminal") bgEl.classList.add("terminal-swipe-peek");
        bgEl.style.zIndex = "2";
        fgEl.style.zIndex = "1";
      }
    }

    if (locked) e.preventDefault();

    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(applySwipe);
  }, { passive: false });

  vc.addEventListener("touchend", () => {
    cancelAnimationFrame(rafId);
    if (!fgEl || !locked) {
      vc.classList.remove("swipe-active");
      return;
    }

    const elapsed = Date.now() - st;
    const velocity = Math.abs(dx) / Math.max(elapsed, 1) * 1000;
    const committed = Math.abs(dx) > 60 || (velocity > 250 && Math.abs(dx) > 15);
    const shouldComplete = isBack ? (committed && dx > 0) : (committed && dx < 0);

    const fg = fgEl, bg = bgEl, card = swipeCard, back = isBack;

    // snap — no transition animation
    if (card) { card.style.transform = ""; }

    if (!shouldComplete) {
      bg.classList.remove("visible", "terminal-swipe-peek");
      [fg, bg].forEach(el => {
        el.style.zIndex = ""; el.style.transform = ""; el.classList.remove("swiping");
      });
    } else {
      fg.classList.remove("visible");
      [fg, bg].forEach(el => {
        el.style.zIndex = ""; el.style.transform = ""; el.classList.remove("swiping");
      });

      haptic(10);
      state.swipeNavigated = true;

      if (back) {
        const backView = BACK_TARGET[state.currentView];
        if (backView === "sessions") {
          const backBtn = document.getElementById("back-btn");
          if (backBtn && backBtn.onclick) backBtn.onclick(new PointerEvent("click"));
        } else {
          showView(backView, true);
        }
      } else if (card) {
        card.click();
      }
    }

    vc.classList.remove("swipe-active");
    fgEl = null; bgEl = null; swipeCard = null; forwardTargetView = null;
  }, { passive: true });
}

// ── Desktop Sidebar ──

let sidebarRefreshTimer = null;
let sidebarAutoCollapseTimer = null;

let sidebarInitialRender = false;
let _sidebarRafId = null;
let _lastSidebarHtml = "";

function renderSidebar() {
  if (!isDesktop()) return;
  // Coalesce multiple calls per frame
  if (_sidebarRafId) return;
  _sidebarRafId = requestAnimationFrame(() => {
    _sidebarRafId = null;
    _renderSidebarNow();
  });
}

function _renderSidebarNow() {
  const el = document.getElementById("sidebar-session-list");
  if (!el) return;
  const groups = state.lastSessionGroups;
  // Don't wipe sidebar with empty content if sessions haven't loaded yet
  if (!groups.length && sidebarInitialRender) return;
  if (groups.length) sidebarInitialRender = true;
  const machines = getMachines();
  const multiMachine = machines.length > 0;

  let html = "";
  if (!multiMachine) {
    // Single machine — simple list with + New + Ralph
    const g = groups[0];
    const sidebarBtns = '<div class="sidebar-top-btns"><div class="new-btn" onclick="showProjectPicker()">+ New Session</div><button class="machine-ralph-btn" onclick="showRalphStart()">&#129355;</button></div>';
    if (g && g.online && g.sessions.length) {
      html += sidebarBtns;
      html += projectDelegationSessions(g.sessions).map(row => sidebarCardHtml(row, "")).join("");
    } else {
      html += sidebarBtns;
      html += '<div class="sidebar-no-sessions">No active sessions</div>';
    }
    if (g && g.online && g.loops && g.loops.length) {
      html += g.loops.map(loop => sidebarRalphCardHtml(loop, "")).join("");
    }
  } else {
    // Multi-machine
    for (const g of groups) {
      const mUrl = escAttr(g.machine.url);
      const mName = esc(g.machine.name);
      const statusDot = g.online ? "green" : (g.pending ? "gray" : "red");
      html += `<div class="machine-group" data-machine="${mUrl}">`;
      html += `<div class="machine-header"><div class="dot ${statusDot}"></div>${mName}<div class="machine-header-btns"><button class="machine-ralph-btn" onclick="showRalphStart('${escAttr(g.machine.url)}')">&#129355;</button><button class="machine-add-btn" onclick="showProjectPicker('${escAttr(g.machine.url)}')">+</button></div></div>`;
      if (g.online && g.sessions.length) {
        html += projectDelegationSessions(g.sessions).map(row => sidebarCardHtml(row, g.machine.url)).join("");
      } else if (g.pending) {
        html += '<div class="sidebar-conn-status">Connecting...</div>';
      } else if (!g.online) {
        html += '<div class="sidebar-conn-status">Offline</div>';
      }
      if (g.online && g.loops && g.loops.length) {
        html += g.loops.map(loop => sidebarRalphCardHtml(loop, g.machine.url)).join("");
      }
      html += '</div>';
    }
  }
  // Skip DOM update if nothing changed
  if (html === _lastSidebarHtml) return;
  _lastSidebarHtml = html;
  el.innerHTML = html;
}

function sidebarCardHtml(row: DelegationSessionRow<DelegationSessionLike>, machineUrl: string) {
  const s = row.session;
  const machineUrlAttr = escAttr(machineUrl);
  const lastLine = s.lastLine || "";
  const ui = triageUi(s);
  const isActive = s.name === state.currentSession && machineUrl === state.currentMachine;
  const inGrid = isSessionInGrid(s.name, machineUrl);
  const activeClass = isActive ? " sidebar-active" : (inGrid ? " sidebar-grid" : "");
  const onclick = machineUrl
    ? `openSession('${escAttr(s.name)}', '${machineUrlAttr}')`
    : `openSession('${escAttr(s.name)}')`;
  const gridBtnOnclick = machineUrl
    ? `toggleGrid('${escAttr(s.name)}', '${machineUrlAttr}', event)`
    : `toggleGrid('${escAttr(s.name)}', '', event)`;
  const gridBtn = `<button class="grid-btn${inGrid ? ' in-grid' : ''}" onclick="${gridBtnOnclick}" title="${inGrid ? 'Remove from grid' : 'Add to grid'}">${inGrid ? '⊠' : '+'}</button>`;
  const grouping = delegationCardAttributes(row);
  return `<div class="card ${ui.card}${activeClass}${grouping.className}"${grouping.dataAttribute} onclick="${onclick}">
    <div class="dot ${ui.dot}" title="${ui.title}"></div>
    <div class="card-info">
      <div class="card-name">${esc(s.name)}</div>
      <div class="card-status"><span class="triage-badge ${ui.badge}">${ui.label}</span></div>
      ${delegationParentSummaryHtml(row)}
      ${delegationParentMissingHtml(row)}
      <div class="card-preview">${esc(lastLine)}</div>
    </div>
    ${gridBtn}
    <button class="kill-btn" onclick="killSession('${escAttr(s.name)}', event${machineUrl ? ", '" + machineUrlAttr + "'" : ''})">&times;</button>
  </div>`;
}

function updatePinButton() {
  const btn = document.getElementById("sidebar-collapse-btn");
  btn.classList.toggle("pinned", state.sidebarPinned);
  btn.title = state.sidebarPinned ? "Unpin sidebar" : "Pin sidebar";
}

function initSidebar() {
  if (!isDesktop()) return;
  const sidebar = document.getElementById("desktop-sidebar");
  const hoverEdge = document.getElementById("sidebar-hover-edge");

  // Restore state
  if (!state.sidebarPinned) {
    sidebar.classList.add("collapsed");
    state.sidebarCollapsed = true;
  }
  // Body class drives layout: pinned → in flex flow (pushes main); unpinned →
  // overlay (doesn't affect terminal width).
  document.body.classList.toggle("sidebar-pinned", state.sidebarPinned);
  updatePinButton();

  // Pin/unpin button
  document.getElementById("sidebar-collapse-btn").onclick = () => {
    state.sidebarPinned = !state.sidebarPinned;
    localStorage.setItem("wolfpack-sidebar-pinned", state.sidebarPinned ? "1" : "0");
    state.sidebarTransitionIsHover = false;
    if (!state.sidebarResizeDone) hideGridCellsForTransition();
    document.body.classList.toggle("sidebar-pinned", state.sidebarPinned);
    if (state.sidebarPinned) {
      // Pin: ensure visible
      sidebar.classList.remove("collapsed");
      state.sidebarCollapsed = false;
      state.sidebarAutoExpanded = false;
    } else {
      // Unpin: collapse immediately
      sidebar.classList.add("collapsed");
      state.sidebarCollapsed = true;
    }
    updatePinButton();
  };

  // Expand button — toggle full-page sessions view
  document.getElementById("sidebar-expand-btn").onclick = () => {
    state.sessionsExpanded = !state.sessionsExpanded;
    document.body.classList.toggle("sessions-expanded", state.sessionsExpanded);
    document.getElementById("sidebar-expand-btn").classList.toggle("active", state.sessionsExpanded);
    state.sidebarTransitionIsHover = false;
    if (!state.sidebarResizeDone) hideGridCellsForTransition();
    if (state.sessionsExpanded) {
      // Collapse sidebar when expanded — main area has all sessions
      sidebar.classList.add("collapsed");
      state.sidebarCollapsed = true;
      state.sidebarAutoExpanded = false;
      showView("sessions");
      loadSessions();
    } else {
      // Restore sidebar based on pin state
      if (state.sidebarPinned) {
        sidebar.classList.remove("collapsed");
        state.sidebarCollapsed = false;
      }
      // Return to terminal if we have a session, else just stay
      if (state.currentSession || hasPreservedGrid()) returnToTerminalView();
    }
  };

  // Hover edge — expand on hover (only when unpinned and not in expanded mode)
  hoverEdge.addEventListener("mouseenter", () => {
    if (state.sidebarCollapsed && !state.sidebarPinned && !state.sessionsExpanded) {
      state.sidebarTransitionIsHover = true;
      sidebar.classList.remove("collapsed");
      state.sidebarAutoExpanded = true;
    }
  });

  // Auto-collapse when mouse leaves sidebar (only if auto-expanded, not pinned)
  sidebar.addEventListener("mouseleave", () => {
    if (state.sidebarAutoExpanded && !state.sidebarPinned) {
      sidebarAutoCollapseTimer = setTimeout(() => {
        if (state.sidebarAutoExpanded) {
          state.sidebarTransitionIsHover = true;
          sidebar.classList.add("collapsed");
          state.sidebarCollapsed = true;
          state.sidebarAutoExpanded = false;
        }
      }, 300);
    }
  });
  sidebar.addEventListener("mouseenter", () => {
    if (sidebarAutoCollapseTimer) {
      clearTimeout(sidebarAutoCollapseTimer);
      sidebarAutoCollapseTimer = null;
    }
  });

  // Refit terminal after sidebar transition completes.
  // Hover transitions: just reveal canvases (no PTY resize — causes dot fill).
  // Pin/unpin transitions: resize PTY to new dimensions + reveal.
  sidebar.addEventListener("transitionend", (e) => {
    if (e.propertyName !== "margin-left") return;
    if (state.sidebarTransitionIsHover) {
      // Hover expand/collapse — reveal without resizing PTY
      revealGridCellsWithoutResize();
      state.sidebarTransitionIsHover = false;
    } else if (!state.sidebarAutoExpanded) {
      // Pin/unpin — resize PTY to fit new layout, then reveal the canvas.
      // Without the reveal the .transitioning class stays on the container
      // and the canvas stays hidden, leaving a black gap.
      if (isGridActive()) {
        scheduleGridStabilizedFit();
      } else if (state.terminalController) {
        state.terminalController.resize();
      }
      revealGridCellsWithoutResize();
    }
    state.sidebarResizeDone = true;
  });

  // Nav buttons
  document.getElementById("sidebar-settings-btn").onclick = () => showSettings();

  // Start session refresh for sidebar
  startSidebarRefresh();

  // Initial render
  renderSidebar();
}

function startSidebarRefresh() {
  if (sidebarRefreshTimer) clearInterval(sidebarRefreshTimer);
  if (isDesktop()) {
    sidebarRefreshTimer = setInterval(() => {
      loadSessions().then(renderSidebar);
    }, 5000);
  }
}

// ── Bind all HTML event listeners (replaces inline onclick/onchange/etc) ──

function bindHtmlEventListeners(): void {
  const $ = (id: string) => document.getElementById(id);
  const on = (id: string, event: string, fn: EventListener) => {
    const el = $(id);
    if (el) el.addEventListener(event, fn);
  };

  // Header
  on("session-chip", "click", () => toggleDrawer());
  on("gear-btn", "click", () => showSettings());

  // Delegation workspace
  on("delegation-focus-back", "click", () => returnToDelegationGrid());
  on("delegation-collapse-idle", "click", () => collapseIdleDelegationSessions());
  on("delegation-expand-all", "click", () => expandDelegationSessions());
  on("delegation-focus-parent", "click", () => {
    if (state.activeDelegationRoot) focusDelegationSession(state.activeDelegationRoot, state.delegationMachine || "");
  });
  on("delegation-exit-grid", "click", () => exitDelegationWorkspace());

  // Drawer / overlays
  on("drawer-backdrop", "click", () => closeDrawer());
  on("git-status-overlay", "click", () => dismissGitStatus());

  // Expanded toolbar
  on("expanded-settings-btn", "click", () => showSettings());
  on("expanded-collapse-btn", "click", () => $("sidebar-expand-btn")?.click());

  // Project picker
  const pickerCancel = document.querySelector("#projects-view .picker-cancel-btn");
  if (pickerCancel) pickerCancel.addEventListener("click", () => { returnFromProjectPicker(); });
  const createProjectBtn = document.querySelector("#projects-view .new-project-row button");
  if (createProjectBtn) createProjectBtn.addEventListener("click", () => selectNewProject());

  // Agent picker (read-only — add/remove/toggle moved to Settings)
  const agentBackBtn = document.querySelector("#agent-view .picker-cancel-btn");
  if (agentBackBtn) agentBackBtn.addEventListener("click", () => showView("projects"));

  // Settings
  on("settings-back-btn", "click", () => backFromSettings());
  const discoverBtn = document.querySelector(".discover-btn");
  if (discoverBtn) discoverBtn.addEventListener("click", () => discoverMachines());

  // Settings toggles
  on("setting-animations", "change", function(this: HTMLInputElement) { toggleSetting("animations", this.checked); });
  on("setting-haptics", "change", function(this: HTMLInputElement) { toggleSetting("haptics", this.checked); });
  on("setting-notifications", "change", function(this: HTMLInputElement) { toggleSetting("notifications", this.checked); });
  on("setting-enterSends", "change", function(this: HTMLInputElement) { toggleSetting("enterSends", this.checked); });
  on("setting-holdToSend", "change", function(this: HTMLInputElement) { toggleSetting("holdToSend", this.checked); });
  on("setting-ralphEnabled", "change", function(this: HTMLInputElement) { toggleSetting("ralphEnabled", this.checked); });
  on("setting-debugPanel", "change", function(this: HTMLInputElement) { toggleSetting("debugPanel", this.checked); toggleDebugPanel(); });
  on("setting-snapshotTtl", "input", function(this: HTMLInputElement) {
    toggleSetting("snapshotTtl", +this.value);
    const val = $("snapshot-ttl-val");
    if (val) val.textContent = formatSnapshotTtl(+this.value);
  });

  // Term font size buttons
  document.querySelectorAll(".term-size-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const size = (btn as HTMLElement).dataset.size;
      if (size) toggleSetting("termFontSize", size);
    });
  });

  // Term font family buttons
  document.querySelectorAll(".term-font-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const font = (btn as HTMLElement).dataset.font;
      if (font) toggleSetting("termFont", font);
    });
  });
  document.querySelectorAll(".solo-prefill-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = (btn as HTMLElement).dataset.mode;
      if (mode === "fast" && isDesktop()) return;
      if (mode === "fast" || mode === TERMINAL_PREFILL_MODE.FULL) toggleSetting("soloPrefillMode", mode);
    });
  });

  // Quick commands
  on("add-quick-cmd-btn", "click", () => addQuickCmd());

  // Debug reset
  const debugResetBtn = document.querySelector(".debug-reset-btn");
  if (debugResetBtn) debugResetBtn.addEventListener("click", () => { wpMetrics.reset(); renderDebugPanel(); });

  // Terminal view

  // Keyboard accessory
  const gitBtn = document.querySelector(".kb-key.kb-git");
  if (gitBtn) gitBtn.addEventListener("click", () => showGitStatus());
  const copyBtn = document.querySelector(".kb-key.kb-copy");
  if (copyBtn) copyBtn.addEventListener("click", () => copySessionToClipboard());


  // Ralph detail
  on("ralph-detail-back-btn", "click", () => backFromRalph());
  on("ralph-log-toggle", "click", () => toggleRawLog());

  // Ralph start form
  on("ralph-start-back-btn", "click", () => backFromRalph());
  const ralphSegmented = document.querySelector(".ralph-segmented");
  if (ralphSegmented) ralphSegmented.addEventListener("change", () => onIsolationChange());
  const launchBtn = document.querySelector(".ralph-launch-btn");
  if (launchBtn) launchBtn.addEventListener("click", () => startRalph());
}

bindHtmlEventListeners();

initGridDeps({
  showView, openSession, destroyTerminal, initTerminal,
  backToSessions, renderSidebar,
  createPtyTerminalController, createConflictOverlay,
  canUseWasmTerminal,
  saveGridCellSnapshot: (gs) => {
    if (!gs.controller?.term) return;
    const text = serializeXtermTail(gs.controller.term, 200);
    if (text) saveSnapshot(gs.machine || "", gs.session, text);
  },
  scheduleSnapshotSave: () => scheduleSnapshotSave(null),
  flushGridSnapshots,
  loadSnapshot,
  focusDelegationSession,
  leaveDelegationWorkspace: leaveDelegationWorkspaceForManualGrid,
});
initRalphDeps({
  api, errorMessage, showView, getMachines, backToSessions,
  loadSessions, renderSidebar, startSidebarRefresh,
  getSidebarRefreshTimer: () => sidebarRefreshTimer,
  setSidebarRefreshTimer: (v) => { sidebarRefreshTimer = v; },
});
initSettings();
cleanStaleSnapshots();
renderCmdPalette();
initSidebar(); // Init sidebar early so pin/expand/hover handlers are ready
// Apply expanded sessions as default on desktop — sidebar collapsed in this mode
if (isDesktop() && state.sessionsExpanded) {
  document.body.classList.add("sessions-expanded");
  const expandBtn = document.getElementById("sidebar-expand-btn");
  if (expandBtn) expandBtn.classList.add("active");
  const sb = document.getElementById("desktop-sidebar");
  if (sb) { sb.classList.add("collapsed"); state.sidebarCollapsed = true; }
}
showView("sessions", true);
loadSessions().then(renderSidebar);
scheduleGhosttyPrewarm();

// Unregister stale service workers but keep our push SW
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => {
    regs.forEach(r => {
      if (r.active?.scriptURL === `${location.origin}/sw.js`) return;
      r.unregister();
    });
  });
}

// ── Expose onclick-referenced functions to global scope ──
// Bun's bundler tree-shakes functions only referenced in HTML onclick strings.
// Assigning to window ensures they survive bundling and are callable from inline handlers.
Object.assign(window, {
  // ralph onclick handlers
  openRalphDetail, dismissRalph, cancelRalph, continueRalph, discardRalph, showRalphStart,
  // session/project onclick handlers
  openSession, killSession, selectProject, showProjectPicker,
  sendQuickCmd, editQuickCmd, deleteQuickCmd, moveQuickCmd,
  createSessionWithAgent, deleteCustomCmd, removeMachineUI,
  // agent settings onclick handlers (inline in renderAgentsList)
  toggleAgentEnabled, removeAgent, addAgent,
  // grid + view (used by onclick and e2e page.evaluate)
  toggleGrid, addToGrid, removeFromGrid, suspendGridMode,
  loadSessions, showView, state,
});
