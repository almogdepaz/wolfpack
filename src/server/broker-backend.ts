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
import { DuplicateSessionError, UnsupportedTerminalKeyError } from "./backend-contract.js";
import type {
  CapturePaneOptions,
  PtyBackendMethods,
  SessionAttachLease,
  SessionBackend,
  SessionDataUnsubscribe,
  SessionLaunchOptions,
  SessionLifecycleEvent,
  SessionListFact,
  SessionPrefill,
  SessionPrefillOptions,
  SessionPromptBackendMethods,
  SessionSnapshotCapture,
} from "./backend-contract.js";
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
import type {
  BrokerClient,
  BrokerSnapshotSubscription,
  OutputSubscriber,
} from "../broker/client.js";
import type { ControlResponse, EventBody, OutputBinaryFrame } from "../broker/codec.js";
import type { SessionInspectionResult } from "../session-status-contract.js";
import { SESSION_EXIT_REASON, WOLFPACK_EVENT_KIND } from "../events-contract.js";
import { publishEvent } from "./event-bus.js";
import { notifyProgramStatusChanged } from "./program-status-signal.js";
import {
  AGENT_KIND,
  detectAgentKindFromCommandArgs,
  resolveAgentCommand,
} from "../agent-kind.js";
import { SHELL } from "./shell.js";
import { TASK_WORKER_DEFAULT_EXTENSION_POLICY } from "../task-worker-policy-contract.js";
import { CMD_REGEX } from "../validation.js";
import { createLogger, errMsg } from "../log.js";
import { brokerOutputSequence } from "../broker-output-sequence.js";
import { PROGRAM_STATUS_STATE, parseBrokerProgramStatusRecord } from "../program-status-contract.js";
import type { ProgramStatusRecord } from "../program-status-contract.js";
import {
  SESSION_SEND_DELIVERY,
  SESSION_SEND_FAILURE_REASON,
  SESSION_SEND_OUTCOME,
} from "../session-send-contract.js";
import type {
  SessionSendDelivery,
  SessionSendFailureReason,
  SessionSendObservationOptions,
  SessionSendObservationResult,
  SessionSendOutcome,
} from "../session-send-contract.js";
import {
  plainLine,
  renderSnapshotToAnsi,
  renderSnapshotToPlainText,
  trimRenderedPrefill,
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
/**
 * How long a broker disconnect may last before attached viewers are told.
 * Shorter drops stay invisible: the client resubscribes on reconnect.
 */
export const BROKER_UNAVAILABLE_GRACE_MS = 3_000;

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
  ): Promise<BrokerSnapshotSubscription>;
  snapshotSubscribeAnsi(
    sessionId: string,
    params: { scrollbackLines?: number; targetCols?: number; maxBytes: number; timeoutMs?: number },
  ): Promise<BrokerSnapshotSubscription>;
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
  /** Cancel a failed subscription and force remote teardown when connected. */
  cancelSubscription(
    sessionId: string,
    opts?: { timeoutMs?: number },
  ): Promise<void>;
  outputSequence(sessionId: string): bigint | undefined;
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
  /** Root OSC 7501 record; omitted by brokers without program status support. */
  program_status?: unknown;
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
  session_id?: string;
  visible_screen: StyledLine[];
  scrollback?: StyledLine[];
  cols?: number;
  rows?: number;
  captured_at_ms?: number;
  /** Final broker PTY-chunk seq covered at capture time. Present on all broker snapshots. */
  seq?: number;
}

type SnapshotCut =
  | {
      readonly kind: "atomic";
      readonly snapshot: SnapshotPayload;
      readonly outputBoundarySeq: bigint | undefined;
      readonly cancel: () => Promise<void>;
    }
  | {
      readonly kind: "legacy";
      readonly snapshot: SnapshotPayload;
    };

/** A snapshot cut whose prefill bytes are already rendered and budgeted. */
type AttachCut =
  | {
      readonly kind: "atomic";
      readonly prefill: SessionPrefill;
      readonly outputBoundarySeq: bigint | undefined;
      readonly cancel: () => Promise<void>;
    }
  | {
      readonly kind: "legacy";
      readonly prefill: SessionPrefill;
    };

type SubscriptionStart =
  | { readonly kind: "subscribe"; readonly sinceSeq: bigint | undefined }
  | {
      readonly kind: "adopt";
      readonly snapshotSeq: bigint | undefined;
      readonly outputBoundarySeq: bigint | undefined;
    };

interface SubscriberRegistration {
  unsubscribeData: (() => void) | undefined;
  readonly cb: OutputSubscriber;
  readonly onSubscribeError: (error: unknown) => void;
  readonly sinceSeq: bigint | undefined;
  lastDeliveredSeq: bigint | undefined;
  readonly ready: Promise<SubscriptionReady>;
  readonly resolveReady: (result: SubscriptionReady) => void;
}

type SubscriptionReady =
  | { readonly ok: true; readonly outputBoundarySeq: bigint | undefined }
  | { readonly ok: false; readonly error: unknown };

interface SubscriberRef {
  readonly subscribers: Set<SubscriberRegistration>;
  /** The first physical subscribe result, used by non-replay registrations. */
  readonly initialReady: Promise<SubscriptionReady>;
  /** Serializes broker replays so BrokerClient cannot coalesce distinct floors. */
  replayQueue: Promise<void>;
}

interface SubscriberHandle {
  readonly ready: Promise<SubscriptionReady>;
  readonly outputBoundarySeq: bigint | undefined;
  readonly unsubscribe: SessionDataUnsubscribe;
}

type LifecycleSubscriber = (event: SessionLifecycleEvent) => void;

type ProgramStatusSubscriber = (record: ProgramStatusRecord | undefined) => void;

/** How one observed send attempt stopped. */
type SendAttemptStop =
  | { readonly kind: "observed" }
  | { readonly kind: "not_delivered"; readonly reason: SessionSendFailureReason };

/** Each status read inside a send's observation window gets at most this much of it. */
const SESSION_SEND_STATUS_READ_MAX_MS = 200;

/**
 * Root program status around one write, ordered by the broker's stamp rather
 * than by arrival: pacing can deliver a pre-write transition after the write,
 * and a status read can return a snapshot older than an event already pushed.
 * The broker shares this host's wall clock; a stamp equal to the write time is
 * ambiguous and counts as before it.
 */
class SendStatusTimeline {
  /** Latest record stamped at or before the write; undefined when none or unread. */
  baseline: ProgramStatusRecord | undefined;
  /** Records stamped after the write, in stamp order; undefined is a cleared record. */
  readonly after: Array<ProgramStatusRecord | undefined> = [];
  /** Two records share a stamp but not a state, so their order is unknown. */
  ambiguous = false;
  /** Newest record admitted; anything stamped before it is a stale snapshot. */
  private newest: ProgramStatusRecord | undefined;

  admit(record: ProgramStatusRecord | undefined, writtenAtMs: number | undefined): void {
    if (record !== undefined && this.newest !== undefined && record.updatedAtMs <= this.newest.updatedAtMs) {
      // Placing a stale record by its stamp could only invent an edge; drop it.
      if (record.updatedAtMs === this.newest.updatedAtMs && record.state !== this.newest.state) this.ambiguous = true;
      return;
    }
    if (record !== undefined) this.newest = record;
    if (writtenAtMs === undefined) {
      this.baseline = record;
      return;
    }
    // A cleared record carries no stamp, so it only breaks the idle edge.
    if (record === undefined) {
      this.after.push(undefined);
      return;
    }
    if (record.updatedAtMs <= writtenAtMs) {
      // Its order against a cleared record is unknown; ignore rather than guess.
      if (this.after.length === 0) this.baseline = record;
      return;
    }
    this.after.push(record);
  }

  /** A record the broker stamped after the write arrived, so the status changed since. */
  changed(): boolean {
    return this.after.some((record) => record !== undefined);
  }

  /** An observed `idle` directly followed by a non-idle record stamped after the write. */
  submitted(): boolean {
    if (this.ambiguous) return false;
    let previous = this.baseline;
    for (const record of this.after) {
      if (previous?.state === PROGRAM_STATUS_STATE.IDLE && record !== undefined && record.state !== PROGRAM_STATUS_STATE.IDLE) {
        return true;
      }
      previous = record;
    }
    return false;
  }
}

interface SendAttemptEvidence {
  readonly noEnter: boolean;
  readonly status: SendStatusTimeline;
  /** No final status read completed inside the window, so the last state is unknown. */
  readonly statusUnknown: boolean;
  readonly outputSeen: boolean;
  /** An earlier attempt of the same send already proved delivery. */
  readonly priorDelivered: boolean;
}

function classifySendAttempt(
  evidence: SendAttemptEvidence,
): { readonly delivery: SessionSendDelivery; readonly outcome: SessionSendOutcome } {
  const { status } = evidence;
  const delivered = evidence.outputSeen || evidence.priorDelivered || status.changed();
  const unverified = { delivery: SESSION_SEND_DELIVERY.UNVERIFIED, outcome: SESSION_SEND_OUTCOME.UNVERIFIED } as const;
  if (evidence.noEnter) {
    return delivered
      ? { delivery: SESSION_SEND_DELIVERY.DELIVERED, outcome: SESSION_SEND_OUTCOME.DELIVERED }
      : unverified;
  }
  if (status.submitted()) {
    return { delivery: SESSION_SEND_DELIVERY.DELIVERED, outcome: SESSION_SEND_OUTCOME.SUBMITTED };
  }
  if (!delivered) return unverified;
  // Only an untouched idle record proves the program sat on the text:
  // pacing can fold idle->working->idle into one idle with a new timestamp.
  const pasted = !evidence.statusUnknown
    && !status.ambiguous
    && status.baseline?.state === PROGRAM_STATUS_STATE.IDLE
    && status.after.length === 0;
  return {
    delivery: SESSION_SEND_DELIVERY.DELIVERED,
    outcome: pasted ? SESSION_SEND_OUTCOME.PASTED_NOT_SUBMITTED : SESSION_SEND_OUTCOME.UNVERIFIED,
  };
}

function notDeliveredSend(reason: SessionSendFailureReason): SessionSendObservationResult {
  return {
    delivery: SESSION_SEND_DELIVERY.NOT_DELIVERED,
    outcome: SESSION_SEND_OUTCOME.NOT_DELIVERED,
    reason,
    observedMs: 0,
  };
}

/** Live state of one `writeObservedInput` call, handed to its callbacks. */
interface InputObservation<T> {
  inputSent: boolean;
  /** Wall clock taken just before the write; set with `inputSent`. */
  inputSentAtMs: number | undefined;
  /** Settle the observation; only the first call counts. */
  finish(result: T): void;
}

interface ObservedInputSpec<T> {
  readonly sessionName: string;
  readonly input: string;
  /** Bounds the whole call, subscribe included. */
  readonly timeoutMs: number;
  readonly onTimeout: () => T;
  readonly onLifecycle: (event: SessionLifecycleEvent) => T;
  readonly onSubscribeError: (error: unknown) => T;
  readonly onWriteError: () => T;
  /** Output after the boundary; `observation.inputSent` separates pre-write frames. */
  readonly onOutput: (frame: OutputBinaryFrame, observation: InputObservation<T>) => void;
  readonly onInputSent?: (observation: InputObservation<T>) => void;
  /** Runs synchronously before subscribing, for callers with other evidence sources. */
  readonly bind?: (observation: InputObservation<T>) => void;
}

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

/** `snapshot_subscribe_ansi` errors that fall back to the JSON atomic cut. */
const ANSI_FALLBACK_CODES: ReadonlySet<string> = new Set(["unknown_method", "prefill_too_large"]);

function nonNegativeSafeSeq(value: unknown): bigint | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
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

interface PendingSessionExit {
  readonly name: string | undefined;
  readonly exitCode: number | undefined;
  readonly signal: number | undefined;
}

interface KillRequestState {
  name: string | undefined;
  inFlight: number;
  succeeded: boolean;
  exit?: PendingSessionExit;
}

export class BrokerBackend implements SessionBackend, PtyBackendMethods, SessionPromptBackendMethods {
  private readonly client: BrokerClientApi;
  private readonly nameToId = new Map<string, string>();
  private readonly idToInfo = new Map<string, BrokerSessionInfo>();
  /** Refcount of active onSessionData subscribers, keyed by session UUID. */
  private readonly subscriberRefs = new Map<string, SubscriberRef>();
  /** Lifecycle subscribers keyed by session UUID. */
  private readonly lifecycleSubs = new Map<string, Set<LifecycleSubscriber>>();
  private readonly programStatusSubs = new Map<string, Set<ProgramStatusSubscriber>>();
  /**
   * Kill requests per session UUID. `killSessionById` drops the name cache
   * before the broker's `session_exited` arrives, and that event can also
   * overtake the RPC reply, so the exit's reason is decided only once no kill
   * is in flight: `killed` if any request succeeded, otherwise `exit`.
   */
  private readonly killRequests = new Map<string, KillRequestState>();
  private brokerUnavailableTimer: ReturnType<typeof setTimeout> | null = null;

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
      const programStatus = parseBrokerProgramStatusRecord(s.program_status);
      facts.push({
        name: s.name,
        alive: s.alive,
        ...(outputSequence !== undefined && { outputSequence }),
        ...(identity && { identity }),
        ...(programStatus && { programStatus }),
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
    const agentCmd = cmd || loadSettings().agentCmd || AGENT_KIND.CLAUDE.id;
    if (agentCmd !== AGENT_KIND.SHELL.id && !CMD_REGEX.test(agentCmd)) {
      throw new Error(`invalid command: ${agentCmd}`);
    }
    const taskWorker = options?.taskWorker;
    const launchCmd = resolveAgentCommand(agentCmd);
    let shellCmd: string;
    let commandArgs: string[] = [];
    if (options?.model !== undefined && agentCmd !== AGENT_KIND.PI.id) {
      throw new Error("model selection requires the pi harness");
    }
    if (taskWorker !== undefined && (agentCmd !== AGENT_KIND.PI.id || options?.initialPrompt !== undefined)) {
      throw new Error("task worker requires the Pi harness without an initial prompt");
    }
    if (agentCmd === AGENT_KIND.SHELL.id) {
      if (options?.initialPrompt !== undefined) {
        throw new Error("initial prompt requires an agent harness");
      }
      shellCmd = SHELL;
    } else if (taskWorker !== undefined) {
      // Test and compatibility callers can provide the pre-policy launch shape;
      // route-owned launches always provide the resolved fields.
      const workerExtensions = taskWorker.extensions ?? [taskWorker.extension];
      const workerPiOptions = taskWorker.piOptions ?? {};
      const workerPiArgs = [
        ...((taskWorker.extensionPolicy ?? TASK_WORKER_DEFAULT_EXTENSION_POLICY) === "inherit" ? [] : ["--no-extensions"]),
        ...workerExtensions.flatMap((extension) => ["--extension", extension]),
        ...(options?.model !== undefined ? ["--model", options.model] : []),
        ...(workerPiOptions.thinking !== undefined ? ["--thinking", workerPiOptions.thinking] : []),
        ...(workerPiOptions.offline ? ["--offline"] : []),
        ...(workerPiOptions.verbose ? ["--verbose"] : []),
      ];
      shellCmd = `{ setopt nonotify nomonitor 2>/dev/null; set +m 2>/dev/null; } ; clear; exec "$@"`;
      commandArgs = [taskWorker.executable, ...workerPiArgs];
    } else {
      const modelArg = options?.model !== undefined ? ' --model "$1"' : "";
      const promptArg = options?.initialPrompt !== undefined
        ? ` "$${options.model !== undefined ? 2 : 1}"`
        : "";
      shellCmd = `{ setopt nonotify nomonitor 2>/dev/null; set +m 2>/dev/null; } ; clear; ${launchCmd}${modelArg}${promptArg}; exec ${SHELL}`;
      commandArgs = [
        ...(options?.model !== undefined ? [options.model] : []),
        ...(options?.initialPrompt !== undefined ? [options.initialPrompt] : []),
      ];
    }

    const agentKind = options?.agentKind ?? inferAgentKind(agentCmd);
    const taskWorkerEnv: Array<[string, string]> = [];
    if (taskWorker !== undefined) {
      taskWorkerEnv.push(["PI_TASK_WORKER", "1"]);
      const port = process.env.WOLFPACK_PORT;
      if (port) taskWorkerEnv.push(["WOLFPACK_PORT", port]);
      const home = process.env.HOME;
      if (home) taskWorkerEnv.push(["HOME", home]);
      taskWorkerEnv.push(...Object.entries(taskWorker.env ?? {}));
    }
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
      ...taskWorkerEnv,
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
          ...(commandArgs.length > 0 ? ["wolfpack-agent", ...commandArgs] : []),
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
    await this.killSessionById(id);
  }

  async killSessionById(id: string): Promise<void> {
    // SIGHUP (1) - interactive bash ignores SIGTERM, but SIGHUP propagates to
    // the foreground process group via the controlling PTY and reliably tears
    // down nested shells (e.g. `bash -lic /bin/zsh`).
    const kill = this.killRequests.get(id) ?? { name: undefined, inFlight: 0, succeeded: false };
    kill.name ??= this.idToInfo.get(id)?.name;
    kill.inFlight++;
    this.killRequests.set(id, kill);
    let resp: ControlResponse;
    try {
      resp = await this.client.request("kill_session", { session_id: id, signal: 1 });
      if (resp.status === "ok") kill.succeeded = true;
    } finally {
      kill.inFlight--;
      this.settleKillRequest(id, kill);
    }
    if (resp.status === "error") {
      const code = resp.error?.code;
      if (code !== "unknown_session" && code !== "session_not_alive") {
        throw new BrokerRpcError(code ?? "internal_error", resp.error?.message ?? "kill failed");
      }
    }
    const name = this.idToInfo.get(id)?.name;
    if (name !== undefined && this.nameToId.get(name) === id) this.nameToId.delete(name);
    this.idToInfo.delete(id);
    getSessionIdentityStore().deleteById(id);
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

  async captureSessionSnapshotById(sessionId: string): Promise<SessionSnapshotCapture> {
    const session = await this.exactSessionInfo(sessionId);
    if (!session.alive) throw new BrokerRpcError("session_not_alive", `session is not alive: ${sessionId}`);
    let snapshot: SnapshotPayload;
    try {
      snapshot = await this.fetchSnapshot(sessionId, session.name, "captureSessionSnapshotById", undefined, 0);
    } catch (error: unknown) {
      if (error instanceof BrokerRpcError && (error.code === "unknown_session" || error.code === "session_not_alive")) {
        throw new BrokerRpcError("session_not_alive", `session ended during capture: ${sessionId}`);
      }
      throw error;
    }
    if (
      snapshot.session_id !== sessionId
      || typeof snapshot.captured_at_ms !== "number"
      || typeof snapshot.cols !== "number"
      || typeof snapshot.rows !== "number"
      || !Number.isInteger(snapshot.captured_at_ms)
      || !Number.isInteger(snapshot.cols)
      || !Number.isInteger(snapshot.rows)
      || snapshot.cols < 1
      || snapshot.rows < 1
    ) {
      throw new BrokerRpcError("invalid_snapshot", "broker returned an invalid exact-ID snapshot");
    }
    return {
      session: session.name,
      sessionId,
      text: renderSnapshotToPlainText(snapshot),
      capturedAtMs: snapshot.captured_at_ms,
      cols: snapshot.cols,
      rows: snapshot.rows,
    };
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

  /**
   * Write `text` to a pinned session and judge, from output and the program's
   * OSC 7501 root status, whether it was delivered and submitted.
   */
  async sendAndObserveSubmission(
    sessionId: string,
    options: SessionSendObservationOptions,
  ): Promise<SessionSendObservationResult> {
    const info = this.idToInfo.get(sessionId);
    if (!info?.alive) {
      return notDeliveredSend(this.targetUnavailableOutcome(sessionId, options.sessionName ?? info?.name));
    }
    const first = await this.observeSendAttempt(sessionId, info.name, {
      input: options.noEnter ? options.text : `${options.text}\r`,
      noEnter: options.noEnter,
      observeMs: options.observeMs,
      priorDelivered: false,
      sessionName: options.sessionName,
    });
    if (
      options.noEnter
      || !options.ensureSubmitted
      || first.outcome !== SESSION_SEND_OUTCOME.PASTED_NOT_SUBMITTED
    ) {
      return first;
    }
    const retry = await this.observeSendAttempt(sessionId, info.name, {
      input: "\r",
      noEnter: false,
      observeMs: options.observeMs,
      priorDelivered: true,
      sessionName: options.sessionName,
    });
    // A retry that could not be written sent nothing: the first verdict stands.
    if (retry.delivery === SESSION_SEND_DELIVERY.NOT_DELIVERED) return first;
    return {
      delivery: retry.delivery,
      outcome: retry.outcome,
      observedMs: first.observedMs + retry.observedMs,
      retried: true,
    };
  }

  private async observeSendAttempt(
    sessionId: string,
    name: string,
    attempt: {
      readonly input: string;
      readonly noEnter: boolean;
      readonly observeMs: number;
      readonly priorDelivered: boolean;
      readonly sessionName: string | undefined;
    },
  ): Promise<SessionSendObservationResult> {
    // One deadline covers the baseline read, subscribe, write and final read;
    // nothing after it is evidence.
    const deadlineMs = Date.now() + attempt.observeMs;
    const statusReadMs = Math.min(SESSION_SEND_STATUS_READ_MAX_MS, Math.floor(attempt.observeMs / 4));
    const status = new SendStatusTimeline();
    let outputSeen = false;
    let observation: InputObservation<SendAttemptStop> | undefined;
    const observed: SendAttemptStop = { kind: "observed" };
    const notDelivered = (reason: SessionSendFailureReason): SendAttemptStop => ({ kind: "not_delivered", reason });
    const stopUnlessWritten = (reason: SessionSendFailureReason): SendAttemptStop =>
      observation?.inputSent ? observed : notDelivered(reason);
    const decided = (): boolean => (attempt.noEnter ? outputSeen || status.changed() : status.submitted());
    // Listen before reading the baseline so no pushed change falls between them.
    const unsubscribeStatus = this.onProgramStatusById(sessionId, (record) => {
      if (Date.now() > deadlineMs) return;
      status.admit(record, observation?.inputSentAtMs);
      if (observation?.inputSent && decided()) observation.finish(observed);
    });
    try {
      const initial = await this.rootProgramStatusWithin(sessionId, Date.now() + statusReadMs, "baseline");
      if (initial) status.admit(initial.record, undefined);
      const targetUnavailableOutcome = () => this.targetUnavailableOutcome(sessionId, attempt.sessionName ?? name);
      const { result: stop } = await this.writeObservedInput<SendAttemptStop>(sessionId, {
        sessionName: name,
        input: attempt.input,
        timeoutMs: Math.max(0, deadlineMs - statusReadMs - Date.now()),
        bind: (bound) => { observation = bound; },
        onTimeout: () => stopUnlessWritten(SESSION_SEND_FAILURE_REASON.BACKEND_UNAVAILABLE),
        onLifecycle: (event) => stopUnlessWritten(event.kind === "exited"
          ? SESSION_SEND_FAILURE_REASON.TARGET_EXITED
          : SESSION_SEND_FAILURE_REASON.REPLAY_GAP),
        onSubscribeError: (error) => stopUnlessWritten(this.subscribeErrorOutcome(error, targetUnavailableOutcome)),
        onWriteError: () => notDelivered(SESSION_SEND_FAILURE_REASON.BACKEND_UNAVAILABLE),
        onOutput: (frame, current) => {
          if (!current.inputSent || frame.data.length === 0 || Date.now() > deadlineMs) return;
          outputSeen = true;
          if (attempt.noEnter) current.finish(observed);
        },
      });
      if (stop.kind === "not_delivered") return notDeliveredSend(stop.reason);
      const writtenAtMs = observation?.inputSentAtMs;
      let statusUnknown = false;
      if (!decided()) {
        // Pushed changes are paced, so read the final state once, inside the window.
        const final = await this.rootProgramStatusWithin(sessionId, deadlineMs, "final");
        if (final) status.admit(final.record, writtenAtMs);
        else statusUnknown = true;
      }
      return {
        ...classifySendAttempt({
          noEnter: attempt.noEnter,
          status,
          statusUnknown,
          outputSeen,
          priorDelivered: attempt.priorDelivered,
        }),
        observedMs: writtenAtMs === undefined ? 0 : Math.min(Date.now(), deadlineMs) - writtenAtMs,
      };
    } finally {
      unsubscribeStatus();
    }
  }

  /** Reads the root status record, or undefined when the read fails or is not handled by `untilMs`. */
  private async rootProgramStatusWithin(
    sessionId: string,
    untilMs: number,
    phase: "baseline" | "final",
  ): Promise<{ readonly record: ProgramStatusRecord | undefined } | undefined> {
    const timeoutMs = untilMs - Date.now();
    if (timeoutMs <= 0) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); });
    try {
      const read = await Promise.race([
        this.exactSessionInfo(sessionId, timeoutMs)
          .then((session) => ({ record: parseBrokerProgramStatusRecord(session.program_status) })),
        expired,
      ]);
      // A busy turn can run the response before an expired timer, so check the clock and stamp too.
      if (read && (Date.now() > untilMs || (read.record?.updatedAtMs ?? 0) > untilMs)) {
        log.debug(`send ${phase} status read was late`, { sessionId });
        return undefined;
      }
      return read;
    } catch (error: unknown) {
      log.debug(`send ${phase} status read failed`, { sessionId, error: errMsg(error) });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private onProgramStatusById(id: string, cb: ProgramStatusSubscriber): () => void {
    let set = this.programStatusSubs.get(id);
    if (!set) {
      set = new Set();
      this.programStatusSubs.set(id, set);
    }
    set.add(cb);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const s = this.programStatusSubs.get(id);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.programStatusSubs.delete(id);
    };
  }

  private publishProgramStatus(id: string, record: ProgramStatusRecord | undefined): void {
    const subs = this.programStatusSubs.get(id);
    if (!subs) return;
    for (const cb of [...subs]) cb(record);
  }

  async promptAndWaitForOutput(
    sessionId: string,
    options: SessionPromptWaitOptions,
  ): Promise<SessionPromptWaitResult> {
    const info = this.idToInfo.get(sessionId);
    const targetUnavailableOutcome = (): SessionPromptWaitResult["outcome"] =>
      this.targetUnavailableOutcome(sessionId, options.sessionName ?? info?.name);
    if (!info?.alive) {
      return {
        outcome: targetUnavailableOutcome(),
        outputBoundarySeq: null,
      };
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let bufferCodePoints = 0;
    const { result, outputBoundarySeq } = await this.writeObservedInput<SessionPromptWaitResult["outcome"]>(sessionId, {
      sessionName: info.name,
      input: options.noEnter ? options.prompt : `${options.prompt}\r`,
      timeoutMs: options.timeoutMs,
      onTimeout: () => SESSION_PROMPT_OUTCOME.TIMED_OUT,
      onLifecycle: (event) => event.kind === "exited"
        ? SESSION_PROMPT_OUTCOME.TARGET_EXITED
        : SESSION_PROMPT_OUTCOME.REPLAY_GAP,
      onSubscribeError: (error) => this.subscribeErrorOutcome(error, targetUnavailableOutcome),
      onWriteError: () => SESSION_PROMPT_OUTCOME.BACKEND_UNAVAILABLE,
      onOutput: (frame, observation) => {
        const decoded = decoder.decode(frame.data, { stream: true });
        buffer += decoded;
        bufferCodePoints += unicodeCodePointLength(decoded);
        if (observation.inputSent && buffer.includes(options.outputContains)) {
          observation.finish(SESSION_PROMPT_OUTCOME.MATCHED);
        }
        if (bufferCodePoints > SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS) {
          buffer = unicodeCodePointSuffix(buffer, SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS);
          bufferCodePoints = SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS;
        }
      },
      onInputSent: (observation) => {
        if (buffer.includes(options.outputContains)) {
          observation.finish(SESSION_PROMPT_OUTCOME.MATCHED);
        }
      },
    });
    return { outcome: result, outputBoundarySeq };
  }

  private targetUnavailableOutcome(
    sessionId: string,
    expectedName: string | undefined,
  ): typeof SESSION_PROMPT_OUTCOME.TARGET_REPLACED | typeof SESSION_PROMPT_OUTCOME.TARGET_UNAVAILABLE {
    const currentIdForName = expectedName ? this.nameToId.get(expectedName) : undefined;
    if (currentIdForName !== undefined && currentIdForName !== sessionId) {
      return SESSION_PROMPT_OUTCOME.TARGET_REPLACED;
    }
    return SESSION_PROMPT_OUTCOME.TARGET_UNAVAILABLE;
  }

  private subscribeErrorOutcome<T extends SessionPromptWaitResult["outcome"]>(
    error: unknown,
    targetUnavailableOutcome: () => T,
  ): T | typeof SESSION_PROMPT_OUTCOME.TARGET_EXITED | typeof SESSION_PROMPT_OUTCOME.BACKEND_UNAVAILABLE {
    if (error instanceof BrokerSubscribeError) {
      if (error.code === "session_not_alive") return SESSION_PROMPT_OUTCOME.TARGET_EXITED;
      if (error.code === "unknown_session") return targetUnavailableOutcome();
    }
    return SESSION_PROMPT_OUTCOME.BACKEND_UNAVAILABLE;
  }

  /**
   * Subscribe to a pinned session's output, establish the output boundary,
   * write `input`, then let the caller decide when the observation ends.
   * Frames at or before the boundary are dropped; frames that arrive before
   * the boundary is known are queued (bounded) and replayed once it is.
   */
  private async writeObservedInput<T>(
    sessionId: string,
    spec: ObservedInputSpec<T>,
  ): Promise<{ readonly result: T; readonly outputBoundarySeq: string | null }> {
    let settled = false;
    let boundaryEstablished = false;
    let effectiveBoundarySeq: bigint | undefined;
    let outputBoundarySeq: string | null = null;
    const pendingOutput: OutputBinaryFrame[] = [];
    let pendingOutputBytes = 0;
    let resolveTerminal!: (result: T) => void;
    const terminal = new Promise<T>((resolve) => {
      resolveTerminal = resolve;
    });
    const observation: InputObservation<T> = {
      inputSent: false,
      inputSentAtMs: undefined,
      finish: (result) => {
        if (settled) return;
        settled = true;
        resolveTerminal(result);
      },
    };
    const settle = async (): Promise<{ readonly result: T; readonly outputBoundarySeq: string | null }> => ({
      result: await terminal,
      outputBoundarySeq,
    });
    const appendOutput = (frame: OutputBinaryFrame): void => {
      if (effectiveBoundarySeq !== undefined && frame.seq <= effectiveBoundarySeq) return;
      spec.onOutput(frame, observation);
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
    spec.bind?.(observation);
    const timer = setTimeout(
      () => observation.finish(spec.onTimeout()),
      spec.timeoutMs,
    );
    const lifecycleUnsubscribe = this.onSessionLifecycleById(sessionId, (event) => {
      observation.finish(spec.onLifecycle(event));
    });
    const subscriber = this.registerOutputSubscriber(
      sessionId,
      spec.sessionName,
      (frame) => {
        if (boundaryEstablished) appendOutput(frame);
        else queuePendingOutput(frame);
      },
      (error) => observation.finish(spec.onSubscribeError(error)),
    );

    try {
      const readiness = await Promise.race([
        subscriber.ready.then((value) => ({ kind: "ready" as const, value })),
        terminal.then((result) => ({ kind: "terminal" as const, result })),
      ]);
      if (readiness.kind === "terminal") return { result: readiness.result, outputBoundarySeq };
      if (!readiness.value.ok) return await settle();

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
      if (settled) return await settle();
      // Output can arrive while the write is still on the stack; it already
      // follows the input.
      observation.inputSent = true;
      observation.inputSentAtMs = Date.now();
      try {
        this.client.writeInput(sessionId, TEXT_ENCODER.encode(spec.input));
      } catch {
        observation.inputSent = false;
        observation.inputSentAtMs = undefined;
        observation.finish(spec.onWriteError());
        return await settle();
      }
      spec.onInputSent?.(observation);
      return await settle();
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
  ): SessionDataUnsubscribe | null {
    const id = this.nameToId.get(name);
    if (!id) return null;
    const subscriber = this.registerOutputSubscriber(
      id,
      name,
      (frame) => cb(frame.data),
      opts.onSubscribeError,
      { kind: "subscribe", sinceSeq: opts.sinceSeq },
    );
    const unsubscribe = subscriber.unsubscribe as SessionDataUnsubscribe;
    unsubscribe.ready = subscriber.ready.then((result) => result.ok);
    return unsubscribe;
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

  /** Fetch a side-effect-free snapshot for non-streaming callers. */
  async getSessionPrefill(name: string, cols?: number, options?: SessionPrefillOptions): Promise<SessionPrefill> {
    const id = await this.resolveId(name);
    if (!id) throw new BrokerRpcError("unknown_session", `session not found: ${name}`);
    const snapshot = await this.fetchSnapshot(
      id,
      name,
      "getSessionPrefill",
      cols,
      options?.scrollbackLines,
    );
    const seq = typeof snapshot.seq === "number" ? BigInt(snapshot.seq) : undefined;
    const data = renderSnapshotToAnsi(snapshot);
    return { data: options?.maxBytes === undefined ? data : trimRenderedPrefill(data, options.maxBytes), seq };
  }

  async beginSessionAttach(
    name: string,
    cols?: number,
    options?: SessionPrefillOptions,
  ): Promise<SessionAttachLease> {
    const id = await this.resolveId(name);
    if (!id) throw new BrokerRpcError("unknown_session", `session not found: ${name}`);
    const cut = await this.fetchAttachCut(id, name, cols, options);
    const { prefill } = cut;
    const seq = prefill.seq;
    let state: "pending" | "active" | "cancelled" = "pending";

    return {
      prefill,
      activate: (cb, opts) => {
        if (state !== "pending") return null;
        state = "active";
        const subscriber = this.registerOutputSubscriber(
          id,
          name,
          frame => cb(frame.data),
          opts.onSubscribeError,
          cut.kind === "atomic"
            ? {
                kind: "adopt",
                snapshotSeq: seq,
                outputBoundarySeq: cut.outputBoundarySeq,
              }
            : { kind: "subscribe", sinceSeq: seq },
        );
        const unsubscribe = subscriber.unsubscribe as SessionDataUnsubscribe;
        unsubscribe.ready = subscriber.ready.then(result => result.ok);
        return unsubscribe;
      },
      cancel: async () => {
        if (state !== "pending") return;
        state = "cancelled";
        if (cut.kind === "atomic") await cut.cancel();
      },
    };
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
      case "session_started": {
        // Read the broker payload directly: this event can arrive before
        // createSession has populated the local caches.
        const session = event.session;
        if (typeof session !== "object" || session === null) return;
        const { id, name, cwd } = session as Record<string, unknown>;
        if (typeof id !== "string" || typeof name !== "string" || typeof cwd !== "string") return;
        publishEvent({ kind: WOLFPACK_EVENT_KIND.SESSION_CREATED, sessionId: id, session: name, cwd });
        return;
      }
      case "session_exited": {
        const id = typeof event.session_id === "string" ? event.session_id : undefined;
        if (!id) return;
        const info = this.idToInfo.get(id);
        if (info) info.alive = false;
        const exitCode = typeof event.exit_code === "number" ? event.exit_code : undefined;
        const signal = typeof event.signal === "number" ? event.signal : undefined;
        this.publishSessionExited(id, info?.name, exitCode, signal);
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
      case "program_status_changed":
        // Refresh runtime state now; the root record also rides on
        // list_sessions, so the observer's poll remains the fallback.
        if (typeof event.session_id === "string") {
          this.publishProgramStatus(event.session_id, parseBrokerProgramStatusRecord(event.program_status));
          notifyProgramStatusChanged(event.session_id);
        }
        return;
    }
  }

  private publishSessionExited(id: string, cachedName: string | undefined, exitCode: number | undefined, signal: number | undefined): void {
    const exit: PendingSessionExit = { name: cachedName, exitCode, signal };
    const kill = this.killRequests.get(id);
    if (kill && kill.inFlight > 0) {
      // A kill reply is still outstanding; its outcome decides the reason.
      kill.exit = exit;
      return;
    }
    this.killRequests.delete(id);
    this.emitSessionExited(id, exit, kill?.succeeded ?? false, kill?.name);
  }

  private settleKillRequest(id: string, kill: KillRequestState): void {
    if (kill.inFlight > 0 || this.killRequests.get(id) !== kill) return;
    if (kill.exit) {
      this.killRequests.delete(id);
      this.emitSessionExited(id, kill.exit, kill.succeeded, kill.name);
    } else if (!kill.succeeded) {
      // Nothing was killed; a later exit is natural.
      this.killRequests.delete(id);
    }
  }

  private emitSessionExited(id: string, exit: PendingSessionExit, killed: boolean, killName: string | undefined): void {
    const name = exit.name ?? killName;
    publishEvent({
      kind: WOLFPACK_EVENT_KIND.SESSION_EXITED,
      sessionId: id,
      ...(name !== undefined && { session: name }),
      reason: killed ? SESSION_EXIT_REASON.KILLED : SESSION_EXIT_REASON.EXIT,
      ...(exit.exitCode !== undefined && { exitCode: exit.exitCode }),
      ...(exit.signal !== undefined && { signal: exit.signal }),
    });
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

  /** Wired to the broker client's onDisconnect; starts the grace window. */
  handleBrokerDisconnected(): void {
    if (this.brokerUnavailableTimer) return;
    this.brokerUnavailableTimer = setTimeout(() => {
      this.brokerUnavailableTimer = null;
      this.notifyBrokerUnavailable();
    }, BROKER_UNAVAILABLE_GRACE_MS);
    this.brokerUnavailableTimer.unref?.();
  }

  /** Wired to the broker client's onConnect; a reconnect inside the grace window stays invisible. */
  handleBrokerConnected(): void {
    if (!this.brokerUnavailableTimer) return;
    clearTimeout(this.brokerUnavailableTimer);
    this.brokerUnavailableTimer = null;
  }

  private notifyBrokerUnavailable(): void {
    for (const [id, subs] of Array.from(this.lifecycleSubs)) {
      for (const cb of Array.from(subs)) {
        try {
          cb({ kind: "broker_unavailable" });
        } catch (e: unknown) {
          log.debug("lifecycle broker_unavailable callback threw", { id, error: errMsg(e) });
        }
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
    start: SubscriptionStart = { kind: "subscribe", sinceSeq: undefined },
  ): SubscriberHandle {
    const existingRef = this.subscriberRefs.get(id);
    const sinceSeq = start.kind === "adopt" ? start.snapshotSeq : start.sinceSeq;
    const outputBoundarySeq = start.kind === "adopt"
      ? start.outputBoundarySeq
      : existingRef
        ? this.client.outputSequence(id)
        : undefined;
    let resolveReady!: (result: SubscriptionReady) => void;
    const ready = new Promise<SubscriptionReady>((resolve) => {
      resolveReady = resolve;
    });
    const registration: SubscriberRegistration = {
      unsubscribeData: undefined,
      cb,
      onSubscribeError,
      sinceSeq,
      lastDeliveredSeq: sinceSeq,
      ready,
      resolveReady,
    };
    const ref = existingRef ?? {
      subscribers: new Set(),
      initialReady: ready,
      replayQueue: Promise.resolve(),
    };
    if (!existingRef) this.subscriberRefs.set(id, ref);
    ref.subscribers.add(registration);

    const attachOutput = (): void => {
      registration.unsubscribeData = this.client.subscribeOutput(id, (frame) => {
        if (registration.lastDeliveredSeq !== undefined && frame.seq <= registration.lastDeliveredSeq) return;
        registration.lastDeliveredSeq = frame.seq;
        registration.cb(frame);
      });
    };
    const activate = async (): Promise<void> => {
      if (this.subscriberRefs.get(id) !== ref || !ref.subscribers.has(registration)) {
        resolveReady({ ok: false, error: new Error("output subscription cancelled") });
        return;
      }
      attachOutput();
      try {
        const response = await this.client.subscribe(id, { sinceSeq: registration.sinceSeq });
        const currentSeq = (response.payload as Record<string, unknown> | undefined)?.current_seq;
        resolveReady({
          ok: true,
          outputBoundarySeq: typeof currentSeq === "number"
            && Number.isSafeInteger(currentSeq)
            && currentSeq >= 0
            ? BigInt(currentSeq)
            : this.client.outputSequence(id),
        });
      } catch (error: unknown) {
        resolveReady({ ok: false, error });
        this.failOutputSubscribers(id, name, error, ref);
      }
    };

    if (start.kind === "adopt") {
      attachOutput();
      resolveReady({ ok: true, outputBoundarySeq: start.outputBoundarySeq });
    } else if (!existingRef) {
      const initial = activate();
      ref.replayQueue = initial.catch(() => undefined);
    } else if (sinceSeq !== undefined) {
      const queued = ref.replayQueue.then(activate);
      ref.replayQueue = queued.catch(() => undefined);
    } else {
      attachOutput();
      void ref.initialReady.then(resolveReady);
    }

    let released = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const unsubscribe = (() => {
      if (released) return;
      released = true;
      try { registration.unsubscribeData?.(); } catch { /* teardown must not throw */ }
      registration.resolveReady({ ok: false, error: new Error("output subscription cancelled") });
      if (this.subscriberRefs.get(id) !== ref) {
        resolveClosed();
        return;
      }
      ref.subscribers.delete(registration);
      if (ref.subscribers.size !== 0) {
        resolveClosed();
        return;
      }
      this.subscriberRefs.delete(id);
      this.client.unsubscribe(id).catch((error: unknown) => {
        log.debug("unsubscribe rpc failed", { name, id, error: errMsg(error) });
      }).finally(resolveClosed);
    }) as SessionDataUnsubscribe;
    unsubscribe.closed = closed;
    return { ready: registration.ready, outputBoundarySeq, unsubscribe };
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
    void this.client.cancelSubscription(id).catch((cleanupError: unknown) => {
      log.debug("failed subscription cancellation failed", { name, id, error: errMsg(cleanupError) });
    });
    log.warn("subscribe rpc failed; unwinding", { name, id, error: errMsg(error) });
    for (const subscriber of ref.subscribers) {
      try { subscriber.unsubscribeData?.(); } catch { /* ignore */ }
      subscriber.resolveReady({ ok: false, error });
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

  /**
   * Prefer the broker-rendered ANSI cut when the caller has a byte budget;
   * otherwise (or for brokers without it) render the JSON snapshot here.
   */
  private async fetchAttachCut(
    id: string,
    name: string,
    targetCols: number | undefined,
    options: SessionPrefillOptions | undefined,
  ): Promise<AttachCut> {
    const scrollbackLines = options?.scrollbackLines ?? SNAPSHOT_SCROLLBACK_LINES;
    const maxBytes = options?.maxBytes;
    if (maxBytes !== undefined) {
      const ansiCut = await this.fetchAnsiAttachCut(id, name, targetCols, scrollbackLines, maxBytes);
      if (ansiCut) return ansiCut;
    }
    const cut = await this.fetchSnapshotAndSubscribe(id, name, targetCols, scrollbackLines);
    const seq = typeof cut.snapshot.seq === "number" ? BigInt(cut.snapshot.seq) : undefined;
    let data: Buffer;
    try {
      data = renderSnapshotToAnsi(cut.snapshot);
    } catch (error: unknown) {
      if (cut.kind === "atomic") {
        await cut.cancel().catch((cleanupError: unknown) => {
          log.debug("failed atomic prefill render cleanup failed", {
            name,
            id,
            error: errMsg(cleanupError),
          });
        });
      }
      throw error;
    }
    if (maxBytes !== undefined) data = trimRenderedPrefill(data, maxBytes);
    const prefill = { data, seq };
    return cut.kind === "atomic"
      ? { kind: "atomic", prefill, outputBoundarySeq: cut.outputBoundarySeq, cancel: cut.cancel }
      : { kind: "legacy", prefill };
  }

  /** Atomic cut with broker-rendered prefill; undefined when the broker predates it. */
  private async fetchAnsiAttachCut(
    id: string,
    name: string,
    targetCols: number | undefined,
    scrollbackLines: number,
    maxBytes: number,
  ): Promise<AttachCut | undefined> {
    let subscription: BrokerSnapshotSubscription;
    try {
      subscription = await this.client.snapshotSubscribeAnsi(id, { scrollbackLines, targetCols, maxBytes });
    } catch (error: unknown) {
      if (error instanceof BrokerSubscribeError && ANSI_FALLBACK_CODES.has(error.code)) {
        // `unknown_method`: broker predates the method. `prefill_too_large`:
        // the visible screen alone exceeds the broker's prefill limit; the
        // JSON cut plus the relay's tail budget still attaches.
        log.debug("beginSessionAttach: no broker-rendered prefill; rendering JSON snapshot", { name, code: error.code });
        return undefined;
      }
      log.warn("beginSessionAttach: ANSI snapshot subscribe failed", { name, error: errMsg(error) });
      throw error;
    }
    const payload = unwrap(subscription.response);
    if (typeof payload.ansi_base64 !== "string") {
      await subscription.cancel().catch((error: unknown) => {
        log.debug("invalid ANSI snapshot cleanup failed", { name, id, error: errMsg(error) });
      });
      throw new BrokerRpcError("invalid_snapshot", "broker returned no ANSI prefill payload");
    }
    return {
      kind: "atomic",
      prefill: {
        data: Buffer.from(payload.ansi_base64, "base64"),
        seq: nonNegativeSafeSeq(payload.seq),
      },
      outputBoundarySeq: nonNegativeSafeSeq(payload.current_seq),
      cancel: subscription.cancel,
    };
  }

  private async fetchSnapshotAndSubscribe(
    id: string,
    name: string,
    targetCols?: number,
    scrollbackLines: number = SNAPSHOT_SCROLLBACK_LINES,
  ): Promise<SnapshotCut> {
    let subscription: BrokerSnapshotSubscription;
    try {
      subscription = await this.client.snapshotSubscribe(id, { scrollbackLines, targetCols });
    } catch (error: unknown) {
      if (error instanceof BrokerSubscribeError && error.code === "unknown_method") {
        // Older protocol-v2 brokers lack this atomic RPC. Activation performs
        // the replay-safe subscribe from the snapshot sequence instead.
        log.warn("beginSessionAttach: broker lacks atomic snapshot subscribe; using legacy replay-safe attach", { name });
        return {
          kind: "legacy",
          snapshot: await this.fetchSnapshot(
            id,
            name,
            "beginSessionAttach",
            targetCols,
            scrollbackLines,
          ),
        };
      }
      log.warn("beginSessionAttach: atomic snapshot subscribe failed", { name, error: errMsg(error) });
      throw error;
    }
    const payload = unwrap(subscription.response);
    const snapshot = payload.snapshot;
    if (!snapshot || typeof snapshot !== "object") {
      await subscription.cancel().catch((error: unknown) => {
        log.debug("invalid atomic snapshot cleanup failed", { name, id, error: errMsg(error) });
      });
      throw new BrokerRpcError("invalid_snapshot", "broker returned no atomic snapshot payload");
    }
    return {
      kind: "atomic",
      snapshot: snapshot as SnapshotPayload,
      outputBoundarySeq: nonNegativeSafeSeq(payload.current_seq),
      cancel: subscription.cancel,
    };
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

  private async exactSessionInfo(sessionId: string, timeoutMs?: number): Promise<BrokerSessionInfo> {
    const payload = unwrap(await this.client.request(
      "session_info",
      { session_id: sessionId },
      timeoutMs === undefined ? undefined : { timeoutMs },
    ));
    const session = payload.session;
    if (
      !session
      || typeof session !== "object"
      || (session as BrokerSessionInfo).id !== sessionId
      || typeof (session as BrokerSessionInfo).name !== "string"
      || typeof (session as BrokerSessionInfo).alive !== "boolean"
    ) {
      throw new BrokerRpcError("invalid_session", "broker returned an invalid exact-ID session record");
    }
    return session as BrokerSessionInfo;
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
