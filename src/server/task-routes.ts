import type { IncomingMessage, ServerResponse } from "node:http";
import { json, parseBody } from "./http.ts";
import { getTaskGateway } from "../tasks/gateway.ts";
import type { TaskApiErrorCode, TaskResultInput } from "../tasks/domain.ts";
import { TASK_API_ERROR, TASK_LIMITS } from "../tasks/domain.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
type Body = Record<string, unknown>;

function error(res: ServerResponse, code: TaskApiErrorCode, message: string, status = 400): void {
  json(res, { ok: false, error: { code, message, retryable: false } }, status);
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

type GatewayResponse = { readonly ok: true; readonly [key: string]: unknown } | { readonly ok: false; readonly error: { readonly code: TaskApiErrorCode; readonly message: string; readonly retryable: boolean }; readonly status: number };

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
    if (!hasOnly(body, ["callerSession", "to", "task", "context", "role", "preflight", "metadata", "onCompletePrompt", "timeoutMs", "idempotencyKey"])
      || !isObject(body.to) || !hasOnly(body.to, ["machine", "sessionId"]) || typeof body.to.machine !== "string" || typeof body.to.sessionId !== "string"
      || !requiredString(body, "callerSession") || !requiredString(body, "task") || !optionalString(body.role) || !optionalString(body.onCompletePrompt)
      || !optionalString(body.idempotencyKey) || (body.timeoutMs !== undefined && typeof body.timeoutMs !== "number")
      || (body.context !== undefined && (!isObject(body.context) || !hasOnly(body.context, ["summary", "refs"]) || !optionalString(body.context.summary)
        || (body.context.refs !== undefined && (!Array.isArray(body.context.refs) || !body.context.refs.every((ref) => isObject(ref)
          && hasOnly(ref, ["path", "selector", "purpose"]) && typeof ref.path === "string" && optionalString(ref.selector) && optionalString(ref.purpose))))))
      || (body.preflight !== undefined && (!isObject(body.preflight) || !hasOnly(body.preflight, ["requiredProject"]) || !optionalString(body.preflight.requiredProject)))
      || (body.metadata !== undefined && (!isObject(body.metadata) || !hasOnly(body.metadata, ["phaseId", "issueId", "verificationTier", "rootCause"])
        || !optionalString(body.metadata.phaseId) || !optionalString(body.metadata.issueId) || !optionalString(body.metadata.verificationTier) || !optionalString(body.metadata.rootCause)))) {
      return error(res, TASK_API_ERROR.INVALID_REQUEST, "invalid task send request");
    }
    response(res, await getTaskGateway().send({
      callerSession: body.callerSession as string,
      to: body.to as { machine: string; sessionId: string },
      task: body.task as string,
      context: body.context === undefined ? undefined : {
        summary: body.context.summary as string | undefined,
        refs: (body.context.refs as readonly Body[] | undefined)?.map((ref) => ({
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
