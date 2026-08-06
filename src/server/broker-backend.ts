/**
 * BrokerBackend - SessionBackend implementation that delegates every PTY
 * operation to the Rust broker via `BrokerClient` RPC.
 *
 * Identity bridging:
 *   The SessionBackend interface uses string `name`s; the broker addresses
 *   sessions by UUID. This class maintains a `name → session_id` index that
 *   is rebuilt on every `list()` call (the authoritative source of truth)
 *   and updated on `createSession` / `killSession`.
 *
 * capturePane is derived from the `snapshot` RPC by concatenating the
 * `ch` field of each StyledCell - the broker emulator already produces
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
import { DuplicateSessionError, UnsupportedTerminalKeyError } from "./backend.js";
import type {
  CapturePaneOptions,
  PtyBackendMethods,
  SessionBackend,
  SessionLaunchOptions,
  SessionLifecycleEvent,
  SessionListFact,
  SessionPrefill,
  SessionPrefillOptions,
  SessionPromptBackendMethods,
} from "./backend.js";
import {
  SESSION_PROMPT_OUTCOME,
  SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS,
  SESSION_PROMPT_PENDING_OUTPUT_MAX_BYTES,
  unicodeCodePointLength,
  unicodeCodePointSuffix,
} from "../session-prompt-contract.js";
import type {
  SessionPromptWaitOptions,
  SessionPromptWaitResult,
} from "../session-prompt-contract.js";
import {
  BrokerSubscribeError,
} from "../broker/client.js";
import type { BrokerClient, OutputSubscriber } from "../broker/client.js";
import type { ControlResponse, EventBody, OutputBinaryFrame } from "../broker/codec.js";
import type { SessionInspectionResult } from "../session-status-contract.js";
import {
  AGENT_KIND,
  detectAgentKindFromCommandArgs,
} from "../agent-kind.js";
import { SHELL } from "./shell.js";
import { CMD_REGEX } from "../validation.js";
import { createLogger, errMsg } from "../log.js";
import { brokerOutputSequence } from "../broker-output-sequence.js";
import {
  plainLine,
  renderSnapshotToAnsi,
  type SnapshotForRender,
} from "../broker/snapshot-render.js";
import {
  extractExternalAgentFromEnv,
  extractParentSessionFromEnv,
  getSessionIdentityStore,
  identityEnvVars,
  inferAgentKind,
  toPublicSessionIdentity,
} from "./session-identity.js";
import type {
  AgentKind,
  CaptureSessionIdentityInput,
  ParentSessionIdentity,
  PublicSessionIdentity,
} from "./session-identity.js";
import { resolveSessionSelector } from "./session-selector.js";

const log = createLogger("broker-backend");

/** Cap on scrollback lines requested per `snapshot` RPC. Heavy TUI sessions
 *  (Claude, etc.) empirically blew past 16MB on 2000 lines - JSON-encoded
 *  cells with full attrs run much larger than the rough 30B/cell estimate.
 *  500 lines keeps frames comfortably small while still giving useful context;
 *  the codec cap was also bumped to 64MB for defense-in-depth. */
const SNAPSHOT_SCROLLBACK_LINES = 500;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

/** Minimal subset of `BrokerClient` BrokerBackend depends on; eases test mocking. */
export interface BrokerClientApi {
  request(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<ControlResponse>;
  snapshotSubscribe(
    sessionId: string,
    params?: { scrollbackLines?: number; targetCols?: number; timeoutMs?: number },
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
  ): Promise<void>;
  outputSequence(sessionId: string): bigint | undefined;
  isSubscribed(sessionId: string): boolean;
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
  /** Decimal u64 emitted by protocol-v2 brokers that support activity facts. */
  output_seq?: string;
  command?: string[];
  env?: Array<[string, string]>;
}

interface StyledCell {
  ch: string;
}

interface StyledLine {
  cells?: StyledCell[];
  wrapped?: boolean;
}

interface SnapshotPayload extends SnapshotForRender {
  visible_screen: StyledLine[];
  scrollback?: StyledLine[];
  /** Final broker PTY-chunk seq covered at capture time. Present on all broker snapshots. */
  seq?: number;
}

interface SubscriberRegistration {
  readonly unsubscribeData: () => void;
  readonly onSubscribeError: (error: unknown) => void;
}

type SubscriptionReady =
  | { readonly ok: true; readonly outputBoundarySeq: bigint | undefined }
  | { readonly ok: false; readonly error: unknown };

interface SubscriberRef {
  readonly subscribers: Set<SubscriberRegistration>;
  readonly ready: Promise<SubscriptionReady>;
}

interface SubscriberHandle {
  readonly ready: Promise<SubscriptionReady>;
  readonly outputBoundarySeq: bigint | undefined;
  readonly unsubscribe: () => void;
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

function renderSnapshot(snap: SnapshotPayload): string {
  const lines: string[] = [];
  for (const l of snap.scrollback ?? []) lines.push(plainLine(l));
  for (const l of snap.visible_screen ?? []) lines.push(plainLine(l));
  return lines.join("\n");
}

const TEXT_ENCODER = new TextEncoder();

function toBytes(data: Buffer | string): Uint8Array {
  if (typeof data === "string") return TEXT_ENCODER.encode(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function envValue(env: Array<[string, string]> | undefined, key: string): string | undefined {
  return env?.find(([k]) => k === key)?.[1];
}

function commandAgent(command: string[] | undefined): string | undefined {
  return detectAgentKindFromCommandArgs(command);
}

export class BrokerBackend implements SessionBackend, PtyBackendMethods, SessionPromptBackendMethods {
  private readonly client: BrokerClientApi;
  private readonly nameToId = new Map<string, string>();
  private readonly idToInfo = new Map<string, BrokerSessionInfo>();
  /** Refcount of active onSessionData subscribers, keyed by session UUID. */
  private readonly subscriberRefs = new Map<string, SubscriberRef>();
  /** Lifecycle subscribers keyed by session UUID. */
  private readonly lifecycleSubs = new Map<string, Set<LifecycleSubscriber>>();

  constructor(client: BrokerClientApi) {
    this.client = client;
  }

  // ── SessionBackend ──

  private async brokerSessions(): Promise<BrokerSessionInfo[]> {
    const payload = unwrap(await this.client.request("list_sessions", {}));
    return (payload.sessions as BrokerSessionInfo[] | undefined) ?? [];
  }

  async list(): Promise<string[]> {
    return (await this.listSessionFacts()).filter((fact) => fact.alive).map((fact) => fact.name);
  }

  async listSessionFacts(): Promise<SessionListFact[]> {
    const sessions = await this.brokerSessions();
    const identitySessions: Array<{
      wolfpackSessionId: string;
      wolfpackSessionName: string;
      projectPath: string;
      agentKind?: AgentKind | string;
      externalAgent?: CaptureSessionIdentityInput["externalAgent"];
      parentSession?: ParentSessionIdentity;
    }> = sessions.map((s) => ({
      wolfpackSessionId: s.id,
      wolfpackSessionName: s.name,
      projectPath: s.cwd,
      agentKind: inferAgentKind(envValue(s.env, "WOLFPACK_AGENT_KIND") || commandAgent(s.command)),
      parentSession: extractParentSessionFromEnv(s.env),
      externalAgent: extractExternalAgentFromEnv(s.env, "broker_env"),
    }));
    const identitiesById = new Map(
      getSessionIdentityStore().restore(identitySessions).map((identity) => [identity.wolfpackSessionId, toPublicSessionIdentity(identity)]),
    );
    const liveIds = new Set<string>();
    const liveNames = new Set<string>();
    const facts: SessionListFact[] = [];
    for (const s of sessions) {
      const identity = identitiesById.get(s.id);
      const outputSequence = brokerOutputSequence(s.output_seq);
      facts.push({
        name: s.name,
        alive: s.alive,
        ...(outputSequence !== undefined && { outputSequence }),
        ...(identity && { identity }),
      });
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
    return facts;
  }

  async listIdentities(): Promise<Record<string, PublicSessionIdentity>> {
    const byName: Record<string, PublicSessionIdentity> = {};
    for (const identity of getSessionIdentityStore().list()) {
      byName[identity.wolfpackSessionName] = toPublicSessionIdentity(identity);
    }
    return byName;
  }

  async inspectSession(selector: string): Promise<SessionInspectionResult> {
    const sessions = await this.brokerSessions();
    const observedAt = new Date(0).toISOString();
    const identities: Record<string, PublicSessionIdentity> = {};
    for (const session of sessions) {
      const parentSession = extractParentSessionFromEnv(session.env);
      identities[session.name] = {
        wolfpackSessionId: session.id,
        wolfpackSessionName: session.name,
        projectPath: session.cwd,
        agentKind: inferAgentKind(
          envValue(session.env, "WOLFPACK_AGENT_KIND") || commandAgent(session.command),
        ),
        createdAt: observedAt,
        updatedAt: observedAt,
        ...(parentSession && { parentSession }),
      };
    }
    const resolved = resolveSessionSelector(selector, sessions.map(session => session.name), identities);
    if (!resolved.ok) return resolved;
    const session = sessions.find(candidate => candidate.id === resolved.identity.wolfpackSessionId);
    if (!session) return { ok: false, code: "NOT_FOUND" };
    return {
      ok: true,
      session: session.name,
      sessionId: session.id,
      projectPath: session.cwd,
      harness: resolved.identity.agentKind,
      alive: session.alive,
      ...(resolved.identity.parentSession && {
        parentSession: {
          session: resolved.identity.parentSession.wolfpackSessionName,
          sessionId: resolved.identity.parentSession.wolfpackSessionId,
        },
      }),
    };
  }

  async createSession(
    name: string,
    cwd: string,
    cmd: string | undefined,
    loadSettings: () => { agentCmd: string },
    options?: SessionLaunchOptions,
  ): Promise<PublicSessionIdentity> {
    const agentCmd = cmd || loadSettings().agentCmd || AGENT_KIND.CLAUDE;
    if (agentCmd !== AGENT_KIND.SHELL && !CMD_REGEX.test(agentCmd)) {
      throw new Error(`invalid command: ${agentCmd}`);
    }
    let shellCmd: string;
    if (agentCmd === AGENT_KIND.SHELL) {
      if (options?.initialPrompt !== undefined) {
        throw new Error("initial prompt requires an agent harness");
      }
      shellCmd = SHELL;
    } else {
      const promptArg = options?.initialPrompt !== undefined ? " \"$1\"" : "";
      shellCmd = `{ setopt nonotify nomonitor 2>/dev/null; set +m 2>/dev/null; } ; clear; ${agentCmd}${promptArg}; exec ${SHELL}`;
    }

    const agentKind = options?.agentKind ?? inferAgentKind(agentCmd);
    const env: Array<[string, string]> = [
      ["TERM", "xterm-256color"],
      ["COLORTERM", "truecolor"],
      ["LANG", "en_US.UTF-8"],
      ...identityEnvVars({
        wolfpackSessionName: name,
        projectPath: cwd,
        agentKind,
        parentSession: options?.parentSession,
      }),
    ];

    let resp: ControlResponse;
    try {
      resp = await this.client.request("create_session", {
        name,
        cwd,
        command: [
          SHELL,
          "-lic",
          shellCmd,
          ...(options?.initialPrompt !== undefined
            ? ["wolfpack-agent", options.initialPrompt]
            : []),
        ],
        env,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      });
    } catch (e: unknown) {
      log.error("createSession: broker request failed", { name, error: errMsg(e) });
      throw e;
    }

    if (resp.status === "error" && resp.error?.code === "duplicate_session_name") {
      throw new DuplicateSessionError(name);
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
    const identity = getSessionIdentityStore().capture({
      wolfpackSessionId: session.id,
      wolfpackSessionName: session.name,
      projectPath: cwd,
      agentKind,
      parentSession: options?.parentSession,
      externalAgent: options?.externalAgent,
    });
    log.info("session created", { name: session.name, id: session.id, cwd, cmd: agentCmd });
    return toPublicSessionIdentity(identity);
  }

  async killSession(name: string): Promise<void> {
    const id = await this.resolveId(name);
    if (!id) return;
    // SIGHUP (1) - interactive bash ignores SIGTERM, but SIGHUP propagates to
    // the foreground process group via the controlling PTY and reliably tears
    // down nested shells (e.g. `bash -lic /bin/zsh`).
    const resp = await this.client.request("kill_session", { session_id: id, signal: 1 });
    if (resp.status === "error") {
      const code = resp.error?.code;
      if (code !== "unknown_session" && code !== "session_not_alive") {
        throw new BrokerRpcError(code ?? "internal_error", resp.error?.message ?? "kill failed");
      }
    }
    this.nameToId.delete(name);
    this.idToInfo.delete(id);
    getSessionIdentityStore().deleteByName(name);
  }

  async hasSession(name: string): Promise<boolean> {
    const id = await this.resolveId(name);
    if (!id) return false;
    return this.idToInfo.get(id)?.alive ?? false;
  }

  async capturePane(name: string, options?: CapturePaneOptions): Promise<string> {
    const id = await this.resolveId(name);
    if (!id) return "";
    const snap = await this.fetchSnapshot(id, name, "capturePane", undefined, options?.scrollbackLines);
    return renderSnapshot(snap);
  }

  async resize(name: string, cols: number, rows: number): Promise<void> {
    const id = await this.resolveId(name);
    if (!id) return;
    unwrap(await this.client.request("resize", { session_id: id, cols, rows }));
  }

  async send(name: string, text: string, noEnter?: boolean): Promise<void> {
    const id = await this.resolveId(name);
    if (!id) return;
    const payload = noEnter ? text : text + "\r";
    this.client.writeInput(id, TEXT_ENCODER.encode(payload));
  }

  async promptAndWaitForOutput(
    sessionId: string,
    options: SessionPromptWaitOptions,
  ): Promise<SessionPromptWaitResult> {
    const info = this.idToInfo.get(sessionId);
    const targetUnavailableOutcome = (): SessionPromptWaitResult["outcome"] => {
      const expectedName = options.sessionName ?? info?.name;
      const currentIdForName = expectedName ? this.nameToId.get(expectedName) : undefined;
      if (currentIdForName !== undefined && currentIdForName !== sessionId) {
        return SESSION_PROMPT_OUTCOME.TARGET_REPLACED;
      }
      return SESSION_PROMPT_OUTCOME.TARGET_UNAVAILABLE;
    };
    if (!info?.alive) {
      return {
        outcome: targetUnavailableOutcome(),
        outputBoundarySeq: null,
      };
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let bufferCodePoints = 0;
    let inputSent = false;
    let settled = false;
    let boundaryEstablished = false;
    let effectiveBoundarySeq: bigint | undefined;
    let outputBoundarySeq: string | null = null;
    const pendingOutput: OutputBinaryFrame[] = [];
    let pendingOutputBytes = 0;
    let resolveTerminal!: (result: SessionPromptWaitResult) => void;
    const terminal = new Promise<SessionPromptWaitResult>((resolve) => {
      resolveTerminal = resolve;
    });
    const finish = (outcome: SessionPromptWaitResult["outcome"]): void => {
      if (settled) return;
      settled = true;
      resolveTerminal({ outcome, outputBoundarySeq });
    };
    const appendOutput = (frame: OutputBinaryFrame): void => {
      if (effectiveBoundarySeq !== undefined && frame.seq <= effectiveBoundarySeq) return;
      const decoded = decoder.decode(frame.data, { stream: true });
      buffer += decoded;
      bufferCodePoints += unicodeCodePointLength(decoded);
      if (inputSent && buffer.includes(options.outputContains)) {
        finish(SESSION_PROMPT_OUTCOME.MATCHED);
      }
      if (bufferCodePoints > SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS) {
        buffer = unicodeCodePointSuffix(buffer, SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS);
        bufferCodePoints = SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS;
      }
    };
    const queuePendingOutput = (frame: OutputBinaryFrame): void => {
      if (frame.data.length === 0) return;
      pendingOutput.push(frame);
      pendingOutputBytes += frame.data.length;
      let overflow = pendingOutputBytes - SESSION_PROMPT_PENDING_OUTPUT_MAX_BYTES;
      while (overflow > 0) {
        const first = pendingOutput[0];
        if (!first) break;
        if (first.data.length <= overflow) {
          pendingOutput.shift();
          pendingOutputBytes -= first.data.length;
          overflow -= first.data.length;
          continue;
        }
        pendingOutput[0] = {
          ...first,
          data: first.data.slice(overflow),
        };
        pendingOutputBytes -= overflow;
        overflow = 0;
      }
    };
    const timer = setTimeout(
      () => finish(SESSION_PROMPT_OUTCOME.TIMED_OUT),
      options.timeoutMs,
    );
    const lifecycleUnsubscribe = this.onSessionLifecycleById(sessionId, (event) => {
      finish(event.kind === "exited"
        ? SESSION_PROMPT_OUTCOME.TARGET_EXITED
        : SESSION_PROMPT_OUTCOME.REPLAY_GAP);
    });
    const subscriber = this.registerOutputSubscriber(
      sessionId,
      info.name,
      (frame) => {
        if (boundaryEstablished) appendOutput(frame);
        else queuePendingOutput(frame);
      },
      (error) => {
        if (error instanceof BrokerSubscribeError) {
          if (error.code === "session_not_alive") {
            finish(SESSION_PROMPT_OUTCOME.TARGET_EXITED);
            return;
          }
          if (error.code === "unknown_session") {
            finish(targetUnavailableOutcome());
            return;
          }
        }
        finish(SESSION_PROMPT_OUTCOME.BACKEND_UNAVAILABLE);
      },
    );

    try {
      const readiness = await Promise.race([
        subscriber.ready.then((value) => ({ kind: "ready" as const, value })),
        terminal.then((result) => ({ kind: "terminal" as const, result })),
      ]);
      if (readiness.kind === "terminal") return readiness.result;
      if (!readiness.value.ok) return await terminal;

      for (const candidate of [
        subscriber.outputBoundarySeq,
        readiness.value.outputBoundarySeq,
      ]) {
        if (
          candidate !== undefined
          && (effectiveBoundarySeq === undefined || candidate > effectiveBoundarySeq)
        ) {
          effectiveBoundarySeq = candidate;
        }
      }
      outputBoundarySeq = effectiveBoundarySeq?.toString() ?? null;
      boundaryEstablished = true;
      for (const pending of pendingOutput) appendOutput(pending);
      pendingOutput.length = 0;
      if (settled) return await terminal;
      try {
        const input = options.noEnter ? options.prompt : `${options.prompt}\r`;
        this.client.writeInput(sessionId, TEXT_ENCODER.encode(input));
      } catch {
        finish(SESSION_PROMPT_OUTCOME.BACKEND_UNAVAILABLE);
        return await terminal;
      }
      inputSent = true;
      if (buffer.includes(options.outputContains)) {
        finish(SESSION_PROMPT_OUTCOME.MATCHED);
      }
      return await terminal;
    } finally {
      clearTimeout(timer);
      subscriber.unsubscribe();
      lifecycleUnsubscribe?.();
    }
  }

  async sendKey(name: string, key: string): Promise<void> {
    const id = await this.resolveId(name);
    if (!id) return;
    const seq = KEY_MAP[key] ?? (key.length === 1 ? key : null);
    if (seq === null) throw new UnsupportedTerminalKeyError(key);
    this.client.writeInput(id, TEXT_ENCODER.encode(seq));
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
   * cache - caller is expected to have run `list()`/`createSession` first.
   *
   * `sinceSeq` is forwarded to the broker `subscribe` RPC so bytes between
   * the snapshot and live-stream attach are replayed from the ring buffer,
   * closing the snapshot→subscribe gap.
   */
  onSessionData(
    name: string,
    cb: (data: Uint8Array) => void,
    opts: {
      sinceSeq?: bigint;
      onSubscribeError: (err: unknown) => void;
    },
  ): (() => void) | null {
    const id = this.nameToId.get(name);
    if (!id) return null;
    return this.registerOutputSubscriber(
      id,
      name,
      (frame) => cb(frame.data),
      opts.onSubscribeError,
      opts.sinceSeq,
    ).unsubscribe;
  }

  writeToTerminal(name: string, data: Buffer | string): boolean {
    const id = this.nameToId.get(name);
    if (!id) return false;
    try {
      this.client.writeInput(id, toBytes(data));
      return true;
    } catch (e: unknown) {
      log.warn("writeToTerminal failed", { name, error: errMsg(e) });
      return false;
    }
  }

  /**
   * Fetch a fresh broker snapshot and render it to ANSI bytes for WS prefill.
   * A legitimate empty terminal returns empty data with its snapshot sequence.
   * Snapshot transport/RPC failures reject so attach can reconnect rather than
   * falsely presenting a blank terminal as ready.
   * `seq` is the final broker PTY-chunk watermark covered by the snapshot;
   * pass it to `onSessionData` so the broker replays chunks emitted between
   * snapshot and subscribe attach.
   */
  async getSessionPrefill(name: string, cols?: number, options?: SessionPrefillOptions): Promise<SessionPrefill> {
    const id = await this.resolveId(name);
    if (!id) throw new BrokerRpcError("unknown_session", `session ${name} is unavailable`);
    const snap = await this.fetchSnapshotAndSubscribe(id, name, cols, options?.scrollbackLines);
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
   * Returns null when the session is unknown to the local cache - caller must
   * have run `list()` / `createSession` first. Idempotent unsub.
   */
  onSessionLifecycle(name: string, cb: LifecycleSubscriber): (() => void) | null {
    const id = this.nameToId.get(name);
    if (!id) return null;
    return this.onSessionLifecycleById(id, cb);
  }

  private onSessionLifecycleById(id: string, cb: LifecycleSubscriber): () => void {
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
   * `BrokerClient.onEvent`. Unknown event names are ignored - additive
   * protocol changes must not crash the client (per docs/broker-protocol.md).
   */
  ingestEvent(event: EventBody): void {
    switch (event.event) {
      case "session_exited": {
        const id = typeof event.session_id === "string" ? event.session_id : undefined;
        if (!id) return;
        const info = this.idToInfo.get(id);
        if (info) info.alive = false;
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
      case "snapshot_invalidated":
        return;
    }
  }

  /**
   * Fan out a `replay_truncated` lifecycle event to subscribers of the
   * given session id. Wired by `BackendRouter` via
   * `BrokerClient.onReplayTruncated`. The WS layer translates this into a
   * 1011 close so the client reconnects with a fresh snapshot, closing
   * the stale-prefill window.
   */
  handleReplayTruncated(id: string): void {
    const subs = this.lifecycleSubs.get(id);
    if (!subs) return;
    for (const cb of Array.from(subs)) {
      try {
        cb({ kind: "replay_truncated" });
      } catch (e: unknown) {
        log.debug("lifecycle replay_truncated callback threw", { id, error: errMsg(e) });
      }
    }
  }

  handleResubscribeError(id: string, error: Error): void {
    const name = this.idToInfo.get(id)?.name ?? id;
    this.failOutputSubscribers(id, name, error);
  }

  // ── Internals ──

  private registerOutputSubscriber(
    id: string,
    name: string,
    cb: OutputSubscriber,
    onSubscribeError: (error: unknown) => void,
    sinceSeq?: bigint,
  ): SubscriberHandle {
    const registration: SubscriberRegistration = {
      unsubscribeData: this.client.subscribeOutput(id, cb),
      onSubscribeError,
    };
    let ref = this.subscriberRefs.get(id);
    const outputBoundarySeq = ref ? this.client.outputSequence(id) : undefined;
    if (!ref) {
      if (this.client.isSubscribed(id)) {
        ref = {
          subscribers: new Set(),
          ready: Promise.resolve({ ok: true, outputBoundarySeq: this.client.outputSequence(id) }),
        };
        this.subscriberRefs.set(id, ref);
      } else {
        let resolveReady!: (result: SubscriptionReady) => void;
        const ready = new Promise<SubscriptionReady>((resolve) => {
          resolveReady = resolve;
        });
        ref = { subscribers: new Set(), ready };
        this.subscriberRefs.set(id, ref);
        const pendingRef = ref;
        this.client.subscribe(id, { sinceSeq }).then(
          (response) => {
            const currentSeq = (response.payload as Record<string, unknown> | undefined)?.current_seq;
            resolveReady({
              ok: true,
              outputBoundarySeq: typeof currentSeq === "number"
                && Number.isSafeInteger(currentSeq)
                && currentSeq >= 0
                ? BigInt(currentSeq)
                : this.client.outputSequence(id),
            });
          },
          (error: unknown) => {
            this.failOutputSubscribers(id, name, error, pendingRef);
            resolveReady({ ok: false, error });
          },
        );
      }
    }
    ref.subscribers.add(registration);

    let released = false;
    return {
      ready: ref.ready,
      outputBoundarySeq,
      unsubscribe: () => {
        if (released) return;
        released = true;
        try { registration.unsubscribeData(); } catch { /* teardown must not throw */ }
        if (this.subscriberRefs.get(id) !== ref) return;
        ref.subscribers.delete(registration);
        if (ref.subscribers.size === 0) {
          this.subscriberRefs.delete(id);
          this.client.unsubscribe(id).catch((error: unknown) => {
            log.debug("unsubscribe rpc failed", { name, id, error: errMsg(error) });
          });
        }
      },
    };
  }

  private failOutputSubscribers(
    id: string,
    name: string,
    error: unknown,
    expectedRef?: SubscriberRef,
  ): void {
    const ref = this.subscriberRefs.get(id);
    if (!ref || (expectedRef && ref !== expectedRef)) return;
    this.subscriberRefs.delete(id);
    log.warn("subscribe rpc failed; unwinding", { name, id, error: errMsg(error) });
    for (const subscriber of ref.subscribers) {
      try { subscriber.unsubscribeData(); } catch { /* ignore */ }
      try { subscriber.onSubscribeError(error); } catch (callbackError: unknown) {
        log.debug("onSubscribeError callback threw", {
          name,
          id,
          error: errMsg(callbackError),
        });
      }
    }
    ref.subscribers.clear();
  }

  private async fetchSnapshotAndSubscribe(
    id: string,
    name: string,
    targetCols?: number,
    scrollbackLines: number = SNAPSHOT_SCROLLBACK_LINES,
  ): Promise<SnapshotPayload> {
    let response: ControlResponse;
    try {
      response = await this.client.snapshotSubscribe(id, { scrollbackLines, targetCols });
    } catch (error: unknown) {
      log.warn("getSessionPrefill: atomic snapshot subscribe failed", { name, error: errMsg(error) });
      throw error;
    }
    const payload = unwrap(response);
    const snapshot = payload.snapshot;
    if (!snapshot || typeof snapshot !== "object") {
      throw new BrokerRpcError("invalid_snapshot", "broker returned no atomic snapshot payload");
    }
    return snapshot as SnapshotPayload;
  }

  /** Issue a bounded `snapshot` RPC or reject with the typed broker failure. */
  private async fetchSnapshot(
    id: string,
    name: string,
    callsite: string,
    targetCols?: number,
    scrollbackLines: number = SNAPSHOT_SCROLLBACK_LINES,
  ): Promise<SnapshotPayload> {
    let resp: ControlResponse;
    const params: Record<string, unknown> = {
      session_id: id,
      scrollback_lines: scrollbackLines,
    };
    if (targetCols !== undefined && targetCols > 0) {
      params.target_cols = targetCols;
    }
    try {
      resp = await this.client.request("snapshot", params);
    } catch (error: unknown) {
      log.warn(`${callsite}: snapshot transport failed`, { name, error: errMsg(error) });
      throw error;
    }
    const payload = unwrap(resp);
    const snapshot = payload.snapshot;
    if (!snapshot || typeof snapshot !== "object") {
      throw new BrokerRpcError("invalid_snapshot", "broker returned no snapshot payload");
    }
    return snapshot as SnapshotPayload;
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
