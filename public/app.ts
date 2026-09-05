import {
  esc, escAttr, loadStoredJson, isDesktop,
  wpSettings, TERM_PRESETS, toggleSetting,
  initSettings, haptic,
  QC_STORAGE_KEY, RECENTS_STORAGE_KEY, MAX_RECENTS,
  state, setState,
  DESKTOP_TERMINAL_SCROLLBACK,
} from "./app-state";

import {
  initGridDeps,
  isGridActive,
  hasPreservedGrid, clearPreservedGrid, retireGridSessionsForMachine,
  retirePreservedGridSessionsForMachine,
  moveGridFocusByArrow, returnToTerminalView, setGridFocus, suspendGridMode,
  backFromSettings, addToGrid, removeFromGrid, exitGridMode,
  hideGridCellsForTransition, revealGridCellsWithoutResize,
  scheduleGridStabilizedFit, isSessionInGrid, toggleGrid,
  canOpenMultiTerminalGrid, disposeDelegationGrid,
  renderDelegationGridCells, setDelegationGridMembers, suspendDelegationGridTerminals,
} from "./app-grid";
import type { DelegationGridMember } from "./app-grid";

import { bindDelegatedAppActions, SESSION_CARD_VIEW } from "./app-action-controller";
import type { SessionCardView } from "./app-action-controller";
import { setupTouchScrollHandler } from "./app-touch";
import { showAppDialog } from "./app-dialog";
import { rankProjectNames } from "./project-picker";
import { authenticatedFetchWithTimeout, getBrowserAuthToken } from "./browser-auth";
import { RequestTimeoutError } from "./fetch-timeout";
import { keyboardOcclusionHeight } from "./viewport-geometry";
import type { OrderedResizeSettlement } from "./ordered-resize";
import { RESIZE_SEND_DEBOUNCE_MS } from "./pty-socket-client";
import {
  createPtyTerminalController as createStrictPtyTerminalController,
  INITIAL_HYDRATION_SETTLE_MS,
  INITIAL_HYDRATION_SILENCE_MS,
  type PtyTerminalController,
  type PtyTerminalControllerOpts,
  type TerminalInstance,
  type TerminalInstanceOptions,
} from "./pty-terminal-controller";
import {
  GhosttyPrewarmPool,
  scheduleGhosttyPrewarmRefill,
} from "./ghostty-prewarm-pool";

import {
  __wfTraceStart, __wfTraceEvent, wfTraceEnabled,
} from "./app-debug";
import {
  createTerminalSlowPathIndicator,
  revealTerminalConflict,
  setTerminalLoadVisualState,
} from "./terminal-loading-ui";
import { createTerminalLiveGate } from "./terminal-bootstrap";
import type { TerminalLiveGate } from "./terminal-bootstrap";
import { scheduleTakeControlFallback } from "./take-control-coordinator";
import {
  resolveGhosttyPrewarmDebugPoolSize,
  resolveGhosttyPrewarmDebugTiming,
} from "../src/ghostty-prewarm-debug";
import { DEFAULT_GHOSTTY_PREWARM_POOL_SIZE } from "../src/ghostty-prewarm-policy";
import { AGENT_KIND } from "../src/agent-kind";
import {
  FIRST_SESSION_GUIDE_URL,
  PHONE_PWA_NOTIFICATIONS_GUIDE_URL,
  SECURITY_AND_TRUST_URL,
  SESSION_CONTROL_CREATE_URL,
} from "../src/documentation-links";
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
import { WOLFPACK_TERMINAL_THEME } from "../src/terminal-theme";
import { nextMenuSelection } from "../src/menu-navigation";
import { parseSessionNotificationRoute } from "../src/session-notification-route";
import {
  createTailnetDiscoveryAutoRefresh,
} from "../src/tailnet-discovery-auto-refresh";
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
import { candidateEnumerationCandidates } from "../src/tailnet-machine-contract";
import { serializeBufferTail } from "../src/terminal-buffer";
import {
  encodeTerminalBinary,
  sendMessageDraftAttempt,
  shouldInsertMessageNewlineFromAccessoryKey,
  shouldInterceptCopy,
  shouldSubmitMessageInputOnEnter,
} from "../src/terminal-input";
import {
  fetchTimeoutMs as peerHealthTimeoutMs,
  recordFailure as peerHealthRecordFailure,
  recordSuccess as peerHealthRecordSuccess,
} from "../src/peer-health";
import {
  classifyDisconnect,
  handleControlGranted,
  handleDisplaced,
  handleTakeControlClick,
  handleViewerConflict,
  prepareAutoTakeControl,
} from "../src/take-control-logic";

// ── WASM capability guard ──

const GHOSTTY_PREWARM_POOL_SIZE = resolveGhosttyPrewarmDebugPoolSize({
  debugEnabled: wfTraceEnabled,
  storage: safeLocalStorage(),
  defaultPoolSize: DEFAULT_GHOSTTY_PREWARM_POOL_SIZE,
});
const GHOSTTY_PREWARM_DELAY_MS = 0;

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

let ghosttyLoadPromise: Promise<void> | null = null;
let ghosttyRendererReady = false;

function ensureGhosttyLoaded(): Promise<void> {
  if (typeof window.Terminal === "function" && typeof window.FitAddon === "function") {
    return (window.ghosttyReady ?? Promise.resolve()).then(() => {
      ghosttyRendererReady = true;
    });
  }
  if (ghosttyLoadPromise) return ghosttyLoadPromise;
  ghosttyLoadPromise = new Promise<void>((resolve, reject) => {
    const source = document.querySelector<HTMLMetaElement>('meta[name="wolfpack-ghostty-src"]')?.content;
    if (!source) return reject(new Error("Ghostty asset URL is unavailable"));
    const script = document.createElement("script");
    script.src = source;
    script.async = true;
    script.onload = () => {
      const ready = window.ghosttyReady ?? Promise.resolve();
      ready.then(() => {
        ghosttyRendererReady = true;
        resolve();
      }, reject);
    };
    script.onerror = () => reject(new Error("Failed to load terminal renderer"));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    ghosttyLoadPromise = null;
    throw error;
  });
  return ghosttyLoadPromise;
}

function canUseWasmTerminal(): boolean {
  return !window.wasmFailed;
}

function ensureGridIsolation(): Promise<boolean> {
  return ensureGhosttyLoaded().then(() => typeof window.createIsolatedGhostty === "function");
}

function scheduleGhosttyPrewarm(): void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (connection?.saveData || (deviceMemory !== undefined && deviceMemory < 4)) return;
  const timing = resolveGhosttyPrewarmDebugTiming({
    debugEnabled: wfTraceEnabled,
    storage: safeLocalStorage(),
    defaults: { delayMs: GHOSTTY_PREWARM_DELAY_MS },
  });
  const warm = (): void => {
    recordGhosttyPrewarmEvent("schedule", { delayMs: timing.delayMs, poolSize: GHOSTTY_PREWARM_POOL_SIZE });
    void ensureGhosttyLoaded().then(() => {
      for (let i = 0; i < GHOSTTY_PREWARM_POOL_SIZE; i++) {
        const task = ghosttyPrewarmPool.prewarm();
        recordGhosttyPrewarmEvent(task ? "prewarm.start" : "prewarm.skip", { slot: i + 1 });
      }
    }).catch((error: unknown) => console.debug("[wf] ghostty prewarm skipped:", error));
  };
  const idle = window.requestIdleCallback;
  if (idle) window.setTimeout(() => idle(warm, { timeout: 2_000 }), timing.delayMs);
  else window.setTimeout(warm, timing.delayMs);
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
    `<button type="button" class="cmd-chip" data-action="quick-send" data-index="${i}">${esc(c.label)}</button>`
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
      ${i > 0 ? `<button type="button" data-action="quick-move" data-index="${i}" data-offset="-1" class="qc-btn move" title="Move up">&#9650;</button>` : '<span class="qc-spacer"></span>'}
      ${i < state.quickCmds.length - 1 ? `<button type="button" data-action="quick-move" data-index="${i}" data-offset="1" class="qc-btn move" title="Move down">&#9660;</button>` : '<span class="qc-spacer"></span>'}
      <button type="button" data-action="quick-edit" data-index="${i}" class="qc-btn edit" title="Edit">&#9998;</button>
      <button type="button" data-action="quick-delete" data-index="${i}" class="qc-btn delete" title="Delete">&#10005;</button>
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
  overlay.setAttribute("aria-hidden", "false");
  overlay.focus({ preventScroll: true });
  try {
    const data = await api<{ readonly status?: string }>("/git-status?session=" + encodeURIComponent(state.currentSession), {}, state.currentMachine);
    overlay.innerHTML = `<div><pre>${esc(data.status || "(clean)")}</pre><div class="overlay-hint">tap to dismiss</div></div>`;
  } catch (e) {
    overlay.innerHTML = `<div><pre class="error-pre">${esc(errorMessage(e))}</pre><div class="overlay-hint">tap to dismiss</div></div>`;
  }
}

function dismissGitStatus() {
  const overlay = document.getElementById("git-status-overlay");
  overlay.classList.remove("visible");
  overlay.setAttribute("aria-hidden", "true");
}

async function fetchSessionText(session: string, machineIdentity: string): Promise<string> {
  const origin = resolveReadyMachineOrigin(machineIdentity);
  if (machineIdentity && !origin) throw new Error("selected peer is not ready");
  const response = await authenticatedFetchWithTimeout(origin
    ? new URL("/api/copy-text?session=" + encodeURIComponent(session), origin)
    : "/api/copy-text?session=" + encodeURIComponent(session));
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.text();
}

async function copySessionToClipboard(): Promise<void> {
  if (!state.currentSession) return;
  haptic([20]);
  const overlay = document.getElementById("git-status-overlay");
  overlay.innerHTML = '<pre>copying...</pre>';
  overlay.classList.add("visible");
  overlay.setAttribute("aria-hidden", "false");
  overlay.focus({ preventScroll: true });
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
async function createTerminalInstance({ fontSize, scrollback, cursorBlink = true, disableStdin = false, sendInput, sendMessage, canAcceptInput, canSendResize, forwardResizeEvents = true, onWheelScroll = null, alwaysForwardWheel = false, trace = null }: TerminalInstanceOptions): Promise<TerminalInstance> {
  await ensureGhosttyLoaded();
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
  // Copy (ghostty renders to canvas, so native copy doesn't work)
  // ghostty-web: true = "handled, stop", false = "not handled, continue"
  term.attachCustomKeyEventHandler((e) => {
    if (shouldInterceptCopy(e, term.hasSelection())) {
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
        sendInput(encodeTerminalBinary(data));
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

function createPtyTerminalController(opts: PtyTerminalControllerOpts): PtyTerminalController {
  return createStrictPtyTerminalController(opts, {
    createTerminalInstance,
    shouldSuppressContainerResize: () => {
      if (!isDesktop()) return false;
      if (state.sidebarLayoutTransitioning) return true;
      return !state.sidebarPinned &&
        !state.sessionsExpanded &&
        (state.sidebarTransitionIsHover || state.sidebarAutoExpanded);
    },
    getDebugStorage: safeLocalStorage,
    socket: {
      resolveReadyMachineOrigin,
      requestWebSocketTicket: async (machine) => {
        const response = await api<{ readonly ticket?: string }>("/auth/ws-ticket", { method: "POST" }, machine);
        if (!response.ticket) throw new Error("server did not issue a WebSocket ticket");
        return response.ticket;
      },
      getBrowserAuthToken,
      getDebugStorage: safeLocalStorage,
    },
  });
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
    if (gs?.controller?.isConnected) return gs.controller.send(bytes);
    return false;
  }
  if (state.terminalController?.isConnected) return state.terminalController.send(bytes);
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
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", message);
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

// ── Legacy browser recovery-cache cleanup ──

const LEGACY_TERMINAL_RECOVERY_KEY_PREFIX = "wp-snap|";

function purgeLegacyTerminalRecoverySnapshots(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(LEGACY_TERMINAL_RECOVERY_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch { /* storage unavailable */ }
}
function serializeXtermTail(term, maxLines) {
  return serializeBufferTail(term.buffer.active, maxLines);
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

function getWorkspaceMachines(): readonly { readonly url: string; readonly name: string; readonly version: string }[] {
  return getMachines().filter((machine) => machine.ready);
}

function resolveReadyMachineOrigin(machineIdentity: string | undefined): string | undefined {
  if (!machineIdentity || machineIdentity === LOCAL_MACHINE_IDENTITY) return undefined;
  return isStableMachineIdentity(machineIdentity)
    ? tailnetPeers.resolveReadyOrigin(machineIdentity)
    : undefined;
}

async function showMachineUnavailable(): Promise<void> {
  // This best-effort refresh may fail; the dialog reports unavailable state.
  void tailnetDiscoveryAutoRefresh.requestRefresh().catch(() => undefined);
  await showAppDialog({
    title: "Machine unavailable",
    message: "This Tailnet machine is no longer ready. Refresh Tailnet discovery and try again.",
    confirmLabel: "Close",
    cancelLabel: null,
  });
}

let tailnetPeerRefreshGeneration = 0;
let tailnetPeerSessionRefreshScheduled = false;
let tailnetPeerSessionRefreshDirty = false;
let tailnetPeerSessionRefreshGeneration: number | undefined;

function scheduleTailnetPeerSessionRefresh(generation: number): void {
  tailnetPeerSessionRefreshGeneration = generation;
  if (tailnetPeerSessionRefreshScheduled) {
    tailnetPeerSessionRefreshDirty = true;
    return;
  }
  tailnetPeerSessionRefreshScheduled = true;
  queueMicrotask(async () => {
    const scheduledGeneration = tailnetPeerSessionRefreshGeneration;
    tailnetPeerSessionRefreshDirty = false;
    try {
      if (scheduledGeneration === tailnetPeerRefreshGeneration) await loadSessions(true);
    } catch (error) {
      console.warn("[tailnet] session refresh failed:", error);
    } finally {
      const refreshAgain = tailnetPeerSessionRefreshDirty;
      tailnetPeerSessionRefreshScheduled = false;
      if (refreshAgain && tailnetPeerSessionRefreshGeneration === tailnetPeerRefreshGeneration) {
        scheduleTailnetPeerSessionRefresh(tailnetPeerRefreshGeneration);
      }
    }
  });
}

function retireReplacedPeerIdentity(replacement: TailnetPeerIdentityReplacement): void {
  const { oldIdentity } = replacement;
  const manualGridAffected = state.gridSessions.some(session => session.machine === oldIdentity);
  const activeDelegationAffected = state.activeDelegationRoot !== null && (
    state.delegationMachine === oldIdentity
    || state.delegationGridSessions.some(session => session.machine === oldIdentity)
  );
  const singleTerminalAffected = state.currentMachine === oldIdentity;
  const { [oldIdentity]: _retiredPeerHealth, ...peerHealth } = state.peerHealth;

  retirePreservedGridSessionsForMachine(oldIdentity);
  if (activeDelegationAffected) {
    if (state.terminalController) destroyTerminal();
    teardownDelegationWorkspace();
  } else if (manualGridAffected) {
    const result = retireGridSessionsForMachine(oldIdentity);
    if (result === "grid" || result === "single") {
      setState({ peerHealth });
      return;
    }
  } else if (!singleTerminalAffected) {
    setState({ peerHealth });
    return;
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

type TailnetPeerRefreshResult = "applied" | "stale";

async function refreshTailnetPeers(): Promise<TailnetPeerRefreshResult> {
  const generation = ++tailnetPeerRefreshGeneration;
  // Only an existing remote authority can make an in-flight session result
  // unsafe. Local-only startup remains authoritative while an empty Tailnet
  // enumeration completes, avoiding a redundant rate-limited refresh.
  if (getWorkspaceMachines().length > 0) {
    state.loadSessionsEpoch++;
    scheduleTailnetPeerSessionRefresh(generation);
  }
  const isCurrentGeneration = (): boolean => generation === tailnetPeerRefreshGeneration;
  try {
    const response = await api<unknown>("/tailnet/v1/candidates");
    if (!isCurrentGeneration()) return "stale";
    const candidates = candidateEnumerationCandidates(response);
    tailnetPeers.reconcileCandidates(candidates);
    await probeTailnetCandidates(candidates, fetch, {
      onSettled: (probe) => {
        if (!isCurrentGeneration()) return;
        const affectedReadyPeer = probe.status === "ready"
          || tailnetPeers.entries().some((entry) => entry.tailnetNodeId === probe.candidate.tailnetNodeId && entry.status === "ready");
        const applied = tailnetPeers.applyProbe(probe);
        if (applied.kind === "identity-replaced") retireReplacedPeerIdentity(applied.replacement);
        if (affectedReadyPeer) scheduleTailnetPeerSessionRefresh(generation);
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

function renderUpdatedLocalMachineMetadata(): void {
  if (state.lastSessionGroups.length === 0) return;
  const localName = state.selfName || "this machine";
  state.lastSessionGroups = state.lastSessionGroups.map(group => group.machine.url
    ? group
    : { ...group, machine: { ...group.machine, name: localName } });
  state.allSessions = state.allSessions.map(session => session.machineUrl
    ? session
    : { ...session, machineName: localName });
  state.lastSessionsHtml = "";
  renderSessionListFromState();
  renderSidebar();
  if (state.drawerOpen) renderDrawerList();
}

const tailnetDiscoveryAutoRefresh = createTailnetDiscoveryAutoRefresh({
  refresh: async () => {
    await refreshTailnetPeers();
  },
  isVisible: () => document.visibilityState === "visible",
});

void (async (): Promise<void> => {
  try {
    const info = await api<{ readonly name?: string; readonly version?: string }>("/info");
    state.selfName = info.name || "this machine";
    state.selfVersion = info.version || "";
    updateProjectMachineLabels();
    renderUpdatedLocalMachineMetadata();
    const version = document.getElementById("settings-version");
    if (version && state.selfVersion) version.textContent = "wolfpack v" + state.selfVersion;
  } catch {
    state.selfName = "this machine";
    updateProjectMachineLabels();
    renderUpdatedLocalMachineMetadata();
  }
})();

tailnetDiscoveryAutoRefresh.sync(true);

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

interface DirectoryBrowseEntry {
  readonly name: string;
  readonly path: string;
}

interface DirectoryBrowseResponse {
  readonly current: string;
  readonly parent: string | null;
  readonly breadcrumbs?: readonly DirectoryBrowseEntry[];
  readonly directories: readonly DirectoryBrowseEntry[];
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

interface AgentRuntimeStateAcknowledgementResponse {
  readonly runtimeState?: DelegationSessionLike["runtimeState"];
}

async function api<TResponse = unknown>(path: string, opts?: RequestInit, machineIdentity?: string): Promise<TResponse> {
  const origin = resolveReadyMachineOrigin(machineIdentity);
  if (machineIdentity && machineIdentity !== LOCAL_MACHINE_IDENTITY && !origin) throw new Error("selected peer is not ready");
  const base = origin ? new URL("/api" + path, origin).href : "/api" + path;
  const res = await authenticatedFetchWithTimeout(base, opts);
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

function stopDebugPanelRefresh(previousView: string, nextView: string): void {
  if (previousView === "settings" && nextView !== "settings" && debugPanelTimer) {
    clearInterval(debugPanelTimer); debugPanelTimer = null;
  }
}

function teardownTerminalForViewChange(previousView: string, nextView: string): void {
  // Prevents background WS from auto-reconnecting and stealing control from other instances.
  if (previousView !== "terminal" || nextView === "terminal") return;
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

function applyViewVisibility(
  previousView: HTMLElement | null,
  nextView: HTMLElement,
  animate: boolean,
  goingForward: boolean,
): void {
  if (animate && previousView) {
    const fg = goingForward ? nextView : previousView;
    const bg = goingForward ? previousView : nextView;

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
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      [fg, bg].forEach(el => {
        el.style.transition = "";
        el.style.zIndex = "";
        el.style.transform = "";
        el.classList.remove("swiping");
      });
      document.querySelectorAll(".view").forEach(view => {
        if (view !== nextView) view.classList.remove("visible");
      });
      nextView.classList.add("visible");
    };
    fg.addEventListener("transitionend", cleanup, { once: true });
    setTimeout(cleanup, 350);
    return;
  }

  // never remove .visible from target — prevents black flash
  document.querySelectorAll(".view").forEach(view => {
    if (view !== nextView) view.classList.remove("visible", "animating", "swiping");
  });
  nextView.classList.add("visible");
  nextView.style.transform = "";
}

function applyDesktopViewNavigation(viewName: string): void {
  // Exit expanded sessions mode when navigating away from sessions.
  if (viewName !== "sessions" && state.sessionsExpanded) {
    state.sessionsExpanded = false;
    document.body.classList.remove("sessions-expanded");
    const expandBtn = document.getElementById("sidebar-expand-btn");
    if (expandBtn) expandBtn.classList.remove("active");
    // Restore sidebar based on pin state.
    if (state.sidebarPinned) {
      const sidebar = document.getElementById("desktop-sidebar");
      if (sidebar) { sidebar.classList.remove("collapsed"); state.sidebarCollapsed = false; }
    }
  }
  const settingsBackBtn = document.getElementById("settings-back-btn");
  if (settingsBackBtn) settingsBackBtn.style.display = viewName === "settings" ? "block" : "none";
  if (viewName === "settings") {
    const advancedSettings = document.getElementById("settings-advanced") as HTMLDetailsElement | null;
    if (advancedSettings) advancedSettings.open = true;
    renderQuickCmdSettings();
    loadAgentsSettings();
  }
  renderSidebar();
  syncSessionRefreshTimer();
}

function applyMobileViewNavigation(viewName: string): void {
  const back = document.getElementById("back-btn");
  const title = document.getElementById("header-title");
  const gear = document.getElementById("gear-btn");
  const chip = document.getElementById("session-chip");
  const headerCenter = document.getElementById("header-center");

  // Always start with kb-accessory closed on view change.
  document.getElementById("kb-accessory").classList.remove("visible");
  state.kbAccessoryOpen = false;
  chip.style.display = "none";
  closeDrawer(true);
  back.textContent = "← Back";
  title.style.display = "";
  title.style.cursor = "";
  title.onclick = null;
  document.getElementById("header-machine-label").style.display = "none";
  headerCenter.style.transform = "";

  if (viewName === "sessions") {
    back.style.display = "none";
    back.onclick = null;
    gear.style.display = "";
    title.textContent = "wolfpack";
  } else if (viewName === "projects") {
    back.style.display = "block";
    back.onclick = () => { returnFromProjectPicker(); };
    gear.style.display = "none";
    title.textContent = "select project";
    syncProjectPickerMobileHeader();
  } else if (viewName === "agent") {
    back.style.display = "block";
    back.onclick = () => { showView("projects"); };
    gear.style.display = "none";
    title.textContent = "select agent";
  } else if (viewName === "settings") {
    back.style.display = "block";
    back.onclick = () => { returnFromSettingsWithFocus(); };
    gear.style.display = "none";
    title.textContent = "settings";
    renderQuickCmdSettings();
    loadAgentsSettings();
  } else if (viewName === "terminal") {
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
    const machineLabel = document.getElementById("header-machine-label");
    if (getWorkspaceMachines().length > 0) {
      const machineName = state.currentMachine
        ? (getWorkspaceMachines().find(machine => machine.url === state.currentMachine)?.name || "remote")
        : (state.selfName || "local");
      machineLabel.textContent = machineName;
      machineLabel.style.display = "block";
    }
  }
}

function showView(name: string, skipAnimation?: boolean, refreshSessions = true): void {
  const previousView = state.currentView;
  const previousElement = document.getElementById(previousView + "-view");
  const isMobile = !isDesktop();

  // Desktop: "sessions" view is hidden — redirect to terminal if active (unless sessions expanded).
  const viewName = (!isMobile && name === "sessions" && state.currentSession && !state.sessionsExpanded) ? "terminal" : name;
  const nextElement = document.getElementById(viewName + "-view");
  if (!nextElement) return;
  exposeActiveView(nextElement);
  if (state.swipeNavigated) { skipAnimation = true; state.swipeNavigated = false; }
  const animate = isMobile && !skipAnimation && previousView !== viewName && !!previousElement;
  const goingForward = (VIEW_DEPTH[viewName] || 0) > (VIEW_DEPTH[previousView] || 0);

  stopDebugPanelRefresh(previousView, viewName);
  teardownTerminalForViewChange(previousView, viewName);
  setState({ currentView: viewName });
  applyViewVisibility(previousElement, nextElement, animate, goingForward);

  // Stop timers immediately (don't defer these).
  if (state.sessionRefreshTimer) { clearInterval(state.sessionRefreshTimer); state.sessionRefreshTimer = null; }
  if (!isMobile) {
    applyDesktopViewNavigation(viewName);
    return;
  }
  applyMobileViewNavigation(name);
  if (name === "sessions" && refreshSessions) void loadSessions(); // immediate refresh on entering sessions view
  syncSessionRefreshTimer();
}


// ── Sessions ──

async function acknowledgeTerminalRuntimeState(sessionName: string, machineIdentity: string): Promise<void> {
  const machineUrl = machineIdentity || "";
  const group = state.lastSessionGroups.find((candidate) => (candidate.machine.url || "") === machineUrl);
  const session = group?.sessions.find((candidate) => candidate.name === sessionName);
  const sessionId = session && sessionIdentityId(session);
  const transitionSequence = session?.runtimeState?.transitionSequence;
  if (!session?.runtimeState?.unseen || !sessionId || !Number.isInteger(transitionSequence) || transitionSequence < 1) return;

  try {
    const acknowledged = await api<AgentRuntimeStateAcknowledgementResponse>("/agent-runtime-state/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, transitionSequence }),
    }, machineUrl);
    if (!acknowledged.runtimeState) throw new Error("runtime acknowledgement response omitted runtimeState");

    state.lastSessionGroups = state.lastSessionGroups.map((candidate) => {
      if ((candidate.machine.url || "") !== machineUrl) return candidate;
      return {
        ...candidate,
        sessions: candidate.sessions.map((current) => current.name === sessionName
          && sessionIdentityId(current) === sessionId
          && current.runtimeState?.transitionSequence === transitionSequence
          ? { ...current, runtimeState: acknowledged.runtimeState }
          : current),
      };
    });
    state.allSessions = state.allSessions.map((current) => current.machineUrl === machineUrl
      && current.name === sessionName
      && sessionIdentityId(current) === sessionId
      && current.runtimeState?.transitionSequence === transitionSequence
      ? { ...current, runtimeState: acknowledged.runtimeState }
      : current);
    state.lastSessionsHtml = "";
    renderSessionListFromState();
    renderSidebar();
    if (state.drawerOpen) renderDrawerList();
  } catch (error: unknown) {
    console.warn("[terminal] runtime transition acknowledgement failed", {
      session: sessionName,
      machine: machineUrl || "local",
      error: errorMessage(error),
    });
  }
}

function activityHtml(session: DelegationSessionLike): string {
  return session.runtimeState?.unseen ? '<div class="session-activity">changed since review</div>' : "";
}

function sessionCardViewControlsHtml(): string {
  const selectedView = state.sessionCardView;
  const button = (view: SessionCardView, label: string, accessibleLabel: string): string => {
    const selected = selectedView === view;
    return `<button type="button" class="session-card-view-button${selected ? " selected" : ""}" data-action="set-session-card-view" data-session-card-view="${view}" aria-pressed="${selected}" aria-label="${accessibleLabel}">${label}</button>`;
  };
  return `<div class="session-card-view-filter" role="group" aria-label="Session view">${button(SESSION_CARD_VIEW.ALL, "All", "All sessions")}${button(SESSION_CARD_VIEW.IDLE, "Idle", "Idle sessions")}</div>`;
}

function syncSessionCardViewControls(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-session-card-view]").forEach((button) => {
    const selected = button.dataset.sessionCardView === state.sessionCardView;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function setSessionCardView(view: SessionCardView): void {
  if (state.sessionCardView === view) return;
  setState({ sessionCardView: view, lastSessionsHtml: "" });
  syncSessionCardViewControls();
  renderSessionListFromState();
  renderSidebar();
}

function sessionCardRows(
  rows: readonly DelegationSessionRow<DelegationSessionLike>[],
): readonly DelegationSessionRow<DelegationSessionLike>[] {
  if (state.sessionCardView === SESSION_CARD_VIEW.ALL) return rows;
  return rows.filter((row) => sessionRuntimeState(row.session) === AGENT_STATUS_STATE.IDLE);
}

type SessionCardEmptyKind = "idle" | "source-empty" | null;

interface SessionCardGroupPresentation {
  readonly rows: readonly DelegationSessionRow<DelegationSessionLike>[];
  readonly empty: SessionCardEmptyKind;
}

function sessionCardGroupPresentation(
  sessions: readonly DelegationSessionLike[],
  machineUrl: string,
): SessionCardGroupPresentation {
  if (sessions.length === 0) {
    return { rows: [], empty: state.sessionCardView === SESSION_CARD_VIEW.IDLE ? "idle" : "source-empty" };
  }
  const rows = sessionCardRows(sessionOrderRows(sessions, machineUrl));
  return { rows, empty: rows.length === 0 ? "idle" : null };
}

function delegationCardAttributes(row: DelegationSessionRow<DelegationSessionLike>): { readonly className: string; readonly dataAttribute: string } {
  return {
    className: `${row.childSummary ? " delegation-parent-card" : ""}${row.role === "child" ? " sub-session-card" : row.role === "orphan" ? " orphan-session-card" : ""}`,
    dataAttribute: row.parent ? ` data-parent-session="${esc(row.parent.wolfpackSessionName)}"` : "",
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
  return `<button type="button" class="delegation-sidebar-toggle${expanded ? " expanded" : ""}" data-action="delegation-toggle" data-delegation-key="${escAttr(key)}" aria-expanded="${expanded ? "true" : "false"}" aria-label="${expanded ? "Collapse" : "Expand"} ${escAttr(accessibleLabel)}" title="${expanded ? "Collapse" : "Expand"} child agents"><span class="delegation-sidebar-toggle-icon" aria-hidden="true"></span><span>${esc(visibleLabel)}</span></button>`;
}

function visibleDelegationRows(rows: readonly DelegationSessionRow<DelegationSessionLike>[], machineUrl: string): DelegationSessionRow<DelegationSessionLike>[] {
  const renderedSessionIds = new Set(rows.map(row => sessionIdentityId(row.session)).filter((id): id is string => id !== null));
  const hiddenSessionIds = new Set<string>();
  const visibleRows: DelegationSessionRow<DelegationSessionLike>[] = [];
  for (const row of rows) {
    const sessionId = sessionIdentityId(row.session);
    const parentId = row.parent?.wolfpackSessionId;
    const hiddenByAncestor = parentId ? hiddenSessionIds.has(parentId) : false;
    const hiddenByCollapsedParent = row.role === "child"
      && parentId !== undefined
      && renderedSessionIds.has(parentId)
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
  const multiMachine = getWorkspaceMachines().length > 0;
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

function idleSessionEmptyHtml(): string {
  return `<section class="idle-session-empty" aria-label="No idle sessions">
    <h2>No sessions are currently idle</h2>
    <p>Sessions will appear here when their current runtime state becomes idle.</p>
  </section>`;
}

function zeroSessionOnboardingHtml(machineUrl: string): string {
  return `<section class="zero-session-card" aria-label="No sessions yet">
    <h2>No sessions yet</h2>
    <p>A session runs an installed agent or Shell inside a project on this machine.</p>
    <button type="button" class="zero-session-primary" data-action="new-session" data-machine="${escAttr(machineUrl)}">Create your first session</button>
    <ol class="zero-session-steps" aria-label="Session creation steps">
      <li>Choose project</li>
      <li>Choose agent</li>
      <li>Open persistent terminal</li>
    </ol>
    <div class="zero-session-links">
      <a href="${escAttr(FIRST_SESSION_GUIDE_URL)}" target="_blank" rel="noopener noreferrer">First session guide</a>
      <a href="${escAttr(SESSION_CONTROL_CREATE_URL)}" target="_blank" rel="noopener noreferrer">Use the CLI instead</a>
      <a href="${escAttr(SECURITY_AND_TRUST_URL)}" target="_blank" rel="noopener noreferrer">Why Tailnet access is shell access</a>
    </div>
  </section>`;
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
  const compactCreateButton = g.online && g.sessions.length === 0
    ? ""
    : `<button type="button" class="machine-add-btn" data-action="new-session" data-machine="${mUrlAttr}" aria-label="Start a session on ${escAttr(g.machine.name)}" title="New session"${createDisabled}>+</button>`;
  html += `<div class="machine-header"><div class="dot ${statusDot}" title="${statusTitle}"></div>${mName}${versionWarning}<div class="machine-header-btns">${sessionOrderResetButtonHtml(machineKey)}${compactCreateButton}</div></div>`;
  if (multiMachine && g.pending) {
    html += `<div class="group-status">Connecting...</div>`;
  } else if (g.online) {
    const presentation = sessionCardGroupPresentation(g.sessions, machineKey);
    if (presentation.empty === "idle") {
      html += idleSessionEmptyHtml();
    } else if (presentation.rows.length) {
      const useCollapsibleSessionCards = !isDesktop();
      const rows = useCollapsibleSessionCards
        ? visibleDelegationRows(presentation.rows, machineKey)
        : presentation.rows;
      html += rows.map((row, i) => {
          const s = row.session;
          const lastLine = s.lastLine || "";
          const ui = sessionRuntimeUi(s);
          const anim = state.firstLoad ? "animate-in" : "";
          const grouping = delegationCardAttributes(row);
          const ordering = sessionOrderCardHtml(row, machineKey);
          return `<div class="card card-stagger ${anim} ${ui.card}${grouping.className}"${grouping.dataAttribute}${ordering.attributes} style="${state.firstLoad ? 'animation-delay:' + i * 30 + 'ms' : ''}">
            <button type="button" class="card-open" data-action="open-session" data-session="${escAttr(s.name)}" data-machine="${mUrlAttr}" aria-label="Open ${escAttr(s.name)}"${ordering.openAttributes}></button>
            <div class="dot ${ui.dot}" title="${ui.title}"></div>
            <div class="card-info">
              <div class="card-name"><span class="card-name-text">${esc(s.name)}</span><span class="triage-badge ${ui.badge}">${ui.label}</span>${useCollapsibleSessionCards ? sidebarDelegationToggleHtml(row, machineKey) : ""}</div>
              ${useCollapsibleSessionCards ? "" : delegationParentSummaryHtml(row)}
              ${delegationParentMissingHtml(row)}
              <div class="card-preview">${esc(lastLine)}</div>
              ${activityHtml(s)}
            </div>
            <button type="button" class="kill-btn" data-action="kill-session" data-session="${escAttr(s.name)}" data-machine="${mUrlAttr}" aria-label="Stop ${escAttr(s.name)}" title="Stop session">&times;</button>
          </div>`;
      }).join("");
    } else {
      html += zeroSessionOnboardingHtml(multiMachine ? g.machine.url || "" : "");
    }
  } else if (multiMachine) {
    const failure = machineFailureLabel(g.failure || "unknown");
    html += `<div class="group-status machine-failure" role="status">${esc(failure)}. Live terminal actions require this machine to reconnect. <button type="button" class="machine-retry-btn" data-action="retry-machine" data-machine="${mUrlAttr}" aria-label="Retry ${escAttr(g.machine.name)}">Retry</button></div>`;
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
  const ui = sessionRuntimeUi(row.session);
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
  void initTerminal(TERMINAL_PREFILL_MODE.FULL);
  renderSidebar();
}

function returnToDelegationGrid(): void {
  if (!state.activeDelegationRoot) return;
  openDelegationGrid(state.activeDelegationRoot, state.delegationMachine || "");
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

function fetchMachine(machineIdentity, machineMeta, isCurrentLoad, refreshSignal: AbortSignal) {
  const isRemote = machineIdentity !== "";
  const currentMachineMeta = () => isRemote
    ? machineMeta
    : { ...machineMeta, name: state.selfName || "this machine" };
  if (isRemote && !resolveReadyMachineOrigin(machineIdentity)) {
    return Promise.resolve({
      machine: { ...machineMeta, url: machineIdentity, version: machineMeta.version || "" },
      sessions: [], online: false, pending: false,
      failure: "network" as const,
    });
  }
  const timeoutMs = isRemote ? peerHealthTimeoutMs(state.peerHealth, machineIdentity) : 0;
  const signal = isRemote
    ? AbortSignal.any([refreshSignal, AbortSignal.timeout(timeoutMs)])
    : refreshSignal;
  const options = { signal };
  return api<SessionsResponse>("/sessions", options, machineIdentity || undefined).then((sessions) => {
    if (isRemote && isCurrentLoad()) state.peerHealth = peerHealthRecordSuccess(state.peerHealth, machineIdentity);
    const sessionRows = sessions.sessions || [];
    if (isRemote) for (const session of sessionRows) session.activity = undefined;
    return {
      machine: { ...currentMachineMeta(), url: machineIdentity, version: machineMeta.version || "" },
      sessions: sessionRows,
      online: true,
      pending: false,
    };
  }).catch((error: unknown) => {
    if (isRemote && isCurrentLoad()) state.peerHealth = peerHealthRecordFailure(state.peerHealth, machineIdentity);
    return {
      machine: { ...currentMachineMeta(), url: machineIdentity, version: machineMeta.version || "" },
      sessions: [], online: false, pending: false,
      failure: classifyMachineFailure(error),
    };
  });
}

async function loadSessionsOnce(refreshSignal: AbortSignal) {
  const myEpoch = ++state.loadSessionsEpoch;
  const isCurrentLoad = (): boolean => myEpoch === state.loadSessionsEpoch;
  const el = document.getElementById("session-list");
  const machines = getWorkspaceMachines();
  const multiMachine = machines.length > 0;

  // Single-machine: just fetch and render
  if (!multiMachine) {
    const g = await fetchMachine("", { name: state.selfName || "this machine" }, isCurrentLoad, refreshSignal);
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

  const groups = new Array(allMachines.length);
  // Keep a previous successful peer group visible while its next session
  // request is pending. New peers enter workspace navigation only after that
  // request succeeds; failures remove their workspace group.
  const prevByUrl = new Map((state.lastSessionGroups || [])
    .filter(group => !group.machine.url || group.online)
    .map(group => [group.machine.url, group]));
  const localPending = {
    machine: { ...allMachines[0].meta, url: "", version: "" },
    sessions: [], online: false, pending: true,
  };
  const withCurrentLocalMetadata = (group, machineUrl) => machineUrl
    ? group
    : { ...group, machine: { ...group.machine, name: state.selfName || "this machine" } };
  const visibleGroupsInOrder = () => allMachines.flatMap((machine, index) => {
    const resolved = groups[index];
    if (resolved) return !machine.url || resolved.online
      ? [withCurrentLocalMetadata(resolved, machine.url)]
      : [];
    const previous = prevByUrl.get(machine.url);
    if (previous) return [withCurrentLocalMetadata(previous, machine.url)];
    return machine.url ? [] : [withCurrentLocalMetadata(localPending, machine.url)];
  });
  const renderVisibleGroups = () => {
    const visible = visibleGroupsInOrder();
    state.lastSessionGroups = visible;
    const html = visible.map(group => renderMachineGroupHtml(group, true)).join("");
    if (html !== state.lastSessionsHtml) {
      el.innerHTML = html;
      state.lastSessionsHtml = html;
    }
    renderSidebar();
  };

  renderVisibleGroups();

  const promises = allMachines.map((m, i) =>
    fetchMachine(m.url, m.meta, isCurrentLoad, refreshSignal).then(g => {
      if (!isCurrentLoad()) return; // stale call, discard
      groups[i] = g;
      renderVisibleGroups();
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
        renderVisibleGroups();
      }
    }
  }

  state.firstLoad = false;
  const visibleGroups = visibleGroupsInOrder();
  state.lastSessionGroups = visibleGroups;
  const out = [];
  for (const g of visibleGroups) {
    for (const s of g.sessions) out.push({ ...s, machineUrl: g.machine.url, machineName: g.machine.name });
  }
  state.allSessions = out;
  syncDelegationWorkspace();
  checkStateTransitions(visibleGroups);
  await openSessionFromNotificationRoute(myEpoch);
}

let sessionRefreshPromise: Promise<void> | null = null;
let sessionRefreshAbort: AbortController | null = null;
let forceSessionRefreshAfterCurrent = false;

function loadSessions(forceAfterCurrent = false): Promise<void> {
  if (sessionRefreshPromise) {
    if (forceAfterCurrent) {
      forceSessionRefreshAfterCurrent = true;
      // Invalidate immediately so stale catch/render continuations cannot update
      // peer health or the dashboard while their requests are being aborted.
      state.loadSessionsEpoch += 1;
      sessionRefreshAbort?.abort(new DOMException("superseded", "AbortError"));
    }
    return sessionRefreshPromise;
  }
  sessionRefreshPromise = (async () => {
    do {
      forceSessionRefreshAfterCurrent = false;
      sessionRefreshAbort = new AbortController();
      await loadSessionsOnce(sessionRefreshAbort.signal);
      renderSidebar();
    } while (forceSessionRefreshAfterCurrent);
  })().finally(() => {
    sessionRefreshAbort = null;
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
  void tailnetDiscoveryAutoRefresh.requestRefresh()
    .then(() => loadSessions(true))
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
  if (refreshNow) void loadSessions(true);
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
  destroyTerminal();
  setState({ currentSession: name, currentMachine: machineUrl || "" });
  recordRecent(state.currentMachine, name);
  wpMetrics.reset();
  restoreDraft();
  showView("terminal");
  __wfTraceEvent(trace, "dom.view.created");
  void initTerminal(TERMINAL_PREFILL_MODE.FULL);
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
  if (!view || (view === "projects" && projectPickerPanel !== "projects")) return;
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
<button type="button" class="card" data-action="select-project" data-project="${escAttr(project)}" aria-label="Open project ${escAttr(project)}">
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
  const directoryInput = document.getElementById("directory-browser-path") as HTMLInputElement;
  const createProjectInput = document.getElementById("new-project-create-name") as HTMLInputElement;
  state.selectedProjectDir = "";
  state.newProjectParent = "";
  projectNameInput.value = "";
  directoryInput.value = "";
  createProjectInput.value = "";
  showProjectPickerPanel("projects");
  updateProjectMachineLabels();
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

type ProjectPickerPanel = "projects" | "directory" | "create";
type DirectoryBrowserPurpose = "open" | "create-parent";

let projectPickerPanel: ProjectPickerPanel = "projects";
let directoryBrowserPurpose: DirectoryBrowserPurpose = "open";
let directoryBrowserSelection: DirectoryBrowseResponse | null = null;
let directoryBrowserFocusReturn: HTMLElement | null = null;
let directoryBrowserRequest = 0;

function projectMachineName(): string {
  if (!state.projectMachine) return state.selfName || "this machine";
  return getWorkspaceMachines().find(machine => machine.url === state.projectMachine)?.name || "remote machine";
}

function updateProjectMachineLabels(): void {
  const machineName = projectMachineName();
  document.querySelectorAll<HTMLElement>(".project-machine-name")
    .forEach(element => { element.textContent = machineName; });
  document.getElementById("open-folder-action")
    ?.setAttribute("aria-label", `Open folder on ${machineName}`);
  document.getElementById("create-project-action")
    ?.setAttribute("aria-label", `Create project on ${machineName}`);
  const pathMachine = document.getElementById("directory-browser-path-machine");
  if (pathMachine) pathMachine.textContent = machineName;
  const directoryTitle = document.getElementById("directory-browser-title");
  if (directoryTitle) {
    directoryTitle.textContent = directoryBrowserPurpose === "open"
      ? `Choose folder on ${machineName}`
      : `Choose a parent folder on ${machineName}`;
  }
  const createTitle = document.getElementById("create-project-title");
  if (createTitle) createTitle.textContent = `Create project on ${machineName}`;
}

function showProjectPickerPanel(panel: ProjectPickerPanel, focusTarget?: HTMLElement | null): void {
  projectPickerPanel = panel;
  const panels: Readonly<Record<ProjectPickerPanel, HTMLElement>> = {
    projects: document.getElementById("project-picker-main") as HTMLElement,
    directory: document.getElementById("directory-browser-panel") as HTMLElement,
    create: document.getElementById("create-project-panel") as HTMLElement,
  };
  for (const [name, element] of Object.entries(panels)) {
    const visible = name === panel;
    element.hidden = !visible;
    element.toggleAttribute("inert", !visible);
  }
  updateProjectMachineLabels();
  syncProjectPickerMobileHeader();
  focusTarget?.focus({ preventScroll: true });
}

function syncProjectPickerMobileHeader(): void {
  if (isDesktop() || state.currentView !== "projects") return;
  const back = document.getElementById("back-btn");
  const title = document.getElementById("header-title");
  back.style.display = "block";
  if (projectPickerPanel === "projects") {
    back.textContent = "← Back";
    back.onclick = () => { returnFromProjectPicker(); };
    title.style.display = "";
    title.textContent = "select project";
    return;
  }
  back.textContent = "← Projects";
  title.style.display = "none";
  back.onclick = projectPickerPanel === "directory"
    ? () => { returnFromDirectoryBrowser(); }
    : () => { showProjectPickerPanel("projects", document.getElementById("create-project-action")); };
}

function showCreateProjectPanel(focusTarget?: HTMLElement | null): void {
  const parent = document.getElementById("directory-create-parent");
  if (parent) parent.textContent = state.newProjectParent || "Configured project directory";
  updateCreateProjectPreview();
  showProjectPickerPanel("create", focusTarget);
}

function updateCreateProjectPreview(): void {
  const name = (document.getElementById("new-project-create-name") as HTMLInputElement).value.trim();
  const preview = document.getElementById("directory-create-preview");
  if (!preview) return;
  preview.textContent = name
    ? `Wolfpack will create “${name}” in the selected parent folder.`
    : "";
}

function isDirectoryBrowseEntry(value: unknown): value is DirectoryBrowseEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.name === "string" && typeof entry.path === "string";
}

function isDirectoryBrowseResponse(value: unknown): value is DirectoryBrowseResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  return typeof response.current === "string"
    && (response.parent === null || typeof response.parent === "string")
    && (response.breadcrumbs === undefined
      || (Array.isArray(response.breadcrumbs) && response.breadcrumbs.every(isDirectoryBrowseEntry)))
    && Array.isArray(response.directories)
    && response.directories.every(isDirectoryBrowseEntry);
}

function directoryBrowseBreadcrumbs(selection: DirectoryBrowseResponse): readonly DirectoryBrowseEntry[] {
  return selection.breadcrumbs ?? [{ name: selection.current, path: selection.current }];
}

function currentDirectoryName(selection: DirectoryBrowseResponse): string {
  return directoryBrowseBreadcrumbs(selection).at(-1)?.name || selection.current;
}

function setDirectoryBrowserSelection(selection: DirectoryBrowseResponse | null): void {
  directoryBrowserSelection = selection;
  const current = document.getElementById("directory-browser-current");
  const breadcrumbs = document.getElementById("directory-browser-breadcrumbs");
  const list = document.getElementById("directory-browser-list");
  const select = document.getElementById("directory-browser-select") as HTMLButtonElement;
  const selectionLabel = document.getElementById("directory-browser-selection-label");
  const pathInput = document.getElementById("directory-browser-path") as HTMLInputElement;
  current.textContent = selection?.current ?? "";
  breadcrumbs.replaceChildren();
  list.replaceChildren();
  select.disabled = !selection;
  selectionLabel.textContent = selection?.current ?? "";
  if (!selection) return;

  pathInput.value = selection.current;
  const directoryName = currentDirectoryName(selection);
  select.textContent = directoryBrowserPurpose === "open" ? `Open “${directoryName}”` : "Use this folder";
  select.setAttribute(
    "aria-label",
    directoryBrowserPurpose === "open"
      ? `Open ${directoryName} folder`
      : `Use ${directoryName} as parent`,
  );

  for (const breadcrumb of directoryBrowseBreadcrumbs(selection)) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = breadcrumb.name;
    button.disabled = breadcrumb.path === selection.current;
    if (button.disabled) button.setAttribute("aria-current", "location");
    button.addEventListener("click", (event) => {
      void loadDirectoryBrowser(breadcrumb.path, event.detail === 0);
    });
    breadcrumbs.append(button);
  }

  if (!selection.directories.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No child folders";
    list.append(empty);
    return;
  }
  for (const directory of selection.directories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "directory-browser-entry";
    button.setAttribute("aria-label", `Open ${directory.name}`);
    const icon = document.createElement("span");
    icon.className = "directory-browser-entry-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "▸";
    const name = document.createElement("span");
    name.textContent = directory.name;
    button.append(icon, name);
    button.addEventListener("click", (event) => {
      void loadDirectoryBrowser(directory.path, event.detail === 0);
    });
    list.append(button);
  }
}

function directoryBrowseErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("data" in error)) return undefined;
  const data = error.data;
  if (!data || typeof data !== "object" || !("code" in data)) return undefined;
  return typeof data.code === "string" ? data.code : undefined;
}

function directoryBrowseErrorMessage(error: unknown): string {
  const machineName = projectMachineName();
  if (error instanceof RequestTimeoutError) {
    return `The folder request timed out on ${machineName}. Wolfpack may be waiting for macOS folder authorization on that machine. Approve or deny the host prompt, or choose another folder.`;
  }
  if (directoryBrowseErrorCode(error) !== "permission_denied") return errorMessage(error);
  return `Wolfpack can't read this folder on ${machineName}. Grant the Wolfpack server access on that machine or choose another folder.`;
}

async function loadDirectoryBrowser(path?: string, preserveKeyboardFocus = false): Promise<void> {
  const request = ++directoryBrowserRequest;
  const previousSelection = directoryBrowserSelection;
  const list = document.getElementById("directory-browser-list");
  const error = document.getElementById("directory-browser-error");
  const select = document.getElementById("directory-browser-select") as HTMLButtonElement;
  error.textContent = "";
  select.disabled = true;
  list.textContent = "Loading folders…";
  list.setAttribute("aria-busy", "true");
  if (preserveKeyboardFocus) list.focus({ preventScroll: true });
  try {
    const response = await api<unknown>(
      "/directories" + (path === undefined ? "" : `?path=${encodeURIComponent(path)}`),
      undefined,
      state.projectMachine,
    );
    if (request !== directoryBrowserRequest) return;
    if (!isDirectoryBrowseResponse(response)) throw new Error("invalid directory response");
    setDirectoryBrowserSelection(response);
    if (preserveKeyboardFocus) {
      document.getElementById("directory-browser-current")?.focus({ preventScroll: true });
    }
  } catch (loadError: unknown) {
    if (request !== directoryBrowserRequest) return;
    setDirectoryBrowserSelection(previousSelection);
    error.textContent = directoryBrowseErrorMessage(loadError);
    if (preserveKeyboardFocus) error.focus({ preventScroll: true });
  } finally {
    if (request === directoryBrowserRequest) list.removeAttribute("aria-busy");
  }
}

function openDirectoryBrowser(trigger: HTMLElement, purpose: DirectoryBrowserPurpose): void {
  directoryBrowserPurpose = purpose;
  directoryBrowserFocusReturn = trigger;
  setDirectoryBrowserSelection(null);
  document.getElementById("directory-browser-error").textContent = "";
  showProjectPickerPanel("directory");
  const startPath = purpose === "create-parent" && state.newProjectParent
    ? state.newProjectParent
    : undefined;
  void loadDirectoryBrowser(startPath);
}

function returnFromDirectoryBrowser(): void {
  directoryBrowserRequest++;
  const focusReturn = directoryBrowserFocusReturn;
  directoryBrowserFocusReturn = null;
  if (directoryBrowserPurpose === "create-parent") {
    showCreateProjectPanel(focusReturn);
    return;
  }
  showProjectPickerPanel("projects", focusReturn);
}

function selectBrowsedDirectory(): void {
  if (!directoryBrowserSelection) return;
  if (directoryBrowserPurpose === "create-parent") {
    state.selectedProjectDir = "";
    state.newProjectParent = directoryBrowserSelection.current;
    state.isNewProject = false;
    directoryBrowserFocusReturn = null;
    showCreateProjectPanel(document.getElementById("new-project-create-name"));
    return;
  }
  state.selectedProject = directoryBrowserSelection.current;
  state.selectedProjectDir = directoryBrowserSelection.current;
  state.newProjectParent = "";
  state.isNewProject = false;
  directoryBrowserFocusReturn = null;
  void showAgentPicker();
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
  state.selectedProjectDir = "";
  state.newProjectParent = "";
  state.isNewProject = false;
  showAgentPicker();
}

function selectNewProject(): void {
  const input = document.getElementById("new-project-create-name") as HTMLInputElement;
  const name = input.value.trim();
  if (!name) return;
  recordProjectRecent(name);
  state.selectedProject = name;
  state.selectedProjectDir = "";
  state.isNewProject = true;
  showAgentPicker();
}

async function showAgentPicker(): Promise<void> {
  showView("agent");
  resetPickerKeyboardSelection();
  const el = document.getElementById("agent-list");
  el.innerHTML = '<div class="empty">Loading...</div>';
  const nameInput = document.getElementById("session-name-input") as HTMLInputElement;
  const nameError = document.getElementById("session-name-error");
  const createError = document.getElementById("agent-create-error");
  nameInput.value = "";
  createError.textContent = "";
  createError.classList.remove("visible");
  nameInput.classList.remove("invalid");
  nameError.classList.remove("visible");
  const projectQuery = state.selectedProjectDir
    ? "projectDir=" + encodeURIComponent(state.selectedProjectDir)
    : (state.isNewProject ? "newProject=" : "project=") + encodeURIComponent(state.selectedProject);
  const settingsPromise = api<SettingsResponse>("/settings", undefined, state.projectMachine).then(
    (value) => ({ status: "fulfilled" as const, value }),
    () => ({ status: "rejected" as const }),
  );
  const namePromise = api<NextSessionNameResponse>(
    "/next-session-name?" + projectQuery,
    undefined,
    state.projectMachine,
  );
  let nameData: NextSessionNameResponse;
  try {
    nameData = await namePromise;
  } catch (error) {
    el.innerHTML = `<div class="empty">${esc(errorMessage(error))}</div>`;
    return;
  }
  const settingsResult = await settingsPromise;
  if (settingsResult.status === "rejected") {
    el.innerHTML = '<div class="empty">Failed to load agents</div>';
    return;
  }
  const data = settingsResult.value;
  if (!nameInput.value.trim()) nameInput.value = nameData.name || state.selectedProject;
  // /api/settings now returns { settings, effective } — effective.cmds is
  // the list to render (already filtered to enabled, with ["shell"] fallback
  // when nothing's on). Manage which cmds appear via the Settings page.
  const cmds = data.effective?.cmds || [AGENT_KIND.SHELL.id];
  const defaultCmd = data.effective?.agentCmd;
  const html = cmds.map(cmd => `
    <button type="button" class="card" data-action="create-agent-session" data-command="${escAttr(cmd)}" aria-label="Start ${escAttr(cmd)}">
      <div class="dot ${cmd === defaultCmd ? "brand" : "green"}" title="${cmd === defaultCmd ? "default" : "agent"}"></div>
      <div class="card-name">${esc(cmd)}</div>
    </button>
  `).join("");
  el.innerHTML = html;
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
      <input type="checkbox" class="agent-row-checkbox" data-action="agent-toggle" data-command="${escAttr(c.cmd)}"
        ${c.enabled ? "checked" : ""}
        aria-label="Enable ${escAttr(c.cmd)}">
      <span class="agent-row-cmd">${esc(c.cmd)}</span>
      ${isDefault ? '<span class="agent-row-default">default</span>' : ""}
      <button type="button" class="agent-row-delete" data-action="agent-remove" data-command="${escAttr(c.cmd)}"
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
  const shellAdded = configured.has(AGENT_KIND.SHELL.id);
  const shell = `<div class="provider-row installed" data-provider-id="${escAttr(AGENT_KIND.SHELL.id)}">
    <div class="provider-row-header">
      <span class="provider-name">Shell</span>
      <span class="provider-badge installed">built-in</span>
      <button class="provider-add-btn" data-provider-command="${escAttr(AGENT_KIND.SHELL.id)}"
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

async function createSessionWithAgent(cmd) {
  const nameInput = document.getElementById("session-name-input") as HTMLInputElement;
  const sessionName = (nameInput.value || "").trim();
  if (sessionName && !/^[a-zA-Z0-9_-]+$/.test(sessionName)) return;
  const machine = state.projectMachine;
  const createError = document.getElementById("agent-create-error");
  createError.textContent = "";
  createError.classList.remove("visible");
  try {
    const body = state.isNewProject
      ? {
          newProject: state.selectedProject,
          ...(state.newProjectParent && { newProjectParent: state.newProjectParent }),
          cmd,
          sessionName: sessionName || undefined,
        }
      : state.selectedProjectDir
        ? { projectDir: state.selectedProjectDir, cmd, sessionName: sessionName || undefined }
        : { project: state.selectedProject, cmd, sessionName: sessionName || undefined };
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
      _tcState = prepareAutoTakeControl(_tcState);
    },
  });
}

function showDesktopConflictOverlay() {
  const container = document.getElementById("desktop-terminal-container");
  if (!container) return;
  revealTerminalConflict(container, state.terminalController?.hydration);
  removeDesktopConflictOverlay();
  const overlay = createConflictOverlay("Session active on another device", "Take Control", () => {
    if (!state.terminalController) return;
    var clickAction = handleTakeControlClick(state.terminalController.isConnected);
    if (clickAction === "send-take-control") {
      state.terminalController.sendTakeControl();
      startDesktopTakeControlFallback();
    } else {
      _tcState = prepareAutoTakeControl(_tcState);
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

type TerminalSlowLoadIndicator = ReturnType<typeof createTerminalSlowPathIndicator>;

interface TerminalControllerBootstrapOptions {
  readonly container: HTMLElement;
  readonly isMobile: boolean;
  readonly prefillMode: TerminalPrefillMode;
  readonly slowLoad: TerminalSlowLoadIndicator;
  readonly liveGate: TerminalLiveGate;
}

function prepareTerminalBootstrapView(container: HTMLElement): TerminalSlowLoadIndicator {
  document.getElementById("terminal-view")?.classList.remove("terminal-swipe-peek");
  container.style.display = "block";
  container.innerHTML = "";
  container.classList.add("hydrating");
  container.classList.remove("hydrated");
  setTerminalLoadVisualState(container, "prefill-loading");
  const slowLoad = createTerminalSlowPathIndicator(container);
  slowLoad.start("waiting for terminal snapshot");
  document.getElementById("kb-accessory").classList.remove("visible");
  state.kbAccessoryOpen = false;
  document.getElementById("input-bar").style.display = "none";
  document.getElementById("cmd-palette").classList.remove("visible");
  document.getElementById("msg-preview").style.display = "none";
  return slowLoad;
}

function handleTerminalOpened(
  container: HTMLElement,
  slowLoad: TerminalSlowLoadIndicator,
  wasReconnect: boolean,
): void {
  if (wasReconnect) wpMetrics.reconnectCount++;
  // Successful WS open clears stale conflict overlay. If the server
  // sees a conflict, onViewerConflict fires after onOpen and re-shows it.
  _tcState = handleControlGranted(_tcState);
  removeDesktopConflictOverlay();
  setTerminalLoadVisualState(container, "prefill-loading");
  slowLoad.start("waiting for terminal prefill");
  setConnState("live");
}

function handleTerminalPtyReady(): void {
  // Force a full canvas repaint after prefill completes. FitAddon.fit() and
  // Terminal.resize() both no-op when dimensions haven't changed, so sendFitResize
  // does nothing if the terminal is the same size as before the session switch.
  // renderer.render(forceAll=true) bypasses both guards and repaints every cell.
  state.terminalController?.forceRepaint();
}

function handleTerminalOutput(): void {
  if (state.enterRetryTimer) {
    clearTimeout(state.enterRetryTimer);
    state.enterRetryTimer = null;
  }
  wpMetrics.wsMessagesReceived++;
}

function handleTerminalSubSessionOpened(parentSession: string, session: string): void {
  if (!isDesktop()) return;
  if (state.currentView !== "terminal") return;
  if (state.currentSession !== parentSession) return;
  if (state.gridSessions.length > 0) return;
  if (session === parentSession) return;
  addToGrid(session, state.currentMachine || "");
}

function handleTerminalViewerConflict(
  container: HTMLElement,
  slowLoad: TerminalSlowLoadIndicator,
): void {
  const result = handleViewerConflict(_tcState);
  _tcState = result.newState;
  slowLoad.stop();
  setTerminalLoadVisualState(container, _tcState.displaced ? "displaced" : "viewer-conflict");
  if (result.action === "auto-take-control") {
    state.terminalController.sendTakeControl();
  } else {
    showDesktopConflictOverlay();
  }
}

function handleTerminalControlGranted(
  container: HTMLElement,
  slowLoad: TerminalSlowLoadIndicator,
  isMobile: boolean,
): void {
  _tcState = handleControlGranted(_tcState);
  removeDesktopConflictOverlay();
  setTerminalLoadVisualState(container, "hydrating");
  slowLoad.start("restoring terminal control");
  if (isMobile) setMobileGhosttyKeyboardOpen(state.kbAccessoryOpen);
  else state.terminalController?.focus();
}

function handleTerminalDisconnected(
  container: HTMLElement,
  slowLoad: TerminalSlowLoadIndicator,
  code: number,
  reason: string,
): void {
  removeDesktopConflictOverlay();
  const action = classifyDisconnect(code, reason || "");
  if (action === "displaced") {
    _tcState = handleDisplaced(_tcState);
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
}

function handleTerminalReconnecting(
  container: HTMLElement,
  slowLoad: TerminalSlowLoadIndicator,
): void {
  setTerminalLoadVisualState(container, "reconnecting");
  slowLoad.start("reconnecting terminal");
  setConnState("reconnecting");
}

function handleTerminalReconnectExhausted(
  container: HTMLElement,
  slowLoad: TerminalSlowLoadIndicator,
): void {
  slowLoad.stop();
  setTerminalLoadVisualState(container, "failed");
  setConnState("offline");
}

function handleTerminalRouteUnavailable(
  container: HTMLElement,
  slowLoad: TerminalSlowLoadIndicator,
): void {
  slowLoad.stop();
  setTerminalLoadVisualState(container, "failed");
  setConnState("machine-unavailable");
}

function handleTerminalHydrationStart(
  container: HTMLElement,
  slowLoad: TerminalSlowLoadIndicator,
  liveGate: TerminalLiveGate,
): void {
  // A controller survives reconnects, but each hydration cycle needs its
  // own final live transition after the mobile post-mount gate is ready.
  liveGate.onHydrationStart();
  setTerminalLoadVisualState(container, "hydrating");
  slowLoad.start("hydrating terminal");
}

function createTerminalBootstrapController(
  options: TerminalControllerBootstrapOptions,
): PtyTerminalController {
  const { container, isMobile, liveGate, prefillMode, slowLoad } = options;
  const session = state.currentSession;
  const machine = state.currentMachine || "";
  let acknowledgementAttempted = false;
  return createPtyTerminalController({
    session,
    machine,
    scrollback: DESKTOP_TERMINAL_SCROLLBACK,
    prefillMode,
    hydrationMinPendingMs: 80,
    hydrationSettleMs: INITIAL_HYDRATION_SETTLE_MS,
    hydrationSilenceMs: INITIAL_HYDRATION_SILENCE_MS,
    disableStdin: isMobile,
    getHydrationElement: () => document.getElementById("desktop-terminal-container"),
    shouldFocus: () => !isMobile,
    shouldReconnect: () => !!state.terminalController?.term,
    onOpen: (wasReconnect) => {
      handleTerminalOpened(container, slowLoad, wasReconnect);
      if (acknowledgementAttempted) return;
      acknowledgementAttempted = true;
      void acknowledgeTerminalRuntimeState(session, machine);
    },
    onPtyReady: handleTerminalPtyReady,
    onOutput: handleTerminalOutput,
    onSubSessionOpened: handleTerminalSubSessionOpened,
    onViewerConflict: () => handleTerminalViewerConflict(container, slowLoad),
    onControlGranted: () => handleTerminalControlGranted(container, slowLoad, isMobile),
    onDisconnected: (code, reason) => handleTerminalDisconnected(container, slowLoad, code, reason),
    onReconnecting: () => handleTerminalReconnecting(container, slowLoad),
    onReconnectExhausted: () => handleTerminalReconnectExhausted(container, slowLoad),
    onRouteUnavailable: () => handleTerminalRouteUnavailable(container, slowLoad),
    onHydrationStart: () => handleTerminalHydrationStart(container, slowLoad, liveGate),
    onHydrated: liveGate.onHydrated,
  });
}

function showTerminalMountFailure(
  container: HTMLElement,
  slowLoad: TerminalSlowLoadIndicator,
): void {
  slowLoad.stop();
  setTerminalLoadVisualState(container, "failed");
  container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:13px;padding:20px;text-align:center">Terminal unavailable — WebAssembly not supported in this browser</div>';
}

function setupMobileTerminalInput(
  container: HTMLElement,
  controller: PtyTerminalController,
): void {
  if (!controller.term) return;
  // Ghostty owns input semantics; Wolfpack only gates whether its native
  // textarea is allowed to open the virtual keyboard.
  container.setAttribute("inputmode", "none");
  setMobileGhosttyKeyboardOpen(false);
  state._touchCleanup = setupTouchScrollHandler(
    container, controller.term,
    (data) => state.terminalController && state.terminalController.send(data),
    () => !!(state.terminalController && state.terminalController.isConnected),
    () => {
      setMobileGhosttyKeyboardOpen(false);
    },
  );
}

function setupMobileTerminalViewport(): void {
  if (!window.visualViewport) return;
  const vvHandler = (): void => {
    if (!window.visualViewport) return;
    const kbHeight = keyboardOcclusionHeight(window.innerHeight, {
      height: window.visualViewport.height,
      // Browsers always provide offsetTop; use zero for incomplete viewport
      // implementations so keyboard resize handling still fails safely.
      offsetTop: window.visualViewport.offsetTop ?? 0,
    });
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
  window.visualViewport.addEventListener("scroll", vvHandler);
  state.visualViewportHandler = vvHandler;
  // Fire once to catch keyboard already open from previous session
  vvHandler();
}

async function initTerminal(prefillModeOverride?: TerminalPrefillMode): Promise<void> {
  if (state.terminalController) return;
  const isMobile = !isDesktop();
  const container = document.getElementById("desktop-terminal-container");
  const slowLoad = prepareTerminalBootstrapView(container);
  const terminalPrefillMode = prefillModeOverride ?? TERMINAL_PREFILL_MODE.FULL;
  const liveGate = createTerminalLiveGate({
    waitForPostMount: isMobile,
    onLive: () => {
      slowLoad.stop();
      setTerminalLoadVisualState(container, "live");
      scheduleGhosttyPrewarm();
    },
  });

  _tcState = { displaced: false, autoTakeControl: false };
  state.terminalController = createTerminalBootstrapController({
    container,
    isMobile,
    prefillMode: terminalPrefillMode,
    slowLoad,
    liveGate,
  });

  await state.terminalController.mount(container);
  if (!state.terminalController) return; // disposed while awaiting WASM init
  if (!state.terminalController.term) {
    showTerminalMountFailure(container, slowLoad);
    return;
  }

  if (isMobile) {
    setupMobileTerminalInput(container, state.terminalController);
    setupMobileTerminalViewport();
  }
  // Hydration can complete while mount awaits Ghostty. Do not expose a live
  // terminal on mobile until its post-mount handlers are ready.
  liveGate.onPostMountReady();
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
  container.classList.remove("hydrated");
  setTerminalLoadVisualState(container, "prefill-loading");
  void container.offsetHeight;
}

function destroyTerminal() {
  hideTerminalCanvasForTeardown();
  if (state._touchCleanup) { state._touchCleanup(); state._touchCleanup = null; }
  if (!isDesktop()) setMobileGhosttyKeyboardOpen(false);
  if (state.terminalController) { state.terminalController.dispose(); state.terminalController = null; }
  // Clean up visualViewport handler
  if (state.visualViewportHandler && window.visualViewport) {
    window.visualViewport.removeEventListener("resize", state.visualViewportHandler);
    window.visualViewport.removeEventListener("scroll", state.visualViewportHandler);
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
  if (connState === "machine-unavailable") {
    statusEl.style.display = "block";
    statusEl.style.background = "#cc3333";
    statusEl.textContent = "machine unavailable — refresh Tailnet discovery before reconnecting";
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
  const saved = input.value;
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
  const attempt = sendMessageDraftAttempt(saved, wireText =>
    _sendTerminalInput(_textEncoder.encode(wireText))
  );
  if (attempt.sent) {
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
    input.value = attempt.savedDraft;
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
  const gridIndex = isGridActive()
    ? state.gridSessions.findIndex(session => session.session === name && (session.machine || "") === (machineUrl || ""))
    : -1;
  if (gridIndex !== -1) removeFromGrid(gridIndex);
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
  const multiMachine = getWorkspaceMachines().length > 0;

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
  drawer.removeAttribute("inert");
  drawer.setAttribute("aria-hidden", "false");
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
  requestAnimationFrame(() => drawer.querySelector<HTMLElement>("button")?.focus({ preventScroll: true }));
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
  drawer.setAttribute("aria-hidden", "true");
  drawer.setAttribute("inert", "");
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
  const TAP_SLOP_PX = 15;
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
    if (!state.drawerOpen && dy > TAP_SLOP_PX) {
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
    if (state.drawerOpen && dy < -TAP_SLOP_PX) {
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
      if (dt < 300 && dist <= TAP_SLOP_PX && touchTarget) {
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
  // Suspend the current terminal before mounting the selected session.
  destroyTerminal();
  setState({ currentSession: name, currentMachine: machineUrl });
  recordRecent(machineUrl, name);
  restoreDraft();
  loadSessionSwitcher();
  // Update machine label in header (showView sets it, but drawer bypasses showView)
  const hml = document.getElementById("header-machine-label");
  if (getWorkspaceMachines().length > 0) {
    const mName = machineUrl
      ? (getWorkspaceMachines().find(m => m.url === machineUrl)?.name || "remote")
      : (state.selfName || "local");
    hml.textContent = mName;
    hml.style.display = "block";
  }
  void initTerminal(TERMINAL_PREFILL_MODE.FULL);
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
    // Resume shared cadences and refresh immediately after foregrounding.
    syncSessionRefreshTimer(true);
    tailnetDiscoveryAutoRefresh.sync(true);
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
    // Stop browser-side polling when backgrounded.
    if (state.sessionRefreshTimer) {
      clearInterval(state.sessionRefreshTimer);
      state.sessionRefreshTimer = null;
    }
    tailnetDiscoveryAutoRefresh.stop();
  }
});

window.addEventListener("online", () => {
  tailnetDiscoveryAutoRefresh.sync(true);
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
    if (shouldSubmitMessageInputOnEnter({
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

  function needsHold() {
    if (!wpSettings.holdToSend) return false;
    const text = (document.getElementById("msg-input") as HTMLTextAreaElement).value.trim();
    return text.length > LARGE_THRESHOLD;
  }

  function startHold(e) {
    if (!needsHold()) { sendMsg(); return; }
    e.preventDefault();
    btn.classList.add("holding");
    btn.style.setProperty("--hold-duration", HOLD_MS + "ms");
    holdTimer = setTimeout(() => {
      btn.classList.remove("holding");
      btn.classList.add("hold-complete");
      haptic([10, 30, 10]);
      sendMsg();
      setTimeout(() => btn.classList.remove("hold-complete"), 300);
    }, HOLD_MS);
  }

  function cancelHold() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    btn.classList.remove("holding", "hold-complete");
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
      if (shouldInsertMessageNewlineFromAccessoryKey({
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
  if (state.currentView === "projects" && projectPickerPanel === "directory") {
    e.preventDefault();
    returnFromDirectoryBrowser();
    return;
  }
  if (state.currentView === "projects" && projectPickerPanel === "create") {
    e.preventDefault();
    showProjectPickerPanel("projects", document.getElementById("create-project-action"));
    return;
  }
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
interface SessionNavigationTarget {
  readonly name: string;
  readonly machineUrl: string;
}

function renderedSessionNavigationTargets(): SessionNavigationTarget[] {
  const root = document.querySelector(state.sessionsExpanded ? "#session-list" : "#sidebar-session-list");
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>('[data-action="open-session"]')).flatMap((control) => {
    const name = control.dataset.session;
    return name ? [{ name, machineUrl: control.dataset.machine ?? "" }] : [];
  });
}

document.addEventListener("keydown", (e) => {
  if (!isDesktop()) return;
  const mod = e.metaKey || e.ctrlKey;

  // Cmd+B — toggle the persistent desktop sidebar without covering the terminal.
  if (mod && e.key.toLowerCase() === "b" && !state.sessionsExpanded) {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById("sidebar-collapse-btn")?.click();
    return;
  }

  const arrowDirection = e.key === "ArrowLeft" ? "left"
    : e.key === "ArrowRight" ? "right"
      : e.key === "ArrowUp" ? "up"
        : e.key === "ArrowDown" ? "down"
          : null;
  const paneNavigationShortcut = e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey;
  const cardNavigationShortcut = e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey;
  if (arrowDirection && paneNavigationShortcut && moveGridFocusByArrow(arrowDirection)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  // Cmd+ArrowUp / Cmd+ArrowDown — previous/next rendered session card.
  if (cardNavigationShortcut && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    e.stopPropagation();
    const renderedTargets = renderedSessionNavigationTargets();
    const targets = renderedTargets.length > 0
      ? renderedTargets
      : state.sessionCardView === SESSION_CARD_VIEW.IDLE
        ? []
        : state.allSessions.map(session => ({ name: session.name, machineUrl: session.machineUrl || "" }));
    if (targets.length === 0) return;
    let currentIndex = targets.findIndex(target =>
      target.name === state.currentSession && target.machineUrl === state.currentMachine);
    if (currentIndex === -1) currentIndex = e.key === "ArrowDown" ? -1 : targets.length;
    const nextIndex = e.key === "ArrowDown"
      ? (currentIndex + 1) % targets.length
      : (currentIndex - 1 + targets.length) % targets.length;
    const target = targets[nextIndex];
    if (target) void openSession(target.name, target.machineUrl || undefined);
    return;
  }

  // Cmd+T — new session (project picker)
  if (mod && e.key === "t") {
    e.preventDefault();
    e.stopPropagation();
    showProjectPicker();
    return;
  }

  // Cmd+K — clear terminal (focused grid cell or single terminal)
  if (mod && e.key === "k") {
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

document.getElementById("new-project-create-name")?.addEventListener("input", () => {
  updateCreateProjectPreview();
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
  document.querySelectorAll<HTMLAnchorElement>("#settings-section-nav a").forEach((link) => {
    if (link.hash === `#${sectionId}`) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
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
    await tailnetDiscoveryAutoRefresh.requestRefresh();
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
let sidebarLayoutTransitionId = 0;
let sidebarLayoutSettlementTransitionId: number | null = null;
// Mirrors #desktop-sidebar's 200ms margin-left transition when transitionend is unavailable.
const SIDEBAR_LAYOUT_TRANSITION_FALLBACK_MS = 200;

let sidebarInitialRender = false;
let _sidebarRafId = null;
let _lastSidebarHtml = "";

function sidebarOwnsSessionChooser(): boolean {
  const sidebarIsChooserSurface = state.sidebarPinned
    || (state.sidebarAutoExpanded && state.currentView !== "sessions");
  return isDesktop()
    && sidebarIsChooserSurface
    && !state.sessionsExpanded
    && state.lastSessionGroups.some(group => group.sessions.length > 0);
}

function syncSessionChooserOwnership(): boolean {
  const sidebarOwns = sidebarOwnsSessionChooser();
  const sessionDashboardControls = document.getElementById("session-dashboard-controls");
  const sessionList = document.getElementById("session-list");
  if (sessionDashboardControls) sessionDashboardControls.hidden = sidebarOwns;
  if (sessionList) sessionList.hidden = sidebarOwns;
  return sidebarOwns;
}

function renderSidebar() {
  if (!isDesktop()) return;
  syncSessionChooserOwnership();
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
  if (!syncSessionChooserOwnership()) {
    if (_lastSidebarHtml) {
      _lastSidebarHtml = "";
      el.replaceChildren();
    }
    return;
  }
  const groups = state.lastSessionGroups;
  // Don't wipe sidebar with empty content if sessions haven't loaded yet
  if (!groups.length && sidebarInitialRender) return;
  if (groups.length) sidebarInitialRender = true;
  const machines = getWorkspaceMachines();
  const multiMachine = machines.length > 0;

  let html = sessionCardViewControlsHtml();
  if (!multiMachine) {
    // Single machine — simple list with + New
    const g = groups[0];
    const sidebarBtns = `<div class="sidebar-top-btns"><button type="button" class="new-btn" data-action="new-session" data-machine="" aria-label="Start a session on this machine"><span aria-hidden="true">+</span> New session</button>${sessionOrderResetButtonHtml("")}</div>`;
    if (g && g.online) {
      const presentation = sessionCardGroupPresentation(g.sessions, "");
      html += sidebarBtns;
      html += presentation.rows.length
        ? visibleDelegationRows(presentation.rows, "").map(row => sidebarCardHtml(row, "")).join("")
        : presentation.empty === "idle"
          ? idleSessionEmptyHtml()
          : '<div class="sidebar-no-sessions">No active sessions</div>';
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
      html += `<div class="machine-header"><div class="dot ${statusDot}"></div>${mName}<div class="machine-header-btns">${sessionOrderResetButtonHtml(g.machine.url)}<button type="button" class="machine-add-btn" data-action="new-session" data-machine="${escAttr(g.machine.url)}" aria-label="Start a session on ${escAttr(g.machine.name)}" title="New session"${createDisabled}>+</button></div></div>`;
      if (g.online) {
        const presentation = sessionCardGroupPresentation(g.sessions, g.machine.url);
        if (presentation.rows.length) {
          html += visibleDelegationRows(presentation.rows, g.machine.url).map(row => sidebarCardHtml(row, g.machine.url)).join("");
        } else if (presentation.empty === "idle") {
          html += idleSessionEmptyHtml();
        }
      } else if (g.pending) {
        html += '<div class="sidebar-conn-status">Connecting...</div>';
      } else if (!g.online) {
        html += `<div class="sidebar-conn-status">${esc(machineFailureLabel(g.failure || "unknown"))} <button type="button" class="machine-retry-btn" data-action="retry-machine" data-machine="${mUrl}" aria-label="Retry ${escAttr(g.machine.name)}">Retry</button></div>`;
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
  const ui = sessionRuntimeUi(s);
  const isActive = s.name === state.currentSession && machineUrl === state.currentMachine;
  const inGrid = isSessionInGrid(s.name, machineUrl);
  const activeClass = isActive ? " sidebar-active" : (inGrid ? " sidebar-grid" : "");
  const gridAction = inGrid ? "Remove from grid" : "Add to grid";
  const gridBtn = `<button type="button" class="grid-btn${inGrid ? ' in-grid' : ''}" data-action="toggle-grid" data-session="${escAttr(s.name)}" data-machine="${machineUrlAttr}" title="${gridAction}" aria-label="${gridAction}: ${escAttr(s.name)}" aria-pressed="${inGrid ? "true" : "false"}">${inGrid ? '⊠' : '+'}</button>`;
  const grouping = delegationCardAttributes(row);
  const ordering = sessionOrderCardHtml(row, machineUrl);
  return `<div class="card ${ui.card}${activeClass}${grouping.className}"${grouping.dataAttribute}${ordering.attributes}>
    <button type="button" class="card-open" data-action="open-session" data-session="${escAttr(s.name)}" data-machine="${machineUrlAttr}" aria-label="Open ${escAttr(s.name)}"${isActive ? ' aria-current="page"' : ''}${ordering.openAttributes}></button>
    <div class="dot ${ui.dot}" title="${ui.title}"></div>
    <div class="card-info">
      <div class="card-name"><span class="card-name-text">${esc(s.name)}</span></div>
      <div class="card-status"><span class="triage-badge ${ui.badge}">${ui.label}</span>${sidebarDelegationToggleHtml(row, machineUrl)}</div>
      ${delegationParentMissingHtml(row)}
      <div class="card-preview">${esc(lastLine)}</div>
      ${activityHtml(s)}
    </div>
    ${gridBtn}
    <button type="button" class="kill-btn" data-action="kill-session" data-session="${escAttr(s.name)}" data-machine="${machineUrlAttr}" aria-label="Stop ${escAttr(s.name)}" title="Stop session">&times;</button>
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

function renderedSessionOrderSiblingScope(moving: SessionOrderCardReference): SessionOrderIdentity[] {
  const list = document.getElementById(moving.listId);
  if (!list) return [];
  return Array.from(list.querySelectorAll<HTMLElement>(".card[data-session-order-id]")).flatMap((card) => {
    const sessionId = card.dataset.sessionOrderId;
    const machineUrl = card.dataset.sessionOrderMachine;
    const parentId = card.dataset.sessionOrderParent ?? "";
    return sessionId && machineUrl === moving.machineUrl && parentId === moving.parentId
      ? [{ machineUrl, sessionId }]
      : [];
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
  announcedPosition?: number,
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
  const siblingPosition = announcedPosition ?? (updatedContext
    ? sessionOrderSiblingScope(updatedContext, moving).findIndex(identity => identity.sessionId === moving.sessionId) + 1
    : 0);
  announceSessionOrder(`${moving.name} moved to position ${siblingPosition}${persisted ? "" : "; order could not be saved"}`);
  return true;
}

function moveSessionCardByOffset(moving: SessionOrderCardReference, offset: -1 | 1): boolean {
  const context = sessionOrderContext(moving.machineUrl);
  if (!context) return false;
  const siblings = state.sessionCardView === SESSION_CARD_VIEW.IDLE
    ? renderedSessionOrderSiblingScope(moving)
    : sessionOrderSiblingScope(context, moving);
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
  }, offset < 0 ? "before" : "after", index + offset + 1);
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
  sidebar.classList.toggle("collapsed", !state.sidebarPinned);
  state.sidebarCollapsed = !state.sidebarPinned;
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
    const transitionId = sidebarLayoutTransitionId;
    if (sidebarLayoutSettlementTransitionId === transitionId) return;
    sidebarLayoutSettlementTransitionId = transitionId;
    const complete = (acknowledged = true) => {
      if (transitionId !== sidebarLayoutTransitionId) return;
      sidebarLayoutSettlementTransitionId = null;
      state.sidebarLayoutTransitioning = false;
      if (acknowledged) revealGridCellsWithoutResize();
    };
    if (activeGridTerminalSessions() !== null) {
      scheduleGridStabilizedFit(complete);
      return;
    }
    const controller = state.terminalController;
    if (!controller) {
      complete();
      return;
    }
    const supportsOrderedResize = controller.supportsOrderedResize;
    let settlement: void | Promise<OrderedResizeSettlement>;
    try {
      settlement = controller.resize();
    } catch (error: unknown) {
      console.warn("[sidebar] terminal resize failed:", error);
      complete(false);
      return;
    }
    if (!supportsOrderedResize) {
      complete();
      return;
    }
    void Promise.resolve(settlement).then((outcome) => {
      complete(outcome === "acknowledged");
    }, (error) => {
      console.warn("[sidebar] terminal resize settlement failed:", error);
      complete(false);
    });
  }

  function beginSidebarLayoutTransition(): void {
    if (sidebarLayoutTransitionFallbackTimer) clearTimeout(sidebarLayoutTransitionFallbackTimer);
    sidebarLayoutTransitionId += 1;
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
    renderSidebar();
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
    renderSidebar();
  };

  // Entering the narrow invisible edge temporarily opens an unpinned sidebar.
  const openAutoSidebar = (): void => {
    if (state.sidebarCollapsed && !state.sidebarPinned && !state.sessionsExpanded) {
      state.sidebarTransitionIsHover = true;
      sidebar.classList.remove("collapsed");
      state.sidebarAutoExpanded = true;
      renderSidebar();
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
          renderSidebar();
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
  const phonePwaNotificationsGuideLink = $(
    "phone-pwa-notifications-guide-link",
  ) as HTMLAnchorElement | null;
  if (phonePwaNotificationsGuideLink) {
    phonePwaNotificationsGuideLink.href = PHONE_PWA_NOTIFICATIONS_GUIDE_URL;
  }
  const on = (id: string, event: string, fn: EventListener) => {
    const el = $(id);
    if (el) el.addEventListener(event, fn);
  };

  bindDelegatedAppActions(document, {
    quickSend: sendQuickCmd,
    quickMove: moveQuickCmd,
    quickEdit: index => { void editQuickCmd(index); },
    quickDelete: deleteQuickCmd,
    delegationToggle: toggleSidebarDelegationChildren,
    newSession: machine => { void showProjectPicker(machine); },
    openSession: (session, machine) => { void openSession(session, machine); },
    killSession: (session, event, machine) => { void killSession(session, event, machine); },
    retryMachine,
    selectProject,
    agentRemove: command => { void removeAgent(command); },
    createAgentSession: command => { void createSessionWithAgent(command); },
    agentToggle: (command, enabled) => { void toggleAgentEnabled(command, enabled); },
    toggleGrid,
    setSessionCardView,
  });

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
  on("new-project-create", "click", () => selectNewProject());
  const openFolderAction = document.getElementById("open-folder-action");
  openFolderAction?.addEventListener("click", () => openDirectoryBrowser(openFolderAction, "open"));
  const createProjectAction = document.getElementById("create-project-action");
  createProjectAction?.addEventListener("click", () => {
    showCreateProjectPanel(document.getElementById("new-project-create-name"));
  });
  on("directory-browser-back", "click", () => returnFromDirectoryBrowser());
  on("create-project-back", "click", () => {
    showProjectPickerPanel("projects", createProjectAction);
  });
  const changeParent = document.getElementById("directory-create-change-parent");
  changeParent?.addEventListener("click", () => openDirectoryBrowser(changeParent, "create-parent"));
  on("directory-browser-select", "click", () => selectBrowsedDirectory());
  document.getElementById("directory-browser-path-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.getElementById("directory-browser-path") as HTMLInputElement;
    const path = input.value;
    if (!path.trim()) {
      input.focus({ preventScroll: true });
      return;
    }
    void loadDirectoryBrowser(path, document.activeElement === input);
  });

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
  isGhosttyRendererReady: () => ghosttyRendererReady,
  ensureGridIsolation,
  focusDelegationSession,
  leaveDelegationWorkspace: leaveDelegationWorkspaceForManualGrid,
});

initSettings();
const sessionDashboardControls = document.getElementById("session-dashboard-controls");
if (sessionDashboardControls) sessionDashboardControls.innerHTML = sessionCardViewControlsHtml();
purgeLegacyTerminalRecoverySnapshots();
renderCmdPalette();
initSidebar(); // Init sidebar early so pin/expand/hover handlers are ready
const initialSettingsSection = settingsSectionFromHash();
if (initialSettingsSection) {
  void showSettings().then(() => revealSettingsSection(initialSettingsSection, false));
} else {
  showView("sessions", true, false);
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

function serializeTerminalTailForTest(container: HTMLElement, maxLines: number): string {
  const controller = container.id === "desktop-terminal-container"
    ? state.terminalController
    : [...state.gridSessions, ...state.delegationGridSessions]
      .find((session) => session._cellElement === container)?.controller;
  return controller?.term ? serializeXtermTail(controller.term, maxLines) : "";
}

Object.defineProperty(window, "__wolfpackTest", {
  value: Object.freeze({ serializeTerminalTail: serializeTerminalTailForTest }),
  writable: false,
  configurable: false,
});
