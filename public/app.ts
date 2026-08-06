import {
  esc, escAttr, loadStoredJson, isDesktop,
  getTerminalFontFamily,
  wpSettings, TERM_PRESETS, toggleSetting,
  applyTermToXterm, initSettings, haptic, requestNotifications,
  QC_STORAGE_KEY, loadQuickCmds, RECENTS_STORAGE_KEY, MAX_RECENTS,
  state, setState,
  SNAPSHOT_KEY_PREFIX, SNAPSHOT_MAX_BYTES, SNAPSHOT_SAVE_INTERVAL,
  DESKTOP_TERMINAL_SCROLLBACK, GRID_TERMINAL_SCROLLBACK,
} from "./app-state";

import {
  initGridDeps,
  isGridActive, updateGridLayout, renderGridCells, getGridCellElement,
  hasPreservedGrid, clearPreservedGrid, setCurrentSessionFromGridFocus,
  returnToTerminalView, setGridFocus, suspendGridMode, restorePreservedGrid,
  backFromSettings, addToGrid, removeFromGrid, exitGridMode,
  hideGridCellsForTransition, revealGridCellsWithoutResize,
  scheduleGridStabilizedFit, isSessionInGrid, toggleGrid,
  canOpenMultiTerminalGrid, disposeDelegationGrid,
  renderDelegationGridCells, setDelegationGridMembers, suspendDelegationGridTerminals,
} from "./app-grid";
import type { DelegationGridMember } from "./app-grid";

import { setupTouchScrollHandler } from "./app-touch";
import { showAppDialog } from "./app-dialog";
import { rankProjectNames } from "./project-picker";
import { fetchWithTimeout } from "./fetch-timeout";
import { OrderedResizeTracker } from "./ordered-resize";
import { createReconnector } from "./reconnector";
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
import {
  resolveGhosttyPrewarmDebugPoolSize,
  resolveGhosttyPrewarmDebugTiming,
} from "../src/ghostty-prewarm-debug";
import { DEFAULT_GHOSTTY_PREWARM_POOL_SIZE } from "../src/ghostty-prewarm-policy";
import {
  resolveLayoutStableDebugMode,
  shouldSendImmediateLayoutStable,
  type LayoutStablePrefillMode,
} from "../src/terminal-layout-stable-debug";
import { AGENT_KIND } from "../src/agent-kind";
import { sessionRuntimeState, sessionRuntimeUi } from "../src/agent-runtime-ui";
import {
  delegationChildSummaryText,
  delegationGridMembers,
  delegationRootSession,
  projectDelegationSessions,
  sessionIdentityId,
} from "./delegation-sessions";
import type {
  DelegationSessionLike,
  DelegationSessionRow,
} from "./delegation-sessions";
import {
  loadSessionOrder,
  moveSessionRelative,
  orderDelegationSessionRows,
  reconcileSessionOrder,
  replaceMachineSessionOrder,
  resetMachineSessionOrder,
  saveSessionOrder,
  type SessionOrderIdentity,
} from "./session-order";
import {
  bindSessionOrderEvents,
  type SessionOrderCardReference,
} from "./session-order-ui";
import { AGENT_STATUS_STATE } from "../src/agent-status-contract";
import { TERMINAL_PREFILL_MODE } from "../src/terminal-prefill";
import type { TerminalPrefillMode } from "../src/terminal-prefill";
import { shouldUseAttachAckFallback } from "../src/attach-ack";
import {
  TERMINAL_REHYDRATION_ACTION,
  createTerminalConnectionLifecycle,
} from "../src/terminal-connection-lifecycle";
import { createAttachDimensionRetryState } from "../src/attach-dimension-retry";
import {
  commitTerminalResizePreservingScroll,
  fitTerminalPreservingScroll,
  forceTerminalRepaint,
  syncTerminalLayout,
} from "./terminal-layout";
import { createTerminalResizeLifecycle } from "./terminal-resize-lifecycle";
import { WOLFPACK_TERMINAL_THEME } from "../src/terminal-theme";
import { nextMenuSelection } from "../src/menu-navigation";
import { parseSessionNotificationRoute } from "../src/session-notification-route";
import {
  LOCAL_MACHINE_IDENTITY,
  TailnetPeerRegistry,
  isStableMachineIdentity,
  probeTailnetCandidates,
} from "../src/tailnet-peer-registry";
import type {
  TailnetPeerEntry,
  TailnetPeerIdentityReplacement,
} from "../src/tailnet-peer-registry";
import {
  canonicalTailnetOrigin,
} from "../src/tailnet-machine-contract";
import type { TailnetMachineCandidate } from "../src/tailnet-machine-contract";
import { snapshotKeysToEvict } from "../src/snapshot-cache";
import {
  terminalDataFromBeforeInput,
  terminalDataFromKeydownForBeforeInputDedupe,
} from "../src/terminal-input";

// ── WASM capability guard ──

const GHOSTTY_PREWARM_POOL_SIZE = resolveGhosttyPrewarmDebugPoolSize({
  debugEnabled: wfTraceEnabled,
  storage: safeLocalStorage(),
  defaultPoolSize: DEFAULT_GHOSTTY_PREWARM_POOL_SIZE,
});
const GHOSTTY_PREWARM_DELAY_MS = 0;
const ATTACH_DIMENSION_RETRY_DELAY_MS = 50;
const ATTACH_DIMENSION_MAX_ATTEMPTS = 20;
const RESIZE_SEND_DEBOUNCE_MS = 120;

function safeLocalStorage(): Storage | null {
  try { return window.localStorage; }
  catch { return null; }
}

let sessionOrder = loadSessionOrder(safeLocalStorage());
const manuallyOrderedMachines = new Set(sessionOrder.map(identity => identity.machineUrl));

interface GhosttyPrewarmDebugEvent {
  readonly t: number;
  readonly kind: string;
  readonly slot?: number;
  readonly delayMs?: number;
  readonly readyCount?: number;
  readonly poolSize?: number;
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
  recordGhosttyPrewarmEvent("schedule", {
    delayMs: timing.delayMs,
    poolSize: GHOSTTY_PREWARM_POOL_SIZE,
  });
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

async function addQuickCmd(): Promise<void> {
  const values = await showAppDialog({
    title: "Add quick command",
    fields: [
      { name: "label", label: "Label", placeholder: "Deploy" },
      { name: "command", label: "Command", placeholder: "bun run deploy" },
    ],
    confirmLabel: "Add command",
  });
  if (!values?.label || !values.command) return;
  state.quickCmds.push({ label: values.label, cmd: values.command });
  saveQuickCmds();
  renderQuickCmdSettings();
  renderCmdPalette();
}

async function editQuickCmd(index: number): Promise<void> {
  const quickCommand = state.quickCmds[index];
  if (!quickCommand) return;
  const values = await showAppDialog({
    title: "Edit quick command",
    fields: [
      { name: "label", label: "Label", value: quickCommand.label },
      { name: "command", label: "Command", value: quickCommand.cmd },
    ],
    confirmLabel: "Save changes",
  });
  if (!values?.label || !values.command) return;
  state.quickCmds[index] = { label: values.label, cmd: values.command };
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

async function fetchSessionText(session: string, machineIdentity: string): Promise<string> {
  const origin = resolveReadyMachineOrigin(machineIdentity);
  if (machineIdentity && !origin) throw new Error("selected peer is not ready");
  const headers: Record<string, string> = {};
  const jwt = localStorage.getItem("wpJwt");
  if (jwt) headers.Authorization = "Bearer " + jwt;
  const response = await fetch(origin
    ? new URL("/api/copy-text?session=" + encodeURIComponent(session), origin)
    : "/api/copy-text?session=" + encodeURIComponent(session), { headers });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.text();
}

async function copySessionToClipboard(): Promise<void> {
  if (!state.currentSession) return;
  haptic([20]);
  const overlay = document.getElementById("git-status-overlay");
  overlay.innerHTML = '<pre>copying...</pre>';
  overlay.classList.add("visible");
  try {
    const text = await fetchSessionText(state.currentSession, state.currentMachine || "");
    await navigator.clipboard.writeText(text);
    overlay.innerHTML = `<div><pre>copied ${text.length} chars</pre><div class="overlay-hint">tap to dismiss</div></div>`;
  } catch (e) {
    overlay.innerHTML = `<div><pre class="error-pre">copy failed: ${esc(errorMessage(e))}</pre><div class="overlay-hint">tap to dismiss</div></div>`;
  }
}

async function showTerminalTranscript(): Promise<void> {
  if (!state.currentSession) return;
  const dialog = document.getElementById("terminal-transcript-dialog") as HTMLDialogElement;
  const status = document.getElementById("terminal-transcript-status");
  const output = document.getElementById("terminal-transcript-output");
  status.textContent = "Loading transcript…";
  output.textContent = "";
  dialog.showModal();
  try {
    const text = await fetchSessionText(state.currentSession, state.currentMachine || "");
    output.textContent = text || "(no terminal output)";
    status.textContent = `${text.length} characters`;
    output.focus({ preventScroll: true });
  } catch (error) {
    status.textContent = "Transcript unavailable: " + errorMessage(error);
  }
}

function closeTerminalTranscript(): void {
  const dialog = document.getElementById("terminal-transcript-dialog") as HTMLDialogElement;
  if (dialog.open) dialog.close();
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
const TERMINAL_BEFOREINPUT_DEDUPE_MS = 100;

function installTerminalTextareaInputBridge(
  term: GhosttyTerminal,
  sendInput: (data: Uint8Array) => void,
  canAcceptInput: () => boolean,
  trace: TraceState | null,
): void {
  const input = term.textarea;
  if (!input) return;

  let lastKeydownData: string | null = null;
  let lastKeydownAt = 0;
  let lastCompositionData: string | null = null;
  let lastCompositionAt = 0;
  const encoder = new TextEncoder();

  function now(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
  }

  function recentDuplicate(data: string, previousData: string | null, previousAt: number): boolean {
    return previousData === data && now() - previousAt < TERMINAL_BEFOREINPUT_DEDUPE_MS;
  }

  input.addEventListener("keydown", (event) => {
    const data = terminalDataFromKeydownForBeforeInputDedupe(event);
    if (!data) return;
    lastKeydownData = data;
    lastKeydownAt = now();
  });

  input.addEventListener("compositionend", (event) => {
    if (!event.data) return;
    lastCompositionData = event.data;
    lastCompositionAt = now();
  });

  input.addEventListener("beforeinput", (event) => {
    if (event.defaultPrevented || term.options.disableStdin || !canAcceptInput()) return;
    const data = terminalDataFromBeforeInput(event);
    if (!data) return;
    event.preventDefault();
    event.stopPropagation();
    if (recentDuplicate(data, lastKeydownData, lastKeydownAt)) {
      lastKeydownData = null;
      return;
    }
    if (event.data && recentDuplicate(event.data, lastCompositionData, lastCompositionAt)) {
      lastCompositionData = null;
      return;
    }
    __wfTraceEvent(trace, "terminal.textarea.beforeinput", { inputType: event.inputType });
    sendInput(encoder.encode(data));
  });
}

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
    theme: WOLFPACK_TERMINAL_THEME,
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

import {
  createInitialHydrationController,
} from "./terminal-hydration";
import type { InitialHydrationController } from "./terminal-hydration";

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
  readonly getProposedDimensions?: () => TermDimensions | null;
  readonly getLayoutMetrics?: () => TerminalLayoutMetrics | null;
  readonly fitTerminal: () => void;
  readonly onBinaryData?: (data: Uint8Array) => void;
  readonly onAttach?: () => void;
  readonly onOpen?: (wasReconnect: boolean) => void;
  readonly onPtyReady?: () => void;
  readonly onResizeAck?: (cols: number, rows: number) => void;
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
    shouldReconnect: () => navigator.onLine !== false && (opts.shouldReconnect?.() ?? true),
    onReconnecting: opts.onReconnecting,
    onExhausted: opts.onReconnectExhausted,
  });
  const handleOnline = (): void => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      _rc.reset();
      scheduleReconnect();
    }
  };
  const handleOffline = (): void => _rc.cancel();
  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);
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
  const _attachDimensionRetry = createAttachDimensionRetryState();
  const _layoutStableDebugMode = resolveLayoutStableDebugMode(safeLocalStorage(), wfTraceEnabled);
  // Diagnostic tracer (scrolldown investigation). Created per attach in
  // sendAttachHandshake. Read via window.__wf_dumpTrace().
  let _trace: TraceState | null = null;

  function buildUrl() {
    const resetSuffix = consumeReset ? "&reset=1" : "";
    consumeReset = false;
    const session = encodeURIComponent(opts.session);
    if (opts.machine) {
      const origin = resolveReadyMachineOrigin(opts.machine);
      if (!origin) throw new Error("selected peer is not ready");
      const remote = new URL(origin);
      return "wss://" + remote.host + "/ws/pty?session=" + session + resetSuffix;
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
      _attachDimensionRetry.attempt,
      ATTACH_DIMENSION_MAX_ATTEMPTS,
    );
    if (dimensionAction.kind === "retry") {
      _attachDimensionRetry.setAttempt(dimensionAction.nextAttempt);
      _attachDimensionRetry.schedule(sendAttachHandshake, ATTACH_DIMENSION_RETRY_DELAY_MS);
      return;
    }
    if (dimensionAction.kind === "fail") {
      clearAttachRetryState();
      ws.close(WP.CLOSE_CODE_SERVER_ERROR, "attach dimensions unavailable");
      return;
    }
    clearAttachRetryState();
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
      if (!shouldUseAttachAckFallback({
        ackReceived: _attachAckReceived,
        awaitingAck: _awaitingAttachAck,
      })) return;
      _awaitingAttachAck = false;
      _lastSentResize = "";
      sendFitResize();
    }, 300);
  }

  function clearAttachRetryState(): void {
    _attachDimensionRetry.clear();
  }

  function resetAttachLifecycle(): void {
    clearAttachRetryState();
    _awaitingAttachAck = false;
    _awaitingPrefillDone = false;
    _prefillChunks = [];
    _sawViewportPrefill = false;
    _pendingResizeDimensions = null;
    if (_resizeDebounceTimer) { clearTimeout(_resizeDebounceTimer); _resizeDebounceTimer = null; }
    if (_prefillDoneTimeout) { clearTimeout(_prefillDoneTimeout); _prefillDoneTimeout = null; }
    if (_attachAckTimer) { clearTimeout(_attachAckTimer); _attachAckTimer = null; }
  }

  function sendLayoutStable(reason: "after-paint" | "immediate" = "after-paint"): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const dims = opts.getProposedDimensions?.() ?? opts.getTermDimensions();
    if (!dims) return;
    const key = dims.cols + "x" + dims.rows;
    if (key !== _lastSentResize) sendResizeRequest(dims);
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

  /** Send resize requests with an ordered acknowledgement boundary. */
  let _lastSentResize = "";
  const _orderedResize = new OrderedResizeTracker();
  let _resizeDebounceTimer = null;
  let _pendingResizeDimensions: TermDimensions | null = null;

  function sendResizeRequest(dims: TermDimensions): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    _lastSentResize = `${dims.cols}x${dims.rows}`;
    ws.send(JSON.stringify(_orderedResize.request(dims)));
  }

  function queueResize(dims: TermDimensions, force = false): void {
    const key = `${dims.cols}x${dims.rows}`;
    if (!force && key === _lastSentResize) return;
    _pendingResizeDimensions = dims;
    if (_resizeDebounceTimer) clearTimeout(_resizeDebounceTimer);
    _resizeDebounceTimer = setTimeout(() => {
      _resizeDebounceTimer = null;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const pending = _pendingResizeDimensions;
      _pendingResizeDimensions = null;
      if (!pending) return;
      if (!force && `${pending.cols}x${pending.rows}` === _lastSentResize) return;
      sendResizeRequest(pending);
    }, RESIZE_SEND_DEBOUNCE_MS);
  }

  function sendFitResize(options?: { force?: boolean; fit?: boolean }) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const dims = options?.fit === false
      ? opts.getTermDimensions()
      : (opts.getProposedDimensions?.() ?? opts.getTermDimensions());
    if (!dims) return;
    // Collapse rapid proposals without committing Ghostty.
    queueResize(dims, !!options?.force);
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

  function handleResizeAck(message: SocketControlMessage): void {
    const dimensions = _orderedResize.acknowledge(message);
    if (!dimensions) return;
    _lastSentResize = `${dimensions.cols}x${dimensions.rows}`;
    opts.onResizeAck?.(dimensions.cols, dimensions.rows);
  }

  function handlePtyReady(): void {
    __wfTraceEvent(_trace, "pty_ready");
    // A TCP/WebSocket open is not a usable terminal. Preserve exponential
    // backoff across attach/prefill failures and reset it only after the
    // broker-backed terminal reaches its authoritative ready boundary.
    _rc.connected();
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
    resize_ack: handleResizeAck,
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
    if (navigator.onLine === false) return;
    if (ws && ws.readyState <= WebSocket.OPEN) return;

    const sock = new WebSocket(buildUrl());
    sock.binaryType = "arraybuffer";
    ws = sock;

    sock.onopen = () => {
      if (ws !== sock) return;
      console.log("[pty-ws]", opts.session, "ws.onopen, readyState=", sock.readyState);
      const wasReconnect = hasConnected;
      hasConnected = true;
      sendAttachHandshake();
      // attach trace was created inside sendAttachHandshake above
      __wfTraceEvent(_trace, "ws.open", { wasReconnect });
      if (opts.onOpen) opts.onOpen(wasReconnect);
    };

    sock.onmessage = (event) => {
      if (ws !== sock) return;
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
      resetAttachLifecycle();
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
    queueResize({ cols, rows });
  }

  function sendTakeControl() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "take_control" }));
    }
  }

  function send(data: string | Blob | BufferSource): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const maxBufferedBytes = 256 * 1024;
    const sendBounded = (frame: string | Blob | ArrayBuffer, byteLength: number): boolean => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      if (ws.bufferedAmount + byteLength > maxBufferedBytes) {
        ws.close(1013, "client input backpressure");
        return false;
      }
      ws.send(frame);
      return true;
    };
    if (typeof data === "string") {
      sendBounded(data, new TextEncoder().encode(data).byteLength);
      return;
    }
    if (data instanceof Blob) {
      sendBounded(data, data.size);
      return;
    }
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    for (const frame of WP.splitTerminalInputBytes(bytes)) {
      const copy = new ArrayBuffer(frame.byteLength);
      new Uint8Array(copy).set(frame);
      if (!sendBounded(copy, copy.byteLength)) break;
    }
  }

  function retireSocket(socket: WebSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    if (ws === socket) ws = null;
    try {
      socket.close();
    } catch (error) {
      console.warn("[pty-ws]", opts.session, "socket close failed", error);
    }
  }

  function close() {
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
    _rc.cancel();
    _rc.block();
    resetAttachLifecycle();
    if (ws) retireSocket(ws);
  }

  function resetRetry() {
    _rc.reset();
  }

  // Force-close a potentially zombie socket and reconnect. iOS/Android background
  // tabs kill TCP silently while readyState still reports OPEN — connect() guards
  // against this and bails. reconnect() bypasses that guard. See PR #89 review / df4180c.
  function reconnect(reconnectOpts?: { takeControl?: boolean }) {
    _rc.cancel();
    resetAttachLifecycle();
    _takeControlOnAttach = !!(reconnectOpts && reconnectOpts.takeControl);
    if (ws) retireSocket(ws);
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
  const connectionLifecycle = createTerminalConnectionLifecycle();
  let _initialPrefillComplete = opts.prefillMode === TERMINAL_PREFILL_MODE.NONE;
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
  let _firstFitSeen = false;
  let _firstInputAccepted = false;

  const _canAcceptInput = opts.canAcceptInput || (() => !!(_ptyClient && _ptyClient.isOpen));
  const _canSendResize = opts.canSendResize || _canAcceptInput;
  const _getHydrationElement = opts.getHydrationElement || (() => _container);

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
        const writeEpoch = connectionLifecycle.beginHydrationWrite();
        _term.write(data, () => {
          // Ignore stale callbacks from a prior connect/dispose epoch.
          if (!connectionLifecycle.finishHydrationWrite(writeEpoch)) return;
          __wfTraceEvent(_diagTrace, "term.writeDone", { size: data.length, inFlight: connectionLifecycle.pendingHydrationWrites });
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

  function recordFirstFit(dimensions: { cols: number; rows: number }) {
    if (_firstFitSeen) return;
    _firstFitSeen = true;
    __wfTraceEvent(__wfTraceGet(opts.session, opts.machine || ""), "first.fit", dimensions);
  }

  function fitTerminalPreserveScroll() {
    fitTerminalPreservingScroll({
      term: _term,
      fitAddon: _fitAddon,
      onFit: recordFirstFit,
    });
  }

  function forceRepaint() {
    forceTerminalRepaint(_term);
  }

  function syncLayout(options?: { forceSend?: boolean; repaint?: boolean; reason?: string }) {
    if (!_container) return;
    syncTerminalLayout({
      term: _term,
      fitAddon: _fitAddon,
      ptyClient: _ptyClient,
      forceSend: !!options?.forceSend,
      repaint: options?.repaint !== false,
      onFit: recordFirstFit,
      onDimensionsChanged: () => resizeLifecycle.scheduleResizeRehydrate(),
    });
  }

  function shouldSuppressContainerResize() {
    if (!isDesktop()) return false;
    if (state.sidebarLayoutTransitioning) return true;
    return !state.sidebarPinned &&
      !state.sessionsExpanded &&
      (state.sidebarTransitionIsHover || state.sidebarAutoExpanded);
  }

  const resizeLifecycle = createTerminalResizeLifecycle({
    prefillMode: opts.prefillMode,
    getContainer: () => _container,
    getTerm: () => _term,
    getPtyClient: () => _ptyClient,
    shouldSuppressContainerResize,
    userRequestedScrollback: () => _userRequestedScrollback,
    syncLayout,
    scheduler: {
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (id) => cancelAnimationFrame(id),
      setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimeout: (id) => window.clearTimeout(id),
    },
    createResizeObserver: typeof ResizeObserver === "undefined" ? () => null : (callback) =>
      new ResizeObserver((entries) => callback(entries)),
  });

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
    if (connectionLifecycle.beginReplacementPrefill(hideImmediately).activateHydration) activateReplacementHydration();
  }

  function activateReplacementHydration() {
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
    installTerminalTextareaInputBridge(_term, (data) => _ptyClient && _ptyClient.send(data), _canAcceptInput, trace);
    resizeLifecycle.observe(container);

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
      canFinish: () => connectionLifecycle.pendingHydrationWrites === 0,
      onReveal: () => {
        const pendingResizeScrollRestore = resizeLifecycle.takePendingScrollRestore();
        if (pendingResizeScrollRestore && _term) {
          const target = WP.resizeRehydrateScrollTarget({
            ...pendingResizeScrollRestore,
            newScrollbackLength: _term.getScrollbackLength?.() ?? 0,
          });
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
      onDiagnostic: (kind, fields) => {
        __wfTraceEvent(__wfTraceGet(opts.session, opts.machine || ""), kind, fields);
      },
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
    connectionLifecycle.beginConnection();

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
      getProposedDimensions: () => _fitAddon?.proposeDimensions?.() ?? (_term ? { cols: _term.cols, rows: _term.rows } : null),
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
      onResizeAck: (cols, rows) => {
        if (!isCurrent() || !_term) return;
        if (commitTerminalResizePreservingScroll(_term, { cols, rows })) {
          recordFirstFit({ cols, rows });
          forceRepaint();
          resizeLifecycle.scheduleResizeRehydrate();
        }
      },
      onOpen: (wasReconnect) => {
        console.log("[pty-ctrl]", opts.session, "onOpen, isCurrent=", isCurrent(), "wasReconnect=", wasReconnect);
        if (!isCurrent()) return;
        // The connection lifecycle decides whether this socket replaces
        // displayed content. The authoritative broker prefill clears terminal
        // state itself; never reset the Ghostty instance during hydration.
        const socketOpenAction = connectionLifecycle.onSocketOpen({
          wasReconnect,
          hydrationStarted: _hydrationStarted,
          hasAuthoritativePrefill: opts.prefillMode !== TERMINAL_PREFILL_MODE.NONE,
          hasPendingResizeScrollRestore: resizeLifecycle.hasPendingScrollRestore,
        });
        if (socketOpenAction.rehydrationAction !== TERMINAL_REHYDRATION_ACTION.NONE && _term) {
          if (socketOpenAction.rehydrationAction === TERMINAL_REHYDRATION_ACTION.REPLACEMENT) {
            // Retain the old frame until replacement bytes arrive, then hide
            // every subsequent prefill/replay write behind hydration.
            beginReplacementHydration();
          } else {
            startHydration();
            const el = _getHydrationElement();
            if (el) { el.classList.add("hydrating"); el.classList.remove("hydrated"); }
          }
        }
        if (socketOpenAction.resetScrollLock) {
          _userScrolledUp = false;
          _userRequestedScrollback = false;
        } // reset scroll-lock on ordinary reconnect
        if (opts.onOpen) opts.onOpen(wasReconnect);
      },
      onPtyReady: () => { if (isCurrent() && opts.onPtyReady) opts.onPtyReady(); },
      onPrefillDone: () => {
        if (!isCurrent()) return;
        const prefillAction = connectionLifecycle.onPrefillDone();
        if (prefillAction.activateHydration) activateReplacementHydration();
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
        connectionLifecycle.onReplacePrefill();
      },
      onBinaryData: (data) => {
        if (!_term) return;
        const binaryAction = connectionLifecycle.onBinaryData();
        if (binaryAction.activateHydration) activateReplacementHydration();
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
          if (connectionLifecycle.onControlGranted().activateHydration) activateReplacementHydration();
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
    connectionLifecycle.beginConnection();
    if (_ptyClient) { _ptyClient.close(); _ptyClient = null; }
    if (_hydration) { _hydration.cancel(); _hydration = null; }
    _hydrationStarted = false;
    connectionLifecycle.reset();
    resizeLifecycle.dispose();
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
function snapshotMachineFromKey(key) {
  const separator = key.lastIndexOf("|");
  return separator > SNAPSHOT_KEY_PREFIX.length ? key.slice(SNAPSHOT_KEY_PREFIX.length, separator) : "";
}
function snapshotEntries() {
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(SNAPSHOT_KEY_PREFIX)) continue;
    try {
      const snapshot = JSON.parse(localStorage.getItem(key));
      if (typeof snapshot.d !== "string") throw new Error("invalid snapshot");
      entries.push({
        key,
        machine: snapshotMachineFromKey(key),
        lastUsedAt: typeof snapshot.lastUsedAt === "number"
          ? snapshot.lastUsedAt
          : typeof snapshot.ts === "number" ? snapshot.ts : 0,
      });
    } catch {
      localStorage.removeItem(key);
    }
  }
  return entries;
}
function enforceSnapshotCache() {
  snapshotKeysToEvict(snapshotEntries()).forEach(key => localStorage.removeItem(key));
}
function saveSnapshot(machine, session, text) {
  if (!session || !text) return;
  const trimmed = text.length > SNAPSHOT_MAX_BYTES ? text.slice(-SNAPSHOT_MAX_BYTES) : text;
  try {
    localStorage.setItem(snapshotKey(machine, session), JSON.stringify({ d: trimmed, lastUsedAt: Date.now() }));
    enforceSnapshotCache();
  } catch { /* quota/private-mode */ }
}
function loadSnapshot(machine, session) {
  if (!session) return null;
  const key = snapshotKey(machine, session);
  let snapshot;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    snapshot = JSON.parse(raw);
    if (typeof snapshot.d !== "string") throw new Error("invalid snapshot");
  } catch {
    localStorage.removeItem(key);
    return null;
  }
  try {
    localStorage.setItem(key, JSON.stringify({ d: snapshot.d, lastUsedAt: Date.now() }));
  } catch { /* preserve a readable snapshot when localStorage is full */ }
  return snapshot.d;
}
function cleanSnapshots() {
  enforceSnapshotCache();
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
}
function serializeXtermTail(term, maxLines) {
  return WP.serializeBufferTail(term.buffer.active, maxLines);
}

// ── Machine registry ──

const tailnetPeers = new TailnetPeerRegistry();
const TRANSIENT_MACHINE_KEY_PREFIX = "candidate:";

function machineKey(peer: TailnetPeerEntry): string {
  return peer.identity ?? `${TRANSIENT_MACHINE_KEY_PREFIX}${peer.tailnetNodeId}`;
}

function legacyMachineDisplayMetadata(): readonly { readonly url: unknown; readonly name: unknown }[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem("wolfpack-machines") || "[]");
    return Array.isArray(stored)
      ? stored.flatMap((entry) => entry && typeof entry === "object" ? [entry as { readonly url: unknown; readonly name: unknown }] : [])
      : [];
  } catch {
    return [];
  }
}

function getMachines(): readonly { readonly url: string; readonly name: string; readonly version: string; readonly ready: boolean; readonly diagnostic: string | undefined }[] {
  return tailnetPeers.entries().map((peer) => ({
    url: machineKey(peer),
    name: peer.displayName,
    version: peer.version ?? "",
    ready: peer.status === "ready" && peer.identity !== undefined,
    diagnostic: peer.diagnostic,
  }));
}

function resolveReadyMachineOrigin(machineIdentity: string | undefined): string | undefined {
  if (!machineIdentity || machineIdentity === LOCAL_MACHINE_IDENTITY) return undefined;
  return isStableMachineIdentity(machineIdentity)
    ? tailnetPeers.resolveReadyOrigin(machineIdentity)
    : undefined;
}

async function showMachineUnavailable(): Promise<void> {
  await showAppDialog({
    title: "Machine unavailable",
    message: "This Tailnet machine is no longer ready. Refresh Tailnet discovery and try again.",
    confirmLabel: "Close",
    cancelLabel: null,
  });
}

let tailnetPeerRefreshGeneration = 0;
let tailnetPeerSessionRefreshScheduled = false;
let tailnetPeerSessionRefreshGeneration: number | undefined;

function scheduleTailnetPeerSessionRefresh(generation: number): void {
  tailnetPeerSessionRefreshGeneration = generation;
  if (tailnetPeerSessionRefreshScheduled) return;
  tailnetPeerSessionRefreshScheduled = true;
  queueMicrotask(() => {
    tailnetPeerSessionRefreshScheduled = false;
    const scheduledGeneration = tailnetPeerSessionRefreshGeneration;
    tailnetPeerSessionRefreshGeneration = undefined;
    if (scheduledGeneration !== tailnetPeerRefreshGeneration) return;
    void loadSessions(true);
  });
}

function retireReplacedPeerIdentity(replacement: TailnetPeerIdentityReplacement): void {
  const { oldIdentity } = replacement;
  const manualGridAffected = state.gridSessions.some(session => session.machine === oldIdentity);
  const preservedGridAffected = state.preservedGridSessions.some(session => session.machine === oldIdentity);
  const activeDelegationAffected = state.activeDelegationRoot !== null && (
    state.delegationMachine === oldIdentity
    || state.delegationGridSessions.some(session => session.machine === oldIdentity)
  );
  const singleTerminalAffected = state.currentMachine === oldIdentity;
  const activeTerminalAffected = manualGridAffected || activeDelegationAffected || singleTerminalAffected;
  const { [oldIdentity]: _retiredPeerHealth, ...peerHealth } = state.peerHealth;

  if (preservedGridAffected) clearPreservedGrid();
  if (!activeTerminalAffected) {
    setState({ peerHealth });
    return;
  }

  if (activeDelegationAffected) {
    if (state.terminalController) destroyTerminal();
    teardownDelegationWorkspace();
  } else if (manualGridAffected) {
    exitGridMode(true);
  } else {
    destroyTerminal();
  }
  setState({
    currentSession: null,
    currentMachine: "",
    peerHealth,
  });
  backToSessions();
}

function isCandidate(value: unknown): value is TailnetMachineCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.hostname === "string"
    && typeof candidate.tailnetNodeId === "string"
    && typeof candidate.origin === "string"
    && canonicalTailnetOrigin(candidate.hostname) === candidate.origin
    && typeof candidate.online === "boolean";
}

function candidateEnumerationCandidates(response: unknown): readonly TailnetMachineCandidate[] {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("tailnet candidate enumeration response is malformed");
  }
  const envelope = response as Record<string, unknown>;
  if ("error" in envelope) {
    const message = envelope.error;
    throw new Error(typeof message === "string" && message ? message : "tailnet candidate enumeration unavailable");
  }
  if (!Array.isArray(envelope.candidates) || !envelope.candidates.every(isCandidate)) {
    throw new Error("tailnet candidate enumeration response is malformed");
  }
  return envelope.candidates;
}

type TailnetPeerRefreshResult = "applied" | "stale";

async function refreshTailnetPeers(): Promise<TailnetPeerRefreshResult> {
  const generation = ++tailnetPeerRefreshGeneration;
  // A new Tailnet authority generation makes every in-flight session result
  // stale before it can mutate peer health, rendered groups, or routes.
  state.loadSessionsEpoch++;
  scheduleTailnetPeerSessionRefresh(generation);
  const isCurrentGeneration = (): boolean => generation === tailnetPeerRefreshGeneration;
  try {
    const response = await api<unknown>("/tailnet/v1/candidates");
    if (!isCurrentGeneration()) return "stale";
    const candidates = candidateEnumerationCandidates(response);
    tailnetPeers.reconcileCandidates(candidates);
    await probeTailnetCandidates(candidates, fetch, {
      onSettled: (probe) => {
        if (!isCurrentGeneration()) return;
        const applied = tailnetPeers.applyProbe(probe);
        if (applied.kind === "identity-replaced") retireReplacedPeerIdentity(applied.replacement);
        scheduleTailnetPeerSessionRefresh(generation);
      },
    });
    if (!isCurrentGeneration()) return "stale";
    tailnetPeers.applyLegacyDisplayMetadata(legacyMachineDisplayMetadata());
    return "applied";
  } catch (error: unknown) {
    if (!isCurrentGeneration()) return "stale";
    const retainedEntries = tailnetPeers.entries().length > 0;
    tailnetPeers.markCandidateEnumerationUnavailable();
    if (retainedEntries) {
      renderMachinesList();
      scheduleTailnetPeerSessionRefresh(generation);
    }
    throw error;
  }
}

(async () => {
  try {
    const machine = await api<{ readonly machine?: { readonly displayName?: string }; readonly wolfpack?: { readonly version?: string } }>("/machine");
    state.selfName = machine.machine?.displayName || "this machine";
    state.selfVersion = machine.wolfpack?.version || "";
    const version = document.getElementById("settings-version");
    if (version && state.selfVersion) version.textContent = "wolfpack v" + state.selfVersion;
  } catch {
    state.selfName = "this machine";
  }
  try {
    await refreshTailnetPeers();
  } catch {
    // Local sessions remain useful if Tailnet candidate enumeration is unavailable.
  }
})();

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === "string" && msg) return msg;
  }
  return String(err || "unknown error");
}

interface SessionsResponse {
  readonly sessions?: Array<Record<string, unknown>>;
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

async function api<TResponse = unknown>(path: string, opts?: RequestInit, machineIdentity?: string): Promise<TResponse> {
  const origin = resolveReadyMachineOrigin(machineIdentity);
  if (machineIdentity && machineIdentity !== LOCAL_MACHINE_IDENTITY && !origin) throw new Error("selected peer is not ready");
  const base = origin ? new URL("/api" + path, origin).href : "/api" + path;
  const res = await fetchWithTimeout(base, opts);
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
};

function exposeActiveView(activeView: HTMLElement): void {
  document.querySelectorAll<HTMLElement>(".view").forEach((view) => {
    const active = view === activeView;
    view.toggleAttribute("inert", !active);
    if (active) view.removeAttribute("aria-hidden");
    else view.setAttribute("aria-hidden", "true");
  });
}

function showView(name: string, skipAnimation?: boolean): void {
  const prevView = state.currentView;
  const prevEl = document.getElementById(prevView + "-view");
  const isMobile = !isDesktop();

  // Desktop: "sessions" view is hidden — redirect to terminal if active (unless sessions expanded)
  const effectiveName = (!isMobile && name === "sessions" && state.currentSession && !state.sessionsExpanded) ? "terminal" : name;

  const nextEl = document.getElementById(effectiveName + "-view");
  if (!nextEl) return;
  exposeActiveView(nextEl);
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
    closeTerminalTranscript();
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
    if (effectiveName === "settings") {
      const advancedSettings = document.getElementById("settings-advanced") as HTMLDetailsElement | null;
      if (advancedSettings) advancedSettings.open = true;
      renderQuickCmdSettings();
      loadAgentsSettings();
    }
    // Update sidebar active highlight
    renderSidebar();
    syncSessionRefreshTimer();
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
      void loadSessions(); // immediate refresh on entering sessions view
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
      back.onclick = () => { returnFromSettingsWithFocus(); };
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
    }
  };

  applyHeader();
  syncSessionRefreshTimer();
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

const expandedSidebarDelegationParents = new Set<string>();

function sidebarDelegationParentKey(machineUrl: string, parentSessionId: string): string {
  return `${machineUrl}\u001f${parentSessionId}`;
}

function sidebarDelegationToggleHtml(row: DelegationSessionRow<DelegationSessionLike>, machineUrl: string): string {
  if (!row.childSummary) return "";
  const sessionId = sessionIdentityId(row.session);
  if (!sessionId) return "";
  const key = sidebarDelegationParentKey(machineUrl, sessionId);
  const expanded = expandedSidebarDelegationParents.has(key);
  const count = row.childSummary.total;
  const accessibleLabel = `${count} child ${count === 1 ? "agent" : "agents"}`;
  const visibleLabel = `${count} ${count === 1 ? "agent" : "agents"}`;
  return `<button type="button" class="delegation-sidebar-toggle${expanded ? " expanded" : ""}" onclick="toggleSidebarDelegationChildren('${escAttr(key)}', event)" aria-expanded="${expanded ? "true" : "false"}" aria-label="${expanded ? "Collapse" : "Expand"} ${escAttr(accessibleLabel)}" title="${expanded ? "Collapse" : "Expand"} child agents"><span class="delegation-sidebar-toggle-icon" aria-hidden="true"></span><span>${esc(visibleLabel)}</span></button>`;
}

function visibleDelegationRows(rows: readonly DelegationSessionRow<DelegationSessionLike>[], machineUrl: string): DelegationSessionRow<DelegationSessionLike>[] {
  const hiddenSessionIds = new Set<string>();
  const visibleRows: DelegationSessionRow<DelegationSessionLike>[] = [];
  for (const row of rows) {
    const sessionId = sessionIdentityId(row.session);
    const parentId = row.parent?.wolfpackSessionId;
    const hiddenByAncestor = parentId ? hiddenSessionIds.has(parentId) : false;
    const hiddenByCollapsedParent = row.role === "child"
      && parentId !== undefined
      && !expandedSidebarDelegationParents.has(sidebarDelegationParentKey(machineUrl, parentId));
    if (hiddenByAncestor || hiddenByCollapsedParent) {
      if (sessionId) hiddenSessionIds.add(sessionId);
      continue;
    }
    visibleRows.push(row);
    if (row.childSummary && sessionId && !expandedSidebarDelegationParents.has(sidebarDelegationParentKey(machineUrl, sessionId))) {
      hiddenSessionIds.add(sessionId);
    }
  }
  return visibleRows;
}

function renderSessionListFromState(): void {
  const el = document.getElementById("session-list");
  if (!el || !state.lastSessionGroups.length) return;
  const multiMachine = getMachines().length > 0;
  const html = multiMachine
    ? state.lastSessionGroups.map(group => renderMachineGroupHtml(group, true)).join("")
    : renderMachineGroupHtml(state.lastSessionGroups[0], false);
  if (html !== state.lastSessionsHtml) {
    el.innerHTML = html;
    state.lastSessionsHtml = html;
  }
}

function toggleSidebarDelegationChildren(key: string, event?: Event): void {
  event?.stopPropagation();
  event?.preventDefault();
  if (expandedSidebarDelegationParents.has(key)) expandedSidebarDelegationParents.delete(key);
  else expandedSidebarDelegationParents.add(key);
  renderSessionListFromState();
  renderSidebar();
  if (state.drawerOpen) renderDrawerList();
}

function delegationParentMissingHtml(row: DelegationSessionRow<DelegationSessionLike>): string {
  if (row.role === "orphan" && row.parent) {
    return `<div class="delegation-parent-missing">missing parent: ${esc(row.parent.wolfpackSessionName)}</div>`;
  }
  return "";
}

function sessionOrderIdentity(session: DelegationSessionLike, machineUrl: string): SessionOrderIdentity | null {
  const sessionId = sessionIdentityId(session);
  return sessionId ? { machineUrl, sessionId } : null;
}

function sessionOrderRows(
  sessions: readonly DelegationSessionLike[],
  machineUrl: string,
): DelegationSessionRow<DelegationSessionLike>[] {
  const rows = projectDelegationSessions(sessions);
  const visible = rows.flatMap(row => {
    const identity = sessionOrderIdentity(row.session, machineUrl);
    return identity ? [identity] : [];
  });
  const effectiveOrder = reconcileSessionOrder(
    sessionOrder.filter(identity => identity.machineUrl === machineUrl),
    visible,
  );
  sessionOrder = replaceMachineSessionOrder(sessionOrder, machineUrl, effectiveOrder);
  return orderDelegationSessionRows(rows, effectiveOrder, machineUrl);
}

function sessionOrderCardHtml(row: DelegationSessionRow<DelegationSessionLike>, machineUrl: string): {
  readonly attributes: string;
  readonly openAttributes: string;
} {
  const identity = sessionOrderIdentity(row.session, machineUrl);
  if (!identity) return { attributes: "", openAttributes: "" };
  const parentId = row.role === "child" ? row.parent?.wolfpackSessionId ?? "" : "";
  return {
    attributes: ` data-session-order-id="${escAttr(identity.sessionId)}" data-session-order-machine="${escAttr(machineUrl)}" data-session-order-parent="${escAttr(parentId)}"`,
    openAttributes: ` aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" aria-describedby="session-order-instructions"`,
  };
}

function hasStoredSessionOrder(machineUrl: string): boolean {
  return manuallyOrderedMachines.has(machineUrl);
}

function saveManualSessionOrder(): boolean {
  return saveSessionOrder(
    safeLocalStorage(),
    sessionOrder.filter(identity => manuallyOrderedMachines.has(identity.machineUrl)),
  );
}

function sessionOrderResetButtonHtml(machineUrl: string): string {
  if (!hasStoredSessionOrder(machineUrl)) return "";
  return `<button type="button" class="session-order-reset" data-session-order-machine="${escAttr(machineUrl)}" aria-label="Reset session order" title="Reset session order">↺</button>`;
}

// Shared session groups cache for switcher reuse
function renderMachineGroupHtml(g, multiMachine) {
  const mUrlAttr = multiMachine ? escAttr(g.machine.url) : "";
  const mName = esc(g.machine.name);
  const statusDot = !multiMachine ? "green" : g.online ? "green" : (g.pending ? "gray" : "red");
  const statusTitle = !multiMachine ? "online" : g.online ? "online" : (g.pending ? "connecting" : "offline");
  const versionWarning = multiMachine && g.outdated ? `<span class="version-warning" title="Running v${escAttr(g.machine.version || "?")} — newer version available on another machine">⚠ UPDATE</span>` : "";
  const offlineClass = multiMachine && !g.online && !g.pending ? " offline" : "";
  const failureAttribute = g.failure ? ` data-failure="${escAttr(g.failure)}"` : "";
  let html = multiMachine ? `<div class="machine-group${offlineClass}" data-machine="${mUrlAttr}"${failureAttribute}>` : `<div class="machine-group">`;
  const createDisabled = multiMachine && !g.online ? " disabled" : "";
  const machineKey = multiMachine ? g.machine.url || "" : "";
  html += `<div class="machine-header"><div class="dot ${statusDot}" title="${statusTitle}"></div>${mName}${versionWarning}<div class="machine-header-btns">${sessionOrderResetButtonHtml(machineKey)}<button type="button" class="machine-add-btn" aria-label="Start a session on ${escAttr(g.machine.name)}" title="New session" onclick="showProjectPicker('${mUrlAttr}')"${createDisabled}>+</button></div></div>`;
  if (multiMachine && g.pending) {
    html += `<div class="group-status">Connecting...</div>`;
  } else if (g.online) {
    if (g.sessions.length) {
      const delegationRows = sessionOrderRows(g.sessions, machineKey);
      const useCollapsibleSessionCards = !isDesktop();
      const rows = useCollapsibleSessionCards
        ? visibleDelegationRows(delegationRows, machineKey)
        : delegationRows;
      html += rows.map((row, i) => {
        const s = row.session;
        const lastLine = s.lastLine || "";
        const ui = triageUi(s);
        const anim = state.firstLoad ? "animate-in" : "";
        const grouping = delegationCardAttributes(row);
        const ordering = sessionOrderCardHtml(row, machineKey);
        return `<div class="card card-stagger ${anim} ${ui.card}${grouping.className}"${grouping.dataAttribute}${ordering.attributes} style="${state.firstLoad ? 'animation-delay:' + i * 30 + 'ms' : ''}">
          <button type="button" class="card-open" aria-label="Open ${escAttr(s.name)}"${ordering.openAttributes} onclick="openSession('${escAttr(s.name)}'${mUrlAttr ? ", '" + mUrlAttr + "'" : ''})"></button>
          <div class="dot ${ui.dot}" title="${ui.title}"></div>
          <div class="card-info">
            <div class="card-name"><span class="card-name-text">${esc(s.name)}</span><span class="triage-badge ${ui.badge}">${ui.label}</span>${useCollapsibleSessionCards ? sidebarDelegationToggleHtml(row, machineKey) : ""}</div>
            ${useCollapsibleSessionCards ? "" : delegationParentSummaryHtml(row)}
            ${delegationParentMissingHtml(row)}
            <div class="card-preview">${esc(lastLine)}</div>
          </div>
          <button type="button" class="kill-btn" aria-label="Stop ${escAttr(s.name)}" title="Stop session" onclick="killSession('${escAttr(s.name)}', event${mUrlAttr ? ", '" + mUrlAttr + "'" : ''})">&times;</button>
        </div>`;
      }).join("");
    }
  } else if (multiMachine) {
    const failure = machineFailureLabel(g.failure || "unknown");
    html += `<div class="group-status machine-failure" role="status">${esc(failure)}. Live terminal actions require this machine to reconnect. <button type="button" class="machine-retry-btn" aria-label="Retry ${escAttr(g.machine.name)}" onclick="retryMachine('${mUrlAttr}', event)">Retry</button></div>`;
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
  const idle = sessionRuntimeState(row.session) === AGENT_STATUS_STATE.IDLE;
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
  clearPreservedGrid();
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
  collapseAutoExpandedSidebarImmediately();
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
  collapseAutoExpandedSidebarImmediately();
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

type MachineFailureCategory = "auth" | "timeout" | "server" | "network" | "unknown";

function classifyMachineFailure(error: unknown): MachineFailureCategory {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { readonly status?: unknown }).status;
    if (status === 401 || status === 403) return "auth";
    if (typeof status === "number" && status >= 500) return "server";
  }
  if (error instanceof TypeError) return "network";
  return "unknown";
}

function machineFailureLabel(category: MachineFailureCategory): string {
  if (category === "auth") return "Authentication required";
  if (category === "timeout") return "Timed out";
  if (category === "server") return "Server unavailable";
  if (category === "network") return "Unreachable";
  return "Connection failed";
}

function fetchMachine(machineIdentity, machineMeta, isCurrentLoad) {
  const isRemote = machineIdentity !== "";
  if (isRemote && !resolveReadyMachineOrigin(machineIdentity)) {
    return Promise.resolve({
      machine: { ...machineMeta, url: machineIdentity, version: machineMeta.version || "" },
      sessions: [], online: false, pending: false,
      failure: "network" as const,
    });
  }
  const timeoutMs = isRemote ? WP.peerHealthTimeoutMs(state.peerHealth, machineIdentity) : 0;
  const options = isRemote ? { signal: AbortSignal.timeout(timeoutMs) } : undefined;
  return api<SessionsResponse>("/sessions", options, machineIdentity || undefined).then((sessions) => {
    if (isRemote && isCurrentLoad()) state.peerHealth = WP.peerHealthRecordSuccess(state.peerHealth, machineIdentity);
    return {
      machine: { ...machineMeta, url: machineIdentity, version: machineMeta.version || "" },
      sessions: sessions.sessions || [],
      online: true,
      pending: false,
    };
  }).catch((error: unknown) => {
    if (isRemote && isCurrentLoad()) state.peerHealth = WP.peerHealthRecordFailure(state.peerHealth, machineIdentity);
    return {
      machine: { ...machineMeta, url: machineIdentity, version: machineMeta.version || "" },
      sessions: [], online: false, pending: false,
      failure: classifyMachineFailure(error),
    };
  });
}

async function loadSessionsOnce() {
  const myEpoch = ++state.loadSessionsEpoch;
  const isCurrentLoad = (): boolean => myEpoch === state.loadSessionsEpoch;
  const el = document.getElementById("session-list");
  const machines = getMachines();
  const multiMachine = machines.length > 0;

  // Single-machine: just fetch and render
  if (!multiMachine) {
    const g = await fetchMachine("", { name: state.selfName || "this machine" }, isCurrentLoad);
    if (!isCurrentLoad()) return; // stale call, discard
    state.lastSessionGroups = [g];
    state.allSessions = g.sessions.map(s => ({ ...s, machineUrl: "", machineName: g.machine.name }));
    const html = renderMachineGroupHtml(g, false);
    if (html !== state.lastSessionsHtml) { el.innerHTML = html; state.lastSessionsHtml = html; }
    syncDelegationWorkspace();
    checkStateTransitions([g]);
    state.firstLoad = false;
    await openSessionFromNotificationRoute(myEpoch);
    return;
  }

  // Multi-machine
  const allMachines = [
    { url: "", meta: { name: state.selfName || "this machine" } },
    ...machines.map(m => ({ url: m.url, meta: m })),
  ];

  // Discovery can finish after the initial local-only render. Materialize any
  // newly discovered groups before their independent session requests settle.
  const renderedMachineIds = new Set(Array.from(el.querySelectorAll<HTMLElement>(".machine-group"))
    .map((group) => group.dataset.machine ?? ""));
  if (state.firstLoad || allMachines.some((machine) => !renderedMachineIds.has(machine.url))) {
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
    sessions: [], online: false, pending: true,
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
    fetchMachine(m.url, m.meta, isCurrentLoad).then(g => {
      if (!isCurrentLoad()) return; // stale call, discard
      groups[i] = g;
      state.lastSessionGroups = groupsInOrder();
      renderGroup(i, g);
      // Sidebar reads from state.lastSessionGroups — refresh it now so the
      // local machine's card appears without waiting for slow peers.
      renderSidebar();
    })
  );

  await Promise.all(promises);
  if (!isCurrentLoad()) return; // stale call, discard

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
  await openSessionFromNotificationRoute(myEpoch);
}

let sessionRefreshPromise: Promise<void> | null = null;
let forceSessionRefreshAfterCurrent = false;

function loadSessions(forceAfterCurrent = false): Promise<void> {
  if (sessionRefreshPromise) {
    if (forceAfterCurrent) forceSessionRefreshAfterCurrent = true;
    return sessionRefreshPromise;
  }
  sessionRefreshPromise = (async () => {
    do {
      forceSessionRefreshAfterCurrent = false;
      await loadSessionsOnce();
      renderSidebar();
    } while (forceSessionRefreshAfterCurrent);
  })().finally(() => {
    sessionRefreshPromise = null;
  });
  return sessionRefreshPromise;
}

async function openSessionFromNotificationRoute(expectedLoadEpoch: number): Promise<void> {
  if (expectedLoadEpoch !== state.loadSessionsEpoch) return;
  const route = parseSessionNotificationRoute(location.search);
  if (!route) return;
  const machineIdentity = route.machineIdentity === LOCAL_MACHINE_IDENTITY ? "" : route.machineIdentity;
  const group = state.lastSessionGroups.find(candidate =>
    (candidate.machine.url || "") === machineIdentity && candidate.online);
  const session = group?.sessions.find(candidate => sessionIdentityId(candidate) === route.sessionId);
  if (!session) {
    console.warn("notification target is unavailable; refresh Tailnet discovery and retry");
    return;
  }
  if (expectedLoadEpoch !== state.loadSessionsEpoch) return;

  await openSession(session.name, machineIdentity || undefined);
  const cleanUrl = new URL(location.href);
  cleanUrl.searchParams.delete("sessionId");
  cleanUrl.searchParams.delete("session");
  cleanUrl.searchParams.delete("machine");
  history.replaceState(history.state, "", cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
}

function retryMachine(_machineIdentity: string, event?: Event): void {
  event?.stopPropagation();
  void refreshTailnetPeers()
    .then((result) => result === "applied" ? loadSessions(true) : undefined)
    .catch(() => undefined);
}

const SESSION_REFRESH_INTERVAL_MS = 5_000;

function syncSessionRefreshTimer(refreshNow = false): void {
  if (state.sessionRefreshTimer) {
    clearInterval(state.sessionRefreshTimer);
    state.sessionRefreshTimer = null;
  }
  if (document.visibilityState !== "visible") return;
  if (!isDesktop() && state.currentView !== "sessions") return;
  if (refreshNow) void loadSessions();
  state.sessionRefreshTimer = setInterval(() => { void loadSessions(); }, SESSION_REFRESH_INTERVAL_MS);
}

function setSidebarCollapsedImmediately(collapsed: boolean): void {
  const sidebar = document.getElementById("desktop-sidebar");
  if (!sidebar) return;
  sidebar.style.transition = "none";
  if (collapsed) sidebar.classList.add("collapsed");
  else sidebar.classList.remove("collapsed");
  void sidebar.offsetHeight;
  sidebar.style.transition = "";
  state.sidebarCollapsed = collapsed;
}

function collapseAutoExpandedSidebarImmediately(): void {
  if (!state.sidebarAutoExpanded) return;
  setSidebarCollapsedImmediately(true);
  state.sidebarAutoExpanded = false;
  if (sidebarAutoCollapseTimer) {
    clearTimeout(sidebarAutoCollapseTimer);
    sidebarAutoCollapseTimer = null;
  }
}

async function openSession(name, machineUrl) {
  const targetMachine = machineUrl || "";
  if (targetMachine && !resolveReadyMachineOrigin(targetMachine)) {
    await showMachineUnavailable();
    return;
  }
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
  if (state.activeDelegationRoot) {
    teardownDelegationWorkspace();
    clearPreservedGrid();
  }
  if (state.currentView !== "terminal" && hasPreservedGrid()) clearPreservedGrid();
  // Exit expanded sessions mode when opening a session
  if (state.sessionsExpanded) {
    state.sessionsExpanded = false;
    document.body.classList.remove("sessions-expanded");
    const expandBtn = document.getElementById("sidebar-expand-btn");
    if (expandBtn) expandBtn.classList.remove("active");
    // Settle the terminal-width layout before mounting Ghostty. Animating the
    // pinned sidebar here makes the initial attach use an obsolete column count.
    if (state.sidebarPinned) setSidebarCollapsedImmediately(false);
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
    collapseAutoExpandedSidebarImmediately();
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
let keyboardMenuSelection: { readonly view: "projects" | "agent"; readonly index: number } | null = null;

function resetPickerKeyboardSelection(): void {
  document.querySelectorAll("#project-list .keyboard-selected, #agent-list .keyboard-selected")
    .forEach((card) => card.classList.remove("keyboard-selected"));
  keyboardMenuSelection = null;
}

function pickerMenuCards(view: "projects" | "agent"): HTMLElement[] {
  const listId = view === "projects" ? "project-list" : "agent-list";
  return Array.from(document.querySelectorAll<HTMLElement>(`#${listId} .card`));
}

function handlePickerKeyboardNavigation(event: KeyboardEvent): void {
  if (!isDesktop() || event.altKey || event.ctrlKey || event.metaKey) return;
  const view = state.currentView === "projects" || state.currentView === "agent"
    ? state.currentView
    : null;
  if (!view) return;
  const cards = pickerMenuCards(view);
  const selectedIndex = keyboardMenuSelection?.view === view
    ? keyboardMenuSelection.index
    : null;
  if (event.key === "Enter") {
    if (selectedIndex === null) return;
    event.preventDefault();
    cards[selectedIndex]?.click();
    return;
  }
  const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : null;
  if (direction === null) return;
  event.preventDefault();
  const nextIndex = nextMenuSelection({ itemCount: cards.length, selectedIndex, direction });
  if (nextIndex === null) return;
  cards.forEach((card, index) => card.classList.toggle("keyboard-selected", index === nextIndex));
  keyboardMenuSelection = { view, index: nextIndex };
  cards[nextIndex]?.scrollIntoView({ block: "nearest" });
}

const PROJECT_RECENTS_STORAGE_KEY = "wolfpack-project-recents";
const MAX_VISIBLE_PROJECTS = 50;

function projectRecentStore(): Record<string, unknown> {
  const stored = loadStoredJson(PROJECT_RECENTS_STORAGE_KEY, {}) as unknown;
  return stored && typeof stored === "object" && !Array.isArray(stored)
    ? stored as Record<string, unknown>
    : {};
}

function loadProjectRecents(): readonly string[] {
  const stored = projectRecentStore();
  const recents = stored[state.projectMachine || "local"];
  return Array.isArray(recents) ? recents.filter((project): project is string => typeof project === "string") : [];
}

function recordProjectRecent(project: string): void {
  const stored = projectRecentStore();
  const machine = state.projectMachine || "local";
  const current = Array.isArray(stored[machine])
    ? (stored[machine] as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  stored[machine] = [project, ...current.filter((value) => value !== project)].slice(0, MAX_VISIBLE_PROJECTS);
  try { localStorage.setItem(PROJECT_RECENTS_STORAGE_KEY, JSON.stringify(stored)); }
  catch { /* recent ranking remains optional when storage is unavailable */ }
}

function renderProjectNames(projects: readonly string[]): void {
  resetPickerKeyboardSelection();
  const list = document.getElementById("project-list");
  if (!projects.length) {
    list.innerHTML = '<div class="empty">No matching projects</div>';
    return;
  }
  list.innerHTML = projects
    .map(
      (project) => `
<button type="button" class="card" aria-label="Open project ${escAttr(project)}" onclick="selectProject('${escAttr(project)}')">
  <div class="dot brand" title="project"></div>
  <div class="card-name">${esc(project)}</div>
</button>
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
  resetPickerKeyboardSelection();
  const projectNameInput = document.getElementById("new-project-name") as HTMLInputElement;
  const createProjectInput = document.getElementById("new-project-create-name") as HTMLInputElement;
  projectNameInput.value = "";
  createProjectInput.value = "";
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
    renderProjectNames(rankProjectNames(projectNames, "", loadProjectRecents(), MAX_VISIBLE_PROJECTS));
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
  recordProjectRecent(project);
  state.selectedProject = project;
  state.isNewProject = false;
  showAgentPicker();
}

function selectNewProject() {
  const input = document.getElementById("new-project-create-name") as HTMLInputElement;
  const name = input.value.trim();
  if (!name) return;
  recordProjectRecent(name);
  state.selectedProject = name;
  state.isNewProject = true;
  showAgentPicker();
}

async function showAgentPicker() {
  showView("agent");
  resetPickerKeyboardSelection();
  const el = document.getElementById("agent-list");
  el.innerHTML = '<div class="empty">Loading...</div>';
  const nameInput = document.getElementById("session-name-input") as HTMLInputElement;
  const initialTaskInput = document.getElementById("initial-task-input") as HTMLTextAreaElement;
  const nameError = document.getElementById("session-name-error");
  const createError = document.getElementById("agent-create-error");
  nameInput.value = "";
  initialTaskInput.value = "";
  createError.textContent = "";
  createError.classList.remove("visible");
  nameInput.classList.remove("invalid");
  nameError.classList.remove("visible");
  try {
    const [data, nameData] = await Promise.all([
      api<SettingsResponse>("/settings", undefined, state.projectMachine),
      api<NextSessionNameResponse>("/next-session-name?project=" + encodeURIComponent(state.selectedProject), undefined, state.projectMachine),
    ]);
    if (!nameInput.value.trim()) nameInput.value = nameData.name || state.selectedProject;
    // /api/settings now returns { settings, effective } — effective.cmds is
    // the list to render (already filtered to enabled, with ["shell"] fallback
    // when nothing's on). Manage which cmds appear via the Settings page.
    const cmds = data.effective?.cmds || [AGENT_KIND.SHELL];
    const defaultCmd = data.effective?.agentCmd;
    const cards = cmds.map((cmd) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "card";
      button.setAttribute("aria-label", `Start ${cmd}`);
      button.addEventListener("click", () => { void createSessionWithAgent(cmd); });
      const dot = document.createElement("div");
      dot.className = `dot ${cmd === defaultCmd ? "brand" : "green"}`;
      dot.title = cmd === defaultCmd ? "default" : "agent";
      const name = document.createElement("div");
      name.className = "card-name";
      name.textContent = cmd;
      button.append(dot, name);
      return button;
    });
    el.replaceChildren(...cards);
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
    showAgentAddError("Failed to delete command: " + errorMessage(e));
  }
}

async function createSessionWithAgent(cmd) {
  const nameInput = document.getElementById("session-name-input") as HTMLInputElement;
  const sessionName = (nameInput.value || "").trim();
  const initialPrompt = (document.getElementById("initial-task-input") as HTMLTextAreaElement).value.trim();
  if (sessionName && !/^[a-zA-Z0-9_-]+$/.test(sessionName)) return;
  const machine = state.projectMachine;
  const createError = document.getElementById("agent-create-error");
  createError.textContent = "";
  createError.classList.remove("visible");
  try {
    const body = state.isNewProject
      ? { newProject: state.selectedProject, cmd, sessionName: sessionName || undefined, initialPrompt: initialPrompt || undefined }
      : { project: state.selectedProject, cmd, sessionName: sessionName || undefined, initialPrompt: initialPrompt || undefined };
    const data = await api<CreateSessionResponse>("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, machine);
    if (data.session) {
      showTerminalLoading(sessionName || state.selectedProject);
      setState({ currentSession: data.session, currentMachine: machine });
      // Refresh session list in background so it doesn't block terminal init
      loadSessions(true).then(() => { loadSessionSwitcher(); renderSidebar(); });
      if (isGridActive()) {
        // Grid is active — add new session to grid instead of single-terminal
        addToGrid(data.session, machine);
      } else {
        destroyTerminal();
        initTerminal();
      }
    } else {
      throw new Error("Server returned no session (is wolfpack up to date?)");
    }
  } catch (e) {
    createError.textContent = "Failed to create session: " + errorMessage(e);
    createError.classList.add("visible");
    nameInput.focus({ preventScroll: true });
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
  const terminalPrefillMode = prefillModeOverride ?? TERMINAL_PREFILL_MODE.FULL;
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
    prefillMode: terminalPrefillMode,
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
    statusEl.innerHTML = '<img src="/wolfpack-icon.svg" class="conn-icon">connection lost \u2014 cached output is read-only; reconnect for live terminal actions. <button type="button" id="conn-retry-btn" class="conn-retry-btn">Reconnect</button>';
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
  const delegationReturnTarget = name === state.focusedDelegationSession && state.activeDelegationRoot
    ? { session: state.activeDelegationRoot, machine: state.delegationMachine || "" }
    : null;
  const confirmed = await showAppDialog({
    title: "Stop session",
    message: `Stop session "${name}"?`,
    confirmLabel: "Stop session",
    destructive: true,
  });
  if (!confirmed) return;
  try {
    await api("/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: name }),
    }, machineUrl || "");
  } catch (e) {
    await showAppDialog({
      title: "Could not stop session",
      message: errorMessage(e),
      confirmLabel: "Close",
      cancelLabel: null,
    });
    return;
  }
  if (delegationReturnTarget) {
    destroyTerminal();
    teardownDelegationWorkspace();
    setState({ currentSession: null, currentMachine: "" });
    await loadSessions(true);
    await openSession(delegationReturnTarget.session, delegationReturnTarget.machine || undefined);
    return;
  }
  const wasCurrentSession = name === state.currentSession && (machineUrl || "") === state.currentMachine;
  if (wasCurrentSession && state.currentView === "terminal") {
    destroyTerminal();
    setState({ currentSession: null, currentMachine: "" });
    showView("sessions");
  }
  void loadSessions(true);
}

// ── Session drawer ──

function renderDrawerList() {
  const groups = state.lastSessionGroups;
  const list = document.getElementById("drawer-list");
  const multiMachine = getMachines().length > 0;

  const all = groups.flatMap(group => {
    const machineUrl = group.machine.url || "";
    const rows = visibleDelegationRows(sessionOrderRows(group.sessions, machineUrl), machineUrl);
    return rows.map(row => ({
      row,
      session: row.session,
      machineUrl,
      machineName: group.machine.name,
    }));
  });

  let html = "";
  html += all.map(item => drawerItemHtml(item, multiMachine)).join("");
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

function drawerItemHtml(item, multiMachine) {
  const { row, session, machineUrl, machineName } = item;
  const val = machineUrl ? machineUrl + "|" + session.name : session.name;
  const isCurrent = session.name === state.currentSession && machineUrl === state.currentMachine;
  const machineLbl = multiMachine ? `<span class="drawer-item-machine">${esc(machineName)}</span>` : "";
  const hierarchyClass = row.role === "child"
    ? " drawer-child-item"
    : row.role === "orphan"
      ? " drawer-orphan-item"
      : row.childSummary ? " drawer-parent-item" : "";
  return `<div class="drawer-item-row" role="listitem">
    <button type="button" class="drawer-item${hierarchyClass}${isCurrent ? " current" : ""}" data-val="${escAttr(val)}"${isCurrent ? ' aria-current="page"' : ""}>
      <span class="dot ${isCurrent ? "active" : "inactive"}" title="${isCurrent ? "current session" : "other session"}"></span>
      <span class="drawer-item-name">${esc(session.name)}</span>
      ${machineLbl}
    </button>
    ${sidebarDelegationToggleHtml(row, machineUrl)}
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
  chip.setAttribute("aria-expanded", "true");
  haptic(5);
}

function closeDrawer(instant?: boolean): void {
  if (!state.drawerOpen) return;
  state.drawerOpen = false;
  const drawer = document.getElementById("session-drawer");
  const backdrop = document.getElementById("drawer-backdrop");
  const chip = document.getElementById("session-chip");
  chip.classList.remove("open");
  chip.setAttribute("aria-expanded", "false");
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
        const disclosure = touchTarget.closest(".delegation-sidebar-toggle");
        if (disclosure && drawer.contains(disclosure)) {
          e.preventDefault();
          disclosure.click();
          return;
        }
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
  drawer.addEventListener("touchend", onEnd, { passive: false });
})();

async function switchSession(val) {
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
  if (machineUrl && !resolveReadyMachineOrigin(machineUrl)) {
    await showMachineUnavailable();
    return;
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
    // Resume one shared cadence and refresh immediately after foregrounding.
    syncSessionRefreshTimer(true);
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

// Escape to back out of project/agent picker views
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (state.focusedDelegationSession) {
    e.preventDefault();
    e.stopPropagation();
    returnToDelegationGrid();
  }
  if (state.currentView === "agent") { e.preventDefault(); showView("projects"); }
  else if (state.currentView === "projects") { e.preventDefault(); returnFromProjectPicker(); }
  else if (state.currentView === "settings") { e.preventDefault(); returnFromSettingsWithFocus(); }
});

// ── Desktop keyboard shortcuts (capture phase, before terminal) ──
document.addEventListener("keydown", (e) => {
  if (!isDesktop()) return;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;

  // Cmd+B — toggle the persistent desktop sidebar without covering the terminal.
  if (e.key.toLowerCase() === "b" && !state.sessionsExpanded) {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById("sidebar-collapse-btn")?.click();
    return;
  }

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
  renderProjectNames(rankProjectNames(
    projectNames,
    newProjectNameInput.value,
    loadProjectRecents(),
    MAX_VISIBLE_PROJECTS,
  ));
});
newProjectNameInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  if (state.currentView !== "projects") return;
  if (keyboardMenuSelection?.view === "projects") return;
  event.preventDefault();
  if (projectNames === null) return;
  const match = rankProjectNames(projectNames, newProjectNameInput.value, loadProjectRecents(), MAX_VISIBLE_PROJECTS)[0];
  if (match) selectProject(match);
});

document.getElementById("new-project-create-name")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || state.currentView !== "projects") return;
  event.preventDefault();
  selectNewProject();
});

// ── Settings ──

const SETTINGS_SECTION_IDS = new Set([
  "settings-effects",
  "settings-terminal",
  "settings-input",
  "settings-machines",
  "settings-agents",
]);

function settingsSectionFromHash(): string | null {
  const sectionId = location.hash.slice(1);
  return SETTINGS_SECTION_IDS.has(sectionId) ? sectionId : null;
}

function revealSettingsSection(sectionId: string, updateLocation = true): void {
  if (!SETTINGS_SECTION_IDS.has(sectionId)) return;
  const section = document.getElementById(sectionId);
  if (!section) return;
  const disclosure = section.closest<HTMLDetailsElement>("details");
  if (disclosure) disclosure.open = true;
  if (updateLocation) history.replaceState(history.state, "", `#${sectionId}`);
  requestAnimationFrame(() => section.scrollIntoView({ block: "start", behavior: "smooth" }));
}

let settingsFocusReturn: HTMLElement | null = null;

function returnFromSettingsWithFocus(): void {
  const focusReturn = settingsFocusReturn;
  settingsFocusReturn = null;
  backFromSettings();
  requestAnimationFrame(() => {
    if (focusReturn?.isConnected && !focusReturn.closest("[inert]")) {
      focusReturn.focus({ preventScroll: true });
    }
  });
}

async function showSettings() {
  const activeElement = document.activeElement;
  settingsFocusReturn = activeElement instanceof HTMLElement && activeElement !== document.body
    ? activeElement
    : null;
  setState({ viewBeforeSettings: state.currentView });
  showView("settings");
  const focusTarget = isDesktop()
    ? document.getElementById("settings-back-btn")
    : document.getElementById("back-btn");
  requestAnimationFrame(() => focusTarget?.focus({ preventScroll: true }));
  renderMachinesList();
  toggleDebugPanel();
}

function setPeerNotificationEnrollmentUnavailable(): void {
  const status = document.getElementById("discover-status");
  if (!status) return;
  status.textContent = "This Tailnet machine is no longer ready for notification setup.";
  status.style.color = "#cc3333";
}

function setUpPeerNotifications(machineIdentity: string): void {
  const origin = resolveReadyMachineOrigin(machineIdentity);
  if (!origin) {
    setPeerNotificationEnrollmentUnavailable();
    return;
  }
  window.location.assign(new URL("/#settings-effects", origin).href);
}

function renderMachinesList(): void {
  const machines = getMachines();
  const el = document.getElementById("machines-list");
  if (!machines.length) {
    el.innerHTML = '<div class="no-machines">No Tailnet candidates found</div>';
    return;
  }
  el.innerHTML = machines.map((machine) => {
    const dot = machine.ready ? "green" : "red";
    const status = machine.ready ? "online" : machine.diagnostic || "offline";
    const notificationSetup = machine.ready
      ? `<button class="machine-notification-setup" type="button" data-machine-identity="${escAttr(machine.url)}">Set up notifications on ${esc(machine.name)}</button>`
      : "";
    return `<div class="machine-item">
      <div class="dot ${dot}" title="${escAttr(status)}"></div>
      <span class="machine-item-name">${esc(machine.name)}<span class="machine-item-url">${esc(machine.url)}</span></span>
      ${notificationSetup}
    </div>`;
  }).join("");
  el.querySelectorAll<HTMLButtonElement>(".machine-notification-setup").forEach((button) => {
    button.addEventListener("click", () => {
      const machineIdentity = button.dataset.machineIdentity;
      if (machineIdentity) setUpPeerNotifications(machineIdentity);
    });
  });
}

async function discoverMachines(): Promise<void> {
  const statusEl = document.getElementById("discover-status");
  statusEl.textContent = "Scanning tailnet...";
  statusEl.style.color = "#555";
  try {
    const refreshResult = await refreshTailnetPeers();
    if (refreshResult === "stale") return;
    const machines = getMachines();
    const ready = machines.filter((machine) => machine.ready).length;
    renderMachinesList();
    void loadSessions(true);
    statusEl.textContent = ready ? `Found ${ready} ready Tailnet machine${ready === 1 ? "" : "s"}` : "No ready Wolfpack machines found on Tailnet";
    statusEl.style.color = ready ? "#00ff41" : "#555";
  } catch (error) {
    statusEl.textContent = errorMessage(error);
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
    terminal: "sessions",
    projects: "sessions", agent: "projects", settings: "sessions",
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
        const card = (e.target as Element | null)?.closest(".card") ?? null;
        if (!card) { scrolling = true; return; }
        swipeCard = card;
        isBack = false;
        fgEl = document.getElementById(state.currentView + "-view");
        forwardTargetView = state.currentView === "sessions" ? "terminal" : null;
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
        (card.querySelector(".card-open") as HTMLElement | null)?.click();
      }
    }

    vc.classList.remove("swipe-active");
    fgEl = null; bgEl = null; swipeCard = null; forwardTargetView = null;
  }, { passive: true });
}

// ── Desktop Sidebar ──

let sidebarAutoCollapseTimer = null;
let sidebarSessionOrderDragActive = false;
let sidebarLayoutTransitionFallbackTimer: ReturnType<typeof setTimeout> | null = null;
const SIDEBAR_LAYOUT_TRANSITION_FALLBACK_MS = 300;

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
    // Single machine — simple list with + New
    const g = groups[0];
    const sidebarBtns = `<div class="sidebar-top-btns"><button type="button" class="new-btn" aria-label="Start a session on this machine" onclick="showProjectPicker()"><span aria-hidden="true">+</span> New session</button>${sessionOrderResetButtonHtml("")}</div>`;
    if (g && g.online && g.sessions.length) {
      html += sidebarBtns;
      html += visibleDelegationRows(sessionOrderRows(g.sessions, ""), "").map(row => sidebarCardHtml(row, "")).join("");
    } else {
      html += sidebarBtns;
      html += '<div class="sidebar-no-sessions">No active sessions</div>';
    }
  } else {
    // Multi-machine
    for (const g of groups) {
      const mUrl = escAttr(g.machine.url);
      const mName = esc(g.machine.name);
      const statusDot = g.online ? "green" : (g.pending ? "gray" : "red");
      const offlineClass = !g.online && !g.pending ? " offline" : "";
      const createDisabled = !g.online ? " disabled" : "";
      html += `<div class="machine-group${offlineClass}" data-machine="${mUrl}">`;
      html += `<div class="machine-header"><div class="dot ${statusDot}"></div>${mName}<div class="machine-header-btns">${sessionOrderResetButtonHtml(g.machine.url)}<button type="button" class="machine-add-btn" aria-label="Start a session on ${escAttr(g.machine.name)}" title="New session" onclick="showProjectPicker('${escAttr(g.machine.url)}')"${createDisabled}>+</button></div></div>`;
      if (g.online && g.sessions.length) {
        html += visibleDelegationRows(sessionOrderRows(g.sessions, g.machine.url), g.machine.url).map(row => sidebarCardHtml(row, g.machine.url)).join("");
      } else if (g.pending) {
        html += '<div class="sidebar-conn-status">Connecting...</div>';
      } else if (!g.online) {
        html += `<div class="sidebar-conn-status">${esc(machineFailureLabel(g.failure || "unknown"))} <button type="button" class="machine-retry-btn" aria-label="Retry ${escAttr(g.machine.name)}" onclick="retryMachine('${mUrl}', event)">Retry</button></div>`;
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
  const gridAction = inGrid ? "Remove from grid" : "Add to grid";
  const gridBtn = `<button type="button" class="grid-btn${inGrid ? ' in-grid' : ''}" onclick="${gridBtnOnclick}" title="${gridAction}" aria-label="${gridAction}: ${escAttr(s.name)}">${inGrid ? '⊠' : '+'}</button>`;
  const grouping = delegationCardAttributes(row);
  const ordering = sessionOrderCardHtml(row, machineUrl);
  return `<div class="card ${ui.card}${activeClass}${grouping.className}"${grouping.dataAttribute}${ordering.attributes}>
    <button type="button" class="card-open" aria-label="Open ${escAttr(s.name)}"${ordering.openAttributes} onclick="${onclick}"></button>
    <div class="dot ${ui.dot}" title="${ui.title}"></div>
    <div class="card-info">
      <div class="card-name"><span class="card-name-text">${esc(s.name)}</span></div>
      <div class="card-status"><span class="triage-badge ${ui.badge}">${ui.label}</span>${sidebarDelegationToggleHtml(row, machineUrl)}</div>
      ${delegationParentMissingHtml(row)}
      <div class="card-preview">${esc(lastLine)}</div>
    </div>
    ${gridBtn}
    <button type="button" class="kill-btn" aria-label="Stop ${escAttr(s.name)}" title="Stop session" onclick="killSession('${escAttr(s.name)}', event${machineUrl ? ", '" + machineUrlAttr + "'" : ''})">&times;</button>
  </div>`;
}

interface SessionOrderContext {
  readonly rows: DelegationSessionRow<DelegationSessionLike>[];
  readonly order: SessionOrderIdentity[];
}

function sessionOrderContext(machineUrl: string): SessionOrderContext | null {
  const group = state.lastSessionGroups.find(candidate => (candidate.machine.url || "") === machineUrl);
  if (!group) return null;
  const rows = sessionOrderRows(group.sessions, machineUrl);
  const order = rows.flatMap(row => {
    const identity = sessionOrderIdentity(row.session, machineUrl);
    return identity ? [identity] : [];
  });
  return { rows, order };
}

function sessionOrderSiblingScope(
  context: SessionOrderContext,
  moving: SessionOrderCardReference,
): SessionOrderIdentity[] {
  return context.rows.flatMap(row => {
    const identity = sessionOrderIdentity(row.session, moving.machineUrl);
    if (!identity) return [];
    const parentId = row.role === "child" ? row.parent?.wolfpackSessionId ?? "" : "";
    return parentId === moving.parentId ? [identity] : [];
  });
}

function announceSessionOrder(message: string): void {
  const status = document.getElementById("session-order-status");
  if (status) status.textContent = message;
}

function renderSessionOrderViews(): void {
  renderSessionListFromState();
  renderSidebar();
}

function moveSessionCard(
  moving: SessionOrderCardReference,
  target: SessionOrderCardReference,
  placement: "before" | "after",
): boolean {
  const context = sessionOrderContext(moving.machineUrl);
  if (!context) return false;
  const siblingScope = sessionOrderSiblingScope(context, moving);
  const nextMachineOrder = moveSessionRelative(context.order, siblingScope, moving, target, placement);
  if (nextMachineOrder.every((identity, index) => {
    const previous = context.order[index];
    return previous?.machineUrl === identity.machineUrl && previous.sessionId === identity.sessionId;
  })) return false;
  sessionOrder = replaceMachineSessionOrder(sessionOrder, moving.machineUrl, nextMachineOrder);
  manuallyOrderedMachines.add(moving.machineUrl);
  const persisted = saveManualSessionOrder();
  renderSessionOrderViews();
  const updatedContext = sessionOrderContext(moving.machineUrl);
  const siblingPosition = updatedContext
    ? sessionOrderSiblingScope(updatedContext, moving).findIndex(identity => identity.sessionId === moving.sessionId) + 1
    : 0;
  announceSessionOrder(`${moving.name} moved to position ${siblingPosition}${persisted ? "" : "; order could not be saved"}`);
  return true;
}

function moveSessionCardByOffset(moving: SessionOrderCardReference, offset: -1 | 1): boolean {
  const context = sessionOrderContext(moving.machineUrl);
  if (!context) return false;
  const siblings = sessionOrderSiblingScope(context, moving);
  const index = siblings.findIndex(identity => identity.sessionId === moving.sessionId);
  const targetIdentity = siblings[index + offset];
  if (!targetIdentity) return false;
  const targetRow = context.rows.find(row => sessionIdentityId(row.session) === targetIdentity.sessionId);
  if (!targetRow) return false;
  return moveSessionCard(moving, {
    ...targetIdentity,
    parentId: moving.parentId,
    listId: moving.listId,
    name: targetRow.session.name,
  }, offset < 0 ? "before" : "after");
}

function resetSessionCardOrder(machineUrl: string): void {
  sessionOrder = resetMachineSessionOrder(sessionOrder, machineUrl);
  manuallyOrderedMachines.delete(machineUrl);
  const persisted = saveManualSessionOrder();
  renderSessionOrderViews();
  announceSessionOrder(`Session order reset${persisted ? "" : "; reset could not be saved"}`);
}

function updatePinButton(): void {
  const button = document.getElementById("sidebar-collapse-btn");
  if (!button) return;
  const label = state.sidebarPinned ? "Unpin sidebar" : "Pin sidebar";
  button.classList.toggle("pinned", state.sidebarPinned);
  button.title = label;
  button.setAttribute("aria-label", label);
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
  const syncSidebarInteractivity = (): void => {
    const collapsed = sidebar.classList.contains("collapsed");
    sidebar.toggleAttribute("inert", collapsed);
    sidebar.setAttribute("aria-hidden", String(collapsed));
  };
  new MutationObserver(syncSidebarInteractivity).observe(sidebar, {
    attributes: true,
    attributeFilter: ["class"],
  });
  syncSidebarInteractivity();
  // Body class drives layout: pinned → in flex flow (pushes main); unpinned →
  // overlay (doesn't affect terminal width).
  document.body.classList.toggle("sidebar-pinned", state.sidebarPinned);
  updatePinButton();

  function finishSidebarLayoutTransition(): void {
    if (!state.sidebarLayoutTransitioning) return;
    if (sidebarLayoutTransitionFallbackTimer) {
      clearTimeout(sidebarLayoutTransitionFallbackTimer);
      sidebarLayoutTransitionFallbackTimer = null;
    }
    state.sidebarLayoutTransitioning = false;
    if (activeGridTerminalSessions() !== null) {
      scheduleGridStabilizedFit();
    } else {
      state.terminalController?.resize();
      revealGridCellsWithoutResize();
    }
  }

  function beginSidebarLayoutTransition(): void {
    if (sidebarLayoutTransitionFallbackTimer) clearTimeout(sidebarLayoutTransitionFallbackTimer);
    state.sidebarTransitionIsHover = false;
    state.sidebarLayoutTransitioning = true;
    hideGridCellsForTransition();
    sidebarLayoutTransitionFallbackTimer = setTimeout(
      finishSidebarLayoutTransition,
      SIDEBAR_LAYOUT_TRANSITION_FALLBACK_MS,
    );
  }

  // Pin/unpin button
  document.getElementById("sidebar-collapse-btn").onclick = () => {
    state.sidebarPinned = !state.sidebarPinned;
    localStorage.setItem("wolfpack-sidebar-pinned", state.sidebarPinned ? "1" : "0");
    beginSidebarLayoutTransition();
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
    beginSidebarLayoutTransition();
    document.body.classList.toggle("sessions-expanded", state.sessionsExpanded);
    document.getElementById("sidebar-expand-btn").classList.toggle("active", state.sessionsExpanded);
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

  // Entering the narrow invisible edge temporarily opens an unpinned sidebar.
  const openAutoSidebar = (): void => {
    if (state.sidebarCollapsed && !state.sidebarPinned && !state.sessionsExpanded) {
      state.sidebarTransitionIsHover = true;
      sidebar.classList.remove("collapsed");
      state.sidebarAutoExpanded = true;
    }
  };
  hoverEdge.addEventListener("mouseenter", openAutoSidebar);

  // Auto-collapse when mouse leaves sidebar (only if auto-expanded, not pinned)
  sidebar.addEventListener("mouseleave", () => {
    if (state.sidebarAutoExpanded && !state.sidebarPinned) {
      sidebarAutoCollapseTimer = setTimeout(() => {
        if (state.sidebarAutoExpanded && !sidebarSessionOrderDragActive) {
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

  // Hover is overlay-only. Layout transitions stay hidden and suppress PTY
  // resize until their final width is authoritative.
  sidebar.addEventListener("transitionend", (event) => {
    if (event.propertyName !== "margin-left") return;
    if (state.sidebarTransitionIsHover) {
      state.sidebarTransitionIsHover = false;
      return;
    }
    finishSidebarLayoutTransition();
  });

  // Nav buttons
  document.getElementById("sidebar-settings-btn").onclick = () => showSettings();

  // Start the shared session refresh cadence used by all session surfaces.
  syncSessionRefreshTimer();

  // Initial render
  renderSidebar();
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
  bindSessionOrderEvents({
    move: moveSessionCard,
    moveByOffset: moveSessionCardByOffset,
    reset: resetSessionCardOrder,
    setDragActive: active => { sidebarSessionOrderDragActive = active; },
  });

  // Delegation workspace
  on("delegation-focus-back", "click", () => returnToDelegationGrid());

  // Drawer / overlays
  on("drawer-backdrop", "click", () => closeDrawer());
  on("git-status-overlay", "click", () => dismissGitStatus());

  // Expanded toolbar
  on("expanded-settings-btn", "click", () => showSettings());
  on("expanded-collapse-btn", "click", () => $("sidebar-expand-btn")?.click());

  // Project picker
  document.addEventListener("keydown", handlePickerKeyboardNavigation);
  const pickerCancel = document.querySelector("#projects-view .picker-cancel-btn");
  if (pickerCancel) pickerCancel.addEventListener("click", () => { returnFromProjectPicker(); });
  const createProjectBtn = document.querySelector("#projects-view .new-project-row button");
  if (createProjectBtn) createProjectBtn.addEventListener("click", () => selectNewProject());

  // Agent picker (read-only — add/remove/toggle moved to Settings)
  const agentBackBtn = document.querySelector("#agent-view .picker-cancel-btn");
  if (agentBackBtn) agentBackBtn.addEventListener("click", () => showView("projects"));

  // Settings
  on("settings-back-btn", "click", () => returnFromSettingsWithFocus());
  const discoverBtn = document.querySelector(".discover-btn");
  if (discoverBtn) discoverBtn.addEventListener("click", () => discoverMachines());

  // Settings toggles
  on("setting-animations", "change", function(this: HTMLInputElement) { toggleSetting("animations", this.checked); });
  on("setting-haptics", "change", function(this: HTMLInputElement) { toggleSetting("haptics", this.checked); });
  on("setting-notifications", "change", function(this: HTMLInputElement) { toggleSetting("notifications", this.checked); });
  on("setting-enterSends", "change", function(this: HTMLInputElement) { toggleSetting("enterSends", this.checked); });
  on("setting-holdToSend", "change", function(this: HTMLInputElement) { toggleSetting("holdToSend", this.checked); });
  on("setting-debugPanel", "change", function(this: HTMLInputElement) { toggleSetting("debugPanel", this.checked); toggleDebugPanel(); });

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
  // Quick commands
  on("add-quick-cmd-btn", "click", () => addQuickCmd());

  document.getElementById("settings-section-nav")?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest<HTMLAnchorElement>("a[href^='#settings-']");
    if (!link) return;
    event.preventDefault();
    revealSettingsSection(link.hash.slice(1));
  });

  // Debug reset
  const debugResetBtn = document.querySelector(".debug-reset-btn");
  if (debugResetBtn) debugResetBtn.addEventListener("click", () => { wpMetrics.reset(); renderDebugPanel(); });

  // Terminal view
  on("terminal-transcript-btn", "click", () => { void showTerminalTranscript(); });
  on("terminal-transcript-close", "click", () => closeTerminalTranscript());

  // Keyboard accessory
  const gitBtn = document.querySelector(".kb-key.kb-git");
  if (gitBtn) gitBtn.addEventListener("click", () => showGitStatus());
  const copyBtn = document.querySelector(".kb-key.kb-copy");
  if (copyBtn) copyBtn.addEventListener("click", () => copySessionToClipboard());


}

bindHtmlEventListeners();

initGridDeps({
  showView, openSession, destroyTerminal, initTerminal,
  backToSessions, renderSidebar,
  createPtyTerminalController, createConflictOverlay,
  showNotice: (title, message) => { void showAppDialog({ title, message, confirmLabel: "Close", cancelLabel: null }); },
  canUseWasmTerminal,
  focusDelegationSession,
  leaveDelegationWorkspace: leaveDelegationWorkspaceForManualGrid,
});

initSettings();
cleanSnapshots();
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
const initialSettingsSection = settingsSectionFromHash();
if (initialSettingsSection) {
  void showSettings().then(() => revealSettingsSection(initialSettingsSection, false));
} else {
  showView("sessions", true);
}
void loadSessions();
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
  // session/project onclick handlers
  openSession, killSession, selectProject, showProjectPicker,
  sendQuickCmd, editQuickCmd, deleteQuickCmd, moveQuickCmd,
  createSessionWithAgent, deleteCustomCmd, retryMachine,
  // agent settings onclick handlers (inline in renderAgentsList)
  toggleAgentEnabled, removeAgent, addAgent,
  // grid + view (used by onclick and e2e page.evaluate)
  toggleGrid, addToGrid, removeFromGrid, suspendGridMode,
  toggleSidebarDelegationChildren,
  loadSessions, showView, state,
});
