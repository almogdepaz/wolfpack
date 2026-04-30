/**
 * BrokerBackend — SessionBackend implementation that delegates every PTY
 * operation to the Rust broker via `BrokerClient` RPC.
 *
 * Identity bridging:
 *   The SessionBackend interface uses string `name`s; the broker addresses
 *   sessions by UUID. This class maintains a `name → session_id` index that
 *   is rebuilt on every `list()` call (the authoritative source of truth)
 *   and updated on `createSession` / `killSession`.
 *
 * capturePane is derived from the `snapshot` RPC by concatenating the
 * `ch` field of each StyledCell — the broker emulator already produces
 * graphemes, so no ANSI stripping is needed.
 *
 * send/sendKey/writeToTerminal go through the binary `input_binary` plane
 * via `BrokerClient.writeInput`; control-plane and stdin remain strictly
 * separate as required by the broker protocol.
 *
 * `onSessionData` registers a refcounted broker `subscribe`: the first
 * subscriber issues a `subscribe` RPC, the last unsubscribe issues an
 * `unsubscribe` RPC. Reconnects re-issue every active subscribe via
 * `BrokerClient.handleConnect`. `getSessionPrefill` fetches a fresh
 * `snapshot` and renders it to ANSI bytes for direct WS prefill.
 */
import type { SessionBackend, PtyBackendMethods, SessionLifecycleEvent, SessionPrefill } from "./backend.js";
import type { BrokerClient, OutputSubscriber } from "../broker/client.js";
import type { ControlResponse, EventBody } from "../broker/codec.js";
import { SHELL, injectAgentContext } from "./shell.js";
import { CMD_REGEX } from "../validation.js";
import { createLogger, errMsg } from "../log.js";
import {
  renderSnapshotToAnsi,
  type SnapshotForRender,
} from "../broker/snapshot-render.js";

const log = createLogger("broker-backend");

const TRIAGE_CACHE_TTL_MS = 500;
/** Cap on scrollback lines requested per `snapshot` RPC. The broker rejects
 *  frames >16MB; long-running sessions with styled output (Claude TUI, etc.)
 *  serialize at ~30 bytes/cell × 120 cols, so 2000 lines ≈ 7MB worst case
 *  — well under the limit while still giving plenty of scrollback context. */
const SNAPSHOT_SCROLLBACK_LINES = 2000;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

/** Minimal subset of `BrokerClient` BrokerBackend depends on; eases test mocking. */
export interface BrokerClientApi {
  request(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<ControlResponse>;
  writeInput(sessionId: string, data: Uint8Array): void;
  /** Register a per-session output callback; returns an unsubscribe fn. */
  subscribeOutput(sessionId: string, cb: OutputSubscriber): () => void;
  /** Issue a `subscribe` RPC and remember the session for reconnect re-issue. */
  subscribe(
    sessionId: string,
    opts?: { sinceSeq?: bigint; timeoutMs?: number },
  ): Promise<ControlResponse>;
  /** Issue an `unsubscribe` RPC and drop the session from the active set. */
  unsubscribe(
    sessionId: string,
    opts?: { timeoutMs?: number },
  ): Promise<ControlResponse | null>;
}

/** Tmux-style key names → raw byte sequences (mirrors PtyBackend's KEY_MAP). */
const KEY_MAP: Record<string, string> = {
  Enter: "\r",
  Tab: "\t",
  Escape: "\x1b",
  BSpace: "\x7f",
  DC: "\x1b[3~",
  Up: "\x1b[A",
  Down: "\x1b[B",
  Right: "\x1b[C",
  Left: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PPage: "\x1b[5~",
  NPage: "\x1b[6~",
  BTab: "\x1b[Z",
  "C-a": "\x01", "C-b": "\x02", "C-c": "\x03", "C-d": "\x04",
  "C-e": "\x05", "C-f": "\x06", "C-g": "\x07", "C-h": "\x08",
  "C-k": "\x0b", "C-l": "\x0c", "C-n": "\x0e", "C-p": "\x10",
  "C-r": "\x12", "C-u": "\x15", "C-w": "\x17", "C-z": "\x1a",
};

interface BrokerSessionInfo {
  id: string;
  name: string;
  cwd: string;
  alive: boolean;
}

interface StyledCell {
  ch: string;
}

interface StyledLine {
  cells?: StyledCell[];
}

interface SnapshotPayload extends SnapshotForRender {
  visible_screen: StyledLine[];
  scrollback?: StyledLine[];
  /** Broker output-stream byte offset at capture time. Present on all broker snapshots. */
  seq?: number;
}

/** Per-session refcount for output subscribers. Last unref tears down the broker subscribe. */
interface SubscriberRef {
  count: number;
}

type LifecycleSubscriber = (event: SessionLifecycleEvent) => void;

class BrokerRpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`broker rpc error [${code}]: ${message}`);
    this.name = "BrokerRpcError";
    this.code = code;
  }
}

function unwrap(resp: ControlResponse): Record<string, unknown> {
  if (resp.status === "ok" && resp.payload) return resp.payload;
  const code = resp.error?.code ?? "internal_error";
  const msg = resp.error?.message ?? "broker request failed";
  throw new BrokerRpcError(code, msg);
}

function renderLine(line: StyledLine): string {
  if (!line.cells || line.cells.length === 0) return "";
  let out = "";
  for (const c of line.cells) out += c.ch ?? "";
  // Trim trailing pad-space columns so plain-text consumers don't see a
  // wall of right-padding for short lines. Char class contains both ASCII
  // space (U+0020) and NBSP (U+00A0) — the broker's VT emulator emits NBSP
  // for hard-spaced cells in some TUI redraws.
  return out.replace(/[  ]+$/, "");
}

function renderSnapshot(snap: SnapshotPayload): string {
  const lines: string[] = [];
  for (const l of snap.scrollback ?? []) lines.push(renderLine(l));
  for (const l of snap.visible_screen ?? []) lines.push(renderLine(l));
  return lines.join("\n");
}

const TEXT_ENCODER = new TextEncoder();

function toBytes(data: Buffer | string): Uint8Array {
  if (typeof data === "string") return TEXT_ENCODER.encode(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export class BrokerBackend implements SessionBackend, PtyBackendMethods {
  private readonly client: BrokerClientApi;
  private readonly nameToId = new Map<string, string>();
  private readonly idToInfo = new Map<string, BrokerSessionInfo>();
  private readonly triageCache = new Map<string, { content: string; ts: number }>();
  /** Refcount of active onSessionData subscribers, keyed by session UUID. */
  private readonly subscriberRefs = new Map<string, SubscriberRef>();
  /** Lifecycle subscribers keyed by session UUID. */
  private readonly lifecycleSubs = new Map<string, Set<LifecycleSubscriber>>();

  constructor(client: BrokerClientApi) {
    this.client = client;
  }

  // ── SessionBackend ──

  async list(): Promise<string[]> {
    const payload = unwrap(await this.client.request("list_sessions", {}));
    const sessions = (payload.sessions as BrokerSessionInfo[] | undefined) ?? [];
    const liveIds = new Set<string>();
    const liveNames = new Set<string>();
    for (const s of sessions) {
      if (!s.alive) continue;
      this.nameToId.set(s.name, s.id);
      this.idToInfo.set(s.id, { id: s.id, name: s.name, cwd: s.cwd, alive: s.alive });
      liveIds.add(s.id);
      liveNames.add(s.name);
    }
    for (const [name, id] of this.nameToId) {
      if (!liveIds.has(id) || !liveNames.has(name)) this.nameToId.delete(name);
    }
    for (const id of this.idToInfo.keys()) {
      if (!liveIds.has(id)) this.idToInfo.delete(id);
    }
    for (const name of this.triageCache.keys()) {
      if (!liveNames.has(name)) this.triageCache.delete(name);
    }
    return sessions.filter((s) => s.alive).map((s) => s.name);
  }

  async createSession(
    name: string,
    cwd: string,
    cmd: string | undefined,
    loadSettings: () => { agentCmd: string },
  ): Promise<void> {
    const agentCmd = cmd || loadSettings().agentCmd || "claude";
    if (agentCmd !== "shell" && !CMD_REGEX.test(agentCmd)) {
      throw new Error(`invalid command: ${agentCmd}`);
    }
    let shellCmd: string;
    if (agentCmd === "shell") {
      shellCmd = SHELL;
    } else {
      const fullCmd = injectAgentContext(agentCmd);
      shellCmd = `${fullCmd}; exec ${SHELL}`;
    }

    const env: Array<[string, string]> = [
      ["TERM", "xterm-256color"],
      ["LANG", "en_US.UTF-8"],
      ["WOLFPACK_PROJECT_DIR", cwd],
    ];

    let resp: ControlResponse;
    try {
      resp = await this.client.request("create_session", {
        name,
        cwd,
        command: [SHELL, "-lic", shellCmd],
        env,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      });
    } catch (e: unknown) {
      log.error("createSession: broker request failed", { name, error: errMsg(e) });
      throw e;
    }

    if (resp.status === "error" && resp.error?.code === "duplicate_session_name") {
      const err = new Error(`duplicate session: ${name}`);
      (err as { code?: string }).code = "DUPLICATE_SESSION";
      throw err;
    }
    const payload = unwrap(resp);
    const session = payload.session as BrokerSessionInfo;
    this.nameToId.set(session.name, session.id);
    this.idToInfo.set(session.id, {
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      alive: session.alive,
    });
    log.info("session created", { name: session.name, id: session.id, cwd, cmd: agentCmd });
  }

  async killSession(name: string): Promise<void> {
    const id = await this.resolveId(name);
    if (!id) return;
    try {
      // SIGHUP (1) — interactive bash ignores SIGTERM, but SIGHUP propagates to
      // the foreground process group via the controlling PTY and reliably tears
      // down nested shells (e.g. `bash -lic /bin/zsh`).
      const resp = await this.client.request("kill_session", { session_id: id, signal: 1 });
      if (resp.status === "error") {
        const code = resp.error?.code;
        if (code !== "unknown_session" && code !== "session_not_alive") {
          throw new BrokerRpcError(code ?? "internal_error", resp.error?.message ?? "kill failed");
        }
      }
    } catch (e: unknown) {
      log.debug("killSession: broker error (continuing local cleanup)", { name, error: errMsg(e) });
    }
    this.nameToId.delete(name);
    this.idToInfo.delete(id);
    this.triageCache.delete(name);
  }

  async hasSession(name: string): Promise<boolean> {
    const id = await this.resolveId(name);
    if (!id) return false;
    return this.idToInfo.get(id)?.alive ?? false;
  }

  async capturePane(name: string): Promise<string> {
    const id = await this.resolveId(name);
    if (!id) return "";
    const snap = await this.fetchSnapshot(id, name, "capturePane");
    if (!snap) return "";
    return renderSnapshot(snap);
  }

  async capturePaneForTriage(name: string): Promise<string> {
    const cached = this.triageCache.get(name);
    if (cached && Date.now() - cached.ts < TRIAGE_CACHE_TTL_MS) return cached.content;
    const content = await this.capturePane(name);
    this.triageCache.set(name, { content, ts: Date.now() });
    return content;
  }

  async resize(name: string, cols: number, rows: number): Promise<void> {
    const id = await this.resolveId(name);
    if (!id) return;
    try {
      unwrap(await this.client.request("resize", { session_id: id, cols, rows }));
    } catch (e: unknown) {
      log.debug("resize failed", { name, error: errMsg(e) });
    }
  }

  async send(name: string, text: string, noEnter?: boolean): Promise<void> {
    const id = await this.resolveId(name);
    if (!id) return;
    const payload = noEnter ? text : text + "\r";
    try {
      this.client.writeInput(id, TEXT_ENCODER.encode(payload));
    } catch (e: unknown) {
      log.debug("send failed", { name, error: errMsg(e) });
    }
  }

  async sendKey(name: string, key: string): Promise<void> {
    const id = await this.resolveId(name);
    if (!id) return;
    const seq = KEY_MAP[key] ?? (key.length === 1 ? key : null);
    if (seq === null) {
      log.warn("sendKey: unknown key", { name, key });
      return;
    }
    try {
      this.client.writeInput(id, TEXT_ENCODER.encode(seq));
    } catch (e: unknown) {
      log.debug("sendKey failed", { name, key, error: errMsg(e) });
    }
  }

  sessionDir(name: string): string | undefined {
    const id = this.nameToId.get(name);
    if (!id) return undefined;
    return this.idToInfo.get(id)?.cwd;
  }

  async cleanupOrphans(): Promise<void> {
    // The broker is the sole owner of its sessions; there is no Wolfpack-side
    // process to leak. Refresh the local index from broker truth so any
    // sessions killed out-of-band drop out of the cache.
    try {
      await this.list();
    } catch (e: unknown) {
      log.debug("cleanupOrphans: list failed", { error: errMsg(e) });
    }
  }

  // ── PtyBackendMethods ──

  /**
   * Register an output callback for a session. Refcounted per UUID: the first
   * subscriber issues a broker `subscribe` RPC, the last unsubscribe issues a
   * matching `unsubscribe`. Returns null if the session isn't in the local
   * cache — caller is expected to have run `list()`/`createSession` first.
   *
   * `sinceSeq` is forwarded to the broker `subscribe` RPC so bytes between
   * the snapshot and live-stream attach are replayed from the ring buffer,
   * closing the snapshot→subscribe gap.
   */
  onSessionData(
    name: string,
    cb: (data: Uint8Array) => void,
    opts?: { sinceSeq?: bigint },
  ): (() => void) | null {
    const id = this.nameToId.get(name);
    if (!id) return null;
    const unsubData = this.client.subscribeOutput(id, (frame) => cb(frame.data));
    let ref = this.subscriberRefs.get(id);
    if (!ref) {
      ref = { count: 0 };
      this.subscriberRefs.set(id, ref);
      // Fire-and-forget subscribe RPC. On failure, unwind the local subscriber
      // state so the refcount doesn't leak and the output sub is cleaned up.
      this.client.subscribe(id, { sinceSeq: opts?.sinceSeq }).catch((e: unknown) => {
        log.warn("subscribe rpc failed; unwinding", { name, id, error: errMsg(e) });
        try { unsubData(); } catch { /* ignore */ }
        const r = this.subscriberRefs.get(id);
        if (r) {
          r.count = Math.max(0, r.count - 1);
          if (r.count === 0) this.subscriberRefs.delete(id);
        }
      });
    }
    ref.count++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { unsubData(); } catch { /* swallow — sub teardown must not throw */ }
      const r = this.subscriberRefs.get(id);
      if (!r) return;
      r.count--;
      if (r.count <= 0) {
        this.subscriberRefs.delete(id);
        this.client.unsubscribe(id).catch((e: unknown) => {
          log.debug("unsubscribe rpc failed", { name, id, error: errMsg(e) });
        });
      }
    };
  }

  writeToTerminal(name: string, data: Buffer | string): void {
    const id = this.nameToId.get(name);
    if (!id) return;
    try {
      this.client.writeInput(id, toBytes(data));
    } catch (e: unknown) {
      log.debug("writeToTerminal failed", { name, error: errMsg(e) });
    }
  }

  /**
   * Fetch a fresh broker snapshot and render it to ANSI bytes for WS prefill.
   * Returns `{ data: empty, seq: undefined }` when the session is unknown or
   * the broker rejects the snapshot — callers treat empty data as "no prefill".
   * `seq` is the broker output-stream byte offset at snapshot capture time;
   * pass it to `onSessionData` so the broker replays any bytes emitted between
   * snapshot and subscribe attach.
   */
  async getSessionPrefill(name: string): Promise<SessionPrefill> {
    const id = await this.resolveId(name);
    if (!id) return { data: Buffer.alloc(0) };
    const snap = await this.fetchSnapshot(id, name, "getSessionPrefill");
    if (!snap) return { data: Buffer.alloc(0) };
    const seq = typeof snap.seq === "number" ? BigInt(snap.seq) : undefined;
    return { data: renderSnapshotToAnsi(snap), seq };
  }

  isSessionAlive(name: string): boolean {
    const id = this.nameToId.get(name);
    if (!id) return false;
    return this.idToInfo.get(id)?.alive ?? false;
  }

  /**
   * Register a lifecycle callback for a session. Currently only "exited" fires.
   * Returns null when the session is unknown to the local cache — caller must
   * have run `list()` / `createSession` first. Idempotent unsub.
   */
  onSessionLifecycle(name: string, cb: LifecycleSubscriber): (() => void) | null {
    const id = this.nameToId.get(name);
    if (!id) return null;
    let set = this.lifecycleSubs.get(id);
    if (!set) {
      set = new Set();
      this.lifecycleSubs.set(id, set);
    }
    set.add(cb);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const s = this.lifecycleSubs.get(id);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.lifecycleSubs.delete(id);
    };
  }

  /**
   * Apply a broker event to local state. Wired by `BackendRouter` via
   * `BrokerClient.onEvent`. Unknown event names are ignored — additive
   * protocol changes must not crash the client (per docs/broker-protocol.md).
   */
  ingestEvent(event: EventBody): void {
    switch (event.event) {
      case "session_exited": {
        const id = typeof event.session_id === "string" ? event.session_id : undefined;
        if (!id) return;
        const info = this.idToInfo.get(id);
        if (info) {
          info.alive = false;
          this.triageCache.delete(info.name);
        }
        const exitCode = typeof event.exit_code === "number" ? event.exit_code : undefined;
        const signal = typeof event.signal === "number" ? event.signal : undefined;
        const subs = this.lifecycleSubs.get(id);
        if (subs) {
          // Snapshot so a callback that detaches itself doesn't mutate the
          // iterator we're walking.
          for (const cb of Array.from(subs)) {
            try {
              cb({ kind: "exited", exitCode, signal });
            } catch (e: unknown) {
              log.debug("lifecycle callback threw", { id, error: errMsg(e) });
            }
          }
        }
        return;
      }
      case "session_resized": {
        // Cols/rows are not cached on BrokerSessionInfo today; nothing to
        // update locally. Kept as an explicit branch so future caching of
        // dims has a single hook.
        return;
      }
      case "snapshot_invalidated": {
        const id = typeof event.session_id === "string" ? event.session_id : undefined;
        if (!id) return;
        const info = this.idToInfo.get(id);
        if (info) this.triageCache.delete(info.name);
        return;
      }
    }
  }

  // ── Internals ──

  /**
   * Issue a `snapshot` RPC capped at SNAPSHOT_SCROLLBACK_LINES. Returns
   * `undefined` on transport error or non-ok response — callers treat that
   * as "no snapshot available" and fall back to empty content.
   */
  private async fetchSnapshot(
    id: string,
    name: string,
    callsite: string,
  ): Promise<SnapshotPayload | undefined> {
    let resp: ControlResponse;
    try {
      resp = await this.client.request("snapshot", {
        session_id: id,
        scrollback_lines: SNAPSHOT_SCROLLBACK_LINES,
      });
    } catch (e: unknown) {
      log.debug(`${callsite}: snapshot failed`, { name, error: errMsg(e) });
      return undefined;
    }
    if (resp.status !== "ok" || !resp.payload) return undefined;
    return resp.payload.snapshot as SnapshotPayload | undefined;
  }

  private async resolveId(name: string): Promise<string | undefined> {
    const cached = this.nameToId.get(name);
    if (cached) return cached;
    try {
      await this.list();
    } catch (e: unknown) {
      log.debug("resolveId: list refresh failed", { name, error: errMsg(e) });
    }
    return this.nameToId.get(name);
  }
}

/** Construct a BrokerBackend bound to a real BrokerClient. */
export function createBrokerBackend(client: BrokerClient): BrokerBackend {
  return new BrokerBackend(client);
}
