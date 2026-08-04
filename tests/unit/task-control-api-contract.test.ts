import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TASK_API_ROUTES, TASK_LIMITS } from "../../src/tasks/domain.ts";
import { CONTROL_API_SCHEMA_ARTIFACT } from "../../src/control-api/schema.ts";

type JsonObject = Record<string, unknown>;

const artifact = JSON.parse(readFileSync(CONTROL_API_SCHEMA_ARTIFACT, "utf-8")) as JsonObject;

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonObject;
}

function operation(operationId: string): JsonObject {
  return objectAt(objectAt(artifact.http, "http")[operationId], `http.${operationId}`);
}

function properties(schema: JsonObject): JsonObject {
  return objectAt(schema.properties, "schema.properties");
}

describe("task control api contract", () => {
  test("publishes every locked task route without registering runtime handlers", () => {
    const routes = [
      ["sendTask", TASK_API_ROUTES.send],
      ["getTaskStatus", TASK_API_ROUTES.status],
      ["getTaskInbox", TASK_API_ROUTES.inbox],
      ["sendTaskMessage", TASK_API_ROUTES.message],
      ["completeTask", TASK_API_ROUTES.complete],
      ["cancelTask", TASK_API_ROUTES.cancel],
      ["recordTaskDelivery", TASK_API_ROUTES.delivered],
      ["acknowledgeTask", TASK_API_ROUTES.acknowledge],
      ["peerReceiveTask", TASK_API_ROUTES.peerReceive],
      ["peerAcceptTaskEvent", TASK_API_ROUTES.peerEvent],
    ] as const;

    for (const [operationId, route] of routes) {
      expect(operation(operationId)).toMatchObject({
        route,
        stable: true,
        auth: "jwt-when-configured",
        ...(route.startsWith("POST") ? { requestContentType: "application/json" } : {}),
      });
    }
  });

  test("bounds assignment and inbox fields and publishes strict envelopes", () => {
    const send = operation("sendTask");
    const request = objectAt(send.request, "sendTask.request");
    const requestProperties = properties(request);
    const defs = objectAt(artifact.$defs, "$defs");
    const assignment = objectAt(defs.TaskAssignment, "$defs.TaskAssignment");
    const assignmentProperties = properties(assignment);
    const context = objectAt(defs.TaskContext, "$defs.TaskContext");
    const contextProperties = properties(context);
    const inbox = operation("getTaskInbox");
    const inboxRequest = properties(objectAt(inbox.request, "getTaskInbox.request"));
    const inboxPage = objectAt(defs.TaskInboxPage, "$defs.TaskInboxPage");
    const inboxPageProperties = properties(inboxPage);

    expect(requestProperties.callerSession).toEqual({ $ref: "#/$defs/SessionSelector" });
    expect(assignmentProperties.task).toMatchObject({ minLength: 1, maxLength: TASK_LIMITS.TASK_BYTES });
    expect(contextProperties.summary).toMatchObject({ maxLength: TASK_LIMITS.CONTEXT_SUMMARY_BYTES });
    expect(assignment).toMatchObject({ maxProperties: 11, additionalProperties: false });
    expect(inboxRequest.cursor).toMatchObject({ pattern: "^(0|[1-9][0-9]*)$" });
    expect(objectAt(inboxPageProperties.events, "$defs.TaskInboxPage.events")).toMatchObject({
      maxItems: TASK_LIMITS.INBOX_PAGE_EVENTS,
    });
    const taskErrorEnvelope = objectAt(defs.TaskApiErrorEnvelope, "$defs.TaskApiErrorEnvelope");
    const taskError = objectAt(properties(taskErrorEnvelope).error, "$defs.TaskApiErrorEnvelope.error");
    expect(taskErrorEnvelope).toMatchObject({
      required: ["ok", "error"],
      additionalProperties: false,
    });
    expect(properties(taskError).path).toEqual({ type: "string" });
    expect(taskError.required).toEqual(["code", "message", "retryable"]);
    const eventInput = objectAt(defs.TaskEventInput, "$defs.TaskEventInput");
    expect(eventInput).toHaveProperty("oneOf");
    expect(eventInput).not.toHaveProperty("properties");
    expect(objectAt(properties(objectAt(defs.TaskCompletionInput, "$defs.TaskCompletionInput")).artifacts, "$defs.TaskCompletionInput.artifacts")).toMatchObject({
      maxItems: TASK_LIMITS.ARTIFACTS,
    });
    const peerEventRequest = properties(objectAt(operation("peerAcceptTaskEvent").request, "peerAcceptTaskEvent.request"));
    expect(peerEventRequest).toMatchObject({
      source: { $ref: "#/$defs/TaskAddress" },
      destination: { $ref: "#/$defs/TaskAddress" },
      event: { oneOf: [{ $ref: "#/$defs/TaskEventInput" }, { $ref: "#/$defs/CanonicalTaskEvent" }] },
      projection: { required: ["warnings"], additionalProperties: false },
    });
    expect(eventInput).not.toHaveProperty("sequence");
    const canonicalEvent = objectAt(defs.CanonicalTaskEvent, "$defs.CanonicalTaskEvent");
    expect(canonicalEvent).toHaveProperty("oneOf");
    expect(canonicalEvent).not.toHaveProperty("properties");
    expect(objectAt(defs.TaskEventPayload, "$defs.TaskEventPayload")).toHaveProperty("oneOf");
  });

  test("separates untrusted completion input from stored status output", () => {
    const defs = objectAt(artifact.$defs, "$defs");
    const complete = properties(objectAt(operation("completeTask").request, "completeTask.request"));
    const completionInput = objectAt(defs.TaskCompletionInput, "$defs.TaskCompletionInput");
    const completionArtifacts = objectAt(properties(completionInput).artifacts, "$defs.TaskCompletionInput.artifacts");
    const artifactInput = objectAt(completionArtifacts.items, "$defs.TaskCompletionInput.artifacts.items");
    const storedArtifact = properties(objectAt(defs.StoredArtifactRef, "$defs.StoredArtifactRef"));
    const status = properties(objectAt(operation("getTaskStatus").response, "getTaskStatus.response"));

    expect(complete.result).toEqual({ $ref: "#/$defs/TaskCompletionInput" });
    expect(properties(artifactInput)).not.toHaveProperty("machine");
    expect(storedArtifact).toMatchObject({ machine: { type: "string" }, project: { type: "string" } });
    expect(status).toMatchObject({
      completion: { $ref: "#/$defs/StoredTaskCompletion" },
      warnings: { type: "array" },
    });
  });

  test("publishes malformed upstream responses as 502 forwarding failures", () => {
    expect(operation("sendTask").errors).toContain("502 TaskApiErrorEnvelope");
    expect(operation("peerReceiveTask").errors).toContain("502 TaskApiErrorEnvelope");
    expect(operation("peerAcceptTaskEvent").errors).toContain("502 TaskApiErrorEnvelope");
  });

  test("documents runtime UTF-8 byte enforcement beyond schema character ceilings", () => {
    expect(artifact.trustBoundaries).toContain(
      "task schema maxLength values are character ceilings; runtime validates UTF-8 byte limits and returns PAYLOAD_TOO_LARGE",
    );
  });

  test("publishes sender failure input and reserves late terminals for canonical output", () => {
    const defs = objectAt(artifact.$defs, "$defs");
    const input = objectAt(defs.TaskEventInput, "$defs.TaskEventInput");
    const canonical = objectAt(defs.CanonicalTaskEvent, "$defs.CanonicalTaskEvent");
    const inputVariants = input.oneOf as readonly JsonObject[];
    const canonicalVariants = canonical.oneOf as readonly JsonObject[];
    const matches = (variant: JsonObject, type: string, actor: string) => {
      const variantProperties = properties(variant);
      return objectAt(variantProperties.type, "variant.type").const === type
        && objectAt(variantProperties.actor, "variant.actor").const === actor;
    };

    expect(inputVariants.some((variant) => matches(variant, "task.failed", "sender"))).toBe(true);
    expect(inputVariants.some((variant) => matches(variant, "task.cancelled", "parent"))).toBe(false);
    expect(inputVariants.some((variant) => matches(variant, "task.late_terminal", "sender"))).toBe(false);
    expect(canonicalVariants.some((variant) => matches(variant, "task.failed", "sender"))).toBe(true);
    expect(canonicalVariants.some((variant) => matches(variant, "task.late_terminal", "sender"))).toBe(true);
  });
});
