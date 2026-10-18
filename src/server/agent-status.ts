import {
  existsSync,
  readFileSync,
} from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createLogger, errMsg } from "../log.js";
import { resolveWolfpackDir } from "../wolfpack-dir.js";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import {
  AGENT_STATUS_AUTHORITY,
  AGENT_STATUS_CAPABILITY,
  AGENT_STATUS_FRESHNESS,
  AGENT_STATUS_SOURCE,
  AGENT_STATUS_STATE,
  AGENT_SEMANTIC_STATUS_STATE_SET,
  isAgentStatusState,
} from "../agent-status-contract.js";
import type {
  AgentStatusAuthority,
  AgentStatusCapability,
  AgentStatusFreshness,
  AgentStatusSourceKind,
  AgentStatusState,
} from "../agent-status-contract.js";
import { programStatusAgentState } from "../program-status-contract.js";
import type { ProgramStatusKind, ProgramStatusRecord } from "../program-status-contract.js";

export type {
  AgentStatusAuthority,
  AgentStatusFreshness,
  AgentStatusSourceKind,
  AgentStatusState,
} from "../agent-status-contract.js";

// Soft cache state: coalesce semantic changes for two seconds, without fsync.
export const RUNTIME_STATE_PERSIST_DEBOUNCE_MS = 2_000;
const log = createLogger("server");

/**
 * Typed detail from a program status (OSC 7501) report. Kept as flat optional
 * fields, never folded into state strings, so runtime-state equality stays a
 * shallow comparison.
 */
export interface ProgramStatusFields {
  /** What a `needs-input` program is waiting for. */
  readonly inputKind?: ProgramStatusKind;
  /** 0-100, only for working/blocked reports that sent one. */
  readonly progress?: number;
  readonly app?: string;
  readonly title?: string;
}

function programStatusFields(fields: ProgramStatusFields): ProgramStatusFields {
  return {
    ...(fields.inputKind ? { inputKind: fields.inputKind } : {}),
    ...(typeof fields.progress === "number" ? { progress: fields.progress } : {}),
    ...(fields.app ? { app: fields.app } : {}),
    ...(fields.title ? { title: fields.title } : {}),
  };
}

export interface AgentStatusSource extends ProgramStatusFields {
  readonly state: AgentStatusState;
  readonly authority: AgentStatusAuthority;
  readonly freshness: AgentStatusFreshness;
  readonly source: AgentStatusSourceKind;
  readonly label: string;
  readonly stale: boolean;
  readonly observedAt: string;
  readonly path?: string;
  readonly message?: string;
  readonly capabilities?: readonly AgentStatusCapability[];
  readonly runId?: string;
  readonly runOrder?: number;
  readonly signalSequence?: number;
}

export interface CandidateStatus extends ProgramStatusFields {
  readonly state: AgentStatusState;
  readonly authority: AgentStatusAuthority;
  readonly freshness: AgentStatusFreshness;
  readonly source: AgentStatusSource["source"];
  readonly label: string;
  readonly stale?: boolean;
  readonly observedAt?: string;
  readonly path?: string;
  readonly message?: string;
  readonly capabilities?: readonly AgentStatusCapability[];
  readonly runId?: string;
  readonly runOrder?: number;
  readonly signalSequence?: number;
}

export type BrokerRuntimeLiveness = "alive" | "dead" | "unavailable";

export interface AgentRuntimeState extends ProgramStatusFields {
  readonly state: AgentStatusState;
  readonly authority: AgentStatusAuthority;
  readonly freshness: AgentStatusFreshness;
  readonly source: AgentStatusSourceKind;
  readonly label: string;
  readonly stale: boolean;
  readonly observedAt: string;
  readonly changedAt: string;
  readonly transitionSequence: number;
  readonly acknowledgedAt?: string;
  readonly acknowledgedSequence?: number;
  readonly unseen: boolean;
  readonly runId?: string;
  readonly runOrder?: number;
  readonly signalSequence?: number;
  readonly message?: string;
}

export interface AgentRuntimeStateInput {
  readonly sessionKey: string;
  readonly broker: {
    readonly state: BrokerRuntimeLiveness;
    readonly observedAt: string;
  };
  readonly sources: readonly AgentStatusSource[];
  readonly fallback: {
    readonly rawOutputChanged: boolean;
    readonly observedAt: string;
    readonly preview?: string;
  };
  readonly currentRun?: {
    readonly runId?: string;
    readonly runOrder?: number;
  };
  readonly previous?: AgentRuntimeState;
}

export interface AgentRuntimeStateFile {
  readonly schemaVersion: 1;
  readonly sessions: Record<string, AgentRuntimeState>;
}

export const AGENT_STATUS_MANIFEST_PATH = ".wolfpack/agent-status.json";
export const AGENT_STATUS_TTL_MS = 60_000;
export const AGENT_RUNTIME_STATE_SCHEMA_VERSION = 1;

// Program status (OSC 7501) is a live, protocol-validated self-report from the
// exact process on the broker's PTY, so it outranks the TTL'd manifest file and
// screen heuristics. It stays below broker liveness (a dead process cannot
// report) and below Wolfpack-owned lifecycle facts.
const AUTHORITY_RANK: Record<AgentStatusAuthority, number> = {
  [AGENT_STATUS_AUTHORITY.BROKER]: 6,
  [AGENT_STATUS_AUTHORITY.LIFECYCLE]: 5,
  [AGENT_STATUS_AUTHORITY.PROGRAM]: 4,
  [AGENT_STATUS_AUTHORITY.MANIFEST]: 3,
  [AGENT_STATUS_AUTHORITY.FALLBACK]: 2,
  [AGENT_STATUS_AUTHORITY.IDENTITY]: 1,
};

const RESOLVE_UNDER_KIND = {
  RESOLVED: "resolved",
  BASE_MISSING: "base-missing",
  INVALID: "invalid",
} as const;

type ResolveUnderResult =
  | { readonly kind: typeof RESOLVE_UNDER_KIND.RESOLVED; readonly path: string }
  | { readonly kind: typeof RESOLVE_UNDER_KIND.BASE_MISSING }
  | { readonly kind: typeof RESOLVE_UNDER_KIND.INVALID; readonly message: string };

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isSafeRelativePath(path: string): boolean {
  if (!path || path.includes("\0")) return false;
  const normalized = normalize(path);
  return !isAbsolute(normalized) && normalized !== ".." && !normalized.startsWith("../");
}

async function resolveUnder(baseDir: string, relativePath: string): Promise<ResolveUnderResult> {
  if (!isSafeRelativePath(relativePath)) {
    return {
      kind: RESOLVE_UNDER_KIND.INVALID,
      message: "status path must be a safe relative path",
    };
  }

  try {
    const baseReal = await realpath(baseDir);
    const candidate = resolve(baseReal, relativePath);
    // Like existsSync, any failure to resolve the candidate means "not there".
    const candidateReal = await realpath(candidate).catch(() => undefined);
    if (candidateReal !== undefined) {
      return candidateReal === baseReal || candidateReal.startsWith(baseReal + "/")
        ? { kind: RESOLVE_UNDER_KIND.RESOLVED, path: candidateReal }
        : {
            kind: RESOLVE_UNDER_KIND.INVALID,
            message: "status path does not resolve under project directory",
          };
    }
    const parent = resolve(baseReal, relativePath, "..");
    return parent === baseReal || parent.startsWith(baseReal + "/")
      ? { kind: RESOLVE_UNDER_KIND.RESOLVED, path: candidate }
      : {
          kind: RESOLVE_UNDER_KIND.INVALID,
          message: "status path does not resolve under project directory",
        };
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { kind: RESOLVE_UNDER_KIND.BASE_MISSING };
    }
    const detail = isErrnoException(error) && error.code ? `: ${error.code}` : "";
    return {
      kind: RESOLVE_UNDER_KIND.INVALID,
      message: `status path could not be resolved${detail}`,
    };
  }
}

function normalizeCandidate(candidate: CandidateStatus): AgentStatusSource {
  const observedAt = candidate.observedAt || new Date().toISOString();
  return {
    state: candidate.state,
    authority: candidate.authority,
    freshness: candidate.freshness,
    source: candidate.source,
    label: candidate.label,
    stale: candidate.stale ?? candidate.freshness === AGENT_STATUS_FRESHNESS.STALE,
    observedAt,
    ...(candidate.path ? { path: candidate.path } : {}),
    ...(candidate.message ? { message: candidate.message } : {}),
    ...(candidate.capabilities ? { capabilities: candidate.capabilities } : {}),
    ...(candidate.runId ? { runId: candidate.runId } : {}),
    ...(typeof candidate.runOrder === "number" ? { runOrder: candidate.runOrder } : {}),
    ...(typeof candidate.signalSequence === "number" ? { signalSequence: candidate.signalSequence } : {}),
    ...programStatusFields(candidate),
  };
}

/**
 * Status source for a session's root program status record, or undefined when
 * the program has not reported. The broker reports for this exact session, so
 * the source carries the session's run id. No signal sequence: repeated
 * reports refresh detail without minting a transition unless the state moves.
 */
export function programStatusSource(
  record: ProgramStatusRecord | undefined,
  context: { readonly runId?: string; readonly observedAt: string },
): AgentStatusSource | undefined {
  if (!record) return undefined;
  return normalizeCandidate({
    state: programStatusAgentState(record.state),
    authority: AGENT_STATUS_AUTHORITY.PROGRAM,
    freshness: AGENT_STATUS_FRESHNESS.FRESH,
    source: AGENT_STATUS_SOURCE.PROGRAM_STATUS,
    label: "program status",
    stale: false,
    observedAt: context.observedAt,
    capabilities: [AGENT_STATUS_CAPABILITY.SEMANTIC_STATE],
    ...(context.runId ? { runId: context.runId } : {}),
    ...(record.message ? { message: record.message } : {}),
    inputKind: record.kind,
    progress: record.progress,
    app: record.app,
    title: record.title,
  });
}

export async function collectAgentStatusSources(
  projectDir: string,
  fallback: Omit<CandidateStatus, "authority" | "source" | "label" | "freshness">,
): Promise<AgentStatusSource[]> {
  return agentStatusSources(await readLocalStatusManifest(projectDir), fallback);
}

/** Sources from an already-read manifest plus the screen fallback. */
export function agentStatusSources(
  manifest: CandidateStatus,
  fallback: Omit<CandidateStatus, "authority" | "source" | "label" | "freshness">,
): AgentStatusSource[] {
  const candidates: CandidateStatus[] = [
    manifest,
    {
      ...fallback,
      authority: AGENT_STATUS_AUTHORITY.FALLBACK,
      freshness: AGENT_STATUS_FRESHNESS.FRESH,
      source: AGENT_STATUS_SOURCE.SCREEN_FALLBACK,
      label: "log fallback",
      message: fallback.message || "derived from bounded terminal output; not process liveness",
    },
  ];
  return candidates.map(normalizeCandidate);
}

export function chooseAgentStatusSource(candidates: CandidateStatus[]): AgentStatusSource {
  const viable = candidates
    .filter((candidate) => candidate.freshness === AGENT_STATUS_FRESHNESS.FRESH || candidate.freshness === AGENT_STATUS_FRESHNESS.STALE)
    .sort((a, b) => AUTHORITY_RANK[b.authority] - AUTHORITY_RANK[a.authority]);
  if (viable[0]) return normalizeCandidate(viable[0]);
  return normalizeCandidate({
    state: AGENT_STATUS_STATE.UNKNOWN,
    authority: AGENT_STATUS_AUTHORITY.IDENTITY,
    freshness: AGENT_STATUS_FRESHNESS.UNKNOWN,
    source: AGENT_STATUS_SOURCE.SESSION_IDENTITY,
    label: "identity only",
    message: "no authoritative status source available",
  });
}

function statusCapabilities(raw: unknown): readonly AgentStatusCapability[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((value): value is AgentStatusCapability => value === AGENT_STATUS_CAPABILITY.SEMANTIC_STATE);
}

function statusFromObject(raw: unknown): Pick<CandidateStatus, "state" | "observedAt" | "message" | "capabilities" | "runId" | "runOrder" | "signalSequence"> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.state !== "string" || !isAgentStatusState(obj.state)) return null;
  if (obj.observedAt != null && typeof obj.observedAt !== "string") return null;
  if (obj.message != null && typeof obj.message !== "string") return null;
  if (obj.runId != null && typeof obj.runId !== "string") return null;
  if (obj.runOrder != null && typeof obj.runOrder !== "number") return null;
  if (obj.signalSequence != null && typeof obj.signalSequence !== "number") return null;
  if (obj.transitionSequence != null && typeof obj.transitionSequence !== "number") return null;
  const capabilities = statusCapabilities(obj.capabilities);
  return {
    state: obj.state as AgentStatusState,
    observedAt: typeof obj.observedAt === "string" ? obj.observedAt : undefined,
    message: typeof obj.message === "string" ? obj.message : undefined,
    ...(capabilities ? { capabilities } : {}),
    ...(typeof obj.runId === "string" ? { runId: obj.runId } : {}),
    ...(typeof obj.runOrder === "number" ? { runOrder: obj.runOrder } : {}),
    ...(typeof obj.signalSequence === "number" ? { signalSequence: obj.signalSequence } : {}),
    ...(typeof obj.transitionSequence === "number" ? { signalSequence: obj.transitionSequence } : {}),
  };
}

async function readStructuredStatusFile(
  projectDir: string,
  relativePath: string,
  authority: AgentStatusAuthority,
  source: AgentStatusSource["source"],
  label: string,
  nowMs = Date.now(),
): Promise<CandidateStatus> {
  const statusLocation = await resolveUnder(projectDir, relativePath);
  if (statusLocation.kind === RESOLVE_UNDER_KIND.INVALID) {
    return {
      state: AGENT_STATUS_STATE.UNKNOWN,
      authority,
      freshness: AGENT_STATUS_FRESHNESS.MALFORMED,
      source,
      label: `${label} invalid path`,
      path: relativePath,
      message: statusLocation.message,
    };
  }
  // Like existsSync, any stat failure means the manifest is missing.
  const fileStat = statusLocation.kind === RESOLVE_UNDER_KIND.BASE_MISSING
    ? undefined
    : await stat(statusLocation.path).catch(() => undefined);
  if (statusLocation.kind === RESOLVE_UNDER_KIND.BASE_MISSING || fileStat === undefined) {
    return {
      state: AGENT_STATUS_STATE.UNKNOWN,
      authority,
      freshness: AGENT_STATUS_FRESHNESS.MISSING,
      source,
      label: `${label} missing`,
      path: relativePath,
    };
  }

  try {
    const parsed = statusFromObject(JSON.parse(await readFile(statusLocation.path, "utf-8")));
    if (!parsed) {
      return {
        state: AGENT_STATUS_STATE.UNKNOWN,
        authority,
        freshness: AGENT_STATUS_FRESHNESS.MALFORMED,
        source,
        label: `${label} malformed`,
        path: relativePath,
      };
    }
    const stale = nowMs - fileStat.mtimeMs > AGENT_STATUS_TTL_MS;
    return {
      state: parsed.state,
      authority,
      freshness: stale ? AGENT_STATUS_FRESHNESS.STALE : AGENT_STATUS_FRESHNESS.FRESH,
      source,
      label,
      stale,
      observedAt: parsed.observedAt,
      path: relativePath,
      message: parsed.message,
      capabilities: parsed.capabilities,
      runId: parsed.runId,
      runOrder: parsed.runOrder,
      signalSequence: parsed.signalSequence,
    };
  } catch {
    return {
      state: AGENT_STATUS_STATE.UNKNOWN,
      authority,
      freshness: AGENT_STATUS_FRESHNESS.MALFORMED,
      source,
      label: `${label} malformed`,
      path: relativePath,
    };
  }
}

export function readLocalStatusManifest(projectDir: string, nowMs = Date.now()): Promise<CandidateStatus> {
  return readStructuredStatusFile(
    projectDir,
    AGENT_STATUS_MANIFEST_PATH,
    AGENT_STATUS_AUTHORITY.MANIFEST,
    AGENT_STATUS_SOURCE.LOCAL_MANIFEST,
    "manifest",
    nowMs,
  );
}

export async function collectAgentStatus(
  projectDir: string,
  fallback: Omit<CandidateStatus, "authority" | "source" | "label" | "freshness">,
): Promise<AgentStatusSource> {
  return chooseAgentStatusSource(await collectAgentStatusSources(projectDir, fallback));
}

function sourceHasSemanticCapability(source: AgentStatusSource): boolean {
  return source.capabilities?.includes(AGENT_STATUS_CAPABILITY.SEMANTIC_STATE) ?? false;
}

function sourceMatchesRun(source: AgentStatusSource, currentRun: AgentRuntimeStateInput["currentRun"]): boolean {
  if (!currentRun) return true;
  if (currentRun.runId && source.runId) return source.runId === currentRun.runId;
  if (typeof currentRun.runOrder === "number" && typeof source.runOrder === "number") return source.runOrder >= currentRun.runOrder;
  return !currentRun.runId && typeof currentRun.runOrder !== "number";
}

function chooseSemanticRuntimeSource(input: AgentRuntimeStateInput): AgentStatusSource | null {
  const candidates = input.sources
    .filter((source) => source.freshness === AGENT_STATUS_FRESHNESS.FRESH)
    .filter(sourceHasSemanticCapability)
    .filter((source) => AGENT_SEMANTIC_STATUS_STATE_SET.has(source.state))
    .filter((source) => sourceMatchesRun(source, input.currentRun))
    .sort((a, b) => {
      const rankDiff = AUTHORITY_RANK[b.authority] - AUTHORITY_RANK[a.authority];
      if (rankDiff !== 0) return rankDiff;
      return (b.signalSequence ?? 0) - (a.signalSequence ?? 0);
    });
  return candidates[0] ?? null;
}

function fallbackRuntimeSource(input: AgentRuntimeStateInput): AgentStatusSource {
  const state = input.fallback.rawOutputChanged ? AGENT_STATUS_STATE.OUTPUT : AGENT_STATUS_STATE.IDLE;
  return normalizeCandidate({
    state,
    authority: AGENT_STATUS_AUTHORITY.FALLBACK,
    freshness: AGENT_STATUS_FRESHNESS.FRESH,
    source: AGENT_STATUS_SOURCE.SCREEN_FALLBACK,
    label: input.fallback.rawOutputChanged ? "rendered output activity" : "bounded activity idle",
    stale: false,
    observedAt: input.fallback.observedAt,
    message: "derived only from broker-rendered terminal changes",
  });
}

function brokerRuntimeSource(input: AgentRuntimeStateInput): AgentStatusSource | null {
  if (input.broker.state === "alive") return null;
  return normalizeCandidate({
    state: input.broker.state === "dead" ? AGENT_STATUS_STATE.OFF : AGENT_STATUS_STATE.UNKNOWN,
    authority: AGENT_STATUS_AUTHORITY.BROKER,
    freshness: input.broker.state === "dead" ? AGENT_STATUS_FRESHNESS.FRESH : AGENT_STATUS_FRESHNESS.UNKNOWN,
    source: AGENT_STATUS_SOURCE.BROKER_LIVENESS,
    label: input.broker.state === "dead" ? "broker dead" : "broker unavailable",
    stale: false,
    observedAt: input.broker.observedAt,
  });
}

function runtimeRunId(next: AgentStatusSource, run: AgentRuntimeStateInput["currentRun"]): string | undefined {
  return run?.runId ?? next.runId;
}

function runtimeRunOrder(next: AgentStatusSource, run: AgentRuntimeStateInput["currentRun"]): number | undefined {
  return typeof run?.runOrder === "number" ? run.runOrder : next.runOrder;
}

function sameSourceAuthority(previous: AgentRuntimeState | undefined, next: AgentStatusSource): boolean {
  return !!previous && previous.authority === next.authority && previous.source === next.source;
}

function runOrderDelta(previous: AgentRuntimeState, next: AgentStatusSource, run: AgentRuntimeStateInput["currentRun"]): number | null {
  const nextRunId = runtimeRunId(next, run);
  if (previous.runId || nextRunId) return null;
  const nextRunOrder = runtimeRunOrder(next, run);
  if (typeof previous.runOrder !== "number" || typeof nextRunOrder !== "number") return null;
  return nextRunOrder - previous.runOrder;
}

function sameStructuredSequenceContext(previous: AgentRuntimeState | undefined, next: AgentStatusSource, run: AgentRuntimeStateInput["currentRun"]): boolean {
  if (!previous) return false;
  if (typeof previous.signalSequence !== "number" || typeof next.signalSequence !== "number") return false;
  if (!sameSourceAuthority(previous, next)) return false;
  const nextRunId = runtimeRunId(next, run);
  if (previous.runId || nextRunId) return previous.runId === nextRunId;
  const delta = runOrderDelta(previous, next, run);
  return delta === null || delta === 0;
}

function staleStructuredSignal(previous: AgentRuntimeState | undefined, next: AgentStatusSource, run: AgentRuntimeStateInput["currentRun"]): boolean {
  if (!previous || !sameSourceAuthority(previous, next) || typeof next.signalSequence !== "number") return false;
  const delta = runOrderDelta(previous, next, run);
  if (delta !== null && delta < 0) return true;
  if (delta !== null && delta > 0) return false;
  return typeof previous.signalSequence === "number"
    && sameStructuredSequenceContext(previous, next, run)
    && next.signalSequence <= previous.signalSequence;
}

function structuredSignalAdvanced(previous: AgentRuntimeState | undefined, next: AgentStatusSource, run: AgentRuntimeStateInput["currentRun"]): boolean {
  if (!previous || !sameSourceAuthority(previous, next) || typeof next.signalSequence !== "number") return false;
  const delta = runOrderDelta(previous, next, run);
  if (delta !== null && delta > 0) return true;
  return typeof previous.signalSequence === "number"
    && sameStructuredSequenceContext(previous, next, run)
    && next.signalSequence > previous.signalSequence;
}

/**
 * A blocked program asking for something new (another kind or another
 * question) is a new request even though the state is still needs-input, so
 * the attention layer sees it. Only program status carries this detail, and
 * only blocked requests count: working/done messages narrate progress and
 * would otherwise mint a transition per report.
 */
function programRequestChanged(previous: AgentRuntimeState, next: AgentStatusSource): boolean {
  return next.authority === AGENT_STATUS_AUTHORITY.PROGRAM
    && next.state === AGENT_STATUS_STATE.NEEDS_INPUT
    && (previous.inputKind !== next.inputKind || previous.message !== next.message);
}

function runtimeStateChanged(previous: AgentRuntimeState | undefined, next: AgentStatusSource, run: AgentRuntimeStateInput["currentRun"]): boolean {
  if (!previous) return true;
  return previous.state !== next.state
    || previous.authority !== next.authority
    || previous.source !== next.source
    || previous.freshness !== next.freshness
    || previous.runId !== runtimeRunId(next, run)
    || previous.runOrder !== runtimeRunOrder(next, run)
    || programRequestChanged(previous, next);
}

export function deriveAgentRuntimeState(input: AgentRuntimeStateInput): AgentRuntimeState {
  const selected = brokerRuntimeSource(input)
    ?? chooseSemanticRuntimeSource(input)
    ?? fallbackRuntimeSource(input);
  const previous = input.previous;
  if (previous && staleStructuredSignal(previous, selected, input.currentRun)) return previous;
  const stateChanged = runtimeStateChanged(previous, selected, input.currentRun);
  const sequenceAdvanced = structuredSignalAdvanced(previous, selected, input.currentRun);
  const acknowledgedOutputAdvanced = !stateChanged
    && selected.state === AGENT_STATUS_STATE.OUTPUT
    && input.fallback.rawOutputChanged
    && previous?.acknowledgedSequence === previous?.transitionSequence;
  const changed = stateChanged || sequenceAdvanced || acknowledgedOutputAdvanced;
  const transitionSequence = changed ? (previous?.transitionSequence ?? 0) + 1 : previous?.transitionSequence ?? 1;
  const acknowledgedSequence = previous?.acknowledgedSequence;
  const acknowledgedAt = previous?.acknowledgedAt;
  return {
    state: selected.state,
    authority: selected.authority,
    freshness: selected.freshness,
    source: selected.source,
    label: selected.label,
    stale: selected.stale,
    observedAt: selected.observedAt,
    changedAt: changed ? selected.observedAt : previous?.changedAt ?? selected.observedAt,
    transitionSequence,
    ...(acknowledgedAt ? { acknowledgedAt } : {}),
    ...(typeof acknowledgedSequence === "number" ? { acknowledgedSequence } : {}),
    unseen: transitionSequence > (acknowledgedSequence ?? 0),
    ...(input.currentRun?.runId ? { runId: input.currentRun.runId } : selected.runId ? { runId: selected.runId } : {}),
    ...(typeof input.currentRun?.runOrder === "number" ? { runOrder: input.currentRun.runOrder } : typeof selected.runOrder === "number" ? { runOrder: selected.runOrder } : {}),
    ...(typeof selected.signalSequence === "number" ? { signalSequence: selected.signalSequence } : {}),
    ...(selected.message ? { message: selected.message } : {}),
    ...programStatusFields(selected),
  };
}

function isAgentRuntimeState(value: unknown): value is AgentRuntimeState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.state === "string" && isAgentStatusState(obj.state)
    && typeof obj.authority === "string"
    && typeof obj.freshness === "string"
    && typeof obj.source === "string"
    && typeof obj.label === "string"
    && typeof obj.stale === "boolean"
    && typeof obj.observedAt === "string"
    && typeof obj.changedAt === "string"
    && typeof obj.transitionSequence === "number"
    && typeof obj.unseen === "boolean";
}

function isAgentRuntimeStateFile(value: unknown): value is AgentRuntimeStateFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== AGENT_RUNTIME_STATE_SCHEMA_VERSION) return false;
  if (typeof obj.sessions !== "object" || obj.sessions === null || Array.isArray(obj.sessions)) return false;
  return Object.values(obj.sessions).every(isAgentRuntimeState);
}

export function agentRuntimeStatePath(): string {
  return process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH || resolve(resolveWolfpackDir(), "agent-runtime-state.json");
}

function sameRuntimeState(previous: AgentRuntimeState | undefined, next: AgentRuntimeState): boolean {
  if (!previous) return false;
  const keys = Object.keys(next) as (keyof AgentRuntimeState)[];
  return keys.length === Object.keys(previous).length
    && keys.every((key) => Object.hasOwn(previous, key)
      && (key === "observedAt" || Object.is(previous[key], next[key])));
}

/** Freeze constructor-owned JSON, including any extension fields accepted on disk. */
function freezePersistedState(state: AgentRuntimeState): void {
  const pending: object[] = [state];
  while (pending.length > 0) {
    const value = pending.pop()!;
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
    Object.freeze(value);
  }
}

/** Single-owner projection: load once, update entries, then persist a batch. */
export class AgentRuntimeStateStore {
  private readonly file: AgentRuntimeStateFile;
  private dirty = true;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<boolean> | null = null;
  private draining = false;

  constructor(readonly path = agentRuntimeStatePath()) {
    this.file = this.read();
  }

  snapshot(): AgentRuntimeStateFile {
    return {
      schemaVersion: AGENT_RUNTIME_STATE_SCHEMA_VERSION,
      sessions: { ...this.file.sessions },
    };
  }

  get(sessionKey: string): AgentRuntimeState | undefined {
    return this.file.sessions[sessionKey];
  }

  reduce(
    input: Omit<AgentRuntimeStateInput, "previous">,
    options: { readonly persist?: boolean } = {},
  ): AgentRuntimeState {
    const next = deriveAgentRuntimeState({
      ...input,
      previous: this.file.sessions[input.sessionKey],
    });
    const stored = this.set(input.sessionKey, next);
    if (options.persist !== false) this.write();
    return stored;
  }

  acknowledge(sessionKey: string, transitionSequence: number, acknowledgedAt = new Date().toISOString()): AgentRuntimeState | null {
    const current = this.file.sessions[sessionKey];
    if (!current || !Number.isInteger(transitionSequence) || transitionSequence !== current.transitionSequence) return null;
    const acknowledgedSequence = transitionSequence;
    const next: AgentRuntimeState = {
      ...current,
      acknowledgedAt,
      acknowledgedSequence,
      unseen: current.transitionSequence > acknowledgedSequence,
    };
    const stored = this.set(sessionKey, next);
    this.write();
    return stored;
  }

  prune(
    activeSessionKeys: ReadonlySet<string>,
    options: { readonly persist?: boolean } = {},
  ): void {
    for (const key of Object.keys(this.file.sessions)) {
      if (!activeSessionKeys.has(key)) {
        delete this.file.sessions[key];
        this.dirty = true;
      }
    }
    if (options.persist !== false) this.write();
  }

  private set(sessionKey: string, next: AgentRuntimeState): AgentRuntimeState {
    const previous = this.file.sessions[sessionKey];
    const equivalent = sameRuntimeState(previous, next);
    if (equivalent && previous!.observedAt === next.observedAt) return previous!;
    // Reducer values are flat; acknowledgement only shares already-frozen disk
    // extensions. Never mutate old results or freeze caller-owned input graphs.
    this.file.sessions[sessionKey] = Object.freeze(next);
    if (!equivalent) this.dirty = true;
    return next;
  }

  /** Schedule pending reductions; callers must not assume synchronous durability. */
  flush(): void {
    this.write();
  }

  private read(): AgentRuntimeStateFile {
    // Null-prototype storage keeps opaque names such as __proto__ safe even
    // though per-entry updates no longer use computed-property object spreads.
    const sessions: Record<string, AgentRuntimeState> = Object.create(null);
    const file: AgentRuntimeStateFile = { schemaVersion: AGENT_RUNTIME_STATE_SCHEMA_VERSION, sessions };
    if (!existsSync(this.path)) return file;
    const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as unknown;
    if (!isAgentRuntimeStateFile(parsed)) return file;
    for (const [key, state] of Object.entries(parsed.sessions)) {
      freezePersistedState(state);
      sessions[key] = state;
    }
    this.dirty = false;
    return file;
  }

  private write(): void {
    // A pending initial write owns creation; observation-only updates must not
    // mistake its not-yet-renamed destination for an externally deleted file.
    if (this.inFlight && !this.dirty) return;
    // Preserve explicit recreation after removal under the load-once contract.
    if (!this.dirty && existsSync(this.path)) return;
    this.dirty = true;
    if (this.persistTimer || this.inFlight || this.draining) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.startPersist();
    }, RUNTIME_STATE_PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref();
  }

  private startPersist(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.persist().finally(() => {
      this.inFlight = null;
      if (this.dirty) this.write();
    });
    return this.inFlight;
  }

  private async persist(): Promise<boolean> {
    const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    // Capture before yielding; later semantic changes remain dirty for one
    // follow-up window, rather than being cleared by this older write.
    this.dirty = false;
    try {
      const contents = `${JSON.stringify(this.file, null, 2)}\n`;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      try {
        await writeFile(tmp, contents, { flag: "wx", mode: 0o600 });
        await rename(tmp, this.path);
      } finally {
        await rm(tmp, { force: true });
      }
      return true;
    } catch (error: unknown) {
      this.dirty = true;
      log.warn("runtime state persistence failed", { path: this.path, error: errMsg(error) });
      return false;
    }
  }

  /** Existing server-close hook may bypass debounce and drain pending writes. */
  async flushForShutdown(): Promise<void> {
    this.draining = true;
    this.cancelScheduledPersist();
    try {
      if (this.inFlight) await this.inFlight;
      while (this.dirty) {
        if (!await this.startPersist()) break;
      }
    } finally {
      this.draining = false;
      if (this.dirty) this.write();
    }
  }

  /** Also used by test singleton resets to avoid writes from abandoned stores. */
  cancelScheduledPersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
  }
}

let runtimeStateStore: AgentRuntimeStateStore | null = null;

export function getAgentRuntimeStateStore(): AgentRuntimeStateStore {
  runtimeStateStore ??= new AgentRuntimeStateStore();
  return runtimeStateStore;
}

export async function flushAgentRuntimeStateForShutdown(): Promise<void> {
  await runtimeStateStore?.flushForShutdown();
}

export function __resetAgentRuntimeStateStoreForTests(): void {
  runtimeStateStore?.cancelScheduledPersist();
  runtimeStateStore = null;
}
