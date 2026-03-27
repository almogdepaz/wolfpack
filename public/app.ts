import {
  esc, escAttr, loadStoredJson, isDesktop, formatSnapshotTtl,
  getTerminalFontFamily, getCharDimensions,
  wpDefaults, wpSettings, TERM_PRESETS, toggleSetting, applySetting,
  applyTermToXterm, initSettings, haptic, requestNotifications,
  QC_STORAGE_KEY, loadQuickCmds, RECENTS_STORAGE_KEY, MAX_RECENTS,
  state, setState,
  SNAPSHOT_KEY_PREFIX, SNAPSHOT_MAX_BYTES, SNAPSHOT_SAVE_INTERVAL,
  DESKTOP_TERMINAL_SCROLLBACK, GRID_TERMINAL_SCROLLBACK,
} from "./app-state";

function useClassicMobile(): boolean {
  return !isDesktop() && wpSettings.mobileTerminal === "classic";
}

import {
  initRalphDeps,
  getRalphStatus, renderRalphCardHtml, sidebarRalphCardHtml,
  openRalphDetail, refreshRalphDetail, parseIterations, toggleRawLog,
  cancelRalph, loadRalphStartForm, onIsolationChange,
  startRalph, continueRalph, discardRalph, showRalphStart, dismissRalph,
  getRalphNotificationStatus, checkRalphTransitions,
} from "./app-ralph";

import {
  initGridDeps,
  isGridActive, updateGridLayout, renderGridCells, getGridCellElement,
  hasPreservedGrid, clearPreservedGrid, setCurrentSessionFromGridFocus,
  returnToTerminalView, setGridFocus, suspendGridMode, restorePreservedGrid,
  backFromRalph, backFromSettings, addToGrid, removeFromGrid, exitGridMode,
  fitAllGridCells, hideGridCellsForTransition, revealGridCellsWithoutResize,
  scheduleGridStabilizedFit, isSessionInGrid, toggleGrid,
} from "./app-grid";

import { setupTouchScrollHandler } from "./app-touch";

// ── WASM capability guard ──

function canUseWasmTerminal() {
  return !(window as any).wasmFailed;
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
  const samples = el("dbg-samples"); if (samples) samples.textContent = wpMetrics.latencySamples.length;
  const wsMsgs = el("dbg-ws-msgs"); if (wsMsgs) wsMsgs.textContent = wpMetrics.wsMessagesReceived;
  const reconnects = el("dbg-reconnects"); if (reconnects) reconnects.textContent = wpMetrics.reconnectCount;
  const sends = el("dbg-sends"); if (sends) sends.textContent = wpMetrics.sendCount;
  const fails = el("dbg-send-fails"); if (fails) {
    fails.textContent = wpMetrics.sendFailCount;
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

function sendQuickCmd(index) {
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

function editQuickCmd(index) {
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

function deleteQuickCmd(index) {
  state.quickCmds.splice(index, 1);
  saveQuickCmds();
  renderQuickCmdSettings();
  renderCmdPalette();
}

function moveQuickCmd(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= state.quickCmds.length) return;
  const tmp = state.quickCmds[index];
  state.quickCmds[index] = state.quickCmds[target];
  state.quickCmds[target] = tmp;
  saveQuickCmds();
  renderQuickCmdSettings();
  renderCmdPalette();
}

async function showGitStatus() {
  if (!state.currentSession) return;
  haptic([30]);
  const overlay = document.getElementById("git-status-overlay");
  overlay.innerHTML = '<pre>loading...</pre>';
  overlay.classList.add("visible");
  try {
    const data = await api("/git-status?session=" + encodeURIComponent(state.currentSession), {}, state.currentMachine);
    overlay.innerHTML = `<div><pre>${esc(data.status || "(clean)")}</pre><div class="overlay-hint">tap to dismiss</div></div>`;
  } catch (e) {
    overlay.innerHTML = `<div><pre class="error-pre">${esc(errorMessage(e))}</pre><div class="overlay-hint">tap to dismiss</div></div>`;
  }
}

function dismissGitStatus() {
  document.getElementById("git-status-overlay").classList.remove("visible");
}

// ── Session Recents ──

function sessionKey(machine, name) {
  return (machine || "") + "|" + name;
}

function saveRecents() {
  localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(state.sessionRecents));
}

function recordRecent(machine, name) {
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
function createReconnector(opts = {}) {
  let _timer = null;
  let _delay = RECONNECT_BASE_DELAY_MS;
  let _startedAt = 0;
  let _blocked = false;

  function schedule(connectFn) {
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
 * @returns {{ term: Terminal, fitAddon: FitAddon }}
 */
function createTerminalInstance({ fontSize, scrollback, cursorBlink = true, disableStdin = false, sendInput, sendMessage, canAcceptInput, canSendResize }) {
  const shouldSendResize = canSendResize || canAcceptInput;
  const tp = TERM_PRESETS[wpSettings.termFontSize] || TERM_PRESETS.medium;
  const termFontFamily = wpSettings.termFont === "alt"
    ? '"JetBrains Mono", "Fira Code", "Source Code Pro", "Cascadia Code", monospace'
    : '"SF Mono", "Menlo", "Consolas", "DejaVu Sans Mono", "Liberation Mono", monospace';
  const term = new Terminal({
    cursorBlink,
    disableStdin,
    macOptionClickForcesSelection: true,
    fontSize: fontSize != null ? fontSize : tp.fontSize,
    lineHeight: tp.lineHeight,
    fontFamily: termFontFamily,
    theme: {
      background: "#0a0a0a",
      foreground: "#e0e0e0",
      cursor: "#e0e0e0",
      selectionBackground: "rgba(255,255,255,0.2)",
    },
    scrollback,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  // Copy (ghostty renders to canvas, so native copy doesn't work)
  // ghostty-web: true = "handled, stop", false = "not handled, continue"
  term.attachCustomKeyEventHandler((e) => {
    if (WP.shouldInterceptCopy(e, term.hasSelection())) {
      navigator.clipboard.writeText(term.getSelection()).catch((e) => { console.debug("[clipboard] copy failed:", e); });
      return true;
    }
    return false;
  });

  // Mouse wheel → SGR scroll sequences for tmux (ghostty-web doesn't do mouse reporting)
  // Trackpad sends many small-deltaY events; accumulate before emitting scroll lines.
  let _scrollAccum = 0;
  const SCROLL_THRESHOLD = 60; // px of deltaY per scroll line (tuned for trackpad)
  term.attachCustomWheelEventHandler((ev) => {
    try {
      const hasMouse = term.getMode(1000) || term.getMode(1002) || term.getMode(1003);
      if (!hasMouse) return false;
    } catch { return false; }
    _scrollAccum += ev.deltaY;
    const lines = Math.trunc(_scrollAccum / SCROLL_THRESHOLD);
    if (lines === 0) return true; // accumulate more before scrolling
    _scrollAccum -= lines * SCROLL_THRESHOLD;
    const btn = lines > 0 ? 65 : 64;
    const seq = `\x1b[<${btn};1;1M`;
    const encoded = new TextEncoder().encode(seq);
    const count = Math.min(Math.abs(lines), 5);
    for (let i = 0; i < count; i++) {
      if (canAcceptInput()) sendInput(encoded);
    }
    return true;
  });

  // Stdin forwarding
  term.onData((data) => {
    if (canAcceptInput()) sendInput(new TextEncoder().encode(data));
  });
  if (term.onBinary) {
    term.onBinary((data) => {
      if (canAcceptInput()) {
        const buf = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) buf[i] = data.charCodeAt(i) & 0xff;
        sendInput(buf);
      }
    });
  }

  // Resize forwarding (debounced to prevent resize storms)
  let _termResizeTimer = null;
  term.onResize(({ cols, rows }) => {
    if (!shouldSendResize()) return;
    if (_termResizeTimer) clearTimeout(_termResizeTimer);
    _termResizeTimer = setTimeout(() => {
      _termResizeTimer = null;
      if (shouldSendResize()) sendMessage(JSON.stringify({ type: "resize", cols, rows }));
    }, 50);
  });

  return { term, fitAddon };
}
const DESKTOP_INITIAL_PREFILL_TIMEOUT_MS = 1000;

/**
 * Shared hydration controller for ghostty-web terminals.
 * Owns: pending state, timeout fallback, visibility reveal, scrollToBottom,
 * optional focus, and a short quiet-period debounce so initial history bursts
 * can settle before the terminal becomes visible.
 * @param {{ getElement: () => HTMLElement|null, getTerm: () => Terminal|null, shouldFocus: () => boolean, canFinish?: () => boolean, timeoutMs?: number, settleMs?: number, maxPendingMs?: number }} opts
 */
function createInitialHydrationController(opts) {
  let _pending = false;
  let _fallbackTimer = null;
  let _settleTimer = null;
  let _startedAt = 0;
  const timeoutMs = opts.timeoutMs || DESKTOP_INITIAL_PREFILL_TIMEOUT_MS;
  const settleMs = opts.settleMs || 80;
  const maxPendingMs = opts.maxPendingMs || 4000;

  function finish() {
    if (!_pending) return;
    if (opts.canFinish && !opts.canFinish()) {
      if (Date.now() - _startedAt >= maxPendingMs) {
        // Safety valve: avoid infinite loader on very high-throughput sessions.
      } else {
        if (_settleTimer) clearTimeout(_settleTimer);
        _settleTimer = setTimeout(finish, settleMs);
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
    requestAnimationFrame(() => {
      if (!_pending) {
        const el = opts.getElement();
        if (el) {
          el.classList.remove("hydrating");
          el.classList.add("hydrated");
        }
        if (term && opts.shouldFocus()) term.focus();
      }
    });
  }

  function start() {
    _pending = true;
    _startedAt = Date.now();
    if (_fallbackTimer) clearTimeout(_fallbackTimer);
    if (_settleTimer) { clearTimeout(_settleTimer); _settleTimer = null; }
    _fallbackTimer = setTimeout(finish, timeoutMs);
  }

  function scheduleFinish() {
    if (!_pending) return;
    if (_settleTimer) clearTimeout(_settleTimer);
    _settleTimer = setTimeout(finish, settleMs);
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
    finish,
    cancel,
  };
}
/**
 * Shared PTY WebSocket client for ghostty-web terminals.
 * Owns: URL construction, socket lifecycle, binary/text frame dispatch,
 *       initial attach handshake, reconnect backoff, control message parsing.
 * @param {object} opts
 * @param {string} opts.session - tmux session name
 * @param {string} opts.machine - remote machine URL ("" for local)
 * @param {boolean} [opts.resetPty] - append &reset=1 on first connect
 * @param {string} [opts.prefillMode] - "full" (default), "viewport", or "none"
 * @param {() => {cols:number, rows:number}|null} opts.getTermDimensions
 * @param {() => void} opts.fitTerminal
 * @param {(Uint8Array) => void} opts.onBinaryData
 * @param {() => void} [opts.onOpen]
 * @param {() => void} [opts.onPtyReady]
 * @param {() => void} [opts.onViewerConflict]
 * @param {() => void} [opts.onControlGranted]
 * @param {() => void} [opts.onReplacePrefill]
 * @param {(number, string) => void} opts.onDisconnected
 * @param {() => void} [opts.onReconnecting]
 * @param {() => void} [opts.onReconnectExhausted]
 * @param {() => boolean} [opts.shouldReconnect]
 */
function createPtySocketClient(opts) {
  let ws = null;
  const _rc = createReconnector({
    shouldReconnect: opts.shouldReconnect,
    onReconnecting: opts.onReconnecting,
    onExhausted: opts.onReconnectExhausted,
  });
  let hasConnected = false;
  let consumeReset = !!opts.resetPty;
  let _initialPrefillMode = opts.prefillMode || "full";
  let _attachAckTimer = null;
  let _awaitingAttachAck = false;
  let _prefillChunks: Uint8Array[] = [];
  let _awaitingPrefillDone = false;
  let _sawViewportPrefill = false;
  let _prefillDoneTimeout = null;

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
    if (!dims) return;
    const prefillMode = _initialPrefillMode;
    _initialPrefillMode = "full";
    _lastSentResize = dims.cols + "x" + dims.rows;
    _awaitingAttachAck = true;
    _prefillChunks = [];
    _awaitingPrefillDone = prefillMode !== "none";
    _sawViewportPrefill = false;
    const msg: any = { type: "attach", cols: dims.cols, rows: dims.rows, prefillMode };
    if (_takeControlOnAttach) { msg.takeControl = true; _takeControlOnAttach = false; }
    ws.send(JSON.stringify(msg));
    if (_attachAckTimer) clearTimeout(_attachAckTimer);
    // Compatibility fallback: older servers don't implement attach_ack.
    _attachAckTimer = setTimeout(() => {
      _attachAckTimer = null;
      if (!_awaitingAttachAck) return;
      _awaitingAttachAck = false;
      _lastSentResize = "";
      sendFitResize();
    }, 300);
  }

  /** Fit terminal + send resize dimensions over the socket (debounced). */
  let _lastSentResize = "";
  let _resizeDebounceTimer = null;
  function sendFitResize() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { opts.fitTerminal(); } catch {}
    const dims = opts.getTermDimensions();
    if (!dims) return;
    const key = dims.cols + "x" + dims.rows;
    if (key === _lastSentResize) return; // same dimensions, skip
    // Debounce: collapse rapid resize calls into one
    if (_resizeDebounceTimer) clearTimeout(_resizeDebounceTimer);
    _resizeDebounceTimer = setTimeout(() => {
      _resizeDebounceTimer = null;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const d = opts.getTermDimensions();
      if (!d) return;
      const msg = JSON.stringify({ type: "resize", cols: d.cols, rows: d.rows });
      _lastSentResize = d.cols + "x" + d.rows;
      ws.send(msg);
    }, 50);
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
      if (opts.onOpen) opts.onOpen(wasReconnect);
    };

    sock.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "attach_ack") {
            _awaitingAttachAck = false;
            if (_attachAckTimer) { clearTimeout(_attachAckTimer); _attachAckTimer = null; }
          } else if (msg.type === "pty_ready") {
            if (opts.onPtyReady) opts.onPtyReady();
          } else if (msg.type === "prefill_viewport") {
            // Phase 1 complete: viewport content already written as binary.
            // Flush any buffered viewport chunks immediately for fast first paint.
            const viewportChunks = _prefillChunks;
            _prefillChunks = [];
            if (opts.onBinaryData) {
              for (const chunk of viewportChunks) opts.onBinaryData(chunk);
            }
            // Stay in prefill mode for phase 2 scrollback (if server sends it)
            _awaitingPrefillDone = true;
            _sawViewportPrefill = true;
            // Safety timeout: if WS drops between phase 1 and phase 2 (prefill_done
            // never arrives), we'd buffer live output indefinitely. Force-flush after
            // 2s so the terminal isn't stuck blank on flaky mobile connections.
            if (_prefillDoneTimeout) clearTimeout(_prefillDoneTimeout);
            _prefillDoneTimeout = setTimeout(() => {
              _prefillDoneTimeout = null;
              if (!_awaitingPrefillDone) return;
              console.warn("[pty-ws] prefill_done timeout — force-flushing buffered output");
              _awaitingPrefillDone = false;
              const chunks = _prefillChunks;
              _prefillChunks = [];
              // Mark viewport prefill as consumed so a late prefill_done
              // doesn't trigger onReplacePrefill (which would clear+reflash).
              _sawViewportPrefill = false;
              if (opts.onBinaryData) {
                for (const chunk of chunks) opts.onBinaryData(chunk);
              }
            }, 2000);
          } else if (msg.type === "prefill_done") {
            // Phase 2 complete (or single-phase legacy): flush remaining chunks.
            // If the 2s timeout already force-flushed (_sawViewportPrefill was
            // cleared), skip onReplacePrefill to avoid a needless clear+flash.
            _awaitingPrefillDone = false;
            if (_prefillDoneTimeout) { clearTimeout(_prefillDoneTimeout); _prefillDoneTimeout = null; }
            const chunks = _prefillChunks;
            _prefillChunks = [];
            if (_sawViewportPrefill && chunks.length && opts.onReplacePrefill) {
              opts.onReplacePrefill();
            }
            _sawViewportPrefill = false;
            if (opts.onBinaryData) {
              for (const chunk of chunks) opts.onBinaryData(chunk);
            }
          } else if (msg.type === "viewer_conflict") {
            console.log("[pty-ws]", opts.session, "viewer_conflict");
            _awaitingAttachAck = false;
            _awaitingPrefillDone = false;
            _prefillChunks = [];
            _sawViewportPrefill = false;
            if (_prefillDoneTimeout) { clearTimeout(_prefillDoneTimeout); _prefillDoneTimeout = null; }
            if (_attachAckTimer) { clearTimeout(_attachAckTimer); _attachAckTimer = null; }
            if (opts.onViewerConflict) opts.onViewerConflict();
          } else if (msg.type === "control_granted") {
            console.log("[pty-ws]", opts.session, "control_granted — sending re-attach");
            // Fresh viewer takeover needs a fresh attach bootstrap.
            sendAttachHandshake();
            if (opts.onControlGranted) opts.onControlGranted();
          }
        } catch (e) { console.warn("[pty-ws] failed to parse control message:", e); }
        return;
      }
      if (_awaitingPrefillDone) {
        _prefillChunks.push(new Uint8Array(ev.data));
        return;
      }
      if (opts.onBinaryData) opts.onBinaryData(new Uint8Array(ev.data));
    };

    sock.onclose = (ev) => {
      // Ignore stale close events from sockets replaced by reconnect().
      if (ws !== sock) return;
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

  function sendResize(cols, rows) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  }

  function sendTakeControl() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "take_control" }));
    }
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  function close() {
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
 * @param {string} opts.session - tmux session name
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
 * @param {(boolean) => void} [opts.onOpen] - WebSocket opened (wasReconnect)
 * @param {() => void} [opts.onPtyReady]
 * @param {() => void} [opts.onViewerConflict]
 * @param {() => void} [opts.onControlGranted]
 * @param {() => void} [opts.onReplacePrefill]
 * @param {(number, string) => void} [opts.onDisconnected]
 * @param {() => void} [opts.onReconnecting]
 * @param {() => void} [opts.onReconnectExhausted]
 * @returns {{ mount, connect, focus, resize, dispose, scheduleReconnect, sendTakeControl, sendFitResize, send, resetRetry, term, fitAddon, ptyClient, hydration, isConnected, retryBlocked }}
 */
function createPtyTerminalController(opts) {
  let _container = null;
  let _term = null;
  let _fitAddon = null;
  let _hydration = null;
  let _ptyClient = null;
  let _hydrationStarted = false;
  let _hydrationWritesInFlight = 0;
  let _reconnectPendingReset = false;
  let _postResetBuffer: Uint8Array[] | null = null;
  let _mounting = false;
  let _cachedLoaded = false;

  const _canAcceptInput = opts.canAcceptInput || (() => !!(_ptyClient && _ptyClient.isOpen));
  const _canSendResize = opts.canSendResize || _canAcceptInput;
  const _getHydrationElement = opts.getHydrationElement || (() => _container);

  /** Clear scrollback and flush buffered writes next frame.
   *  Uses clear() instead of reset() to avoid a 1-frame blank flash —
   *  clear() preserves the visible viewport while wiping scrollback.
   *  Buffers writes because ghostty-web WASM crashes with "memory access
   *  out of bounds" if write() follows clear() in the same tick.
   *  Hide canvas during the gap so stale viewport from an earlier point
   *  in the conversation doesn't flash for one frame on reconnect. */
  function _scheduleBufferedClear() {
    if (!_postResetBuffer) _postResetBuffer = [];
    // Hide canvas before clear — visibility:hidden prevents the compositor
    // from painting the stale viewport that clear() preserves.
    const canvas = _container ? _container.querySelector('canvas') : null;
    if (canvas) canvas.style.visibility = 'hidden';
    _term.clear();
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
    if (_hydration && _hydration.pending) {
      _hydrationWritesInFlight++;
      _term.write(data, () => {
        _hydrationWritesInFlight = Math.max(0, _hydrationWritesInFlight - 1);
        if (_hydration) _hydration.scheduleFinish();
        if (opts.onOutput) opts.onOutput(data);
      });
    } else {
      _term.write(data);
      if (opts.onOutput) opts.onOutput(data);
    }
  }

  function fitTerminalPreserveScroll() {
    if (!_fitAddon || !_term) return;
    const scrollState = WP.captureScrollState(_term.buffer.active);
    _fitAddon.fit();
    if (!scrollState.wasAtBottom) {
      const target = WP.scrollTargetAfterResize(_term.buffer.active.baseY, scrollState.distanceFromBottom);
      try { _term.scrollToLine(target); } catch {}
    }
  }

  /**
   * mount(container, { cached }?) — create terminal, open in container, load
   * CanvasAddon, fit, create hydration controller (not yet started).
   * Optionally write cached content.
   */
  async function mount(container, mountOpts) {
    if (_term || _mounting) return; // already mounted or in progress
    _mounting = true;
    try { await window.ghosttyReady; } catch (err) {
      console.error("[ghostty-web] WASM init failed:", err);
      _mounting = false;
      return;
    }
    if (_term) { _mounting = false; return; } // double-mount during async gap
    _container = container;

    const result = createTerminalInstance({
      fontSize: opts.fontSize,
      scrollback: opts.scrollback,
      cursorBlink: opts.cursorBlink,
      disableStdin: opts.disableStdin,
      sendInput: (data) => _ptyClient && _ptyClient.send(data),
      sendMessage: (msg) => _ptyClient && _ptyClient.send(msg),
      canAcceptInput: _canAcceptInput,
      canSendResize: _canSendResize,
    });
    _term = result.term;
    _fitAddon = result.fitAddon;

    // Mark hydrating before terminal mounts to avoid first-frame flicker.
    const hydrationEl = _getHydrationElement();
    if (hydrationEl) { hydrationEl.classList.add("hydrating"); hydrationEl.classList.remove("hydrated"); }

    _term.open(container);

    // Let browser shortcuts through — ghostty-web's keydown handler
    // calls preventDefault() on everything, swallowing Cmd+R etc.
    container.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if ("rwtlnq".includes(k) || (e.shiftKey && k === "r")) {
          e.stopImmediatePropagation();
        }
      }
    }, true);

    // Create hydration controller (started in connect())
    _hydration = createInitialHydrationController({
      getElement: _getHydrationElement,
      getTerm: () => _term,
      shouldFocus: opts.shouldFocus || (() => true),
      canFinish: () => _hydrationWritesInFlight === 0,
      timeoutMs: opts.hydrationTimeoutMs,
      settleMs: 50,
    });

    fitTerminalPreserveScroll();
    if (mountOpts && mountOpts.cached) {
      _cachedLoaded = true;
      _term.write(mountOpts.cached, () => {
        try { _term.scrollToBottom(); } catch {}
      });
    }
    _mounting = false;
  }

  /**
   * connect() — start hydration (first time only), create PTY WebSocket
   * client, and open the connection.
   */
  function connect(connectOpts?: { takeControl?: boolean }) {
    if (_ptyClient && _ptyClient.isOpen) return;
    if (_ptyClient) _ptyClient.close();

    // Start hydration on first connect
    if (!_hydrationStarted && _hydration) {
      _hydration.start();
      _hydrationStarted = true;
    }

    // If cached snapshot was written during mount(), replace the cached
    // buffer with live data on first output (tmux attach redraws the pane).
    if (_cachedLoaded && opts.prefillMode !== "full") {
      _reconnectPendingReset = true;
      _cachedLoaded = false;
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
      fitTerminal: fitTerminalPreserveScroll,
      shouldReconnect: opts.shouldReconnect,
      onOpen: (wasReconnect) => {
        console.log("[pty-ctrl]", opts.session, "onOpen, isCurrent=", isCurrent(), "wasReconnect=", wasReconnect);
        if (!isCurrent()) return;
        // On reconnect, clear stale content and restart hydration —
        // server sends fresh prefill scrollback on the new connection.
        const rehydrate = WP.shouldRehydrate(wasReconnect, _hydrationStarted, opts.prefillMode !== "full");
        if (rehydrate && _term) {
          _hydrationWritesInFlight = 0;
          if (wasReconnect) {
            // Defer terminal reset until first data arrives — keeps old
            // content visible so there's no blank flash during reconnect.
            _reconnectPendingReset = true;
            if (_hydration) _hydration.start();
          } else {
            _term.reset();
            if (_hydration) _hydration.start();
            const el = _getHydrationElement();
            if (el) { el.classList.add("hydrating"); el.classList.remove("hydrated"); }
          }
        }
        if (opts.onOpen) opts.onOpen(wasReconnect);
      },
      onPtyReady: () => { if (isCurrent() && opts.onPtyReady) opts.onPtyReady(); },
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
          _reconnectPendingReset = false;
          _postResetBuffer = [data];
          _scheduleBufferedClear();
          return;
        }
        _writeTermData(data);
      },
      onViewerConflict: () => { if (isCurrent() && opts.onViewerConflict) opts.onViewerConflict(); },
      onControlGranted: () => { if (isCurrent() && opts.onControlGranted) opts.onControlGranted(); },
      onDisconnected: (code, reason) => { if (isCurrent() && opts.onDisconnected) opts.onDisconnected(code, reason); },
      onReconnecting: () => { if (isCurrent() && opts.onReconnecting) opts.onReconnecting(); },
      onReconnectExhausted: () => { if (isCurrent() && opts.onReconnectExhausted) opts.onReconnectExhausted(); },
    });
    _ptyClient.connect();
  }

  function focus() {
    if (_term) _term.focus();
  }

  function resize() {
    fitTerminalPreserveScroll();
  }

  let _resizeTransitionId = 0;
  /** Blank canvas → fit → reveal. No loading overlay — just instant hide/show. */
  function resizeWithTransition() {
    if (!_fitAddon || !_term) return;
    // Refit directly without hiding the canvas — hiding causes a blank frame
    // flicker that's more jarring than the brief reflow ghostty-web does.
    fitTerminalPreserveScroll();
  }

  /**
   * dispose() — close socket, cancel hydration, dispose addons and terminal.
   * Does NOT clean up view-specific DOM (containers, overlays, event listeners).
   */
  function dispose() {
    if (_ptyClient) { _ptyClient.close(); _ptyClient = null; }
    if (_hydration) { _hydration.cancel(); _hydration = null; }
    _hydrationStarted = false;
    _hydrationWritesInFlight = 0;
    _reconnectPendingReset = false;
    _postResetBuffer = null;
    _mounting = false;
    _cachedLoaded = false;
    if (_term) { try { _term.dispose(); } catch {} _term = null; }
    _fitAddon = null;
    _container = null;
  }

  return {
    mount,
    connect,
    focus,
    resize,
    resizeWithTransition,
    dispose,
    // Delegation to pty client
    scheduleReconnect: () => { if (_ptyClient) _ptyClient.scheduleReconnect(); },
    sendTakeControl: () => { if (_ptyClient) _ptyClient.sendTakeControl(); },
    sendFitResize: () => { if (_ptyClient) _ptyClient.sendFitResize(); },
    send: (data) => { if (_ptyClient) _ptyClient.send(data); },
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
  // Classic mobile: send text via JSON over /ws/terminal
  if (useClassicMobile()) {
    if (state.mobileWs && state.mobileWs.readyState === WebSocket.OPEN) {
      const text = new TextDecoder().decode(bytes);
      state.mobileWs.send(JSON.stringify({ type: "input", data: text }));
      return true;
    }
    return false;
  }
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

function sendMobileProxyText(proxy, text) {
  const pending = text || proxy.value;
  if (!pending) return true;
  // Preserve original field content so we don't silently lose buffered chars
  // when an explicit `text` arg is passed and the send fails (PR #89 review).
  const savedField = proxy.value;
  if (_sendTerminalInput(_textEncoder.encode(pending))) {
    proxy.value = "";
    return true;
  }
  proxy.value = savedField || pending;
  return false;
}

function flushMobileKbProxyPendingInput() {
  const proxy = document.getElementById("mobile-kb-proxy");
  if (!proxy) return false;
  return sendMobileProxyText(proxy, proxy.value);
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
  const val = document.getElementById("msg-input").value;
  const key = draftKey(state.currentMachine, state.currentSession);
  if (val) localStorage.setItem(key, val);
  else localStorage.removeItem(key);
}
function restoreDraft() {
  if (!state.currentSession) return;
  const val = localStorage.getItem(draftKey(state.currentMachine, state.currentSession)) || "";
  const input = document.getElementById("msg-input");
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
  try { localStorage.setItem(snapshotKey(machine, session), JSON.stringify({ d: trimmed, ts: Date.now() })); } catch {}
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

function getMachines() {
  try { return JSON.parse(localStorage.getItem("wolfpack-machines") || "[]"); }
  catch { return []; }
}

function saveMachines(list) {
  localStorage.setItem("wolfpack-machines", JSON.stringify(list));
}

function removeMachine(url) {
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
    const d = await api("/discover");
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

function errorMessage(err) {
  if (err && typeof err.message === "string" && err.message) return err.message;
  return String(err || "unknown error");
}

async function api(path, opts, machineUrl) {
  const base = machineUrl ? machineUrl + "/api" : "/api";
  const res = await fetch(base + path, opts);
  const body = await res.text();
  let data = {};
  if (body) {
    try { data = JSON.parse(body); } catch {}
  }
  if (!res.ok) {
    const message = data && typeof data.error === "string"
      ? data.error
      : (body ? body.slice(0, 200) : `HTTP ${res.status}`);
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
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

function showView(name, skipAnimation) {
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
    if (isGridActive()) { suspendGridMode(); }
    else { destroyTerminal(); }
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
      state.sessionRefreshTimer = setInterval(loadSessions, 5000);
    } else if (name === "projects") {
      back.style.display = "block";
      back.onclick = () => { showView(state.viewBeforePicker); loadSessions(); };
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
      back.onclick = () => { backToSessions(); };
      gear.style.display = "none";
      const ralphMachineSuffix = state.currentRalphMachine
        ? " @ " + (getMachines().find(m => m.url === state.currentRalphMachine)?.name || "remote")
        : "";
      title.textContent = (state.currentRalphProject || "ralph") + ralphMachineSuffix;

      refreshRalphDetail();
      state.ralphLogPollTimer = setInterval(refreshRalphDetail, 2000);
    } else if (name === "ralph-start") {
      back.style.display = "block";
      back.onclick = () => { backToSessions(); };
      gear.style.display = "none";
      title.textContent = "start ralph";

      loadRalphStartForm();
    }
  };

  applyHeader();
}


// ── Sessions ──

const TRIAGE_MAP = {
  "needs-input": { dot: "yellow", card: "attention", label: "input", title: "waiting for input" },
  "running":     { dot: "green",  card: "active-session", label: "running", title: "running" },
  "idle":        { dot: "gray",   card: "idle-session", label: "idle", title: "idle" },
};

function triageUi(triage) {
  return TRIAGE_MAP[triage] || TRIAGE_MAP["idle"];
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
      html += g.sessions.map((s, i) => {
        const lastLine = s.lastLine || "";
        const ui = triageUi(s.triage);
        const anim = state.firstLoad ? "animate-in" : "";
        return `<div class="card card-stagger ${anim} ${ui.card}" style="${state.firstLoad ? 'animation-delay:' + i * 30 + 'ms' : ''}" onclick="openSession('${escAttr(s.name)}'${mUrlAttr ? ", '" + mUrlAttr + "'" : ''})">
          <div class="dot ${ui.dot}" title="${ui.title}"></div>
          <div class="card-info">
            <div class="card-name">${esc(s.name)}<span class="triage-badge ${esc(s.triage || "idle")}">${ui.label}</span></div>
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

function fetchMachine(machineUrl, machineMeta) {
  const ralphFetch = wpSettings.ralphEnabled ? api("/ralph", undefined, machineUrl || undefined).catch(() => ({ loops: [] })) : Promise.resolve({ loops: [] });
  return Promise.all([api("/sessions", undefined, machineUrl || undefined), api("/info", undefined, machineUrl || undefined), ralphFetch])
    .then(([d, info, ralph]) => ({
      machine: { ...machineMeta, url: machineUrl, version: info.version || "", name: info.name || machineMeta.name },
      sessions: d.sessions || [], loops: ralph.loops || [], online: true, pending: false,
    }))
    .catch(() => ({
      machine: { ...machineMeta, url: machineUrl, version: "" },
      sessions: [], loops: [], online: false, pending: false,
    }));
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

  // On first load, render each machine group as it resolves for perceived speed.
  // On subsequent polls, just collect results silently — final render handles it.
  const promises = allMachines.map((m, i) =>
    fetchMachine(m.url, m.meta).then(g => {
      groups[i] = g;
      state.lastSessionGroups = groups.filter(Boolean);
      if (state.firstLoad) {
        const existing = el.querySelector(`[data-machine="${escAttr(m.url)}"]`);
        if (existing) {
          const tmp = document.createElement("div");
          tmp.innerHTML = renderMachineGroupHtml(g, true);
          existing.replaceWith(tmp.firstElementChild);
        }
      }
    })
  );

  await Promise.all(promises);
  if (myEpoch !== state.loadSessionsEpoch) return; // stale call, discard

  // Version outdated check (needs all machines resolved)
  const versions = groups.filter(g => g.online && g.machine.version).map(g => g.machine.version);
  const newestVersion = versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] || "";
  if (newestVersion) {
    groups.forEach(g => {
      g.outdated = g.online && g.machine.version !== newestVersion;
    });
  }

  // Render groups in stable order (no reordering)
  const html = groups.map(g => renderMachineGroupHtml(g, true)).join("");
  if (html !== state.lastSessionsHtml) {
    // Incremental per-group update: replace only changed groups
    const perGroupHtml = groups.map(g => renderMachineGroupHtml(g, true));
    let didIncrementalUpdate = false;
    if (!state.firstLoad && el.children.length === groups.length) {
      didIncrementalUpdate = true;
      for (let gi = 0; gi < groups.length; gi++) {
        const existingChild = el.children[gi];
        const newHtml = perGroupHtml[gi];
        if (existingChild && existingChild.outerHTML !== newHtml) {
          const tmp = document.createElement("div");
          tmp.innerHTML = newHtml;
          existingChild.replaceWith(tmp.firstElementChild);
        }
      }
    }
    if (!didIncrementalUpdate) {
      el.innerHTML = html;
    }
    state.lastSessionsHtml = html;
  }

  state.firstLoad = false;
  state.lastSessionGroups = groups;
  state.allSessions = [];
  groups.forEach(g => g.sessions.forEach(s => state.allSessions.push({ ...s, machineUrl: g.machine.url, machineName: g.machine.name })));
  checkStateTransitions(groups);
}

async function openSession(name, machineUrl) {
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
    switchSession(machineUrl ? machineUrl + "|" + name : name);
    renderSidebar();
    return;
  }
  setState({ currentSession: name, currentMachine: machineUrl || "" });
  recordRecent(state.currentMachine, name);
  wpMetrics.reset();
  restoreDraft();
  const cached = loadSnapshot(state.currentMachine, name);
  showView("terminal");
  destroyTerminal();
  if (useClassicMobile()) {
    initClassicMobile(cached);
  } else {
    initTerminal(cached);
  }
  renderSidebar();
}


// ── Project picker ──

async function showProjectPicker(machineUrl) {
  state.projectMachine = machineUrl || "";
  setState({ viewBeforePicker: state.currentView });
  showView("projects");
  document.getElementById("new-project-name").value = "";
  const el = document.getElementById("project-list");
  el.innerHTML = '<div class="empty">Loading...</div>';

  try {
    const data = await api("/projects", undefined, state.projectMachine);
    if (!data.projects?.length) {
      el.innerHTML = '<div class="empty">No projects in ~/Dev</div>';
      return;
    }
    el.innerHTML = data.projects
      .map(
        (p) => `
<div class="card" onclick="selectProject('${escAttr(p)}')">
  <div class="dot brand" title="project"></div>
  <div class="card-name">${esc(p)}</div>
</div>
    `,
      )
      .join("");
  } catch {
    el.innerHTML = '<div class="empty">Failed to load projects</div>';
  }
}

function showTerminalLoading(label) {
  clearPreservedGrid();
  showView("terminal");
  const dtc = document.getElementById("desktop-terminal-container");
  dtc.style.display = "block";
  dtc.innerHTML = '<span class="loading-text">Starting session in ' + esc(label) + '\u2026</span>';
}

function selectProject(project) {
  state.selectedProject = project;
  state.isNewProject = false;
  showAgentPicker();
}

function selectNewProject() {
  const input = document.getElementById("new-project-name");
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
  const nameInput = document.getElementById("session-name-input");
  const nameError = document.getElementById("session-name-error");
  nameInput.value = "";
  nameInput.classList.remove("invalid");
  nameError.classList.remove("visible");
  try {
    const [data, nameData] = await Promise.all([
      api("/settings", undefined, state.projectMachine),
      api("/next-session-name?project=" + encodeURIComponent(state.selectedProject), undefined, state.projectMachine),
    ]);
    nameInput.value = nameData.name || state.selectedProject;
    const presets = Object.entries(data.presets || {});
    const customCmds = data.settings?.customCmds || [];
    let html = presets.map(([label, cmd]) => `
      <div class="card" onclick="createSessionWithAgent('${escAttr(cmd)}')">
        <div class="dot brand" title="preset"></div>
        <div class="card-name">${esc(label)}</div>
      </div>
    `).join("");
    html += customCmds.map(cmd => `
      <div class="card" onclick="createSessionWithAgent('${escAttr(cmd)}')">
        <div class="dot green" title="custom command"></div>
        <div class="card-name">${esc(cmd)}</div>
        <button class="kill-btn" onclick="deleteCustomCmd('${escAttr(cmd)}', event)" title="Remove command">&times;</button>
      </div>
    `).join("");
    el.innerHTML = html;
  } catch {
    el.innerHTML = '<div class="empty">Failed to load agents</div>';
  }
}

// Session name input validation
(function() {
  const input = document.getElementById("session-name-input");
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

async function addCustomCmd() {
  const input = document.getElementById("custom-cmd-input");
  const cmd = (input.value || "").trim();
  if (!cmd) return;
  try {
    await api("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addCustomCmd: cmd }),
    }, state.projectMachine);
    input.value = "";
    showAgentPicker();
  } catch (e) {
    alert("Failed to add command: " + errorMessage(e));
  }
}

async function deleteCustomCmd(cmd, e) {
  e.stopPropagation();
  try {
    await api("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deleteCustomCmd: cmd }),
    }, state.projectMachine);
    showAgentPicker();
  } catch (e) {
    alert("Failed to delete command: " + errorMessage(e));
  }
}

async function createSessionWithAgent(cmd) {
  const nameInput = document.getElementById("session-name-input");
  const sessionName = (nameInput.value || "").trim();
  if (sessionName && !/^[a-zA-Z0-9_-]+$/.test(sessionName)) return;
  const machine = state.projectMachine;
  showTerminalLoading(sessionName || state.selectedProject);
  try {
    const body = state.isNewProject
      ? { newProject: state.selectedProject, cmd, sessionName: sessionName || undefined }
      : { project: state.selectedProject, cmd, sessionName: sessionName || undefined };
    const data = await api("/create", {
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

function showDesktopConflictOverlay() {
  const container = document.getElementById("desktop-terminal-container");
  if (!container) return;
  // Force hydration complete so overlay is visible (container may be opacity:0)
  if (state.terminalController && state.terminalController.hydration) state.terminalController.hydration.finish();
  removeDesktopConflictOverlay();
  const overlay = createConflictOverlay("Session active on another device", "Take Control", () => {
    if (!state.terminalController) return;
    var clickAction = WP.handleTakeControlClick(state.terminalController.isConnected);
    if (clickAction === "send-take-control") {
      state.terminalController.sendTakeControl();
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
  const el = document.getElementById("desktop-conflict-overlay");
  if (el) el.remove();
}

async function initTerminal(cached) {
  if (state.terminalController) return;
  // Defensive: clear stale timer from a prior session that wasn't properly destroyed
  if (state._cachedFallbackTimer) { clearTimeout(state._cachedFallbackTimer); state._cachedFallbackTimer = null; }
  const isMobile = !isDesktop();
  const container = document.getElementById("desktop-terminal-container");
  const kbProxy = document.getElementById("mobile-kb-proxy");
  container.style.display = "block";
  container.innerHTML = "";
  if (cached) {
    container.classList.add("cached-visible");
    container.classList.remove("hydrating", "hydrated");
  } else {
    container.classList.add("hydrating");
    container.classList.remove("hydrated", "cached-visible");
  }
  document.getElementById("kb-accessory").classList.remove("visible");
  state.kbAccessoryOpen = false;
  document.getElementById("input-bar").style.display = "none";
  document.getElementById("cmd-palette").classList.remove("visible");
  document.getElementById("msg-preview").style.display = "none";

  if (isMobile) {
    kbProxy.style.display = "block";
    // Start with inputmode=none so the browser never shows a virtual keyboard
    // on focus. kb-open-btn switches to inputmode=text when user wants to type.
    kbProxy.setAttribute("inputmode", "none");
    kbProxy.setAttribute("readonly", "");
    // Hide ghostty-web's textarea on mobile to prevent focus stealing
    document.body.classList.add("mobile-no-ghost-focus");
  } else {
    kbProxy.style.display = "none";
  }

  _tcState = { displaced: false, autoTakeControl: false };
  let _cachedPendingReset = !!cached;
  // Timer stored on state so destroyTerminal() can cancel it — prevents cross-session
  // side effects if user switches sessions before first output arrives (see PR #89 review).
  // After 5s, ensure canvas is visible even if hydration hasn't completed —
  // but keep cached content showing (don't blank the screen). The onOutput
  // handler removes cached-visible when live data arrives.
  state._cachedFallbackTimer = cached ? setTimeout(() => {
    state._cachedFallbackTimer = null;
    const el = document.getElementById("desktop-terminal-container");
    if (el) el.classList.add("hydrated");
  }, 5000) : null;

  state.terminalController = createPtyTerminalController({
    session: state.currentSession,
    machine: state.currentMachine || "",
    scrollback: DESKTOP_TERMINAL_SCROLLBACK,
    prefillMode: "none",
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
      setConnState("live");
    },
    onPtyReady: () => { flushMobileKbProxyPendingInput(); },
    onOutput: (data) => {
      if (_cachedPendingReset) {
        _cachedPendingReset = false;
        if (state._cachedFallbackTimer) { clearTimeout(state._cachedFallbackTimer); state._cachedFallbackTimer = null; }
        const el = document.getElementById("desktop-terminal-container");
        if (el) { el.classList.remove("cached-visible"); el.classList.add("hydrated"); }
      }
      if (state.enterRetryTimer) { clearTimeout(state.enterRetryTimer); state.enterRetryTimer = null; }
      wpMetrics.wsMessagesReceived++;
      scheduleSnapshotSave(null);
    },
    onViewerConflict: () => {
      var r = WP.handleViewerConflict(_tcState);
      _tcState = r.newState;
      if (r.action === "auto-take-control") {
        state.terminalController.sendTakeControl();
      } else {
        showDesktopConflictOverlay();
      }
    },
    onControlGranted: () => {
      _tcState = WP.handleControlGranted(_tcState);
      removeDesktopConflictOverlay();
      if (state.terminalController) state.terminalController.focus();
      if (isMobile) {
        const proxy = document.getElementById("mobile-kb-proxy");
        if (proxy && proxy.style.display !== "none") proxy.focus({ preventScroll: true });
      }
    },
    onDisconnected: (code, reason) => {
      removeDesktopConflictOverlay();
      var action = WP.classifyDisconnect(code, reason || "");
      if (action === "displaced") {
        _tcState = WP.handleDisplaced(_tcState);
        showDesktopConflictOverlay();
        return;
      }
      if (action === "session-ended") {
        setConnState("session-ended");
        const statusEl = document.getElementById("conn-status");
        if (statusEl) statusEl.textContent = "session unavailable \u2014 use \u2190 to go back";
        return;
      }
      if (action === "pty-exited") {
        setConnState("session-ended");
        return;
      }
      state.terminalController.scheduleReconnect();
    },
    onReconnecting: () => setConnState("reconnecting"),
    onReconnectExhausted: () => setConnState("offline"),
  });

  await state.terminalController.mount(container, { cached });
  if (!state.terminalController) return; // disposed while awaiting WASM init
  if (!state.terminalController.term) {
    // WASM init failed — show error instead of blank screen
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:13px;padding:20px;text-align:center">Terminal unavailable — WebAssembly not supported in this browser</div>';
    return;
  }

  // Mobile: attach touch scroll handler + blur any auto-focused element
  if (isMobile && state.terminalController.term) {
    state._touchCleanup = setupTouchScrollHandler(
      container, state.terminalController.term,
      (data) => state.terminalController && state.terminalController.send(data),
      () => !!(state.terminalController && state.terminalController.isConnected),
    );
    // ghostty-web sets contentEditable + role=textbox on the container, which
    // causes mobile browsers to show the keyboard on any touch. Adding
    // inputmode=none suppresses the keyboard while preserving ghostty's internals.
    function neutralizeGhostFocus() {
      if (container.getAttribute("contenteditable") && !container.getAttribute("inputmode")) {
        container.setAttribute("inputmode", "none");
      }
      container.querySelectorAll("textarea, input").forEach((el: HTMLElement) => {
        if (!el.hasAttribute("readonly")) {
          el.setAttribute("tabindex", "-1");
          el.setAttribute("inputmode", "none");
          el.setAttribute("readonly", "");
        }
      });
    }
    neutralizeGhostFocus();
    // ghostty-web may re-apply attributes or add new elements on reconnect.
    // Debounce to avoid jank from high-frequency DOM mutations during output.
    let _ghostDebounce = null;
    state._ghostInputObserver = new MutationObserver(() => {
      if (_ghostDebounce) return;
      _ghostDebounce = requestAnimationFrame(() => {
        _ghostDebounce = null;
        neutralizeGhostFocus();
      });
    });
    state._ghostInputObserver.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["contenteditable"] });
    // Blur anything that auto-focused during mount (prevents keyboard auto-open)
    if (document.activeElement && document.activeElement !== document.body) {
      (document.activeElement as HTMLElement).blur();
    }
  }

  let _lastContainerWidth = container.clientWidth;
  const onResize = () => {
    if (state.desktopResizeTimer) clearTimeout(state.desktopResizeTimer);
    state.desktopResizeTimer = setTimeout(() => {
      state.desktopResizeTimer = null;
      const newWidth = container.clientWidth;
      if (isMobile && newWidth === _lastContainerWidth) return;
      _lastContainerWidth = newWidth;
      if (state.terminalController) {
        isMobile ? state.terminalController.resize() : state.terminalController.resizeWithTransition();
      }
    }, 60);
  };
  window.addEventListener("resize", onResize);
  state.desktopResizeHandler = onResize;

  if (window.visualViewport && isMobile) {
    const termView = document.getElementById("terminal-view");
    const vvHandler = () => {
      const kbHeight = window.innerHeight - window.visualViewport.height;
      const kbOpen = kbHeight > 150;
      // Option A: translateY slides the terminal up without changing its height.
      // ghostty-web sees no container resize → no reflow → no scroll-through.
      // The bottom portion of the terminal is clipped behind the keyboard.
      termView.style.transform = kbOpen ? `translateY(-${kbHeight}px)` : "";
      // Toggle visual state on keyboard button + sync accessory state
      const kbBtn = document.getElementById("kb-open-btn");
      if (kbBtn) kbBtn.classList.toggle("active", kbOpen);
      if (state.kbAccessoryOpen !== kbOpen) {
        state.kbAccessoryOpen = kbOpen;
        const cmd = document.getElementById("cmd-palette");
        if (cmd && cmd.innerHTML) cmd.classList.toggle("visible", kbOpen);
        if (!kbOpen) {
          const p = document.getElementById("mobile-kb-proxy");
          if (p && document.activeElement !== p) {
            p.setAttribute("readonly", "");
            p.setAttribute("inputmode", "none");
          }
        }
      }
    };
    window.visualViewport.addEventListener("resize", vvHandler);
    state.visualViewportHandler = vvHandler;
    // Fire once to catch keyboard already open from previous session
    vvHandler();
  }

  connectDesktopWs();
}

function destroyTerminal() {
  // Clean up classic mobile if it was active
  if (document.body.classList.contains("classic-mobile")) destroyClassicMobile();
  if (state._ghostInputObserver) { state._ghostInputObserver.disconnect(); state._ghostInputObserver = null; }
  if (state._cachedFallbackTimer) { clearTimeout(state._cachedFallbackTimer); state._cachedFallbackTimer = null; }
  if (state.snapshotTimer) { clearTimeout(state.snapshotTimer); flushSnapshot(); }
  if (state.desktopResizeTimer) { clearTimeout(state.desktopResizeTimer); state.desktopResizeTimer = null; }
  if (state._touchCleanup) { state._touchCleanup(); state._touchCleanup = null; }
  if (state.terminalController) { state.terminalController.dispose(); state.terminalController = null; }
  if (state.desktopResizeHandler) {
    window.removeEventListener("resize", state.desktopResizeHandler);
    state.desktopResizeHandler = null;
  }
  // Clean up visualViewport handler
  if (state.visualViewportHandler && window.visualViewport) {
    window.visualViewport.removeEventListener("resize", state.visualViewportHandler);
    state.visualViewportHandler = null;
  }
  // Reset termView positioning
  const termView = document.getElementById("terminal-view");
  if (termView) { termView.style.bottom = ""; termView.style.transform = ""; }
  if (state.kbResizeTimer) { clearTimeout(state.kbResizeTimer); state.kbResizeTimer = null; }
  // Blur and hide mobile-kb-proxy
  const kbProxy = document.getElementById("mobile-kb-proxy");
  if (kbProxy) { kbProxy.blur(); kbProxy.style.display = "none"; }
  // Remove mobile ghost focus suppression
  document.body.classList.remove("mobile-no-ghost-focus");

  const container = document.getElementById("desktop-terminal-container");
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

function setConnState(connState) {
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
  if (connState === "displaced") {
    statusEl.style.display = "block";
    statusEl.style.background = "#8a5a00";
    statusEl.innerHTML = '<img src="/wolfpack-icon.svg" class="conn-icon">taken over by another viewer \u2014 <button type="button" id="conn-retry-btn" class="conn-retry-btn">Take Control</button>';
    const retryBtn = document.getElementById("conn-retry-btn");
    if (retryBtn) retryBtn.onclick = takeBackControl;
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
  const input = document.getElementById("msg-input");
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
    // Enter retry: if output hasn't changed within 800ms, Enter may have been dropped.
    // Timer is cleared on any output, so this only fires if truly stuck.
    // Skip in grid mode — grid cells have their own controllers and onOutput won't clear this timer.
    if (!isGridActive()) {
      if (state.enterRetryTimer) clearTimeout(state.enterRetryTimer);
      const retrySession = state.currentSession;
      const retryMachine = state.currentMachine;
      state.enterRetryTimer = setTimeout(() => {
        if (state.currentSession === retrySession && state.currentMachine === retryMachine) {
          sendKey("Enter");
        }
        state.enterRetryTimer = null;
      }, 800);
    }
  } else {
    wpMetrics.sendFailCount++;
    input.value = saved;
    saveDraft();
    autoResizeInput();
    updatePreview();
  }
}

function updatePreview() {
  const input = document.getElementById("msg-input");
  const preview = document.getElementById("msg-preview");
  if (input.scrollWidth > input.clientWidth) {
    preview.textContent = input.value;
    preview.style.display = "block";
  } else {
    preview.style.display = "none";
  }
}

function sendKey(key) {
  if (!state.currentSession) return;
  // Classic mobile: send key name directly via WS JSON
  if (useClassicMobile()) {
    if (state.mobileWs && state.mobileWs.readyState === WebSocket.OPEN) {
      wpMetrics.sendCount++;
      state.mobileWs.send(JSON.stringify({ type: "key", key }));
    } else {
      wpMetrics.sendFailCount++;
    }
    return;
  }
  const esc = KEY_TO_ESCAPE[key];
  if (!esc) return;
  wpMetrics.sendCount++;
  if (_sendTerminalInput(_textEncoder.encode(esc))) return;
  wpMetrics.sendFailCount++;
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
    el.onclick = () => {
      switchSession(el.dataset.val); closeDrawer();
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

function closeDrawer(instant) {
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
  closeDrawer(true);
  // Exit grid mode if active
  if (isGridActive()) exitGridMode();
  // Suspend current mode (cache terminal state)
  destroyTerminal();
  setState({ currentSession: name, currentMachine: machineUrl });
  recordRecent(machineUrl, name);
  restoreDraft();
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
  initTerminal();
  renderSidebar();
}


// ── Notifications ──

// State-transition notification tracking
const prevSessionStates = {};  // "machineUrl|sessionName" → triage
function checkStateTransitions(groups) {
  if (!state.notificationsEnabled || !wpSettings.notifications) return;
  if (document.visibilityState === "visible") return;

  for (const g of groups) {
    if (!g.online) continue;
    const mUrl = g.machine.url || "";
    const mName = g.machine.name || "local";

    // Session transitions: running → idle or needs-input
    for (const s of g.sessions) {
      const key = mUrl + "|" + s.name;
      const prev = prevSessionStates[key];
      const cur = s.triage || "idle";
      prevSessionStates[key] = cur;
      if (prev === "running" && (cur === "idle" || cur === "needs-input")) {
        const title = getMachines().length > 0 ? `${mName}: ${s.name}` : `Wolfpack: ${s.name}`;
        new Notification(title, {
          body: cur === "needs-input" ? "Needs input" : "Finished",
          tag: "wolfpack-session-" + key,
        });
        haptic([200, 100, 200]);
      }
    }

    // Ralph transitions: running/cleanup → done/idle/limit
    checkRalphTransitions(g.loops, mUrl, mName);
  }
}

// Recover terminal stream on foreground; manage session refresh
var _hiddenAt = 0;
const DESKTOP_STALE_THRESHOLD_MS = 60_000;

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
        if (useClassicMobile()) {
          startClassicPolling(true);
        } else if (isGridActive()) {
          for (const gs of state.gridSessions) {
            if (!gs.controller || gs._displaced) continue;
            gs.controller.resetRetry();
            gs.controller.reconnect();
          }
        } else if (state.terminalController?.term) {
          state.terminalController.resetRetry();
          state.terminalController.reconnect();
        }
      } else if (hiddenDuration > DESKTOP_STALE_THRESHOLD_MS) {
        // Desktop: reconnect only if tab was backgrounded >60s (App Nap,
        // browser throttling can silently kill the TCP connection too).
        if (isGridActive()) {
          for (const gs of state.gridSessions) {
            if (!gs.controller || gs._displaced) continue;
            gs.controller.resetRetry();
            if (!gs.controller.isConnected) gs.controller.connect();
          }
        } else if (state.terminalController?.term) {
          state.terminalController.resetRetry();
          if (!state.terminalController.isConnected) connectDesktopWs();
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

// Dismiss preview when tapping terminal area
document.getElementById("desktop-terminal-container").addEventListener("click", () => {
  document.getElementById("msg-preview").style.display = "none";
});

// Auto-resize textarea as content grows
function autoResizeInput() {
  const ta = document.getElementById("msg-input");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
}

const msgInput = document.getElementById("msg-input");
msgInput.addEventListener("input", () => {
  autoResizeInput();
  updatePreview();
  saveDraft();
});
// Enter behavior driven by wpSettings.enterSends (UX-07)
// enterSends=true: Enter submits, Shift+Enter newline
// enterSends=false: Enter newline, Shift+Enter submits

msgInput.addEventListener("keydown", (e) => {
  if (state.currentView !== "terminal") return;
  const empty = !msgInput.value.trim();
  if (e.key === "Enter") {
    if (wpSettings.enterSends) {
      // Enter sends, Shift+Enter adds newline
      if (!e.shiftKey) {
        e.preventDefault();
        if (empty) sendKey("Enter"); else sendMsg();
      }
    } else {
      // Enter adds newline, Shift+Enter sends
      if (e.shiftKey) {
        e.preventDefault();
        if (empty) sendKey("Enter"); else sendMsg();
      }
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
    const text = document.getElementById("msg-input").value.trim();
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

(function setupKbAccessory() {
  const acc = document.getElementById("kb-accessory");
  if (!acc) return;

  // Wire up all keys — prevent blur with mousedown/touchstart preventDefault
  acc.querySelectorAll(".kb-key").forEach((btn) => {
    const key = btn.dataset.key;
    // Skip buttons with their own onclick (e.g. git button)
    if (!key) return;
    let touchFired = false;

    function fire() {
      haptic([15]);
      sendKey(key);
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

(function setupMobileKbProxy() {
  const proxy = document.getElementById("mobile-kb-proxy");
  if (!proxy) return;
  let _composing = false;
  let _skipNextInput = false;

  // Send every character immediately — don't wait for composition to finish.
  // The proxy is invisible so we don't need composed text; the terminal wants
  // each keystroke as it happens. On compositionend we flush any remaining
  // buffered text (e.g. autocomplete selection that inserts multiple chars).
  proxy.addEventListener("compositionstart", () => { _composing = true; });
  proxy.addEventListener("compositionend", () => {
    _composing = false;
    if (proxy.value) {
      _skipNextInput = sendMobileProxyText(proxy, proxy.value);
    }
  });

  proxy.addEventListener("input", (e) => {
    if (_skipNextInput) {
      _skipNextInput = false;
      return;
    }
    // Skip deleteContentBackward — keydown handler already sent \x7f
    if (e.inputType === "deleteContentBackward") return;
    // Skip insertLineBreak/insertParagraph — keydown handler already sent \r
    if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") return;
    // During composition: send the newest char immediately (last char in value).
    // Autocomplete/predictive text buffers chars in the proxy — we drain them
    // one by one so the terminal sees each keystroke without waiting for word selection.
    if (_composing && proxy.value) {
      const last = proxy.value.slice(-1);
      // Clear everything except what the IME is still composing over
      sendMobileProxyText(proxy, last);
      return;
    }
    sendMobileProxyText(proxy, proxy.value || e.data || "");
  });

  proxy.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (_sendTerminalInput(_textEncoder.encode("\r"))) e.preventDefault();
    } else if (e.key === "Backspace") {
      if (_sendTerminalInput(_textEncoder.encode("\x7f")) || !proxy.value) e.preventDefault();
    } else if (e.key === "Escape") {
      if (_sendTerminalInput(_textEncoder.encode("\x1b"))) e.preventDefault();
    }
  });

  // Keyboard toggle button — explicit open/close instead of tap-on-terminal
  // (tap-to-focus was unreliable: scroll gestures triggered keyboard open)
  const kbOpenBtn = document.getElementById("kb-open-btn");
  if (kbOpenBtn) {
    function toggleMobileKeyboard() {
      if (proxy.style.display === "none") return;
      const opening = document.activeElement !== proxy;
      if (opening) {
        proxy.removeAttribute("readonly");
        proxy.setAttribute("inputmode", "text");
        proxy.focus({ preventScroll: true });
      } else {
        proxy.blur();
        proxy.setAttribute("readonly", "");
        proxy.setAttribute("inputmode", "none");
      }
      // Sync kbAccessoryOpen so cmd-palette visibility tracks keyboard state
      state.kbAccessoryOpen = opening;
      const cmd = document.getElementById("cmd-palette");
      if (cmd && cmd.innerHTML) cmd.classList.toggle("visible", opening);
    }
    kbOpenBtn.addEventListener("mousedown", (e) => e.preventDefault());
    kbOpenBtn.addEventListener("touchstart", () => {
      haptic([15]);
    }, { passive: true });
    kbOpenBtn.addEventListener("click", () => {
      toggleMobileKeyboard();
    });
  }
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
  if (state.currentView === "agent") { e.preventDefault(); showView("projects"); }
  else if (state.currentView === "projects") { e.preventDefault(); showView(state.viewBeforePicker); loadSessions(); }
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

document
  .getElementById("new-project-name")
  .addEventListener("keydown", (e) => {
    if (e.key === "Enter") selectNewProject();
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
    fetch(m.url + "/api/info", { signal: AbortSignal.timeout(3000) })
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

function removeMachineUI(url) {
  removeMachine(url);
  renderMachinesList();
}

async function discoverMachines() {
  const statusEl = document.getElementById("discover-status");
  statusEl.textContent = "Scanning tailnet...";
  statusEl.style.color = "#555";
  try {
    const data = await api("/discover");
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
    fgEl = null; bgEl = null; swipeCard = null;
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
        const card = e.target.closest(".card, .ralph-card");
        if (!card) { scrolling = true; return; }
        swipeCard = card;
        isBack = false;
        fgEl = document.getElementById(state.currentView + "-view");
        const isRalphCard = card.classList.contains("ralph-card");
        const targetView = state.currentView === "sessions" ? (isRalphCard ? "ralph-detail" : "terminal") : null;
        if (!targetView) { scrolling = true; return; }
        bgEl = document.getElementById(targetView + "-view");
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
      bg.classList.remove("visible");
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
          if (backBtn && backBtn.onclick) backBtn.onclick();
        } else {
          showView(backView, true);
        }
      } else if (card) {
        card.click();
      }
    }

    vc.classList.remove("swipe-active");
    fgEl = null; bgEl = null; swipeCard = null;
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
      html += g.sessions.map(s => sidebarCardHtml(s, "")).join("");
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
        html += g.sessions.map(s => sidebarCardHtml(s, g.machine.url)).join("");
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

function sidebarCardHtml(s, machineUrl) {
  const lastLine = s.lastLine || "";
  const ui = triageUi(s.triage);
  const isActive = s.name === state.currentSession && machineUrl === state.currentMachine;
  const inGrid = isSessionInGrid(s.name, machineUrl);
  const activeClass = isActive ? " sidebar-active" : (inGrid ? " sidebar-grid" : "");
  const onclick = machineUrl
    ? `openSession('${escAttr(s.name)}', '${escAttr(machineUrl)}')`
    : `openSession('${escAttr(s.name)}')`;
  const gridBtnOnclick = machineUrl
    ? `toggleGrid('${escAttr(s.name)}', '${escAttr(machineUrl)}', event)`
    : `toggleGrid('${escAttr(s.name)}', '', event)`;
  const gridBtn = `<button class="grid-btn${inGrid ? ' in-grid' : ''}" onclick="${gridBtnOnclick}" title="${inGrid ? 'Remove from grid' : 'Add to grid'}">${inGrid ? '⊠' : '+'}</button>`;
  return `<div class="card ${ui.card}${activeClass}" onclick="${onclick}">
    <div class="dot ${ui.dot}" title="${ui.title}"></div>
    <div class="card-info">
      <div class="card-name">${esc(s.name)}</div>
      <div class="card-status"><span class="triage-badge ${esc(s.triage || "idle")}">${ui.label}</span></div>
      <div class="card-preview">${esc(lastLine)}</div>
    </div>
    ${gridBtn}
    <button class="kill-btn" onclick="killSession('${escAttr(s.name)}', event${machineUrl ? ", '" + escAttr(machineUrl) + "'" : ''})">&times;</button>
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
  updatePinButton();

  // Pin/unpin button
  document.getElementById("sidebar-collapse-btn").onclick = () => {
    state.sidebarPinned = !state.sidebarPinned;
    localStorage.setItem("wolfpack-sidebar-pinned", state.sidebarPinned ? "1" : "0");
    state.sidebarTransitionIsHover = false;
    if (!state.sidebarResizeDone) hideGridCellsForTransition();
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
      if (!state.sidebarResizeDone) hideGridCellsForTransition();
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
          if (!state.sidebarResizeDone) hideGridCellsForTransition();
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
    } else if (!state.sidebarAutoExpanded) {
      // Pin/unpin — resize PTY to fit new layout
      if (isGridActive()) {
        scheduleGridStabilizedFit();
      } else if (state.terminalController) {
        state.terminalController.resizeWithTransition();
      }
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

  // Drawer / overlays
  on("drawer-backdrop", "click", () => closeDrawer());
  on("git-status-overlay", "click", () => dismissGitStatus());

  // Expanded toolbar
  on("expanded-settings-btn", "click", () => showSettings());
  on("expanded-collapse-btn", "click", () => $("sidebar-expand-btn")?.click());

  // Project picker
  const pickerCancel = document.querySelector("#projects-view .picker-cancel-btn");
  if (pickerCancel) pickerCancel.addEventListener("click", () => { showView(state.viewBeforePicker); loadSessions(); });

  const createProjectBtn = document.querySelector("#projects-view .new-project-row button");
  if (createProjectBtn) createProjectBtn.addEventListener("click", () => selectNewProject());

  // Agent picker
  const agentBackBtn = document.querySelector("#agent-view .picker-cancel-btn");
  if (agentBackBtn) agentBackBtn.addEventListener("click", () => showView("projects"));

  on("custom-cmd-input", "keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") addCustomCmd(); });
  const addCmdBtn = document.querySelector("#agent-view .custom-cmd-add-btn");
  if (addCmdBtn) addCmdBtn.addEventListener("click", () => addCustomCmd());

  // Settings
  on("settings-back-btn", "click", () => backFromSettings());
  const discoverBtn = document.querySelector(".discover-btn");
  if (discoverBtn) discoverBtn.addEventListener("click", () => discoverMachines());

  // Settings toggles
  on("setting-animations", "change", function(this: any) { toggleSetting("animations", this.checked); });
  on("setting-haptics", "change", function(this: any) { toggleSetting("haptics", this.checked); });
  on("setting-notifications", "change", function(this: any) { toggleSetting("notifications", this.checked); });
  on("setting-termWrap", "change", function(this: any) { toggleSetting("termWrap", this.checked); });
  on("setting-enterSends", "change", function(this: any) { toggleSetting("enterSends", this.checked); });
  on("setting-holdToSend", "change", function(this: any) { toggleSetting("holdToSend", this.checked); });
  on("setting-ralphEnabled", "change", function(this: any) { toggleSetting("ralphEnabled", this.checked); });
  on("setting-debugPanel", "change", function(this: any) { toggleSetting("debugPanel", this.checked); toggleDebugPanel(); });
  on("setting-snapshotTtl", "input", function(this: any) {
    toggleSetting("snapshotTtl", +this.value);
    const val = $("snapshot-ttl-val");
    if (val) val.textContent = formatSnapshotTtl(this.value);
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

  // Mobile terminal mode buttons — setting takes effect on next session open
  document.querySelectorAll(".term-mobile-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = (btn as HTMLElement).dataset.mode;
      if (mode && mode !== wpSettings.mobileTerminal) {
        toggleSetting("mobileTerminal", mode);
        document.querySelectorAll(".term-mobile-btn").forEach(b => b.classList.toggle("active", (b as HTMLElement).dataset.mode === mode));
        // Don't apply classic-mobile class immediately — it takes effect
        // on next session open to avoid mid-session transport mismatch.
      }
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
  flushGridSnapshots,
  loadSnapshot,
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

// ── Classic mobile terminal (text polling) ──

function classicMobileWsUrl() {
  if (state.currentMachine) {
    const remote = new URL(state.currentMachine);
    const proto = remote.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + remote.host + "/ws/terminal?session=" + encodeURIComponent(state.currentSession);
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + location.host + "/ws/terminal?session=" + encodeURIComponent(state.currentSession);
}

const classicReconnector = createReconnector({
  shouldReconnect: () => state.mobileStreamingActive && useClassicMobile() && !!state.currentSession && state.currentView === "terminal",
  onReconnecting: () => setConnState("reconnecting"),
  onExhausted: () => setConnState("offline"),
});

function applyTerminalPane(pane) {
  const renderStart = performance.now();
  const term = document.getElementById("terminal");
  const changed = pane !== state.lastRawPane;
  state.lastRawPane = pane;
  if (changed) {
    if (state.enterRetryTimer) {
      clearTimeout(state.enterRetryTimer);
      state.enterRetryTimer = null;
    }
    if (state.searchActive && state.searchTerm) {
      // Search highlight: wrap matches in <mark> tags
      const escaped = state.searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "gi");
      term.innerHTML = esc(pane).replace(re, m => `<mark>${m}</mark>`);
    } else {
      term.textContent = pane;
    }
    wpMetrics.recordLatency(performance.now() - renderStart);
    if (state.termFollowMode) term.scrollTop = term.scrollHeight;
  }
  if (changed) {
    scheduleSnapshotSave(pane);
  }
}

function setFollowMode(on) {
  state.termFollowMode = on;
  const btn = document.getElementById("jump-to-live");
  if (btn) {
    if (on) btn.classList.remove("visible");
    else btn.classList.add("visible");
  }
}

function jumpToLive() {
  const term = document.getElementById("terminal");
  term.scrollTop = term.scrollHeight;
  setFollowMode(true);
  haptic([10]);
}

// Detect user scroll-up to pause follow mode (classic terminal)
(function() {
  const term = document.getElementById("terminal");
  if (!term) return;
  let programmaticScroll = false;
  const origDesc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(term, "scrollTop", {
    get() { return origDesc.get.call(this); },
    set(v) {
      programmaticScroll = true;
      origDesc.set.call(this, v);
      Promise.resolve().then(() => { programmaticScroll = false; });
    }
  });
  term.addEventListener("scroll", () => {
    if (programmaticScroll) return;
    const atBottom = term.scrollHeight - origDesc.get.call(term) - term.clientHeight < 40;
    if (atBottom) setFollowMode(true);
    else if (state.termFollowMode) setFollowMode(false);
  }, { passive: true });
})();

function connectClassicMobileWs() {
  if (!state.mobileStreamingActive || !useClassicMobile() || !state.currentSession || state.currentView !== "terminal") return;
  if (classicReconnector.isBlocked) return;
  if (state.mobileWs && state.mobileWs.readyState <= WebSocket.OPEN) return;
  const connectKey = terminalSessionKey();
  const ws = new WebSocket(classicMobileWsUrl());
  state.mobileWs = ws;

  ws.onopen = async () => {
    if (state.mobileWs !== ws) return;
    if (!state.mobileStreamingActive || !useClassicMobile() || connectKey !== terminalSessionKey()) {
      ws.close();
      return;
    }
    if (classicReconnector.connected()) wpMetrics.reconnectCount++;
    setConnState("live");
    await resizePaneClassic();
  };

  ws.onmessage = (ev) => {
    if (state.mobileWs !== ws) return;
    wpMetrics.wsMessagesReceived++;
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg?.type === "output" && typeof msg.data === "string") {
      setConnState("live");
      applyTerminalPane(msg.data);
    }
  };

  ws.onclose = (ev) => {
    if (state.mobileWs === ws) state.mobileWs = null;
    if (!state.mobileStreamingActive || !useClassicMobile() || connectKey !== terminalSessionKey()) return;
    if (ev.code === 4001 || (ev.code === 1000 && ev.reason === "session ended")) {
      setConnState("session-ended");
      return;
    }
    classicReconnector.schedule(connectClassicMobileWs);
  };

  ws.onerror = () => {};
}

async function resizePaneClassic() {
  if (!state.currentSession) return;
  const term = document.getElementById("terminal");
  const dims = getCharDimensions();
  if (!dims.w || !dims.h) return;
  const cols = Math.floor(term.clientWidth / dims.w);
  const rows = Math.floor(term.clientHeight / dims.h);
  if (cols > 0 && rows > 0) {
    try {
      await api("/resize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: state.currentSession, cols, rows }),
      }, state.currentMachine);
    } catch {}
  }
}

function startClassicPolling(resetBudget = true) {
  state.mobileStreamingActive = true;
  if (resetBudget) classicReconnector.reset();
  if (classicReconnector.isBlocked && !resetBudget) {
    setConnState("offline");
    return;
  }
  classicReconnector.cancel();
  if (!state.mobileWs || state.mobileWs.readyState === WebSocket.CLOSED) {
    setConnState("reconnecting");
  }
  connectClassicMobileWs();
}

function stopClassicPolling() {
  if (state.snapshotTimer) { clearTimeout(state.snapshotTimer); flushSnapshot(); }
  state.mobileStreamingActive = false;
  classicReconnector.reset();
  classicReconnector.cancel();
  if (state.enterRetryTimer) {
    clearTimeout(state.enterRetryTimer);
    state.enterRetryTimer = null;
  }
  if (state.mobileWs) {
    const ws = state.mobileWs;
    state.mobileWs = null;
    try { ws.close(1000, "viewer changed"); } catch {}
  }
  const statusEl = document.getElementById("conn-status");
  if (statusEl) {
    statusEl.style.display = "none";
    statusEl.style.background = "#cc3333";
  }
}

function initClassicMobile(cached) {
  document.body.classList.add("classic-mobile");
  const term = document.getElementById("terminal");
  if (cached) {
    term.textContent = cached;
    state.lastRawPane = cached;
  } else {
    term.textContent = "";
    state.lastRawPane = "";
  }
  state.termFollowMode = true;
  resizePaneClassic();
  startClassicPolling();
}

function destroyClassicMobile() {
  stopClassicPolling();
  document.body.classList.remove("classic-mobile");
  const term = document.getElementById("terminal");
  if (term) term.textContent = "";
}

// Classic mobile search bar handlers
(function() {
  const searchInput = document.getElementById("search-input");
  const searchBar = document.getElementById("search-bar");
  const searchCount = document.getElementById("search-count");
  if (!searchInput || !searchBar) return;

  searchInput.addEventListener("input", () => {
    state.searchTerm = searchInput.value;
    state.searchActive = !!state.searchTerm;
    if (state.lastRawPane) applyTerminalPane(state.lastRawPane);
    // Count matches
    if (state.searchTerm && searchCount) {
      const escaped = state.searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matches = (state.lastRawPane || "").match(new RegExp(escaped, "gi"));
      searchCount.textContent = matches ? matches.length + " found" : "0 found";
    } else if (searchCount) {
      searchCount.textContent = "";
    }
  });

  document.getElementById("search-close-btn")?.addEventListener("click", () => {
    searchBar.classList.remove("visible");
    state.searchActive = false;
    state.searchTerm = "";
    searchInput.value = "";
    if (searchCount) searchCount.textContent = "";
    if (state.lastRawPane) applyTerminalPane(state.lastRawPane);
  });
})();

// classic-mobile class is applied by initClassicMobile() on session open,
// not at boot — avoids mid-session transport mismatch if setting changes.

// Unregister any stale service workers (no longer used)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => {
    regs.forEach(r => r.unregister());
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
  // grid + view (used by onclick and e2e page.evaluate)
  toggleGrid, addToGrid, removeFromGrid, suspendGridMode,
  showView, state,
});
