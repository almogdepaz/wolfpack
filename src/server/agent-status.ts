import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

export type AgentStatusState =
  | "running"
  | "audit"
  | "cleanup"
  | "done"
  | "stopped"
  | "idle"
  | "unknown";

export type AgentStatusAuthority =
  | "lifecycle"
  | "manifest"
  | "fallback"
  | "identity";

export type AgentStatusFreshness =
  | "fresh"
  | "stale"
  | "missing"
  | "malformed"
  | "unknown";

export interface AgentStatusSource {
  state: AgentStatusState;
  authority: AgentStatusAuthority;
  freshness: AgentStatusFreshness;
  source: "ralph-lifecycle" | "local-manifest" | "screen-fallback" | "session-identity";
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
  lifecycle: 4,
  manifest: 3,
  fallback: 2,
  identity: 1,
};

const VALID_STATES: readonly AgentStatusState[] = [
  "running",
  "audit",
  "cleanup",
  "done",
  "stopped",
  "idle",
  "unknown",
];

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
    stale: candidate.stale ?? candidate.freshness === "stale",
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
      authority: "fallback",
      freshness: "fresh",
      source: "screen-fallback",
      label: "log fallback",
      message: fallback.message || "derived from Ralph log markers; not process liveness",
    },
  ];
  return candidates.map(normalizeCandidate);
}

export function chooseAgentStatusSource(candidates: CandidateStatus[]): AgentStatusSource {
  const viable = candidates
    .filter((candidate) => candidate.freshness === "fresh" || candidate.freshness === "stale")
    .sort((a, b) => AUTHORITY_RANK[b.authority] - AUTHORITY_RANK[a.authority]);
  if (viable[0]) return normalizeCandidate(viable[0]);
  return normalizeCandidate({
    state: "unknown",
    authority: "identity",
    freshness: "unknown",
    source: "session-identity",
    label: "identity only",
    message: "no authoritative status source available",
  });
}

function statusFromObject(raw: unknown): Pick<CandidateStatus, "state" | "observedAt" | "message"> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.state !== "string" || !VALID_STATES.includes(obj.state as AgentStatusState)) return null;
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
      state: "unknown",
      authority,
      freshness: "malformed",
      source,
      label: `${label} invalid path`,
      path: relativePath,
      message: `${label} path does not resolve under project directory`,
    };
  }
  if (!existsSync(statusPath)) {
    return {
      state: "unknown",
      authority,
      freshness: "missing",
      source,
      label: `${label} missing`,
      path: relativePath,
    };
  }

  try {
    const parsed = statusFromObject(JSON.parse(readFileSync(statusPath, "utf-8")));
    if (!parsed) {
      return {
        state: "unknown",
        authority,
        freshness: "malformed",
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
      freshness: stale ? "stale" : "fresh",
      source,
      label,
      stale,
      observedAt: parsed.observedAt,
      path: relativePath,
      message: parsed.message,
    };
  } catch {
    return {
      state: "unknown",
      authority,
      freshness: "malformed",
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
    "lifecycle",
    "ralph-lifecycle",
    "lifecycle",
    nowMs,
  );
}

export function readLocalStatusManifest(projectDir: string, nowMs = Date.now()): CandidateStatus {
  return readStructuredStatusFile(
    projectDir,
    AGENT_STATUS_MANIFEST_PATH,
    "manifest",
    "local-manifest",
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
  if (flags.audit) return "audit";
  if (flags.cleanup) return "cleanup";
  if (flags.active) return "running";
  if (flags.completed) return "done";
  if (flags.finished) return "stopped";
  return "idle";
}
