import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CONTROL_API_SCHEMA_ARTIFACT,
  buildControlApiSchema,
} from "../../src/control-api/schema.ts";
import {
  generateControlApiSchemaText,
  validateControlApiSchemaArtifact,
} from "../../scripts/gen-control-api-schema.ts";
import { SESSION_PROMPT_SELECTOR_MAX_CHARS } from "../../src/session-prompt-contract.ts";

type JsonObject = Record<string, unknown>;

const artifact = JSON.parse(readFileSync(CONTROL_API_SCHEMA_ARTIFACT, "utf-8")) as JsonObject;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveRef(schema: JsonObject, root: JsonObject): JsonObject {
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) throw new Error(`unsupported ref ${ref}`);
  const name = ref.slice(prefix.length);
  const defs = root.$defs;
  if (!isObject(defs) || !isObject(defs[name])) throw new Error(`missing ref ${ref}`);
  return defs[name] as JsonObject;
}

function validate(schema: unknown, value: unknown, root: JsonObject, path = "$"): string[] {
  if (!isObject(schema)) return [];
  const resolved = resolveRef(schema, root);
  if (resolved !== schema) return validate(resolved, value, root, path);

  if (Array.isArray(resolved.anyOf)) {
    const variants = resolved.anyOf.map((candidate) => validate(candidate, value, root, path));
    return variants.some((errors) => errors.length === 0)
      ? []
      : [`${path} did not match anyOf: ${variants.map((errors) => errors.join(", ")).join(" | ")}`];
  }

  if ("const" in resolved && value !== resolved.const) {
    return [`${path} expected const ${JSON.stringify(resolved.const)}`];
  }

  if (Array.isArray(resolved.enum) && !resolved.enum.some((candidate) => candidate === value)) {
    return [`${path} expected one of ${JSON.stringify(resolved.enum)}`];
  }

  if (typeof resolved.type === "string") {
    if (resolved.type === "object" && !isObject(value)) return [`${path} expected object`];
    if (resolved.type === "array" && !Array.isArray(value)) return [`${path} expected array`];
    if (resolved.type === "string" && typeof value !== "string") return [`${path} expected string`];
    if (resolved.type === "number" && typeof value !== "number") return [`${path} expected number`];
    if (resolved.type === "integer" && (!Number.isInteger(value))) return [`${path} expected integer`];
    if (resolved.type === "boolean" && typeof value !== "boolean") return [`${path} expected boolean`];
    if (resolved.type === "null" && value !== null) return [`${path} expected null`];
  }

  if (typeof value === "string" && typeof resolved.pattern === "string" && !(new RegExp(resolved.pattern).test(value))) {
    return [`${path} failed pattern ${resolved.pattern}`];
  }

  if (Array.isArray(value) && isObject(resolved.items)) {
    return value.flatMap((item, index) => validate(resolved.items, item, root, `${path}[${index}]`));
  }

  if (isObject(value) && isObject(resolved.properties)) {
    const required = Array.isArray(resolved.required) ? resolved.required : [];
    const errors: string[] = [];
    for (const key of required) {
      if (typeof key === "string" && !(key in value)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(resolved.properties)) {
      if (key in value) errors.push(...validate(child, value[key], root, `${path}.${key}`));
    }
    if (resolved.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in resolved.properties)) errors.push(`${path}.${key} is not allowed`);
      }
    }
    return errors;
  }

  return [];
}

function httpOperation(operationId: string): JsonObject {
  const http = artifact.http;
  if (!isObject(http) || !isObject(http[operationId])) throw new Error(`missing operation ${operationId}`);
  return http[operationId] as JsonObject;
}

function httpRequest(operationId: string): JsonObject {
  const operation = httpOperation(operationId);
  if (!isObject(operation.request)) throw new Error(`missing request schema for ${operationId}`);
  return operation.request;
}

function httpResponse(operationId: string): JsonObject {
  const operation = httpOperation(operationId);
  if (!isObject(operation.response)) throw new Error(`missing response schema for ${operationId}`);
  return operation.response;
}

function wsMessage(name: string): JsonObject {
  const websocket = artifact.websocket;
  const pty = isObject(websocket) ? websocket["/ws/pty"] : undefined;
  const messages = isObject(pty) ? pty.messages : undefined;
  const message = isObject(messages) ? messages[name] : undefined;
  if (!isObject(message) || !isObject(message.schema)) throw new Error(`missing ws message ${name}`);
  return message.schema;
}

describe("control api schema generation", () => {
  test("generated artifact is current", () => {
    expect(readFileSync(CONTROL_API_SCHEMA_ARTIFACT, "utf-8")).toBe(generateControlApiSchemaText());
  });

  test("schema source emits a stable snapshot", () => {
    expect(JSON.stringify(buildControlApiSchema(), null, 2)).toMatchSnapshot();
  });

  test("artifact has no duplicate contracts or unsupported field types", () => {
    expect(validateControlApiSchemaArtifact(artifact)).toEqual([]);
  });

  test("does not publish removed loop-runner contracts", () => {
    const http = artifact.http;
    expect(isObject(http)).toBe(true);
    expect(Object.keys(http as JsonObject).filter((key) => key.toLowerCase().includes("ralph"))).toEqual([]);
    expect("ralph" in artifact).toBe(false);
  });

  test("backend status matches the broker-only runtime response", () => {
    const response = httpResponse("getBackendStatus");

    expect(validate(response, { brokerAvailable: true, counts: { broker: 2 } }, artifact)).toEqual([]);
    expect(validate(response, { brokerAvailable: true, counts: { broker: 2, tmux: 0 } }, artifact)).not.toEqual([]);
  });
});

describe("control api schema docs", () => {
  test("documents runtime routes as authoritative validation boundary", () => {
    const docs = readFileSync("docs/control-api-schema.md", "utf-8");

    expect(docs).toContain("Runtime routes remain authoritative");
  });
});

describe("control api schema compatibility samples", () => {
  test("create-session request requires project or newProject", () => {
    const request = httpRequest("createSession");

    expect(validate(request, { cmd: "shell" }, artifact)).not.toEqual([]);
    expect(validate(request, { project: "wolfpack", cmd: "shell" }, artifact)).toEqual([]);
    expect(validate(request, {
      project: "wolfpack",
      cmd: "pi",
      sessionName: "pi-main-sub-agent",
      parentSession: "pi-main",
      initialPrompt: "perform differential review only",
    }, artifact)).toEqual([]);
    expect((request.properties as JsonObject).parentSession).toEqual({ $ref: "#/$defs/SessionName" });
    expect((request.properties as JsonObject).initialPrompt).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 32768,
    });
    expect(validate(request, { newProject: "fresh-app" }, artifact)).toEqual([]);
  });

  test("atomic prompt wait publishes the output-only predicate and every phase-1 outcome", () => {
    const operation = httpOperation("promptSessionAndWaitForOutput");
    const request = httpRequest("promptSessionAndWaitForOutput");
    const response = httpResponse("promptSessionAndWaitForOutput");

    expect(operation.auth).toBe("jwt-when-configured");
    expect(resolveRef((request.properties as JsonObject).session as JsonObject, artifact)).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: SESSION_PROMPT_SELECTOR_MAX_CHARS,
    });
    expect(operation.errors).toContain("413 ErrorEnvelope");
    expect(validate(request, {
      session: "id-alpha",
      prompt: "run the check",
      outputContains: "READY",
      noEnter: false,
      timeoutMs: 250,
    }, artifact)).toEqual([]);
    expect(validate(request, {
      session: "id-alpha",
      prompt: "run the check",
      agentState: "idle",
    }, artifact)).not.toEqual([]);

    for (const outcome of [
      "matched",
      "timed_out",
      "target_exited",
      "target_unavailable",
      "target_replaced",
      "replay_gap",
      "backend_unavailable",
    ]) {
      expect(validate(response, {
        ok: outcome === "matched",
        session: "alpha",
        sessionId: "id-alpha",
        outcome,
        outputBoundarySeq: "42",
      }, artifact), outcome).toEqual([]);
    }
  });

  test("provider readiness publishes the authenticated discriminated response", () => {
    const operation = httpOperation("listProviderReadiness");
    const response = httpResponse("listProviderReadiness");

    expect(operation.auth).toBe("jwt-when-configured");
    expect(validate(response, {
      providers: [
        {
          id: "codex",
          displayName: "Codex",
          command: "codex",
          status: "installed",
          executablePath: "/opt/homebrew/bin/codex",
          version: "codex-cli 7.6.5",
          authStatus: "unknown",
          loginCommand: "codex login",
        },
        {
          id: "gemini",
          displayName: "Gemini CLI",
          command: "gemini",
          status: "missing",
          installGuidance: "npm install -g @google/gemini-cli",
        },
      ],
    }, artifact)).toEqual([]);
  });

  test("session-open publishes a strict ordinary-auth request and deterministic success", () => {
    const operation = httpOperation("openSession");
    const request = httpRequest("openSession");

    expect(operation.auth).toBe("jwt-when-configured");
    expect(validate(request, {
      project: "wolfpack",
      parentSession: "pi-main",
      initialPrompt: "perform differential review only",
    }, artifact)).toEqual([]);
    expect(validate(request, {
      project: "wolfpack",
      parentSession: "pi-main",
      cmd: "claude",
    }, artifact)).not.toEqual([]);
    expect(validate(request, {
      project: "wolfpack",
      parentSession: "pi-main",
      sessionName: "override",
    }, artifact)).toEqual([]);
    expect((request.properties as JsonObject).initialPrompt).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 32768,
    });
    expect(validate(httpResponse("openSession"), {
      ok: true,
      session: "pi-main-sub-agent",
      sessionId: "11111111-1111-1111-1111-111111111111",
      project: "wolfpack",
      harness: "pi",
    }, artifact)).toEqual([]);
  });

  test("agent runtime acknowledgement request is typed", () => {
    expect(validate(httpRequest("ackAgentRuntimeState"), {
      sessionId: "broker-child",
      transitionSequence: 3,
    }, artifact)).toEqual([]);
    expect(validate(httpResponse("ackAgentRuntimeState"), {
      ok: true,
      runtimeState: {
        state: "needs-input",
        authority: "manifest",
        freshness: "fresh",
        source: "local-manifest",
        label: "structured manifest",
        stale: false,
        observedAt: "2026-07-11T00:00:00Z",
        changedAt: "2026-07-11T00:00:00Z",
        transitionSequence: 3,
        acknowledgedAt: "2026-07-11T00:01:00Z",
        acknowledgedSequence: 3,
        unseen: false,
      },
    }, artifact)).toEqual([]);
  });

  test("session status requires machine-readable preflight fields", () => {
    const response = httpResponse("getSessionStatus");

    expect(validate(response, {
      ok: true,
      session: "wolf-1-sub-agent",
      sessionId: "broker-child",
      state: "active",
      projectPath: "/repo/wolf-1",
      harness: "pi",
    }, artifact)).toEqual(expect.arrayContaining([
      "$.selector is required",
      "$.project is required",
      "$.projectDir is required",
      "$.terminal is required",
    ]));
  });

  test("session status publishes one closed failure envelope", () => {
    const failureSchema = { $ref: "#/$defs/SessionStatusFailure" };

    expect(validate(failureSchema, {
      ok: false,
      selector: "dead-agent",
      session: "dead-agent",
      sessionId: "broker-dead",
      terminal: { exists: true, alive: false, status: "dead" },
      error: { code: "SESSION_DEAD", message: "session is not alive" },
    }, artifact)).toEqual([]);
    expect(validate(failureSchema, {
      ok: false,
      error: { code: "BROKER_SAID_SOMETHING", message: "unbounded prose" },
    }, artifact)).not.toEqual([]);
  });

  test("representative http responses satisfy generated schemas", () => {
    const samples: Array<[string, unknown]> = [
      ["getInfo", { name: "devbox", version: "1.6.6" }],
      ["listSessions", { sessions: [{
        name: "wolf-1-sub-agent",
        lastLine: "",
        triage: "idle",
        outputSequence: "42",
        identity: {
          wolfpackSessionId: "broker-child",
          wolfpackSessionName: "wolf-1-sub-agent",
          projectPath: "/repo/wolf-1",
          agentKind: "pi",
          createdAt: "2026-07-11T00:00:00Z",
          updatedAt: "2026-07-11T00:00:00Z",
          parentSession: {
            wolfpackSessionId: "broker-parent",
            wolfpackSessionName: "wolf-1",
          },
        },
        runtimeState: {
          state: "idle",
          authority: "fallback",
          freshness: "fresh",
          source: "screen-fallback",
          label: "bounded activity idle",
          stale: false,
          observedAt: "2026-07-11T00:00:00Z",
          changedAt: "2026-07-11T00:00:00Z",
          transitionSequence: 1,
          unseen: true,
        },
      }] }],
      ["getSettings", {
        settings: { agentCmd: "shell", cmds: [{ cmd: "shell", enabled: true }] },
        effective: { agentCmd: "shell", cmds: ["shell"] },
      }],
      ["getSessionStatus", {
        ok: true,
        selector: "broker-child",
        session: "wolf-1-sub-agent",
        sessionId: "broker-child",
        state: "active",
        project: "wolf-1",
        projectPath: "/repo/wolf-1",
        projectDir: "/repo/wolf-1",
        harness: "pi",
        terminal: { exists: true, alive: true, status: "ready" },
      }],
    ];

    for (const [operationId, payload] of samples) {
      expect(validate(httpResponse(operationId), payload, artifact), operationId).toEqual([]);
    }
  });

  test("representative websocket control messages satisfy generated schemas", () => {
    const samples: Array<[string, unknown]> = [
      ["attach", { type: "attach", cols: 120, rows: 40, prefillMode: "full" }],
      ["resize", { type: "resize", cols: 100, rows: 30 }],
      ["layout_stable", { type: "layout_stable", cols: 100, rows: 30 }],
      ["take_control", { type: "take_control" }],
      ["attach_ack", { type: "attach_ack" }],
      ["prefill_done", { type: "prefill_done" }],
      ["prefill_viewport", { type: "prefill_viewport" }],
      ["pty_ready", { type: "pty_ready" }],
      ["viewer_conflict", { type: "viewer_conflict" }],
      ["control_granted", { type: "control_granted" }],
      ["sub_session_opened", {
        type: "sub_session_opened",
        parentSession: "pi-main",
        session: "pi-main-sub-agent",
      }],
    ];

    for (const [messageName, payload] of samples) {
      expect(validate(wsMessage(messageName), payload, artifact), messageName).toEqual([]);
    }
  });

});
