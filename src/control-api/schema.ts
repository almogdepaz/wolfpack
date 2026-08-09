import { CREATABLE_HARNESSES } from "../agent-kind.ts";
import { TERMINAL_PREFILL_MODES } from "../terminal-prefill.ts";
import {
  OPENABLE_HARNESSES,
  SESSION_OPEN_ERROR,
  SESSION_OPEN_HTTP_STATUS,
} from "../session-open-contract.ts";
import type { SessionOpenErrorCode } from "../session-open-contract.ts";
import {
  SESSION_STATUS_ERROR,
  SESSION_STATUS_ERROR_MESSAGE_MAX_CODE_POINTS,
  SESSION_TERMINAL_STATUSES,
} from "../session-status-contract.ts";
import { MAX_INITIAL_PROMPT_LENGTH } from "../validation.ts";
import {
  SESSION_PROMPT_MAX_TIMEOUT_MS,
  SESSION_PROMPT_OUTCOME,
  SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS,
  SESSION_PROMPT_SELECTOR_MAX_CHARS,
} from "../session-prompt-contract.ts";
import {
  AGENT_STATUS_AUTHORITIES,
  AGENT_STATUS_FRESHNESSES,
  AGENT_STATUS_SOURCES,
  AGENT_STATUS_STATES,
} from "../agent-status-contract.ts";
import { PTY_ATTACH_CAPABILITIES } from "../pty-websocket-contract.ts";
import {
  MACHINE_CAPABILITIES,
  MACHINE_MAX_CAPABILITIES,
  MACHINE_PROTOCOL,
  TAILNET_MAX_CANDIDATES,
  TAILNET_NODE_ID_PATTERN,
  TAILNET_ORIGIN_PATTERN,
} from "../tailnet-machine-contract.ts";
import {
  TASK_API_ERROR,
  TASK_EVENT_TYPE,
  TASK_LIMITS,
  TASK_STATUS,
} from "../tasks/domain.ts";

export const CONTROL_API_SCHEMA_VERSION = "1.0.0";
export const CONTROL_API_SCHEMA_ARTIFACT = "docs/generated/control-api.schema.json";

type JsonSchema = {
  readonly [key: string]: unknown;
};

type HttpRouteContract = {
  readonly operationId: string;
  readonly stable: boolean;
  readonly auth: "public" | "jwt-when-configured";
  readonly requestContentType?: "application/json";
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

function taskEventVariant(
  type: string,
  actor: string | readonly string[],
  payload: JsonSchema,
  properties: Record<string, JsonSchema> = {},
  required: readonly string[] = [],
  canonical = false,
): JsonSchema {
  return object({
    id: ref("TaskId"),
    taskId: ref("TaskId"),
    type: { const: type },
    actor: Array.isArray(actor) ? { enum: actor } : { const: actor },
    ...(canonical ? {
      source: ref("TaskAddress"),
      destination: ref("TaskAddress"),
      sequence: { type: "string", pattern: "^[1-9][0-9]*$" },
    } : {}),
    occurredAt: string(),
    ...properties,
    payload,
  }, ["id", "taskId", "type", "actor", ...(canonical ? ["source", "destination", "sequence"] : []), "occurredAt", ...required, "payload"]);
}

const NONE_PAYLOAD = object({ kind: { const: "none" } }, ["kind"]);
const RECEIPT_CONFIRMATION_PAYLOAD = object({ kind: { const: "receipt_confirmation" }, receiptId: ref("TaskId"), assignmentHash: { type: "string", pattern: "^[0-9a-f]{64}$" }, createdEventId: ref("TaskId"), receivedEventId: ref("TaskId"), receivedEventSequence: { type: "string", pattern: "^[1-9][0-9]*$" }, receivedEventOccurredAt: string() }, ["kind", "receiptId", "assignmentHash", "createdEventId", "receivedEventId", "receivedEventSequence", "receivedEventOccurredAt"]);
const PARENT_ACKNOWLEDGEMENT_PAYLOAD = object({ kind: { const: "parent_ack" }, pendingAckEventId: ref("TaskId") }, ["kind", "pendingAckEventId"]);
const DELIVERY_PAYLOAD = object({ kind: { const: "delivery" }, injectedEventId: ref("TaskId") }, ["kind", "injectedEventId"]);
const DELIVERY_FAILURE_PAYLOAD = object({ kind: { const: "delivery_failure" }, code: string(), message: string() }, ["kind", "code", "message"]);
const LATE_TERMINAL_PAYLOAD = object({ kind: { const: "late_terminal" }, originalType: ref("TaskTerminalEventType"), originalEventId: ref("TaskId") }, ["kind", "originalType", "originalEventId"]);

function taskEventVariants(completion: JsonSchema, canonical = false, includeLateTerminal = false): readonly JsonSchema[] {
  return [
    taskEventVariant("task.created", "parent", NONE_PAYLOAD, {}, [], canonical),
    taskEventVariant("task.received", "receiver", NONE_PAYLOAD, {}, [], canonical),
    taskEventVariant("task.receipt_confirmed", "sender", RECEIPT_CONFIRMATION_PAYLOAD, {}, [], canonical),
    taskEventVariant("task.delivered", "receiver", DELIVERY_PAYLOAD, {}, [], canonical),
    taskEventVariant("task.question", ["parent", "receiver"], NONE_PAYLOAD, { message: { type: "string", minLength: 1, maxLength: TASK_LIMITS.TASK_BYTES } }, ["message"], canonical),
    taskEventVariant("task.answer", ["parent", "receiver"], NONE_PAYLOAD, { message: { type: "string", minLength: 1, maxLength: TASK_LIMITS.TASK_BYTES }, replyToMessageId: ref("TaskId") }, ["message", "replyToMessageId"], canonical),
    taskEventVariant("task.information", ["parent", "receiver"], NONE_PAYLOAD, { message: { type: "string", minLength: 1, maxLength: TASK_LIMITS.TASK_BYTES } }, ["message"], canonical),
    taskEventVariant("message.delivered", "receiver", DELIVERY_PAYLOAD, {}, [], canonical),
    taskEventVariant("task.cancel_requested", "parent", NONE_PAYLOAD, {}, [], canonical),
    taskEventVariant("task.completed", "receiver", NONE_PAYLOAD, { completion }, ["completion"], canonical),
    taskEventVariant("task.failed", "receiver", NONE_PAYLOAD, { completion }, ["completion"], canonical),
    taskEventVariant("task.failed", "sender", NONE_PAYLOAD, { completion }, ["completion"], canonical),
    taskEventVariant("task.cancelled", "receiver", NONE_PAYLOAD, { completion }, ["completion"], canonical),
    taskEventVariant("task.timed_out", "sender", NONE_PAYLOAD, {}, [], canonical),
    taskEventVariant("task.parent_ack_pending", "sender", NONE_PAYLOAD, {}, [], canonical),
    taskEventVariant("task.parent_acknowledged", "sender", PARENT_ACKNOWLEDGEMENT_PAYLOAD, { replyToMessageId: ref("TaskId") }, ["replyToMessageId"], canonical),
    taskEventVariant("event.delivery_failed", "sender", DELIVERY_FAILURE_PAYLOAD, {}, [], canonical),
    ...(includeLateTerminal ? [taskEventVariant("task.late_terminal", "sender", LATE_TERMINAL_PAYLOAD, {}, [], canonical)] : []),
  ];
}

const TASK_EVENT_INPUT_SCHEMA: JsonSchema = { oneOf: taskEventVariants(ref("TaskCompletionInput")) };
const CANONICAL_TASK_EVENT_SCHEMA: JsonSchema = { oneOf: taskEventVariants(ref("StoredTaskCompletion"), true, true) };
const AGENT_RUNTIME_STATE_REQUIRED = {
  state: "state",
  authority: "authority",
  freshness: "freshness",
  source: "source",
  label: "label",
  stale: "stale",
  observedAt: "observedAt",
  changedAt: "changedAt",
  transitionSequence: "transitionSequence",
  unseen: "unseen",
} as const;

const providerIdentityProperties = {
  id: ref("OpenableHarness"),
  displayName: string(),
  command: ref("Command"),
} as const;

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
    "session-open follows ordinary global JWT policy when configured and adds no inter-session authorization layer",
    "task schema maxLength values are character ceilings; runtime validates UTF-8 byte limits and returns PAYLOAD_TOO_LARGE",
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
    SessionPromptSelector: {
      ...string("Active session name or stable opaque session identifier for an atomic prompt"),
      minLength: 1,
      maxLength: SESSION_PROMPT_SELECTOR_MAX_CHARS,
    },
    SessionPromptOutcome: { enum: Object.values(SESSION_PROMPT_OUTCOME) },
    ProjectName: { type: "string", pattern: "^[a-zA-Z0-9._-]+$" },
    Command: { type: "string", minLength: 1 },
    BrokerOutputSequence: {
      type: "string",
      pattern: "^(0|[1-9][0-9]*)$",
      maxLength: 20,
      description: "Decimal broker PTY output watermark",
    },
    OpenableHarness: { enum: [...OPENABLE_HARNESSES] },
    CreatableHarness: { enum: [...CREATABLE_HARNESSES] },
    TriageStatus: { enum: ["running", "idle"] },
    AgentStatusState: { enum: [...AGENT_STATUS_STATES] },
    AgentStatusAuthority: { enum: [...AGENT_STATUS_AUTHORITIES] },
    AgentStatusFreshness: { enum: [...AGENT_STATUS_FRESHNESSES] },
    AgentStatusSource: { enum: [...AGENT_STATUS_SOURCES] },
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
        source: { enum: ["env", "broker_env"] },
      }, ["provider", "redactedId", "capturedAt", "source"]),
    }, ["wolfpackSessionId", "wolfpackSessionName", "projectPath", "agentKind", "createdAt", "updatedAt"]),
    PrefillMode: { enum: [...TERMINAL_PREFILL_MODES] },
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
    }, ["agentCmd", "cmds"]),
    AgentRuntimeState: object({
      state: ref("AgentStatusState"),
      authority: ref("AgentStatusAuthority"),
      freshness: ref("AgentStatusFreshness"),
      source: ref("AgentStatusSource"),
      label: string(),
      stale: boolean(),
      observedAt: string(),
      changedAt: string(),
      transitionSequence: integer(),
      acknowledgedAt: string(),
      acknowledgedSequence: integer(),
      unseen: boolean(),
      runId: string(),
      runOrder: number(),
      signalSequence: number(),
      message: string(),
    }, Object.values(AGENT_RUNTIME_STATE_REQUIRED)),
    ProviderReadiness: {
      anyOf: [
        object({
          ...providerIdentityProperties,
          status: { const: "installed" },
          executablePath: string(),
          version: nullable(string()),
          authStatus: { const: "unknown" },
          loginCommand: ref("Command"),
        }, ["id", "displayName", "command", "status", "executablePath", "version", "authStatus", "loginCommand"]),
        object({
          ...providerIdentityProperties,
          status: { const: "missing" },
          installGuidance: string(),
        }, ["id", "displayName", "command", "status", "installGuidance"]),
      ],
    },
    SessionSummary: object({
      name: ref("SessionName"),
      lastLine: string(),
      triage: ref("TriageStatus"),
      outputSequence: ref("BrokerOutputSequence"),
      identity: ref("PublicSessionIdentity"),
      runtimeState: ref("AgentRuntimeState"),
    }, ["name", "lastLine", "triage"]),
    SessionControlIdentity: object({
      session: ref("SessionName"),
      sessionId: ref("SessionId"),
    }, ["session", "sessionId"]),
    SessionTerminalStatus: { enum: [...SESSION_TERMINAL_STATUSES] },
    SessionTerminalLiveness: object({
      exists: boolean(),
      alive: boolean(),
      status: ref("SessionTerminalStatus"),
    }, ["exists", "alive", "status"]),
    SessionStatusFailure: object({
      ok: { const: false },
      selector: ref("SessionSelector"),
      session: ref("SessionName"),
      sessionId: ref("SessionId"),
      terminal: ref("SessionTerminalLiveness"),
      error: object({
        code: { enum: Object.values(SESSION_STATUS_ERROR) },
        message: {
          type: "string",
          maxLength: SESSION_STATUS_ERROR_MESSAGE_MAX_CODE_POINTS,
        },
      }, ["code", "message"]),
    }, ["ok", "error"]),
    SessionStatus: object({
      ok: { const: true },
      selector: ref("SessionSelector"),
      session: ref("SessionName"),
      sessionId: ref("SessionId"),
      state: { const: "active" },
      project: string(),
      projectPath: string(),
      projectDir: string(),
      harness: string(),
      terminal: ref("SessionTerminalLiveness"),
      parentSession: ref("SessionControlIdentity"),
    }, [
      "ok",
      "selector",
      "session",
      "sessionId",
      "state",
      "project",
      "projectPath",
      "projectDir",
      "harness",
      "terminal",
    ]),
    TailnetNodeId: {
      type: "string",
      pattern: TAILNET_NODE_ID_PATTERN,
    },
    TailnetOrigin: {
      type: "string",
      pattern: TAILNET_ORIGIN_PATTERN,
    },
    MachineCapabilities: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: MACHINE_CAPABILITIES.length,
      maxItems: MACHINE_MAX_CAPABILITIES,
      uniqueItems: true,
      allOf: MACHINE_CAPABILITIES.map((capability) => ({ contains: { const: capability } })),
    },
    MachineHandshake: object({
      protocol: object({
        name: { const: MACHINE_PROTOCOL.NAME },
        major: { const: MACHINE_PROTOCOL.MAJOR },
        minor: { type: "integer", minimum: 0 },
      }, ["name", "major", "minor"], { additionalProperties: true }),
      machine: object({
        tailnetNodeId: ref("TailnetNodeId"),
        installationId: { type: "string", format: "uuid" },
        displayName: string(),
        origin: ref("TailnetOrigin"),
      }, ["tailnetNodeId", "installationId", "displayName", "origin"], { additionalProperties: true }),
      wolfpack: object({ version: string() }, ["version"], { additionalProperties: true }),
      capabilities: ref("MachineCapabilities"),
    }, ["protocol", "machine", "wolfpack", "capabilities"], { additionalProperties: true }),
    TailnetMachineCandidate: object({
      hostname: string(),
      tailnetNodeId: ref("TailnetNodeId"),
      origin: ref("TailnetOrigin"),
      online: boolean(),
    }, ["hostname", "tailnetNodeId", "origin", "online"]),
    Peer: object({
      name: string(),
      url: string(),
    }, ["name", "url"], { additionalProperties: true }),
    TaskId: {
      type: "string",
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    },
    TaskAddress: object({
      machine: { type: "string", minLength: 1 },
      sessionId: ref("SessionId"),
    }, ["machine", "sessionId"]),
    ContextRef: object({
      path: { type: "string", minLength: 1 },
      selector: string(),
      purpose: string(),
    }, ["path"]),
    TaskContext: object({
      summary: { type: "string", minLength: 1, maxLength: TASK_LIMITS.CONTEXT_SUMMARY_BYTES },
      refs: arrayOf(ref("ContextRef")),
    }),
    TaskMetadata: object({
      phaseId: string(),
      issueId: string(),
      verificationTier: string(),
      rootCause: string(),
    }),
    TaskAssignment: {
      ...object({
        taskId: ref("TaskId"),
        source: ref("TaskAddress"),
        target: ref("TaskAddress"),
        task: { type: "string", minLength: 1, maxLength: TASK_LIMITS.TASK_BYTES },
        createdAt: string(),
        expiresAt: string(),
        context: ref("TaskContext"),
        preflight: object({ requiredProject: ref("ProjectName") }),
        role: string(),
        metadata: ref("TaskMetadata"),
        onCompletePrompt: string(),
      }, ["taskId", "source", "target", "task", "createdAt", "expiresAt"]),
      maxProperties: 11,
    },
    TaskEventType: { enum: Object.values(TASK_EVENT_TYPE) },
    TaskTerminalEventType: { enum: [TASK_EVENT_TYPE.COMPLETED, TASK_EVENT_TYPE.FAILED, TASK_EVENT_TYPE.CANCELLED, TASK_EVENT_TYPE.TIMED_OUT] },
    TaskStatus: { enum: Object.values(TASK_STATUS) },
    TaskMessageType: { enum: ["question", "answer", "information"] },
    TaskCompletionInput: object({
      summary: { type: "string", minLength: 1, maxLength: TASK_LIMITS.TASK_BYTES, description: "Character ceiling only; runtime enforces the UTF-8 byte limit." },
      result: object({}, [], { additionalProperties: true }),
      error: object({
        code: string(),
        message: string(),
        retryable: boolean(),
      }, ["code", "message", "retryable"]),
      artifacts: {
        ...arrayOf(object({
          path: { type: "string", minLength: 1 },
          mimeType: string(),
          description: string(),
        }, ["path"])),
        maxItems: TASK_LIMITS.ARTIFACTS,
      },
    }, ["summary"]),
    StoredArtifactRef: object({
      machine: { type: "string", minLength: 1 },
      project: { type: "string", minLength: 1 },
      path: { type: "string", minLength: 1 },
      mimeType: string(),
      description: string(),
      sizeBytes: { type: "integer", minimum: 0 },
      modifiedAt: string(),
    }, ["machine", "project", "path"]),
    TaskWarning: object({ code: string(), message: string() }, ["code", "message"]),
    StoredTaskCompletion: object({
      summary: { type: "string", minLength: 1 },
      result: object({}, [], { additionalProperties: true }),
      error: object({ code: string(), message: string(), retryable: boolean() }, ["code", "message", "retryable"]),
      artifacts: { ...arrayOf(ref("StoredArtifactRef")), maxItems: TASK_LIMITS.ARTIFACTS },
      warnings: arrayOf(ref("TaskWarning")),
    }, ["summary", "warnings"]),
    TaskEventPayload: {
      oneOf: [
        object({ kind: { const: "none" } }, ["kind"]),
        object({
          kind: { const: "receipt_confirmation" },
          receiptId: ref("TaskId"),
          assignmentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
          createdEventId: ref("TaskId"),
          receivedEventId: ref("TaskId"),
          receivedEventSequence: { type: "string", pattern: "^[1-9][0-9]*$" },
          receivedEventOccurredAt: string(),
        }, ["kind", "receiptId", "assignmentHash", "createdEventId", "receivedEventId", "receivedEventSequence", "receivedEventOccurredAt"]),
        object({ kind: { const: "parent_ack" }, pendingAckEventId: ref("TaskId") }, ["kind", "pendingAckEventId"]),
        object({ kind: { const: "delivery" }, injectedEventId: ref("TaskId") }, ["kind", "injectedEventId"]),
        object({ kind: { const: "delivery_failure" }, code: string(), message: string() }, ["kind", "code", "message"]),
        LATE_TERMINAL_PAYLOAD,
      ],
    },
    TaskEventInput: TASK_EVENT_INPUT_SCHEMA,
    CanonicalTaskEvent: CANONICAL_TASK_EVENT_SCHEMA,
    TaskAcknowledgement: object({
      ok: { const: true },
      taskId: ref("TaskId"),
      eventId: ref("TaskId"),
      sequence: { type: "string", pattern: "^[1-9][0-9]*$" },
    }, ["ok", "taskId", "eventId", "sequence"]),
    TaskInboxPage: object({
      events: { ...arrayOf(ref("CanonicalTaskEvent")), maxItems: TASK_LIMITS.INBOX_PAGE_EVENTS },
      nextCursor: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
      hasMore: boolean(),
    }, ["events", "nextCursor", "hasMore"]),
    TaskApiErrorEnvelope: object({
      ok: { const: false },
      error: object({
        code: { enum: Object.values(TASK_API_ERROR) },
        message: string(),
        retryable: boolean(),
        path: string(),
      }, ["code", "message", "retryable"]),
    }, ["ok", "error"]),
    PushSubscription: object({
      endpoint: string(),
      keys: object({
        p256dh: string(),
        auth: string(),
      }, ["p256dh", "auth"]),
    }, ["endpoint", "keys"]),
  },
  http: {
    "GET /api/info": {
      operationId: "getInfo",
      stable: true,
      auth: "public",
      response: object({
        name: string(),
        version: string(),
        machineId: { type: "string", format: "uuid" },
      }, ["name", "version", "machineId"]),
      errors: [],
    },
    "GET /api/machine": {
      operationId: "getMachineHandshake",
      stable: true,
      auth: "public",
      response: ref("MachineHandshake"),
      errors: ["503 ErrorEnvelope"],
    },
    "POST /api/tasks/v1/send": {
      operationId: "sendTask",
      stable: true,
      auth: "jwt-when-configured",
      requestContentType: "application/json",
      request: object({
        callerSession: ref("SessionSelector"),
        to: ref("TaskAddress"),
        task: { type: "string", minLength: 1, maxLength: TASK_LIMITS.TASK_BYTES },
        context: ref("TaskContext"),
        role: string(),
        preflight: object({ requiredProject: ref("ProjectName") }),
        metadata: ref("TaskMetadata"),
        onCompletePrompt: string(),
        timeoutMs: { type: "integer", minimum: 1000 },
        idempotencyKey: { type: "string", minLength: 1 },
      }, ["callerSession", "to", "task"]),
      response: ref("TaskAcknowledgement"),
      errors: ["400 TaskApiErrorEnvelope", "409 TaskApiErrorEnvelope", "413 TaskApiErrorEnvelope", "422 TaskApiErrorEnvelope", "502 TaskApiErrorEnvelope", "503 TaskApiErrorEnvelope"],
    },
    "GET /api/tasks/v1/status": {
      operationId: "getTaskStatus",
      stable: true,
      auth: "jwt-when-configured",
      request: object({
        taskId: ref("TaskId"),
        callerSession: ref("SessionSelector"),
      }, ["taskId", "callerSession"]),
      response: object({
        ok: { const: true },
        task: ref("TaskAssignment"),
        status: ref("TaskStatus"),
        events: arrayOf(ref("CanonicalTaskEvent")),
        completion: ref("StoredTaskCompletion"),
        warnings: arrayOf(ref("TaskWarning")),
      }, ["ok", "task", "status", "events", "warnings"]),
      errors: ["400 TaskApiErrorEnvelope", "404 TaskApiErrorEnvelope", "409 TaskApiErrorEnvelope", "503 TaskApiErrorEnvelope"],
    },
    "GET /api/tasks/v1/inbox": {
      operationId: "getTaskInbox",
      stable: true,
      auth: "jwt-when-configured",
      request: object({
        callerSession: ref("SessionSelector"),
        cursor: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        includeAcknowledged: boolean(),
      }, ["callerSession", "cursor"]),
      response: ref("TaskInboxPage"),
      errors: ["400 TaskApiErrorEnvelope", "404 TaskApiErrorEnvelope", "503 TaskApiErrorEnvelope"],
    },
    "POST /api/tasks/v1/message": {
      operationId: "sendTaskMessage",
      stable: true,
      auth: "jwt-when-configured",
      requestContentType: "application/json",
      request: object({
        callerSession: ref("SessionSelector"),
        taskId: ref("TaskId"),
        type: ref("TaskMessageType"),
        message: { type: "string", minLength: 1, maxLength: TASK_LIMITS.TASK_BYTES },
        replyToMessageId: ref("TaskId"),
      }, ["callerSession", "taskId", "type", "message"]),
      response: ref("TaskAcknowledgement"),
      errors: ["400 TaskApiErrorEnvelope", "404 TaskApiErrorEnvelope", "409 TaskApiErrorEnvelope", "413 TaskApiErrorEnvelope", "503 TaskApiErrorEnvelope"],
    },
    "POST /api/tasks/v1/complete": {
      operationId: "completeTask",
      stable: true,
      auth: "jwt-when-configured",
      requestContentType: "application/json",
      request: object({
        callerSession: ref("SessionSelector"),
        taskId: ref("TaskId"),
        status: { enum: ["completed", "failed", "cancelled"] },
        result: ref("TaskCompletionInput"),
      }, ["callerSession", "taskId", "status", "result"]),
      response: ref("TaskAcknowledgement"),
      errors: ["400 TaskApiErrorEnvelope", "404 TaskApiErrorEnvelope", "409 TaskApiErrorEnvelope", "413 TaskApiErrorEnvelope", "503 TaskApiErrorEnvelope"],
    },
    "POST /api/tasks/v1/cancel": {
      operationId: "cancelTask",
      stable: true,
      auth: "jwt-when-configured",
      requestContentType: "application/json",
      request: object({ callerSession: ref("SessionSelector"), taskId: ref("TaskId") }, ["callerSession", "taskId"]),
      response: ref("TaskAcknowledgement"),
      errors: ["400 TaskApiErrorEnvelope", "404 TaskApiErrorEnvelope", "409 TaskApiErrorEnvelope", "503 TaskApiErrorEnvelope"],
    },
    "POST /api/tasks/v1/delivered": {
      operationId: "recordTaskDelivery",
      stable: true,
      auth: "jwt-when-configured",
      requestContentType: "application/json",
      request: object({
        callerSession: ref("SessionSelector"),
        taskId: ref("TaskId"),
        eventId: ref("TaskId"),
      }, ["callerSession", "taskId", "eventId"]),
      response: ref("TaskAcknowledgement"),
      errors: ["400 TaskApiErrorEnvelope", "404 TaskApiErrorEnvelope", "409 TaskApiErrorEnvelope", "503 TaskApiErrorEnvelope"],
    },
    "POST /api/tasks/v1/ack": {
      operationId: "acknowledgeTask",
      stable: true,
      auth: "jwt-when-configured",
      requestContentType: "application/json",
      request: object({ callerSession: ref("SessionSelector"), taskId: ref("TaskId") }, ["callerSession", "taskId"]),
      response: ref("TaskAcknowledgement"),
      errors: ["400 TaskApiErrorEnvelope", "404 TaskApiErrorEnvelope", "409 TaskApiErrorEnvelope", "503 TaskApiErrorEnvelope"],
    },
    "POST /api/tasks/v1/peer/receive": {
      operationId: "peerReceiveTask",
      stable: true,
      auth: "jwt-when-configured",
      requestContentType: "application/json",
      request: object({
        source: ref("TaskAddress"),
        assignment: ref("TaskAssignment"),
        assignmentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        createdEventId: ref("TaskId"),
      }, ["source", "assignment", "assignmentHash", "createdEventId"]),
      response: object({ ok: { const: true }, receiptId: ref("TaskId") }, ["ok", "receiptId"]),
      errors: ["400 TaskApiErrorEnvelope", "409 TaskApiErrorEnvelope", "413 TaskApiErrorEnvelope", "422 TaskApiErrorEnvelope", "502 TaskApiErrorEnvelope", "503 TaskApiErrorEnvelope"],
    },
    "POST /api/tasks/v1/peer/event": {
      operationId: "peerAcceptTaskEvent",
      stable: true,
      auth: "jwt-when-configured",
      requestContentType: "application/json",
      request: object({
        source: ref("TaskAddress"),
        destination: ref("TaskAddress"),
        event: { oneOf: [ref("TaskEventInput"), ref("CanonicalTaskEvent")] },
        projection: object({
          artifacts: arrayOf(object({
            sourcePath: string(), machine: string(), project: string(), normalizedPath: string(), sizeBytes: { type: "integer", minimum: 0 }, modifiedAt: string(),
          }, ["sourcePath", "machine", "project", "normalizedPath"])),
          warnings: arrayOf(ref("TaskWarning")),
        }, ["warnings"]),
      }, ["source", "destination", "event"]),
      response: object({
        ok: { const: true }, taskId: ref("TaskId"), eventId: ref("TaskId"), sequence: { type: "string", pattern: "^[1-9][0-9]*$" }, event: ref("CanonicalTaskEvent"),
      }, ["ok", "taskId", "eventId", "sequence", "event"]),
      errors: ["400 TaskApiErrorEnvelope", "404 TaskApiErrorEnvelope", "409 TaskApiErrorEnvelope", "413 TaskApiErrorEnvelope", "502 TaskApiErrorEnvelope", "503 TaskApiErrorEnvelope"],
    },
    "GET /api/sessions": {
      operationId: "listSessions",
      stable: true,
      auth: "jwt-when-configured",
      response: object({ sessions: arrayOf(ref("SessionSummary")) }, ["sessions"]),
      errors: [],
    },
    "POST /api/agent-runtime-state/ack": {
      operationId: "ackAgentRuntimeState",
      stable: true,
      auth: "jwt-when-configured",
      request: object({
        sessionId: ref("SessionId"),
        transitionSequence: integer(),
      }, ["sessionId", "transitionSequence"]),
      response: object({
        ok: { const: true },
        runtimeState: ref("AgentRuntimeState"),
      }, ["ok", "runtimeState"]),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope"],
    },
    "GET /api/projects": {
      operationId: "listProjects",
      stable: true,
      auth: "jwt-when-configured",
      response: object({ projects: arrayOf(ref("ProjectName")) }, ["projects"]),
      errors: [],
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
        harness: ref("CreatableHarness"),
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
        sessionName: ref("SessionName"),
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
    "GET /api/providers": {
      operationId: "listProviderReadiness",
      stable: true,
      auth: "jwt-when-configured",
      response: object({
        providers: arrayOf(ref("ProviderReadiness")),
      }, ["providers"]),
      errors: [],
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
          broker: integer(),
        }, ["broker"]),
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
      errors: [
        "400 SessionStatusFailure",
        "404 SessionStatusFailure",
        "409 SessionStatusFailure",
        "410 SessionStatusFailure",
        "503 SessionStatusFailure",
      ],
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
    "POST /api/session-control/prompt": {
      operationId: "promptSessionAndWaitForOutput",
      stable: true,
      auth: "jwt-when-configured",
      request: object({
        session: ref("SessionPromptSelector"),
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: MAX_INITIAL_PROMPT_LENGTH,
        },
        outputContains: {
          type: "string",
          minLength: 1,
          maxLength: SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS,
        },
        noEnter: boolean(),
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: SESSION_PROMPT_MAX_TIMEOUT_MS,
        },
      }, ["session", "prompt", "outputContains"]),
      response: object({
        ok: boolean(),
        session: ref("SessionName"),
        sessionId: ref("SessionId"),
        outcome: ref("SessionPromptOutcome"),
        outputBoundarySeq: nullable(string("Pre-send broker output sequence boundary")),
      }, ["ok", "session", "sessionId", "outcome", "outputBoundarySeq"]),
      errors: ["400 ErrorEnvelope", "404 ErrorEnvelope", "409 ErrorEnvelope", "413 ErrorEnvelope", "503 ErrorEnvelope"],
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
    "GET /api/tailnet/v1/candidates": {
      operationId: "discoverTailnetCandidates",
      stable: true,
      auth: "jwt-when-configured",
      response: object({
        candidates: { ...arrayOf(ref("TailnetMachineCandidate")), maxItems: TAILNET_MAX_CANDIDATES },
        error: string(),
      }, ["candidates"]),
      errors: [],
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
      request: object({
        message: string(),
        sessionId: ref("SessionId"),
        sessionName: ref("SessionName"),
      }, ["message"]),
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
            resizeId: { type: "integer", minimum: 1 },
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
          schema: object({
            type: { const: "attach_ack" },
            capabilities: arrayOf({ enum: PTY_ATTACH_CAPABILITIES }),
          }, ["type"]),
        },
        resize_ack: {
          stable: true,
          direction: "server-to-client",
          schema: object({
            type: { const: "resize_ack" },
            resizeId: { type: "integer", minimum: 1 },
            cols: integer(),
            rows: integer(),
          }, ["type", "resizeId", "cols", "rows"]),
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
      requestContentType: contract.requestContentType,
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
    $defs: controlApiSource.defs,
  };
}
