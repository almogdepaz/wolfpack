import type { IncomingMessage, ServerResponse } from "node:http";
import { json, parseBody } from "./http.ts";
import { getTaskGateway } from "../tasks/gateway.ts";
import type { TaskApiErrorCode, TaskResultInput } from "../tasks/domain.ts";
import { TASK_API_ERROR, TASK_LIMITS } from "../tasks/domain.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
type Body = Record<string, unknown>;

function error(res: ServerResponse, code: TaskApiErrorCode, message: string, status = 400, path: string | undefined = undefined): void {
  json(res, { ok: false, error: { code, message, retryable: false, ...(path === undefined ? {} : { path }) } }, status);
}

function isObject(value: unknown): value is Body {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnly(body: Body, keys: readonly string[]): boolean {
  return Object.keys(body).every((key) => keys.includes(key));
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function pointer(...tokens: readonly string[]): string {
  return tokens.map((token) => `/${token.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

function unexpectedProperty(body: Body, keys: readonly string[], parent: readonly string[] = []): string | undefined {
  const key = Object.keys(body).sort().find((candidate) => !keys.includes(candidate));
  return key === undefined ? undefined : pointer(...parent, key);
}

interface SendValidationFailure {
  readonly path: string;
  readonly message: string;
}

function invalidSend(path: string): SendValidationFailure {
  return { path, message: "invalid task send request" };
}

function sendValidationFailure(body: Body): SendValidationFailure | undefined {
  const unexpected = unexpectedProperty(body, ["callerSession", "to", "task", "context", "role", "preflight", "metadata", "onCompletePrompt", "timeoutMs", "idempotencyKey"]);
  if (unexpected !== undefined) return invalidSend(unexpected);
  if (!requiredString(body, "callerSession")) return invalidSend("/callerSession");
  if (!isObject(body.to)) return invalidSend("/to");
  const unexpectedTarget = unexpectedProperty(body.to, ["machine", "sessionId"], ["to"]);
  if (unexpectedTarget !== undefined) return invalidSend(unexpectedTarget);
  if (typeof body.to.machine !== "string") return invalidSend("/to/machine");
  if (typeof body.to.sessionId !== "string") return invalidSend("/to/sessionId");
  if (!requiredString(body, "task")) return invalidSend("/task");
  if (!optionalString(body.role)) return invalidSend("/role");
  if (!optionalString(body.onCompletePrompt)) return invalidSend("/onCompletePrompt");
  if (!optionalString(body.idempotencyKey)) return invalidSend("/idempotencyKey");
  if (body.timeoutMs !== undefined && typeof body.timeoutMs !== "number") return invalidSend("/timeoutMs");
  if (body.context !== undefined) {
    if (!isObject(body.context)) return invalidSend("/context");
    const unexpectedContext = unexpectedProperty(body.context, ["summary", "refs"], ["context"]);
    if (unexpectedContext !== undefined) return invalidSend(unexpectedContext);
    if (!optionalString(body.context.summary)) return invalidSend("/context/summary");
    if (body.context.refs !== undefined) {
      if (!Array.isArray(body.context.refs)) return invalidSend("/context/refs");
      for (const [index, ref] of body.context.refs.entries()) {
        if (!isObject(ref)) return invalidSend(pointer("context", "refs", String(index)));
        const unexpectedRef = unexpectedProperty(ref, ["path", "selector", "purpose"], ["context", "refs", String(index)]);
        if (unexpectedRef !== undefined) return invalidSend(unexpectedRef);
        if (typeof ref.path !== "string") return invalidSend(pointer("context", "refs", String(index), "path"));
        if (!optionalString(ref.selector)) return invalidSend(pointer("context", "refs", String(index), "selector"));
        if (!optionalString(ref.purpose)) return invalidSend(pointer("context", "refs", String(index), "purpose"));
      }
    }
  }
  if (body.preflight !== undefined) {
    if (!isObject(body.preflight)) return invalidSend("/preflight");
    const unexpectedPreflight = unexpectedProperty(body.preflight, ["requiredProject"], ["preflight"]);
    if (unexpectedPreflight !== undefined) return invalidSend(unexpectedPreflight);
    if (!optionalString(body.preflight.requiredProject) || (body.preflight.requiredProject !== undefined && body.preflight.requiredProject.length === 0)) return invalidSend("/preflight/requiredProject");
  }
  if (body.metadata !== undefined) {
    if (!isObject(body.metadata)) return invalidSend("/metadata");
    const unexpectedMetadata = unexpectedProperty(body.metadata, ["phaseId", "issueId", "verificationTier", "rootCause"], ["metadata"]);
    if (unexpectedMetadata !== undefined) return invalidSend(unexpectedMetadata);
    for (const key of ["phaseId", "issueId", "verificationTier", "rootCause"] as const) {
      if (!optionalString(body.metadata[key])) return invalidSend(pointer("metadata", key));
    }
  }
  return undefined;
}

type GatewayResponse = { readonly ok: true; readonly [key: string]: unknown } | { readonly ok: false; readonly error: { readonly code: TaskApiErrorCode; readonly message: string; readonly retryable: boolean; readonly path?: string }; readonly status: number };

function response(res: ServerResponse, value: GatewayResponse): void {
  if (value.ok) {
    const { ok, ...body } = value;
    json(res, { ok, ...body });
  } else {
    json(res, { ok: false, error: value.error }, value.status);
  }
}

async function taskBody(req: IncomingMessage, res: ServerResponse): Promise<Body | undefined> {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    error(res, TASK_API_ERROR.INVALID_CONTENT_TYPE, "task routes require application/json");
    return undefined;
  }
  const invalidEnvelope = { envelope: { ok: false, error: { code: TASK_API_ERROR.INVALID_REQUEST, message: "invalid task JSON", retryable: false } }, status: 400 } as const;
  const body = await parseBody(req, res, {
    maxBytes: TASK_LIMITS.HTTP_BODY_BYTES,
    respondOnTooLarge: true,
    invalidResponse: invalidEnvelope,
    tooLargeResponse: { envelope: { ok: false, error: { code: TASK_API_ERROR.PAYLOAD_TOO_LARGE, message: "task request body exceeds 64KiB", retryable: false } }, status: 413 },
  });
  if (body === undefined) return undefined;
  if (!isObject(body)) {
    error(res, TASK_API_ERROR.INVALID_REQUEST, "task request body must be an object");
    return undefined;
  }
  return body;
}

function requiredString(body: Body, key: string): string | undefined {
  return typeof body[key] === "string" && body[key].length > 0 ? body[key] : undefined;
}

function taskResult(value: unknown): TaskResultInput | undefined {
  if (!isObject(value) || !hasOnly(value, ["summary", "result", "error", "artifacts"]) || typeof value.summary !== "string"
    || (value.result !== undefined && !isObject(value.result))
    || (value.error !== undefined && (!isObject(value.error) || !hasOnly(value.error, ["code", "message", "retryable"])
      || typeof value.error.code !== "string" || typeof value.error.message !== "string" || typeof value.error.retryable !== "boolean"))
    || (value.artifacts !== undefined && (!Array.isArray(value.artifacts) || !value.artifacts.every((artifact) => isObject(artifact)
      && hasOnly(artifact, ["path", "mimeType", "description"]) && typeof artifact.path === "string" && optionalString(artifact.mimeType) && optionalString(artifact.description))))) return undefined;
  return value as unknown as TaskResultInput;
}

export const taskRoutes: Record<string, Handler> = {
  "POST /api/tasks/v1/send": async (req, res) => {
    const body = await taskBody(req, res);
    if (!body) return;
    const validationFailure = sendValidationFailure(body);
    if (validationFailure !== undefined) {
      return error(res, TASK_API_ERROR.INVALID_REQUEST, validationFailure.message, 400, validationFailure.path);
    }
    const context = body.context as Body | undefined;
    response(res, await getTaskGateway().send({
      callerSession: body.callerSession as string,
      to: body.to as { machine: string; sessionId: string },
      task: body.task as string,
      context: context === undefined ? undefined : {
        summary: context.summary as string | undefined,
        refs: (context.refs as readonly Body[] | undefined)?.map((ref) => ({
          path: ref.path as string,
          selector: ref.selector as string | undefined,
          purpose: ref.purpose as string | undefined,
        })),
      },
      role: body.role as string | undefined,
      preflight: body.preflight as { requiredProject?: string } | undefined,
      metadata: body.metadata as undefined,
      onCompletePrompt: body.onCompletePrompt as string | undefined,
      timeoutMs: body.timeoutMs as number | undefined,
      idempotencyKey: body.idempotencyKey as string | undefined,
      rawBody: body,
    }));
  },
  "GET /api/tasks/v1/status": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const callerSession = url.searchParams.get("callerSession");
    const taskId = url.searchParams.get("taskId");
    if (!callerSession || !taskId || [...url.searchParams.keys()].some((key) => key !== "callerSession" && key !== "taskId")) return error(res, TASK_API_ERROR.INVALID_REQUEST, "invalid task status query");
    response(res, await getTaskGateway().status(callerSession, taskId));
  },
  "GET /api/tasks/v1/inbox": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const callerSession = url.searchParams.get("callerSession");
    const cursor = url.searchParams.get("cursor");
    const acknowledged = url.searchParams.get("includeAcknowledged");
    if (!callerSession || !cursor || (acknowledged !== null && acknowledged !== "true" && acknowledged !== "false")
      || [...url.searchParams.keys()].some((key) => key !== "callerSession" && key !== "cursor" && key !== "includeAcknowledged")) return error(res, TASK_API_ERROR.INVALID_REQUEST, "invalid task inbox query");
    response(res, await getTaskGateway().inbox(callerSession, cursor, acknowledged === "true"));
  },
  "POST /api/tasks/v1/message": async (req, res) => {
    const body = await taskBody(req, res);
    if (!body) return;
    if (!hasOnly(body, ["callerSession", "taskId", "type", "message", "replyToMessageId"]) || !requiredString(body, "callerSession")
      || !requiredString(body, "taskId") || !requiredString(body, "type") || !requiredString(body, "message") || !optionalString(body.replyToMessageId)) return error(res, TASK_API_ERROR.INVALID_REQUEST, "invalid task message");
    response(res, await getTaskGateway().message({ callerSession: body.callerSession as string, taskId: body.taskId as string, type: body.type as string, message: body.message as string, replyToMessageId: body.replyToMessageId as string | undefined, rawBody: body }));
  },
  "POST /api/tasks/v1/complete": async (req, res) => {
    const body = await taskBody(req, res);
    if (!body) return;
    const result = taskResult(body.result);
    if (!hasOnly(body, ["callerSession", "taskId", "status", "result"]) || !requiredString(body, "callerSession") || !requiredString(body, "taskId")
      || (body.status !== "completed" && body.status !== "failed" && body.status !== "cancelled") || !result) return error(res, TASK_API_ERROR.INVALID_REQUEST, "invalid task completion");
    response(res, await getTaskGateway().complete({ callerSession: body.callerSession as string, taskId: body.taskId as string, status: body.status, result, rawBody: body }));
  },
  "POST /api/tasks/v1/cancel": async (req, res) => {
    const body = await taskBody(req, res);
    if (!body) return;
    if (!hasOnly(body, ["callerSession", "taskId"]) || !requiredString(body, "callerSession") || !requiredString(body, "taskId")) return error(res, TASK_API_ERROR.INVALID_REQUEST, "invalid task cancellation");
    response(res, await getTaskGateway().cancel(body.callerSession as string, body.taskId as string));
  },
  "POST /api/tasks/v1/delivered": async (req, res) => {
    const body = await taskBody(req, res);
    if (!body) return;
    if (!hasOnly(body, ["callerSession", "taskId", "eventId"]) || !requiredString(body, "callerSession") || !requiredString(body, "taskId") || !requiredString(body, "eventId")) return error(res, TASK_API_ERROR.INVALID_REQUEST, "invalid task delivery acknowledgement");
    response(res, await getTaskGateway().delivered(body.callerSession as string, body.taskId as string, body.eventId as string));
  },
  "POST /api/tasks/v1/ack": async (req, res) => {
    const body = await taskBody(req, res);
    if (!body) return;
    if (!hasOnly(body, ["callerSession", "taskId"]) || !requiredString(body, "callerSession") || !requiredString(body, "taskId")) return error(res, TASK_API_ERROR.INVALID_REQUEST, "invalid task acknowledgement");
    response(res, await getTaskGateway().acknowledge(body.callerSession as string, body.taskId as string));
  },
  "POST /api/tasks/v1/peer/receive": async (req, res) => {
    const body = await taskBody(req, res);
    if (!body) return;
    if (!hasOnly(body, ["source", "assignment", "assignmentHash", "createdEventId"])) return error(res, TASK_API_ERROR.INVALID_REQUEST, "invalid peer assignment envelope");
    response(res, await getTaskGateway().receivePeer(body));
  },
  "POST /api/tasks/v1/peer/event": async (req, res) => {
    const body = await taskBody(req, res);
    if (!body) return;
    if (!hasOnly(body, ["source", "destination", "event", "projection"])) return error(res, TASK_API_ERROR.INVALID_REQUEST, "invalid peer event envelope");
    response(res, await getTaskGateway().acceptPeerEvent(body));
  },
};
