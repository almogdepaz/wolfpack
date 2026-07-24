import {
  ACTIVE_RALPH_WORKTREE_MODES,
  RALPH_WORKTREE_MODE,
} from "../ralph-worktree-mode.ts";
import { RALPH_RESPONSE_VERSION } from "../ralph-response.ts";
import { TERMINAL_PREFILL_MODES } from "../terminal-prefill.ts";
import {
  OPENABLE_HARNESSES,
  SESSION_OPEN_ERROR,
  SESSION_OPEN_HTTP_STATUS,
} from "../session-open-contract.ts";
import {
  MAX_NAMED_VIEW_ID_LENGTH,
  MAX_NAMED_VIEW_MACHINE_URL_LENGTH,
  MAX_NAMED_VIEW_MEMBERS,
  MAX_NAMED_VIEW_NAME_CODE_POINTS,
  MAX_NAMED_VIEW_SESSION_ID_LENGTH,
  MAX_NAMED_VIEW_SESSION_NAME_CODE_POINTS,
  NAMED_VIEW_SCHEMA_VERSION,
} from "../named-views.ts";
import type { SessionOpenErrorCode } from "../session-open-contract.ts";
import { MAX_INITIAL_PROMPT_LENGTH } from "../validation.ts";

export const CONTROL_API_SCHEMA_VERSION = "1.0.0";
export const CONTROL_API_SCHEMA_ARTIFACT = "docs/generated/control-api.schema.json";

type JsonSchema = {
  readonly [key: string]: unknown;
};

type HttpRouteContract = {
  readonly operationId: string;
  readonly stable: boolean;
  readonly auth: "public" | "jwt-when-configured";
  readonly request?: JsonSchema;
  readonly response: JsonSchema;
  readonly errors: readonly string[];
};

type WebSocketMessageContract = {
  readonly stable: boolean;
  readonly direction: "client-to-server" | "server-to-client";
  readonly schema: JsonSchema;
};

type ControlApiSource = {
  readonly schemaVersion: typeof CONTROL_API_SCHEMA_VERSION;
  readonly artifactPath: typeof CONTROL_API_SCHEMA_ARTIFACT;
  readonly ownership: {
    readonly schemaSource: string;
    readonly runtimeSource: string;
    readonly generatedArtifact: string;
    readonly compatibilityDocs: string;
  };
  readonly trustBoundaries: readonly string[];
  readonly http: Record<string, HttpRouteContract>;
  readonly websocket: {
    readonly "/ws/pty": {
      readonly auth: "jwt-when-configured";
      readonly query: JsonSchema;
      readonly messages: Record<string, WebSocketMessageContract>;
    };
  };
  readonly ralph: {
    readonly responseFile: {
      readonly path: ".ralph-response.json";
      readonly schema: JsonSchema;
    };
  };
  readonly defs: Record<string, JsonSchema>;
};

const string = (description?: string): JsonSchema => ({
  type: "string",
  ...(description ? { description } : {}),
});

const number = (description?: string): JsonSchema => ({
  type: "number",
  ...(description ? { description } : {}),
});

const integer = (description?: string): JsonSchema => ({
  type: "integer",
  ...(description ? { description } : {}),
});

const boolean = (description?: string): JsonSchema => ({
  type: "boolean",
  ...(description ? { description } : {}),
});

const arrayOf = (items: JsonSchema): JsonSchema => ({
  type: "array",
  items,
});

const nullable = (schema: JsonSchema): JsonSchema => ({
  anyOf: [schema, { type: "null" }],
});

const ref = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });

function sessionOpenErrorLines(): readonly string[] {
  const codesByStatus = new Map<number, SessionOpenErrorCode[]>();
  for (const code of Object.values(SESSION_OPEN_ERROR)) {
    const status = SESSION_OPEN_HTTP_STATUS[code];
    const codes = codesByStatus.get(status) ?? [];
    codes.push(code);
    codesByStatus.set(status, codes);
  }
  return [...codesByStatus.entries()]
    .sort(([left], [right]) => left - right)
    .map(([status, codes]) => `${status} ${codes.sort().join("|")}`);
}

const object = (
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
  extra: { readonly description?: string; readonly additionalProperties?: boolean } = {},
): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: extra.additionalProperties ?? false,
  ...(extra.description ? { description: extra.description } : {}),
});

const ok = object({ ok: boolean() }, ["ok"]);
const error = ref("ErrorEnvelope");

export const controlApiSource: ControlApiSource = {
  schemaVersion: CONTROL_API_SCHEMA_VERSION,
  artifactPath: CONTROL_API_SCHEMA_ARTIFACT,
  ownership: {
    schemaSource: "src/control-api/schema.ts",
    runtimeSource: "src/server/routes.ts",
    generatedArtifact: CONTROL_API_SCHEMA_ARTIFACT,
    compatibilityDocs: "docs/control-api-schema.md",
  },
  trustBoundaries: [
    "schemas publish public client contracts; they do not replace route-side project/session/path validation",
    "filesystem containment remains in src/server/validate-project-dir.ts and src/validation.ts",
    "broker wire compatibility remains covered by broker codec/protocol tests, not by this schema",
    "peer Ralph aggregation still sanitizes remote loop entries before exposing them to clients",
    "session-open follows ordinary global JWT policy when configured and adds no inter-session authorization layer",
    "named-view machineUrl is a stored HTTPS tailnet origin only; clients must resolve members by (machineUrl, sessionId), never by display name",
  ],
  defs: {
    ErrorEnvelope: object({ error: string() }, ["error"], { additionalProperties: true }),
    SessionName: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
    SessionId: {
      ...string("Stable opaque broker session identifier"),
      minLength: 1,
    },
    SessionSelector: {
      ...string("Active session name or stable opaque session identifier"),
      minLength: 1,
    },
    ProjectName: { type: "string", pattern: "^[a-zA-Z0-9._-]+$" },
    PlanFile: {
      type: "string",
      pattern: "^(?:[a-zA-Z0-9._-]+\\.md|\\.plans/[a-zA-Z0-9._-]+\\.md)$",
    },
    BranchName: { type: "string", pattern: "^[A-Za-z0-9._/-]+$" },
    Command: { type: "string", minLength: 1 },
    OpenableHarness: { enum: [...OPENABLE_HARNESSES] },
    TriageStatus: { enum: ["running", "idle"] },
    ParentSessionIdentity: object({
      wolfpackSessionId: string(),
      wolfpackSessionName: ref("SessionName"),
    }, ["wolfpackSessionId", "wolfpackSessionName"]),
    PublicSessionIdentity: object({
      wolfpackSessionId: string(),
      wolfpackSessionName: ref("SessionName"),
      projectPath: string(),
      agentKind: string(),
      createdAt: string(),
      restoredAt: string(),
      updatedAt: string(),
      parentSession: ref("ParentSessionIdentity"),
      externalAgent: object({
        provider: string(),
        redactedId: string(),
        capturedAt: string(),
        source: { enum: ["env", "broker_env", "ralph_launch"] },
      }, ["provider", "redactedId", "capturedAt", "source"]),
    }, ["wolfpackSessionId", "wolfpackSessionName", "projectPath", "agentKind", "createdAt", "updatedAt"]),
    NamedViewId: {
      ...string("Server-generated opaque named-view identifier"),
      minLength: 1,
      maxLength: MAX_NAMED_VIEW_ID_LENGTH,
    },
    NamedViewName: {
      ...string("Trimmed display name; 1..64 Unicode code points at runtime"),
      minLength: 1,
      maxLength: MAX_NAMED_VIEW_NAME_CODE_POINTS,
    },
    NamedViewSessionId: {
      ...string("Stable opaque local or peer session identifier"),
      minLength: 1,
      maxLength: MAX_NAMED_VIEW_SESSION_ID_LENGTH,
    },
    NamedViewSessionName: {
      ...string("Last-known display hint only; never sufficient for matching"),
      minLength: 1,
      maxLength: MAX_NAMED_VIEW_SESSION_NAME_CODE_POINTS,
    },
    NamedViewMachineUrl: {
      ...string("Empty string for local machine or HTTPS tailnet origin for a peer"),
      maxLength: MAX_NAMED_VIEW_MACHINE_URL_LENGTH,
    },
    NamedViewMemberReference: object({
      machineUrl: ref("NamedViewMachineUrl"),
      sessionId: ref("NamedViewSessionId"),
      sessionName: ref("NamedViewSessionName"),
    }, ["machineUrl", "sessionId", "sessionName"]),
    NamedViewFocusReference: object({
      machineUrl: ref("NamedViewMachineUrl"),
      sessionId: ref("NamedViewSessionId"),
    }, ["machineUrl", "sessionId"]),
    NamedViewInput: object({
      name: ref("NamedViewName"),
      members: {
        ...arrayOf(ref("NamedViewMemberReference")),
        minItems: 1,
        maxItems: MAX_NAMED_VIEW_MEMBERS,
      },
      focused: ref("NamedViewFocusReference"),
    }, ["name", "members"]),
    NamedViewUpdateInput: object({
      id: ref("NamedViewId"),
      name: ref("NamedViewName"),
      members: {
        ...arrayOf(ref("NamedViewMemberReference")),
        minItems: 1,
        maxItems: MAX_NAMED_VIEW_MEMBERS,
      },
      focused: ref("NamedViewFocusReference"),
    }, ["id", "name", "members"]),
    NamedViewDeleteInput: object({ id: ref("NamedViewId") }, ["id"]),
    NamedViewRecord: object({
      schemaVersion: { const: NAMED_VIEW_SCHEMA_VERSION },
      id: ref("NamedViewId"),
      name: ref("NamedViewName"),
      members: {
        ...arrayOf(ref("NamedViewMemberReference")),
        minItems: 1,
        maxItems: MAX_NAMED_VIEW_MEMBERS,
      },
      focused: ref("NamedViewFocusReference"),
      createdAt: string(),
      updatedAt: string(),
    }, ["schemaVersion", "id", "name", "members", "createdAt", "updatedAt"]),
    PrefillMode: { enum: [...TERMINAL_PREFILL_MODES] },
    WorktreeMode: { enum: [false, ...Object.values(RALPH_WORKTREE_MODE)] },
    CmdEntry: object({
      cmd: ref("Command"),
      enabled: boolean(),
    }, ["cmd", "enabled"]),
    Settings: object({
      agentCmd: string(),
      cmds: arrayOf(ref("CmdEntry")),
    }, ["agentCmd", "cmds"]),
    EffectiveSettings: object({
      agentCmd: string(),
      cmds: arrayOf(ref("Command")),
      ralphAgents: arrayOf(string()),
    }, ["agentCmd", "cmds", "ralphAgents"]),
    SessionSummary: object({
      name: ref("SessionName"),
      lastLine: string(),
      triage: ref("TriageStatus"),
      identity: ref("PublicSessionIdentity"),
    }, ["name", "lastLine", "triage"]),
    SessionControlIdentity: object({
      session: ref("SessionName"),
      sessionId: ref("SessionId"),
    }, ["session", "sessionId"]),
    SessionStatus: object({
      ok: { const: true },
      session: ref("SessionName"),
      sessionId: ref("SessionId"),
      state: { const: "active" },
      projectPath: string(),
      harness: string(),
      parentSession: ref("SessionControlIdentity"),
    }, ["ok", "session", "sessionId", "state", "projectPath", "harness"]),
    Peer: object({
      name: string(),
      url: string(),
    }, ["name", "url"], { additionalProperties: true }),
    RalphLoop: object({
      project: string(),
      active: boolean(),
      completed: boolean(),
      audit: boolean(),
      cleanup: boolean(),
      cleanupEnabled: boolean(),
      auditFixEnabled: boolean(),
      iteration: integer(),
      totalIterations: integer(),
      agent: string(),
      planFile: string(),
      progressFile: string(),
      started: string(),
      finished: string(),
      lastOutput: string(),
      pid: integer(),
      tasksDone: integer(),
      tasksTotal: integer(),
      worktreeMode: string(),
      worktreeBranch: string(),
      sandbox: string(),
      machineName: string(),
      machineUrl: string(),
    }, [
      "project",
      "active",
      "completed",
      "audit",
      "cleanup",
      "cleanupEnabled",
      "auditFixEnabled",
      "iteration",
      "totalIterations",
      "agent",
      "planFile",
      "progressFile",
      "started",
      "finished",
      "lastOutput",
      "pid",
      "tasksDone",
      "tasksTotal",
      "worktreeMode",
      "worktreeBranch",
    ], { additionalProperties: true }),
    TaskCount: object({
      done: integer(),
      total: integer(),
      issues: arrayOf(string()),
    }, ["done", "total", "issues"]),
    PushSubscription: object({
      endpoint: string(),
      keys: object({
        p256dh: string(),
        auth: string(),
      }, ["p256dh", "auth"]),
    }, ["endpoint", "keys"]),
    RalphIterationResponse: object({
      version: { const: RALPH_RESPONSE_VERSION },
      status: { enum: ["done", "needs_subtasks"] },
      prereqs: arrayOf(string()),
      tests: arrayOf(string()),
      done: arrayOf(string()),
      subtasks: arrayOf(string()),
    }, ["version", "status", "prereqs", "tests", "done", "subtasks"]),
  },
  http: {
    "GET /api/info": {
      operationId: "getInfo",
      stable: true,
      auth: "public",
      response: object({
        name: string(),
        version: string(),
      }, ["name", "version"]),
      errors: [],
    },
    "GET /api/sessions": {
      operationId: "listSessions",
      stable: true,
      auth: "jwt-when-configured",
      response: object({ sessions: arrayOf(ref("SessionSummary")) }, ["sessions"]),
      errors: [],
    },
    "GET /api/projects": {
      operationId: "listProjects",
      stable: true,
      auth: "jwt-when-configured",
      response: object({ projects: arrayOf(ref("ProjectName")) }, ["projects"]),
      errors: [],
    },
    "GET /api/named-views": {
      operationId: "listNamedViews",
      stable: true,
      auth: "jwt-when-configured",
      response: object({ views: arrayOf(ref("NamedViewRecord")) }, ["views"]),
      errors: ["500 ErrorEnvelope"],
    },
    "POST /api/named-views": {
      operationId: "createNamedView",
      stable: true,
      auth: "jwt-when-configured",
      request: ref("NamedViewInput"),
      response: object({ view: ref("NamedViewRecord") }, ["view"]),
      errors: ["400 ErrorEnvelope", "409 ErrorEnvelope", "500 ErrorEnvelope"],
    },
    "PUT /api/named-views": {
      operationId: "updateNamedView",
      stable: true,
      auth: "jwt-when-configured",
      request: ref("NamedViewUpdateInput"),
      response: object({ view: ref("NamedViewRecord") }, ["view"]),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope", "409 ErrorEnvelope", "500 ErrorEnvelope"],
    },
    "DELETE /api/named-views": {
      operationId: "deleteNamedView",
      stable: true,
      auth: "jwt-when-configured",
      request: ref("NamedViewDeleteInput"),
      response: object({
        ok: { const: true },
        id: ref("NamedViewId"),
      }, ["ok", "id"]),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope", "500 ErrorEnvelope"],
    },
    "GET /api/next-session-name": {
      operationId: "nextSessionName",
      stable: true,
      auth: "jwt-when-configured",
      request: object({ project: ref("ProjectName") }, ["project"]),
      response: object({ name: ref("SessionName") }, ["name"]),
      errors: ["400 ErrorEnvelope"],
    },
    "POST /api/create": {
      operationId: "createSession",
      stable: true,
      auth: "jwt-when-configured",
      request: {
        ...object({
          project: ref("ProjectName"),
          newProject: ref("ProjectName"),
          cmd: ref("Command"),
          sessionName: ref("SessionName"),
          parentSession: ref("SessionName"),
          initialPrompt: {
            type: "string",
            minLength: 1,
            maxLength: MAX_INITIAL_PROMPT_LENGTH,
          },
        }),
        anyOf: [
          object({}, ["project"], { additionalProperties: true }),
          object({}, ["newProject"], { additionalProperties: true }),
        ],
      },
      response: object({
        ok: boolean(),
        session: ref("SessionName"),
      }, ["ok", "session"]),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope", "409 ErrorEnvelope", "503 ErrorEnvelope"],
    },
    "POST /api/session-create": {
      operationId: "createTopLevelSession",
      stable: true,
      auth: "jwt-when-configured",
      request: object({
        project: ref("ProjectName"),
        harness: ref("OpenableHarness"),
        initialPrompt: {
          type: "string",
          minLength: 1,
          maxLength: MAX_INITIAL_PROMPT_LENGTH,
        },
      }, ["project"]),
      response: object({
        ok: { const: true },
        session: ref("SessionName"),
        sessionId: ref("SessionId"),
        project: ref("ProjectName"),
        harness: string(),
      }, ["ok", "session", "sessionId", "project", "harness"]),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope", "409 ErrorEnvelope", "503 ErrorEnvelope"],
    },
    "POST /api/session-open": {
      operationId: "openSession",
      stable: true,
      auth: "jwt-when-configured",
      request: object({
        project: ref("ProjectName"),
        parentSession: ref("SessionName"),
        initialPrompt: {
          type: "string",
          minLength: 1,
          maxLength: MAX_INITIAL_PROMPT_LENGTH,
        },
      }, ["project", "parentSession"]),
      response: object({
        ok: { const: true },
        session: ref("SessionName"),
        sessionId: ref("SessionId"),
        project: ref("ProjectName"),
        harness: ref("OpenableHarness"),
      }, ["ok", "session", "sessionId", "project", "harness"]),
      errors: sessionOpenErrorLines(),
    },
    "GET /api/settings": {
      operationId: "getSettings",
      stable: true,
      auth: "jwt-when-configured",
      response: object({
        settings: ref("Settings"),
        effective: ref("EffectiveSettings"),
      }, ["settings", "effective"]),
      errors: [],
    },
    "POST /api/settings": {
      operationId: "updateSettings",
      stable: true,
      auth: "jwt-when-configured",
      request: object({
        agentCmd: ref("Command"),
        addCmd: ref("Command"),
        removeCmd: ref("Command"),
        setCmdEnabled: object({
          cmd: ref("Command"),
          enabled: boolean(),
        }, ["cmd", "enabled"]),
      }),
      response: object({
        ok: boolean(),
        settings: ref("Settings"),
        effective: ref("EffectiveSettings"),
      }, ["ok", "settings", "effective"]),
      errors: ["400 ErrorEnvelope"],
    },
    "GET /api/backend": {
      operationId: "getBackendStatus",
      stable: true,
      auth: "jwt-when-configured",
      response: object({
        brokerAvailable: boolean(),
        counts: object({
          tmux: integer(),
          broker: integer(),
        }, ["tmux", "broker"]),
      }, ["brokerAvailable", "counts"]),
      errors: [],
    },
    "POST /api/kill": {
      operationId: "killSession",
      stable: true,
      auth: "jwt-when-configured",
      request: object({ session: ref("SessionSelector") }, ["session"]),
      response: object({
        ok: { const: true },
        session: ref("SessionName"),
        sessionId: ref("SessionId"),
      }, ["ok", "session", "sessionId"]),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope", "409 ErrorEnvelope", "503 ErrorEnvelope"],
    },
    "GET /api/session-control/list": {
      operationId: "listSessionStatuses",
      stable: true,
      auth: "jwt-when-configured",
      response: object({ sessions: arrayOf(ref("SessionStatus")) }, ["sessions"]),
      errors: ["503 ErrorEnvelope"],
    },
    "GET /api/session-control/status": {
      operationId: "getSessionStatus",
      stable: true,
      auth: "jwt-when-configured",
      request: object({ session: ref("SessionSelector") }, ["session"]),
      response: ref("SessionStatus"),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope", "409 ErrorEnvelope", "503 ErrorEnvelope"],
    },
    "GET /api/session-control/read": {
      operationId: "readSession",
      stable: true,
      auth: "jwt-when-configured",
      request: object({ session: ref("SessionSelector") }, ["session"]),
      response: object({
        session: ref("SessionName"),
        sessionId: ref("SessionId"),
        output: string(),
      }, ["session", "sessionId", "output"]),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope", "409 ErrorEnvelope", "503 ErrorEnvelope"],
    },
    "POST /api/session-control/send": {
      operationId: "sendSessionInput",
      stable: true,
      auth: "jwt-when-configured",
      request: object({
        session: ref("SessionSelector"),
        text: string(),
        noEnter: boolean(),
      }, ["session", "text"]),
      response: object({
        ok: { const: true },
        session: ref("SessionName"),
        sessionId: ref("SessionId"),
      }, ["ok", "session", "sessionId"]),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope", "409 ErrorEnvelope", "503 ErrorEnvelope"],
    },
    "POST /api/session-control/wait": {
      operationId: "waitForSessionText",
      stable: true,
      auth: "jwt-when-configured",
      request: object({
        session: ref("SessionSelector"),
        text: string(),
        timeoutMs: integer(),
      }, ["session", "text"]),
      response: object({
        ok: { const: true },
        session: ref("SessionName"),
        sessionId: ref("SessionId"),
        matched: { const: true },
      }, ["ok", "session", "sessionId", "matched"]),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope", "408 ErrorEnvelope", "409 ErrorEnvelope", "503 ErrorEnvelope"],
    },
    "POST /api/resize": {
      operationId: "resizeSession",
      stable: true,
      auth: "jwt-when-configured",
      request: object({
        session: ref("SessionName"),
        cols: integer(),
        rows: integer(),
      }, ["session", "cols", "rows"]),
      response: ok,
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope"],
    },
    "GET /api/discover": {
      operationId: "discoverPeers",
      stable: true,
      auth: "jwt-when-configured",
      response: object({
        peers: arrayOf(ref("Peer")),
        error: string(),
      }, ["peers"]),
      errors: [],
    },
    "GET /api/poll": {
      operationId: "capturePane",
      stable: false,
      auth: "jwt-when-configured",
      request: object({ session: ref("SessionName") }, ["session"]),
      response: object({ pane: string() }, ["pane"]),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope"],
    },
    "GET /api/copy-text": {
      operationId: "copyText",
      stable: true,
      auth: "jwt-when-configured",
      request: object({ session: ref("SessionName") }, ["session"]),
      response: { type: "string", contentMediaType: "text/plain" },
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope"],
    },
    "GET /api/git-status": {
      operationId: "getGitStatus",
      stable: true,
      auth: "jwt-when-configured",
      request: object({ session: ref("ProjectName") }, ["session"]),
      response: object({ status: string() }, ["status"]),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope", "500 ErrorEnvelope"],
    },
    "GET /api/ralph": {
      operationId: "listRalphLoops",
      stable: true,
      auth: "jwt-when-configured",
      request: object({ aggregate: boolean() }),
      response: object({ loops: arrayOf(ref("RalphLoop")) }, ["loops"]),
      errors: [],
    },
    "GET /api/ralph/branches": {
      operationId: "listRalphBranches",
      stable: true,
      auth: "jwt-when-configured",
      request: object({ project: ref("ProjectName") }, ["project"]),
      response: object({
        branches: arrayOf(ref("BranchName")),
        current: string(),
      }, ["branches", "current"]),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope", "500 ErrorEnvelope"],
    },
    "GET /api/ralph/plans": {
      operationId: "listRalphPlans",
      stable: true,
      auth: "jwt-when-configured",
      request: object({ project: ref("ProjectName") }, ["project"]),
      response: object({ plans: arrayOf(ref("PlanFile")) }, ["plans"]),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope"],
    },
    "GET /api/ralph/log": {
      operationId: "getRalphLog",
      stable: true,
      auth: "jwt-when-configured",
      request: object({ project: ref("ProjectName") }, ["project"]),
      response: object({
        log: string(),
        totalLines: integer(),
      }, ["log", "totalLines"]),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope", "500 ErrorEnvelope"],
    },
    "POST /api/ralph/start": {
      operationId: "startRalph",
      stable: true,
      auth: "jwt-when-configured",
      request: object({
        project: ref("ProjectName"),
        iterations: integer(),
        planFile: ref("PlanFile"),
        agent: string(),
        newBranch: ref("BranchName"),
        sourceBranch: ref("BranchName"),
        format: boolean(),
        cleanup: boolean(),
        auditFix: boolean(),
        worktree: ref("WorktreeMode"),
        worktreeBranch: ref("BranchName"),
        worktreeBase: ref("BranchName"),
        sandbox: boolean(),
      }, ["project"]),
      response: object({
        ok: boolean(),
        pid: integer(),
        branch: string(),
        worktree: { enum: [...ACTIVE_RALPH_WORKTREE_MODES] },
      }, ["ok", "pid"]),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope", "409 ErrorEnvelope", "500 ErrorEnvelope"],
    },
    "GET /api/ralph/task-count": {
      operationId: "getRalphTaskCount",
      stable: true,
      auth: "jwt-when-configured",
      request: object({
        project: ref("ProjectName"),
        plan: ref("PlanFile"),
      }, ["project", "plan"]),
      response: ref("TaskCount"),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope"],
    },
    "POST /api/ralph/cancel": {
      operationId: "cancelRalph",
      stable: true,
      auth: "jwt-when-configured",
      request: object({ project: ref("ProjectName") }, ["project"]),
      response: object({
        ok: boolean(),
        killed: integer(),
      }, ["ok", "killed"]),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope", "500 ErrorEnvelope"],
    },
    "POST /api/ralph/dismiss": {
      operationId: "dismissRalph",
      stable: true,
      auth: "jwt-when-configured",
      request: object({
        project: ref("ProjectName"),
        deletePlan: boolean(),
      }, ["project"]),
      response: object({
        ok: boolean(),
        deleted: arrayOf(string()),
        failed: arrayOf(string()),
        worktreeCleanup: object({
          removed: arrayOf(string()),
          kept: string(),
        }, ["removed", "kept"]),
      }, ["ok", "deleted", "failed"]),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope", "409 ErrorEnvelope"],
    },
    "GET /api/push/vapid-key": {
      operationId: "getVapidPublicKey",
      stable: true,
      auth: "jwt-when-configured",
      response: object({ publicKey: nullable(string()) }, ["publicKey"]),
      errors: [],
    },
    "POST /api/push/subscribe": {
      operationId: "subscribePush",
      stable: true,
      auth: "jwt-when-configured",
      request: ref("PushSubscription"),
      response: ok,
      errors: ["400 ErrorEnvelope", "429 ErrorEnvelope"],
    },
    "POST /api/push/unsubscribe": {
      operationId: "unsubscribePush",
      stable: true,
      auth: "jwt-when-configured",
      request: object({ endpoint: string() }, ["endpoint"]),
      response: ok,
      errors: ["400 ErrorEnvelope"],
    },
    "POST /api/notify": {
      operationId: "sendNotification",
      stable: true,
      auth: "jwt-when-configured",
      request: object({ message: string() }, ["message"]),
      response: object({
        ok: boolean(),
        sent: integer(),
        failed: integer(),
      }, ["ok"], { additionalProperties: true }),
      errors: ["400 ErrorEnvelope", "429 ErrorEnvelope"],
    },
  },
  websocket: {
    "/ws/pty": {
      auth: "jwt-when-configured",
      query: object({
        session: ref("SessionName"),
        reset: boolean(),
        token: string(),
      }, ["session"]),
      messages: {
        attach: {
          stable: true,
          direction: "client-to-server",
          schema: object({
            type: { const: "attach" },
            cols: integer(),
            rows: integer(),
            skipPrefill: boolean(),
            prefillMode: ref("PrefillMode"),
            takeControl: boolean(),
          }, ["type", "cols", "rows"]),
        },
        layout_stable: {
          stable: true,
          direction: "client-to-server",
          schema: object({
            type: { const: "layout_stable" },
            cols: integer(),
            rows: integer(),
          }, ["type", "cols", "rows"]),
        },
        resize: {
          stable: true,
          direction: "client-to-server",
          schema: object({
            type: { const: "resize" },
            cols: integer(),
            rows: integer(),
          }, ["type", "cols", "rows"]),
        },
        take_control: {
          stable: true,
          direction: "client-to-server",
          schema: object({ type: { const: "take_control" } }, ["type"]),
        },
        attach_ack: {
          stable: true,
          direction: "server-to-client",
          schema: object({ type: { const: "attach_ack" } }, ["type"]),
        },
        prefill_done: {
          stable: true,
          direction: "server-to-client",
          schema: object({ type: { const: "prefill_done" } }, ["type"]),
        },
        prefill_viewport: {
          stable: true,
          direction: "server-to-client",
          schema: object({ type: { const: "prefill_viewport" } }, ["type"]),
        },
        pty_ready: {
          stable: true,
          direction: "server-to-client",
          schema: object({ type: { const: "pty_ready" } }, ["type"]),
        },
        viewer_conflict: {
          stable: true,
          direction: "server-to-client",
          schema: object({ type: { const: "viewer_conflict" } }, ["type"]),
        },
        control_granted: {
          stable: true,
          direction: "server-to-client",
          schema: object({ type: { const: "control_granted" } }, ["type"]),
        },
        sub_session_opened: {
          stable: true,
          direction: "server-to-client",
          schema: object({
            type: { const: "sub_session_opened" },
            parentSession: ref("SessionName"),
            session: ref("SessionName"),
          }, ["type", "parentSession", "session"]),
        },
      },
    },
  },
  ralph: {
    responseFile: {
      path: ".ralph-response.json",
      schema: ref("RalphIterationResponse"),
    },
  },
};

function schemaWithId(schema: JsonSchema, id: string, title: string): JsonSchema {
  return {
    $id: id,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title,
    ...schema,
  };
}

function httpOperationSchemas(source: ControlApiSource): Record<string, unknown> {
  const operations: Record<string, unknown> = {};
  for (const [route, contract] of Object.entries(source.http)) {
    operations[contract.operationId] = {
      route,
      stable: contract.stable,
      auth: contract.auth,
      request: contract.request
        ? schemaWithId(contract.request, `wolfpack:control-api:http:${contract.operationId}:request`, `${contract.operationId} request`)
        : undefined,
      response: schemaWithId(contract.response, `wolfpack:control-api:http:${contract.operationId}:response`, `${contract.operationId} response`),
      errors: contract.errors,
    };
  }
  return operations;
}

function wsMessageSchemas(source: ControlApiSource): Record<string, unknown> {
  const messages: Record<string, unknown> = {};
  for (const [name, contract] of Object.entries(source.websocket["/ws/pty"].messages)) {
    messages[name] = {
      stable: contract.stable,
      direction: contract.direction,
      schema: schemaWithId(contract.schema, `wolfpack:control-api:ws:pty:${name}`, `/ws/pty ${name}`),
    };
  }
  return messages;
}

export function buildControlApiSchema(): JsonSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "wolfpack:control-api",
    title: "Wolfpack public control API and event stream schema",
    type: "object",
    version: controlApiSource.schemaVersion,
    generatedFrom: controlApiSource.ownership.schemaSource,
    artifactPath: controlApiSource.artifactPath,
    compatibility: {
      additiveChanges: [
        "new optional object properties",
        "new stable operations",
        "new server-to-client event message types",
      ],
      breakingChanges: [
        "removing or renaming stable operations, fields, or message types",
        "making optional fields required",
        "changing auth expectations",
        "tightening enum/pattern constraints for stable fields",
      ],
    },
    ownership: controlApiSource.ownership,
    trustBoundaries: controlApiSource.trustBoundaries,
    http: httpOperationSchemas(controlApiSource),
    websocket: {
      "/ws/pty": {
        auth: controlApiSource.websocket["/ws/pty"].auth,
        query: schemaWithId(controlApiSource.websocket["/ws/pty"].query, "wolfpack:control-api:ws:pty:query", "/ws/pty query"),
        messages: wsMessageSchemas(controlApiSource),
        binaryFrames: {
          "client-to-server": "raw PTY input bytes, capped by runtime MAX_PTY_BINARY_BYTES",
          "server-to-client": "raw PTY output/prefill bytes",
        },
      },
    },
    ralph: {
      responseFile: {
        path: controlApiSource.ralph.responseFile.path,
        schema: schemaWithId(controlApiSource.ralph.responseFile.schema, "wolfpack:control-api:ralph:response-file", "Ralph structured response file"),
      },
    },
    $defs: controlApiSource.defs,
  };
}
