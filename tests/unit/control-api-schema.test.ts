import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CONTROL_API_SCHEMA_ARTIFACT } from "../../src/control-api/schema.ts";
import {
  generateControlApiSchemaText,
  validateControlApiSchemaArtifact,
} from "../../scripts/gen-control-api-schema.ts";
import { SESSION_PROMPT_SELECTOR_MAX_CHARS } from "../../src/session-prompt-contract.ts";
import { SESSION_OPEN_MAX_MODEL_LENGTH } from "../../src/session-open-contract.ts";
import {
  DIRECTORY_BREADCRUMB_LIMIT,
  DIRECTORY_BROWSE_LIMIT,
} from "../../src/server/directory-browser.ts";
import {
  MACHINE_CAPABILITY,
  MACHINE_MAX_CAPABILITIES,
  TAILNET_MAX_CANDIDATES,
  classifyMachineHandshake,
} from "../../src/tailnet-machine-contract.ts";
import {
  isJsonObject as isObject,
  resolveControlApiSchemaRef as resolveRef,
  validateControlApiSchemaValue as validate,
} from "../control-api-schema-validator.ts";
import type { JsonObject } from "../control-api-schema-validator.ts";

const artifact = JSON.parse(readFileSync(CONTROL_API_SCHEMA_ARTIFACT, "utf-8")) as JsonObject;

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

describe("control api schema", () => {
  test("publishes the opaque relay adapter contract", () => {
    const connect = httpOperation("connectTaskRelay");
    const peerTopology = httpOperation("resolvePeerTaskRelayTopology");
    const send = httpOperation("sendTaskRelayEnvelope");
    const endpoint = resolveRef({ $ref: "#/$defs/RelayEndpoint" }, artifact);
    const relay = (endpoint.properties as JsonObject).relay as JsonObject;

    expect(connect.route).toBe("POST /api/task-relay/v2/connect");
    expect(peerTopology.route).toBe("POST /api/task-relay/v2/peer/resolve");
    expect(peerTopology.request).toMatchObject({
      required: ["origin", "endpoint"],
      properties: { origin: { $ref: "#/$defs/TailnetOrigin" }, endpoint: { $ref: "#/$defs/RelayEndpoint" } },
    });
    expect(send.route).toBe("POST /api/task-relay/v2/send");
    expect(relay).toMatchObject({ type: "string" });
    expect(String(relay.pattern)).toContain("wolfpack");
    expect(JSON.stringify(endpoint)).not.toContain("ts.net");
  });
});

describe("control api schema compatibility samples", () => {
  test("matches classifier compatibility for future additions and canonical Tailnet origins", () => {
    const response = httpResponse("getMachineHandshake");
    const candidate = {
      hostname: "peer.example.ts.net",
      tailnetNodeId: "n-peer",
      origin: "https://peer.example.ts.net",
      online: true,
    };
    const requiredCapabilities = [
      MACHINE_CAPABILITY.SESSIONS,
      MACHINE_CAPABILITY.TERMINAL_WEBSOCKET,
      MACHINE_CAPABILITY.PUSH_SUBSCRIPTION,
    ];
    const futureHandshake = {
      protocol: { name: "wolfpack-machine", major: 1, minor: 9, futureProtocolField: "allowed" },
      machine: {
        tailnetNodeId: candidate.tailnetNodeId,
        installationId: "2af8af29-c4fe-44f9-9a99-9a0e35952d74",
        displayName: "peer",
        origin: candidate.origin,
        futureMachineField: true,
      },
      wolfpack: { version: "1.7.0", futureWolfpackField: "allowed" },
      capabilities: [...requiredCapabilities, "future-capability"],
      futureHandshakeField: { allowed: true },
    };

    expect(classifyMachineHandshake(candidate, futureHandshake).kind).toBe("ready");
    expect(validate(response, futureHandshake, artifact)).toEqual([]);
    expect(validate(response, {
      ...futureHandshake,
      capabilities: [MACHINE_CAPABILITY.SESSIONS, MACHINE_CAPABILITY.TERMINAL_WEBSOCKET, "future-capability"],
    }, artifact)).not.toEqual([]);

    for (const capabilities of [
      [...futureHandshake.capabilities, MACHINE_CAPABILITY.SESSIONS],
      [
        ...requiredCapabilities,
        ...Array.from(
          { length: MACHINE_MAX_CAPABILITIES - requiredCapabilities.length + 1 },
          (_, index) => `future-capability-${index}`,
        ),
      ],
    ]) {
      const handshake = { ...futureHandshake, capabilities };
      expect(classifyMachineHandshake(candidate, handshake).kind).toBe("incompatible");
      expect(validate(response, handshake, artifact)).not.toEqual([]);
    }

    const malformedOrigin = {
      protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
      machine: {
        tailnetNodeId: candidate.tailnetNodeId,
        installationId: "2af8af29-c4fe-44f9-9a99-9a0e35952d74",
        displayName: "peer",
        origin: "https://peer..example.ts.net",
      },
      wolfpack: { version: "1.7.0" },
      capabilities: requiredCapabilities,
    };
    const malformedCandidate = {
      ...candidate,
      hostname: "peer..example.ts.net",
      origin: "https://peer..example.ts.net",
    };

    expect(classifyMachineHandshake(malformedCandidate, malformedOrigin).kind).toBe("incompatible");
    expect(validate(response, malformedOrigin, artifact)).not.toEqual([]);
  });

  test("publishes canonical typed online and offline Tailnet candidate facts", () => {
    const operation = httpOperation("discoverTailnetCandidates");
    const response = httpResponse("discoverTailnetCandidates");
    const candidates = Array.from({ length: TAILNET_MAX_CANDIDATES }, (_, index) => ({
      hostname: `peer-${index}.example.ts.net`,
      tailnetNodeId: `n-peer-${index}`,
      origin: `https://peer-${index}.example.ts.net`,
      online: index % 2 === 0,
    }));

    expect(operation.route).toBe("GET /api/tailnet/v1/candidates");
    expect(validate(response, { candidates }, artifact)).toEqual([]);
    expect(validate(response, { candidates: [...candidates, candidates[0]] }, artifact)).not.toEqual([]);
    expect(validate(response, {
      candidates: [{ hostname: "online.example.ts.net", tailnetNodeId: "n-online", origin: "https://online.example.ts.net" }],
    }, artifact)).not.toEqual([]);
  });

  test("preserves the deprecated legacy discovery peer facade", () => {
    const operation = httpOperation("discoverPeers");
    const response = httpResponse("discoverPeers");
    const peers = [{
      hostname: "online.example.ts.net",
      url: "https://online.example.ts.net",
      name: "online.example.ts.net",
    }];

    expect(operation.route).toBe("GET /api/discover");
    expect(validate(response, { peers }, artifact)).toEqual([]);
    expect(validate(response, { candidates: [] }, artifact)).not.toEqual([]);
  });

  test("publishes the bounded authenticated server-directory browser contract", () => {
    const operation = httpOperation("browseDirectories");
    const request = httpRequest("browseDirectories");
    const response = httpResponse("browseDirectories");
    const directories = Array.from({ length: DIRECTORY_BROWSE_LIMIT }, (_, index) => ({
      name: `directory-${index}`,
      path: `/server/projects/directory-${index}`,
    }));

    expect(operation.route).toBe("GET /api/directories");
    expect(operation.auth).toBe("jwt-when-configured");
    expect(operation.errors).toEqual([
      "400 DirectoryBrowseErrorEnvelope",
      "403 DirectoryBrowseErrorEnvelope",
      "404 DirectoryBrowseErrorEnvelope",
      "422 DirectoryBrowseErrorEnvelope",
      "503 DirectoryBrowseErrorEnvelope",
    ]);
    expect(validate(
      (artifact.$defs as JsonObject).DirectoryBrowseErrorEnvelope,
      {
        error: "directory contains too many entries",
        code: "too_many_entries",
      },
      artifact,
    )).toEqual([]);
    expect(validate(
      (artifact.$defs as JsonObject).DirectoryBrowseErrorEnvelope,
      {
        error: "directory permission denied",
        code: "permission_denied",
      },
      artifact,
    )).toEqual([]);
    expect(validate(request, {}, artifact)).toEqual([]);
    expect(validate(request, { path: "/server/projects" }, artifact)).toEqual([]);
    expect(validate(request, { path: "relative/projects" }, artifact)).not.toEqual([]);
    expect(validate(response, {
      current: "/server/projects",
      parent: "/server",
      breadcrumbs: [
        { name: "/", path: "/" },
        { name: "server", path: "/server" },
        { name: "projects", path: "/server/projects" },
      ],
      directories,
    }, artifact)).toEqual([]);
    expect(validate(response, {
      current: "/",
      parent: null,
      breadcrumbs: [{ name: "/", path: "/" }],
      directories: [],
    }, artifact)).toEqual([]);
    expect(validate(response, {
      current: "/server/projects",
      parent: "/server",
      directories: [],
    }, artifact)).toEqual([]);
    expect(validate(response, {
      current: "/server/projects",
      parent: "/server",
      breadcrumbs: [{ name: "/", path: "/" }],
      directories: [...directories, { name: "overflow", path: "/server/projects/overflow" }],
    }, artifact)).not.toEqual([]);
    expect(validate(response, {
      current: "/server/projects",
      parent: "/server",
      breadcrumbs: Array.from({ length: DIRECTORY_BREADCRUMB_LIMIT + 1 }, (_, index) => ({
        name: `level-${index}`,
        path: `/level-${index}`,
      })),
      directories: [],
    }, artifact)).not.toEqual([]);
  });

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
    expect(validate(request, {
      newProject: "fresh-app",
      newProjectParent: "/srv/worktrees",
    }, artifact)).toEqual([]);
    expect((request as { readonly dependentRequired?: unknown }).dependentRequired).toEqual({
      newProjectParent: ["newProject"],
    });
    expect(validate(request, {
      project: "wolfpack",
      newProject: "fresh-app",
    }, artifact)).toEqual([]);
    expect(validate(request, { projectDir: "/srv/worktrees/alpha", cmd: "pi" }, artifact)).toEqual([]);
    expect(validate(request, {
      project: "wolfpack",
      projectDir: "/srv/worktrees/alpha",
      cmd: "pi",
    }, artifact)).not.toEqual([]);
    expect(validate(request, {
      projectDir: "/srv/worktrees/alpha",
      newProject: "fresh-app",
    }, artifact)).not.toEqual([]);
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

  test("top-level session creation accepts shell without widening child-agent harnesses", () => {
    const request = httpRequest("createTopLevelSession");

    expect(validate(request, { project: "wolfpack", harness: "shell" }, artifact)).toEqual([]);
    expect(validate(request, { project: "wolfpack", harness: "future-agent" }, artifact)).not.toEqual([]);
    expect((artifact.$defs as JsonObject).CreatableHarness).toEqual({
      enum: ["shell", "pi", "claude", "codex", "gemini", "cursor"],
    });
  });

  test("next-session-name publishes unavailable filesystem failures", () => {
    expect(httpOperation("nextSessionName").errors).toEqual([
      "400 ErrorEnvelope",
      "404 ErrorEnvelope",
      "503 ErrorEnvelope",
    ]);
  });

  test("next-session-name accepts exactly one existing or future project selector", () => {
    const request = httpRequest("nextSessionName");

    expect(validate(request, { project: "wolfpack" }, artifact)).toEqual([]);
    expect(validate(request, { projectDir: "/worktrees/wolfpack" }, artifact)).toEqual([]);
    expect(validate(request, { newProject: "fresh-app" }, artifact)).toEqual([]);
    expect(validate(request, {
      project: "wolfpack",
      newProject: "fresh-app",
    }, artifact)).not.toEqual([]);
    expect(validate(request, {
      projectDir: "/worktrees/wolfpack",
      newProject: "fresh-app",
    }, artifact)).not.toEqual([]);
  });

  test("launch contracts accept one explicit absolute project directory selector", () => {
    const explicit = { projectDir: "/worktrees/path with spaces" };

    expect(validate(httpRequest("createTopLevelSession"), explicit, artifact)).toEqual([]);
    expect(validate(httpRequest("openSession"), {
      ...explicit,
      parentSession: "pi-main",
    }, artifact)).toEqual([]);
    expect(validate(httpRequest("createSession"), explicit, artifact)).toEqual([]);
    expect(validate(httpRequest("nextSessionName"), explicit, artifact)).toEqual([]);
    expect(validate(httpRequest("createTopLevelSession"), {
      project: "wolfpack",
      projectDir: "/worktrees/wolfpack",
    }, artifact)).not.toEqual([]);
    expect(validate(httpRequest("createTopLevelSession"), {
      projectDir: "relative/project",
    }, artifact)).not.toEqual([]);
  });

  test("session-open publishes a strict ordinary-auth request and deterministic success", () => {
    const operation = httpOperation("openSession");
    const request = httpRequest("openSession");

    expect(operation.auth).toBe("jwt-when-configured");
    expect(validate(request, {
      project: "wolfpack",
      parentSession: "pi-main",
      model: "openrouter/anthropic/claude-sonnet-4",
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
    expect((request.properties as JsonObject).model).toEqual({
      type: "string",
      minLength: 1,
      maxLength: SESSION_OPEN_MAX_MODEL_LENGTH,
      description: "Opaque pi model pattern or ID passed to the child harness",
    });
    expect(validate(request, {
      project: "wolfpack",
      parentSession: "pi-main",
      model: "x".repeat(SESSION_OPEN_MAX_MODEL_LENGTH + 1),
    }, artifact)).not.toEqual([]);
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

  test("publishes opt-in task-worker readiness on both launch contracts", () => {
    const endpoint = { relay: "wolfpack-pi-tasks-v2", id: "e4ef9a6c-90e2-4e08-a74e-904a2e4f59f5" };
    const topLevel = httpRequest("createTopLevelSession");
    const child = httpRequest("openSession");

    for (const request of [topLevel, child]) {
      expect(validate(request, {
        projectDir: "/worktrees/wolfpack",
        ...(request === child && { parentSession: "pi-main" }),
        taskWorker: true,
        readinessTimeoutMs: 30_000,
      }, artifact)).toEqual([]);
      expect(validate(request, {
        projectDir: "/worktrees/wolfpack",
        ...(request === child && { parentSession: "pi-main" }),
        taskWorker: true,
        readinessTimeoutMs: 60_001,
      }, artifact)).not.toEqual([]);
    }
    expect(validate(httpResponse("createTopLevelSession"), {
      ok: true,
      session: "worker",
      sessionId: "worker-id",
      project: "wolfpack",
      harness: "pi",
      taskEndpoint: endpoint,
    }, artifact)).toEqual([]);
  });

  test("models task-worker mode exclusions and recovery errors", () => {
    const topLevel = httpRequest("createTopLevelSession");
    const child = httpRequest("openSession");

    for (const request of [topLevel, child]) {
      const parent = request === child ? { parentSession: "pi-main" } : {};
      expect(validate(request, {
        project: "wolfpack",
        ...parent,
        taskWorker: true,
      }, artifact)).not.toEqual([]);
      expect(validate(request, {
        projectDir: "/worktrees/wolfpack",
        ...parent,
        taskWorker: true,
        initialPrompt: "do not run",
      }, artifact)).not.toEqual([]);
      expect(validate(request, {
        projectDir: "/worktrees/wolfpack",
        ...parent,
        readinessTimeoutMs: 100,
      }, artifact)).not.toEqual([]);
    }
    expect(validate(topLevel, {
      projectDir: "/worktrees/wolfpack",
      harness: "shell",
      taskWorker: true,
    }, artifact)).not.toEqual([]);

    const readinessError = resolveRef({ $ref: "#/$defs/TaskWorkerLaunchErrorEnvelope" }, artifact);
    expect(validate(readinessError, {
      error: "task worker did not become ready",
      code: "TASK_WORKER_NOT_READY",
      createdSession: { session: "worker", sessionId: "worker-id" },
      cleanup: "unconfirmed",
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
      ["getInfo", { name: "devbox", version: "1.6.6", machineId: "018f6b48-4b1c-7000-8000-000000000001" }],
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

  test("standalone task payload limits late-terminal original types to terminals", () => {
    const payload = { $ref: "#/$defs/TaskEventPayload" };
    const terminalLate = { kind: "late_terminal", originalType: "task.failed", originalEventId: "018f6b48-4b1c-7000-8000-000000000011" };

    expect(validate(payload, terminalLate, artifact)).toEqual([]);
    expect(validate(payload, { ...terminalLate, originalType: "task.created" }, artifact)).not.toEqual([]);
  });

  test("task event schemas reject actor, payload, provenance, and canonical mismatches", () => {
    const input = { $ref: "#/$defs/TaskEventInput" };
    const canonical = { $ref: "#/$defs/CanonicalTaskEvent" };
    const inputCompletion = {
      id: "018f6b48-4b1c-7000-8000-000000000010",
      taskId: "018f6b48-4b1c-7000-8000-000000000001",
      type: "task.completed",
      actor: "receiver",
      occurredAt: "2026-08-03T00:00:00.000Z",
      payload: { kind: "none" },
      completion: { summary: "finished", artifacts: [{ path: "result.json" }] },
    };
    const canonicalCompletion = {
      ...inputCompletion,
      source: { machine: "machine-b", sessionId: "receiver" },
      destination: { machine: "machine-a", sessionId: "parent" },
      sequence: "1",
      completion: {
        summary: "finished",
        artifacts: [{ machine: "machine-b", project: "receiver-project", path: "result.json" }],
        warnings: [],
      },
    };

    expect(validate(input, inputCompletion, artifact)).toEqual([]);
    expect(validate(canonical, canonicalCompletion, artifact)).toEqual([]);
    const parentCancelled = { ...inputCompletion, type: "task.cancelled", actor: "parent", completion: undefined };
    const senderFailed = { ...inputCompletion, type: "task.failed", actor: "sender" };
    const lateTerminal = { ...inputCompletion, type: "task.late_terminal", actor: "sender", completion: undefined, payload: { kind: "late_terminal", originalType: "task.failed", originalEventId: "018f6b48-4b1c-7000-8000-000000000011" } };
    const { completion: _completion, ...lateTerminalWithoutCompletion } = lateTerminal;
    const canonicalLateTerminal = { ...lateTerminalWithoutCompletion, source: { machine: "machine-a", sessionId: "sender" }, destination: { machine: "machine-b", sessionId: "receiver" }, sequence: "2" };

    expect(validate(input, { ...inputCompletion, actor: "parent" }, artifact)).not.toEqual([]);
    expect(validate(input, { ...inputCompletion, payload: { kind: "delivery_failure", code: "OFFLINE", message: "offline" } }, artifact)).not.toEqual([]);
    expect(validate(input, { ...inputCompletion, completion: canonicalCompletion.completion }, artifact)).not.toEqual([]);
    expect(validate(input, parentCancelled, artifact)).not.toEqual([]);
    expect(validate(input, senderFailed, artifact)).toEqual([]);
    expect(validate(input, lateTerminal, artifact)).not.toEqual([]);
    expect(validate(canonical, { ...canonicalCompletion, actor: "parent" }, artifact)).not.toEqual([]);
    expect(validate(canonical, { ...canonicalCompletion, completion: inputCompletion.completion }, artifact)).not.toEqual([]);
    expect(validate(canonical, { ...canonicalLateTerminal, payload: { ...canonicalLateTerminal.payload, originalType: "task.created" } }, artifact)).not.toEqual([]);
    expect(validate(canonical, canonicalLateTerminal, artifact)).toEqual([]);
  });

  test("representative websocket control messages satisfy generated schemas", () => {
    const samples: Array<[string, unknown]> = [
      ["attach", { type: "attach", cols: 120, rows: 40, prefillMode: "full" }],
      ["resize", { type: "resize", resizeId: 1, cols: 100, rows: 30 }],
      ["layout_stable", { type: "layout_stable", cols: 100, rows: 30 }],
      ["take_control", { type: "take_control" }],
      ["attach_ack", { type: "attach_ack", capabilities: ["ordered-resize-ack"] }],
      ["attach_ack", { type: "attach_ack" }], // same-major peer without ordered resize support
      ["resize_ack", { type: "resize_ack", resizeId: 1, cols: 100, rows: 30 }],
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
