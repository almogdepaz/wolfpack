import {
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  CUSTOM_AGENT_KIND,
  inferAgentKindFromCommand,
} from "../agent-kind.js";
import type { AgentKind } from "../agent-kind.js";
export type { AgentKind } from "../agent-kind.js";
import { DEV_DIR } from "./dev-dir.js";
import { readValidatedJsonFile, writePrivateJsonFile } from "./persistence.js";

export const SESSION_IDENTITY_SCHEMA_VERSION = 1;
export type SessionIdentityPersistenceMode = "private" | "memory";

export function sessionIdentityPersistenceMode(env: NodeJS.ProcessEnv = process.env): SessionIdentityPersistenceMode {
  return env.WOLFPACK_SESSION_IDENTITY_MODE?.trim().toLowerCase() === "memory" ? "memory" : "private";
}
const EXTERNAL_ID_VISIBLE_PREFIX = 6;
const EXTERNAL_ID_VISIBLE_SUFFIX = 4;

export interface ExternalAgentIdentity {
  provider: AgentKind | string;
  id: string;
  capturedAt: string;
  source: "env" | "broker_env";
}

export interface ParentSessionIdentity {
  readonly wolfpackSessionId: string;
  readonly wolfpackSessionName: string;
}

export interface SessionIdentity {
  schemaVersion: typeof SESSION_IDENTITY_SCHEMA_VERSION;
  wolfpackSessionId: string;
  wolfpackSessionName: string;
  projectPath: string;
  agentKind: AgentKind | string;
  createdAt: string;
  restoredAt?: string;
  updatedAt: string;
  parentSession?: ParentSessionIdentity;
  externalAgent?: ExternalAgentIdentity;
}

export interface PublicSessionIdentity {
  wolfpackSessionId: string;
  wolfpackSessionName: string;
  projectPath: string;
  agentKind: AgentKind | string;
  createdAt: string;
  restoredAt?: string;
  updatedAt: string;
  parentSession?: ParentSessionIdentity;
  externalAgent?: {
    provider: AgentKind | string;
    redactedId: string;
    capturedAt: string;
    source: ExternalAgentIdentity["source"];
  };
}

export interface CaptureSessionIdentityInput {
  wolfpackSessionId: string;
  wolfpackSessionName: string;
  projectPath: string;
  agentKind: AgentKind | string;
  parentSession?: ParentSessionIdentity;
  externalAgent?: {
    provider?: AgentKind | string;
    id?: string;
    source: ExternalAgentIdentity["source"];
  };
  now?: Date;
}

interface IdentityStoreFile {
  schemaVersion: typeof SESSION_IDENTITY_SCHEMA_VERSION;
  sessions: SessionIdentity[];
}

export function sessionIdentityStorePath(devDir?: string): string {
  if (devDir !== undefined) return join(devDir, ".wolfpack", "session-identities.json");
  if (process.env.WOLFPACK_SESSION_IDENTITY_PATH) return process.env.WOLFPACK_SESSION_IDENTITY_PATH;
  if (process.env.WOLFPACK_TEST) {
    return join(process.cwd(), ".wolfpack", `session-identities-test-${process.pid}.json`);
  }
  return join(DEV_DIR, ".wolfpack", "session-identities.json");
}

export function inferAgentKind(cmd: string | undefined): AgentKind {
  return inferAgentKindFromCommand(cmd);
}

export function identityEnvVars(input: {
  readonly wolfpackSessionName: string;
  readonly projectPath: string;
  readonly agentKind: AgentKind | string;
  readonly parentSession?: ParentSessionIdentity;
}): Array<[string, string]> {
  return [
    ["WOLFPACK_SESSION_NAME", input.wolfpackSessionName],
    ["WOLFPACK_PROJECT_DIR", input.projectPath],
    ["WOLFPACK_AGENT_KIND", input.agentKind],
    ...(input.parentSession ? [
      ["WOLFPACK_PARENT_SESSION_ID", input.parentSession.wolfpackSessionId] as [string, string],
      ["WOLFPACK_PARENT_SESSION_NAME", input.parentSession.wolfpackSessionName] as [string, string],
    ] : []),
    ["WOLFPACK_EXTERNAL_AGENT_ID_FILE", join(input.projectPath, ".wolfpack", "external-agent-id")],
  ];
}

export function extractParentSessionFromEnv(
  env: Array<[string, string]> | undefined,
): ParentSessionIdentity | undefined {
  if (!env) return undefined;
  const map = new Map(env);
  const wolfpackSessionId = map.get("WOLFPACK_PARENT_SESSION_ID")?.trim();
  const wolfpackSessionName = map.get("WOLFPACK_PARENT_SESSION_NAME")?.trim();
  if (!wolfpackSessionId || !wolfpackSessionName) return undefined;
  return { wolfpackSessionId, wolfpackSessionName };
}

export function extractExternalAgentFromEnv(
  env: Array<[string, string]> | undefined,
  source: ExternalAgentIdentity["source"],
): CaptureSessionIdentityInput["externalAgent"] | undefined {
  if (!env) return undefined;
  const map = new Map(env);
  const id = map.get("WOLFPACK_EXTERNAL_AGENT_ID")?.trim();
  if (!id) return undefined;
  const provider = map.get("WOLFPACK_EXTERNAL_AGENT_PROVIDER")?.trim() || map.get("WOLFPACK_AGENT_KIND")?.trim();
  return { id, provider, source };
}

export function redactExternalAgentId(id: string): string {
  if (id.length <= EXTERNAL_ID_VISIBLE_PREFIX + EXTERNAL_ID_VISIBLE_SUFFIX) {
    return "*".repeat(Math.max(4, id.length));
  }
  return `${id.slice(0, EXTERNAL_ID_VISIBLE_PREFIX)}...${id.slice(-EXTERNAL_ID_VISIBLE_SUFFIX)}`;
}

export function toPublicSessionIdentity(identity: SessionIdentity): PublicSessionIdentity {
  return {
    wolfpackSessionId: identity.wolfpackSessionId,
    wolfpackSessionName: identity.wolfpackSessionName,
    projectPath: identity.projectPath,
    agentKind: identity.agentKind,
    createdAt: identity.createdAt,
    restoredAt: identity.restoredAt,
    updatedAt: identity.updatedAt,
    ...(identity.parentSession && { parentSession: identity.parentSession }),
    ...(identity.externalAgent && {
      externalAgent: {
        provider: identity.externalAgent.provider,
        redactedId: redactExternalAgentId(identity.externalAgent.id),
        capturedAt: identity.externalAgent.capturedAt,
        source: identity.externalAgent.source,
      },
    }),
  };
}

export class SessionIdentityStore {
  readonly path: string;
  readonly mode: SessionIdentityPersistenceMode;
  private memory: IdentityStoreFile = emptyStore();

  constructor(devDir?: string, mode: SessionIdentityPersistenceMode = sessionIdentityPersistenceMode()) {
    this.path = sessionIdentityStorePath(devDir);
    this.mode = mode;
  }

  list(): SessionIdentity[] {
    return this.read().sessions;
  }

  getByName(name: string): SessionIdentity | undefined {
    return this.list().find((s) => s.wolfpackSessionName === name);
  }

  capture(input: CaptureSessionIdentityInput): SessionIdentity {
    const now = (input.now ?? new Date()).toISOString();
    const file = this.read();
    const existingIndex = file.sessions.findIndex((s) => s.wolfpackSessionId === input.wolfpackSessionId);
    const existing = existingIndex >= 0 ? file.sessions[existingIndex] : undefined;
    const externalAgent = normalizeExternalAgent(input, existing, now);
    const parentSession = input.parentSession ?? existing?.parentSession;
    const next: SessionIdentity = {
      schemaVersion: SESSION_IDENTITY_SCHEMA_VERSION,
      wolfpackSessionId: input.wolfpackSessionId,
      wolfpackSessionName: input.wolfpackSessionName,
      projectPath: input.projectPath,
      agentKind: input.agentKind || existing?.agentKind || CUSTOM_AGENT_KIND,
      createdAt: existing?.createdAt ?? now,
      restoredAt: existing ? now : undefined,
      updatedAt: now,
      ...(parentSession && { parentSession }),
      ...(externalAgent && { externalAgent }),
    };
    if (existingIndex >= 0) file.sessions[existingIndex] = next;
    else file.sessions.push(next);
    this.write(file);
    return next;
  }

  restore(activeSessions: Array<{
    wolfpackSessionId: string;
    wolfpackSessionName: string;
    projectPath: string;
    agentKind?: AgentKind | string;
    externalAgent?: CaptureSessionIdentityInput["externalAgent"];
    parentSession?: ParentSessionIdentity;
  }>, now: Date = new Date()): SessionIdentity[] {
    const file = this.read();
    const byId = new Map(file.sessions.map((s) => [s.wolfpackSessionId, s]));
    const restoredAt = now.toISOString();
    const next: SessionIdentity[] = [];
    for (const session of activeSessions) {
      const existing = byId.get(session.wolfpackSessionId);
      const candidateExternalAgent = normalizeExternalAgent(
        {
          ...session,
          agentKind: session.agentKind ?? existing?.agentKind ?? CUSTOM_AGENT_KIND,
          externalAgent: session.externalAgent,
        },
        existing,
        restoredAt,
      );
      const candidate: SessionIdentity = {
        schemaVersion: SESSION_IDENTITY_SCHEMA_VERSION,
        wolfpackSessionId: session.wolfpackSessionId,
        wolfpackSessionName: session.wolfpackSessionName,
        projectPath: session.projectPath,
        agentKind: session.agentKind ?? existing?.agentKind ?? CUSTOM_AGENT_KIND,
        createdAt: existing?.createdAt ?? restoredAt,
        restoredAt: existing?.restoredAt ?? restoredAt,
        updatedAt: existing?.updatedAt ?? restoredAt,
        ...((session.parentSession ?? existing?.parentSession) && {
          parentSession: session.parentSession ?? existing?.parentSession,
        }),
        ...(candidateExternalAgent && { externalAgent: candidateExternalAgent }),
      };
      if (existing && sameIdentityIgnoringTimestamps(existing, candidate)) {
        next.push(existing);
      } else {
        next.push({ ...candidate, restoredAt, updatedAt: restoredAt });
      }
    }

    if (!sameIdentitySet(file.sessions, next)) this.write({ schemaVersion: SESSION_IDENTITY_SCHEMA_VERSION, sessions: next });
    return next;
  }

  deleteByName(name: string): void {
    const file = this.read();
    const next = file.sessions.filter((s) => s.wolfpackSessionName !== name);
    if (next.length !== file.sessions.length) {
      this.write({ schemaVersion: SESSION_IDENTITY_SCHEMA_VERSION, sessions: next });
    }
  }

  deleteAll(): void {
    this.memory = emptyStore();
    if (this.mode === "private") rmSync(this.path, { force: true });
  }

  private read(): IdentityStoreFile {
    if (this.mode === "memory") return structuredClone(this.memory);
    return readValidatedJsonFile(this.path, "session identity", isStoreFile) ?? emptyStore();
  }

  private write(file: IdentityStoreFile): void {
    if (this.mode === "memory") {
      this.memory = structuredClone(file);
      return;
    }
    writePrivateJsonFile(this.path, file);
  }
}

function normalizeExternalAgent(
  input: CaptureSessionIdentityInput,
  existing: SessionIdentity | undefined,
  now: string,
): ExternalAgentIdentity | undefined {
  const id = input.externalAgent?.id?.trim();
  if (!id) return existing?.externalAgent;
  return {
    provider: input.externalAgent?.provider || input.agentKind,
    id,
    source: input.externalAgent!.source,
    capturedAt: now,
  };
}

function emptyStore(): IdentityStoreFile {
  return { schemaVersion: SESSION_IDENTITY_SCHEMA_VERSION, sessions: [] };
}

function isStoreFile(value: unknown): value is IdentityStoreFile {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== SESSION_IDENTITY_SCHEMA_VERSION) return false;
  if (!Array.isArray(obj.sessions)) return false;
  return obj.sessions.every(isSessionIdentity);
}

function isSessionIdentity(value: unknown): value is SessionIdentity {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return obj.schemaVersion === SESSION_IDENTITY_SCHEMA_VERSION
    && typeof obj.wolfpackSessionId === "string"
    && typeof obj.wolfpackSessionName === "string"
    && typeof obj.projectPath === "string"
    && typeof obj.agentKind === "string"
    && typeof obj.createdAt === "string"
    && typeof obj.updatedAt === "string"
    && (obj.parentSession === undefined || isParentSessionIdentity(obj.parentSession));
}

function isParentSessionIdentity(value: unknown): value is ParentSessionIdentity {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.wolfpackSessionId === "string"
    && typeof obj.wolfpackSessionName === "string";
}

function sameIdentitySet(a: SessionIdentity[], b: SessionIdentity[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameIdentityIgnoringTimestamps(a: SessionIdentity, b: SessionIdentity): boolean {
  const left = { ...a, restoredAt: undefined, updatedAt: undefined };
  const right = { ...b, restoredAt: undefined, updatedAt: undefined };
  return JSON.stringify(left) === JSON.stringify(right);
}

let singleton: SessionIdentityStore | null = null;

export function getSessionIdentityStore(): SessionIdentityStore {
  if (!singleton) singleton = new SessionIdentityStore();
  return singleton;
}

export function __resetSessionIdentityStoreForTest(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__resetSessionIdentityStoreForTest() is test-only");
  singleton = null;
}

export function __sessionIdentityStoreFileExistsForTest(devDir: string): boolean {
  if (!process.env.WOLFPACK_TEST) throw new Error("__sessionIdentityStoreFileExistsForTest() is test-only");
  return existsSync(sessionIdentityStorePath(devDir));
}
