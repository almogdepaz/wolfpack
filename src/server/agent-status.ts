import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";
import {
  AGENT_STATUS_AUTHORITY,
  AGENT_STATUS_FRESHNESS,
  AGENT_STATUS_SOURCE,
  AGENT_STATUS_STATE,
  isAgentStatusState,
} from "../agent-status-contract.js";
import type {
  AgentStatusAuthority,
  AgentStatusFreshness,
  AgentStatusSourceKind,
  AgentStatusState,
} from "../agent-status-contract.js";

export type {
  AgentStatusAuthority,
  AgentStatusFreshness,
  AgentStatusSourceKind,
  AgentStatusState,
} from "../agent-status-contract.js";

export interface AgentStatusSource {
  state: AgentStatusState;
  authority: AgentStatusAuthority;
  freshness: AgentStatusFreshness;
  source: AgentStatusSourceKind;
  label: string;
  stale: boolean;
  observedAt: string;
  path?: string;
  message?: string;
}

interface CandidateStatus {
  state: AgentStatusState;
  authority: AgentStatusAuthority;
  freshness: AgentStatusFreshness;
  source: AgentStatusSource["source"];
  label: string;
  stale?: boolean;
  observedAt?: string;
  path?: string;
  message?: string;
}

export const AGENT_STATUS_MANIFEST_PATH = ".wolfpack/agent-status.json";
export const AGENT_STATUS_LIFECYCLE_PATH = ".ralph/status.json";
export const AGENT_STATUS_TTL_MS = 60_000;

const AUTHORITY_RANK: Record<AgentStatusAuthority, number> = {
  [AGENT_STATUS_AUTHORITY.LIFECYCLE]: 4,
  [AGENT_STATUS_AUTHORITY.MANIFEST]: 3,
  [AGENT_STATUS_AUTHORITY.FALLBACK]: 2,
  [AGENT_STATUS_AUTHORITY.IDENTITY]: 1,
};

function isSafeRelativePath(path: string): boolean {
  if (!path || path.includes("\0")) return false;
  const normalized = normalize(path);
  return !isAbsolute(normalized) && normalized !== ".." && !normalized.startsWith("../");
}

function resolveUnder(baseDir: string, relativePath: string): string | null {
  if (!isSafeRelativePath(relativePath)) return null;
  const baseReal = realpathSync(baseDir);
  const candidate = resolve(baseReal, relativePath);
  if (existsSync(candidate)) {
    const candidateReal = realpathSync(candidate);
    return candidateReal === baseReal || candidateReal.startsWith(baseReal + "/") ? candidateReal : null;
  }
  const parent = resolve(baseReal, relativePath, "..");
  if (parent === baseReal || parent.startsWith(baseReal + "/")) return candidate;
  return null;
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
  };
}

export function collectAgentStatusSources(
  projectDir: string,
  fallback: Omit<CandidateStatus, "authority" | "source" | "label" | "freshness">,
): AgentStatusSource[] {
  const candidates: CandidateStatus[] = [
    readLifecycleStatus(projectDir),
    readLocalStatusManifest(projectDir),
    {
      ...fallback,
      authority: AGENT_STATUS_AUTHORITY.FALLBACK,
      freshness: AGENT_STATUS_FRESHNESS.FRESH,
      source: AGENT_STATUS_SOURCE.SCREEN_FALLBACK,
      label: "log fallback",
      message: fallback.message || "derived from Ralph log markers; not process liveness",
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

function statusFromObject(raw: unknown): Pick<CandidateStatus, "state" | "observedAt" | "message"> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.state !== "string" || !isAgentStatusState(obj.state)) return null;
  if (obj.observedAt != null && typeof obj.observedAt !== "string") return null;
  if (obj.message != null && typeof obj.message !== "string") return null;
  return {
    state: obj.state as AgentStatusState,
    observedAt: typeof obj.observedAt === "string" ? obj.observedAt : undefined,
    message: typeof obj.message === "string" ? obj.message : undefined,
  };
}

function readStructuredStatusFile(
  projectDir: string,
  relativePath: string,
  authority: AgentStatusAuthority,
  source: AgentStatusSource["source"],
  label: string,
  nowMs = Date.now(),
): CandidateStatus {
  const statusPath = resolveUnder(projectDir, relativePath);
  if (!statusPath) {
    return {
      state: AGENT_STATUS_STATE.UNKNOWN,
      authority,
      freshness: AGENT_STATUS_FRESHNESS.MALFORMED,
      source,
      label: `${label} invalid path`,
      path: relativePath,
      message: `${label} path does not resolve under project directory`,
    };
  }
  if (!existsSync(statusPath)) {
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
    const parsed = statusFromObject(JSON.parse(readFileSync(statusPath, "utf-8")));
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
    const stat = statSync(statusPath);
    const stale = nowMs - stat.mtimeMs > AGENT_STATUS_TTL_MS;
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

export function readLifecycleStatus(projectDir: string, nowMs = Date.now()): CandidateStatus {
  return readStructuredStatusFile(
    projectDir,
    AGENT_STATUS_LIFECYCLE_PATH,
    AGENT_STATUS_AUTHORITY.LIFECYCLE,
    AGENT_STATUS_SOURCE.RALPH_LIFECYCLE,
    "lifecycle",
    nowMs,
  );
}

export function readLocalStatusManifest(projectDir: string, nowMs = Date.now()): CandidateStatus {
  return readStructuredStatusFile(
    projectDir,
    AGENT_STATUS_MANIFEST_PATH,
    AGENT_STATUS_AUTHORITY.MANIFEST,
    AGENT_STATUS_SOURCE.LOCAL_MANIFEST,
    "manifest",
    nowMs,
  );
}

export function collectAgentStatus(
  projectDir: string,
  fallback: Omit<CandidateStatus, "authority" | "source" | "label" | "freshness">,
): AgentStatusSource {
  return chooseAgentStatusSource(collectAgentStatusSources(projectDir, fallback));
}

export function statusStateFromRalphFlags(flags: {
  active: boolean;
  completed: boolean;
  audit?: boolean;
  cleanup?: boolean;
  finished?: string;
}): AgentStatusState {
  if (flags.audit) return AGENT_STATUS_STATE.AUDIT;
  if (flags.cleanup) return AGENT_STATUS_STATE.CLEANUP;
  if (flags.active) return AGENT_STATUS_STATE.RUNNING;
  if (flags.completed) return AGENT_STATUS_STATE.DONE;
  if (flags.finished) return AGENT_STATUS_STATE.STOPPED;
  return AGENT_STATUS_STATE.IDLE;
}
