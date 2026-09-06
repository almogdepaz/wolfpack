import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import type { Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";
import pkg from "../../package.json";
import { SESSION_CREATE_ERROR } from "../../src/session-create-contract.ts";
import {
  SESSION_OPEN_ERROR,
  SESSION_OPEN_HTTP_STATUS,
  SESSION_OPEN_MAX_MODEL_LENGTH,
} from "../../src/session-open-contract.ts";
import type { PublicSessionIdentity } from "../../src/server/session-identity.ts";
import {
  SESSION_PROMPT_MAX_REQUEST_BODY_BYTES,
  SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS,
  SESSION_PROMPT_SELECTOR_MAX_CHARS,
} from "../../src/session-prompt-contract.ts";
import { MAX_INITIAL_PROMPT_LENGTH } from "../../src/validation.ts";
import {
  createTailnetOriginServerFixture,
  getTailnetReadyPort,
  TAILNET_ORIGIN_IPC_MESSAGE_TYPE,
  TAILNET_REJECTED_ORIGINS,
  TAILNET_SIBLING_ORIGIN,
} from "./tailnet-origin-fixture.ts";
import type { TailnetOriginServerFixture } from "./tailnet-origin-fixture.ts";
import { CONTROL_API_SCHEMA_ARTIFACT } from "../../src/control-api/schema.ts";
import {
  isJsonObject as isSchemaObject,
  validateControlApiSchemaValue as validateSchema,
} from "../control-api-schema-validator.ts";
import type { JsonObject } from "../control-api-schema-validator.ts";

// ─── Environment setup (must precede imports that read env) ──────────────────
process.env.WOLFPACK_TEST = "1";
delete process.env.WOLFPACK_JWT_SECRET;

const PRIOR_WOLFPACK_DEV_DIR = process.env.WOLFPACK_DEV_DIR;
const PRIOR_WOLFPACK_SESSION_IDENTITY_PATH = process.env.WOLFPACK_SESSION_IDENTITY_PATH;
const PRIOR_WOLFPACK_AGENT_RUNTIME_STATE_PATH = process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH;
const PRIOR_WOLFPACK_SETTINGS_PATH = process.env.WOLFPACK_SETTINGS_PATH;
const PRIOR_WOLFPACK_TASK_RELAY_ROOT = process.env.WOLFPACK_TASK_RELAY_ROOT;
const { DEV_DIR: PRIOR_CACHED_DEV_DIR } = await import("../../src/server/dev-dir.ts");

// Create a real temp dir for test project directories.
// realpathSync resolves macOS /var → /private/var so isUnderDevDir agrees.
const RAW_TEST_DEV_DIR = mkdtempSync(join(tmpdir(), "wolfpack-api-test-"));
const TEST_DEV_DIR = realpathSync(RAW_TEST_DEV_DIR);
process.env.WOLFPACK_DEV_DIR = TEST_DEV_DIR;
process.env.WOLFPACK_SESSION_IDENTITY_PATH = join(TEST_DEV_DIR, "session-identities.json");
process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH = join(TEST_DEV_DIR, "agent-runtime-state.json");
// Isolate the settings file so the /api/settings tests don't mutate the
// developer's real ~/.wolfpack/bridge-settings.json. The path is read at
// every loadSettings/saveSettings call so this works as long as it's set
// before the first request.
const TEST_SETTINGS_PATH = join(TEST_DEV_DIR, "bridge-settings.json");
const TEST_TASK_RELAY_ROOT = join(TEST_DEV_DIR, "task-relay");
process.env.WOLFPACK_SETTINGS_PATH = TEST_SETTINGS_PATH;
process.env.WOLFPACK_TASK_RELAY_ROOT = TEST_TASK_RELAY_ROOT;

const { __resetTaskRelayGatewayForTests, getTaskRelayGateway } = await import("../../src/task-relay/gateway.ts");
__resetTaskRelayGatewayForTests();
const { __resetJwtAuthConfig, __setDevDir } = await import("../../src/test-hooks.ts");
const { __setTestBackend, DuplicateSessionError } = await import("../../src/server/backend.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");
__resetJwtAuthConfig();

// Override cached DEV_DIR so routes.ts join(DEV_DIR, ...) uses our temp path.
// Other test files may have imported tmux.ts first with a different env value.
__setDevDir(TEST_DEV_DIR);
process.env.WOLFPACK_DEV_DIR = TEST_DEV_DIR;

const controlApiSchema = JSON.parse(readFileSync(CONTROL_API_SCHEMA_ARTIFACT, "utf8")) as JsonObject;

function responseSchema(operationId: string): JsonObject {
  const http = controlApiSchema.http;
  if (!isSchemaObject(http)) throw new Error("control API HTTP schema is missing");
  const operation = http[operationId];
  if (!isSchemaObject(operation) || !isSchemaObject(operation.response)) {
    throw new Error(`control API response schema is missing for ${operationId}`);
  }
  return operation.response;
}

const mockBackend = new MockBackend({
  sessions: ["wolf-1", "wolf-2"],
  capturePane: async (s: string) => `captured output for ${s}\n`,
});
__setTestBackend(mockBackend);

// Reset rate limiters so they don't interfere
const {
  createServerInstance,
  __pollRateLimiter,
  __globalRateLimiter,
} = await import("../../src/server/index.ts") as any;
const {
  addSubscription,
  removeSubscription,
  _testing: pushTesting,
} = await import("../../src/server/push.ts");
const { activePtySessions } = await import("../../src/server/websocket.ts");
const { AgentRuntimeStateStore, __resetAgentRuntimeStateStoreForTests } = await import("../../src/server/agent-status.ts");
const { forgetSessionObservation } = await import("../../src/server/session-observation.ts");

const {
  __resetSessionObservationForTests,
  __runSessionNotificationObservationForTests,
} = await import("../../src/server/routes.ts");

const { server } = createServerInstance();

let base = "";

// Test project names used by /api/create tests
const TEST_PROJECTS = ["my-app", "wolf-1", "fresh-app"];

// Track external temp roots we created so cleanup never touches unrelated paths.
const externalTempRoots: string[] = [];

function createExplicitProjectDir(name = "outside project"): string {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-explicit-api-"));
  const projectDir = join(root, name);
  mkdirSync(projectDir);
  externalTempRoots.push(root);
  return realpathSync(projectDir);
}

function ensureTestProjectDirs(): void {
  mkdirSync(TEST_DEV_DIR, { recursive: true });
  for (const name of TEST_PROJECTS) {
    const dir = join(TEST_DEV_DIR, name);
    mkdirSync(dir, { recursive: true });
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  ensureTestProjectDirs();

  await new Promise<void>((resolve) => {
    (server as Server).listen(0, "127.0.0.1", () => {
      const port = ((server as Server).address() as AddressInfo).port;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

beforeEach(() => {
  // Reset rate limiters before each test
  __pollRateLimiter._map.clear();
  __globalRateLimiter._map.clear();
  // Reset push notify debounce/rate-limit state so notify tests don't
  // depend on execution order (see TEST-01).
  pushTesting.resetDebounce();
  activePtySessions.clear();
  rmSync(process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH!, { force: true });
  __resetAgentRuntimeStateStoreForTests();
  __resetSessionObservationForTests();
});

afterAll(() => {
  (server as Server).close();
  __resetTaskRelayGatewayForTests();
  if (PRIOR_WOLFPACK_TASK_RELAY_ROOT === undefined) delete process.env.WOLFPACK_TASK_RELAY_ROOT;
  else process.env.WOLFPACK_TASK_RELAY_ROOT = PRIOR_WOLFPACK_TASK_RELAY_ROOT;
  for (const root of externalTempRoots) rmSync(root, { recursive: true, force: true });
  rmSync(TEST_DEV_DIR, { recursive: true, force: true });
  if (PRIOR_WOLFPACK_DEV_DIR === undefined) delete process.env.WOLFPACK_DEV_DIR;
  else process.env.WOLFPACK_DEV_DIR = PRIOR_WOLFPACK_DEV_DIR;
  if (PRIOR_WOLFPACK_SESSION_IDENTITY_PATH === undefined) delete process.env.WOLFPACK_SESSION_IDENTITY_PATH;
  else process.env.WOLFPACK_SESSION_IDENTITY_PATH = PRIOR_WOLFPACK_SESSION_IDENTITY_PATH;
  if (PRIOR_WOLFPACK_AGENT_RUNTIME_STATE_PATH === undefined) delete process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH;
  else process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH = PRIOR_WOLFPACK_AGENT_RUNTIME_STATE_PATH;
  if (PRIOR_WOLFPACK_SETTINGS_PATH === undefined) delete process.env.WOLFPACK_SETTINGS_PATH;
  else process.env.WOLFPACK_SETTINGS_PATH = PRIOR_WOLFPACK_SETTINGS_PATH;
  __setDevDir(PRIOR_CACHED_DEV_DIR);
});

describe("API fixture isolation", () => {
  test("keeps the task relay gateway under the suite temp dev directory", () => {
    expect(getTaskRelayGateway().root).toBe(TEST_TASK_RELAY_ROOT);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function post(path: string, body: unknown, headers?: Record<string, string>) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function get(path: string, headers?: Record<string, string>) {
  return fetch(`${base}${path}`, { headers });
}

interface TestSessionFact {
  readonly name: string;
  readonly alive: boolean;
  readonly outputSequence?: string;
  readonly identity?: PublicSessionIdentity;
}

class FactBackend extends MockBackend {
  private facts: TestSessionFact[];
  private failFacts = false;
  private readonly panes = new Map<string, string>();
  capturePaneCalls = 0;

  constructor(facts: TestSessionFact[]) {
    super({ sessions: facts.filter((fact) => fact.alive).map((fact) => fact.name) });
    this.facts = facts;
  }

  setFacts(facts: TestSessionFact[]): void {
    this.facts = facts;
    this.setSessions(facts.filter((fact) => fact.alive).map((fact) => fact.name));
  }

  setFactsUnavailable(unavailable: boolean): void {
    this.failFacts = unavailable;
  }

  setPane(name: string, pane: string): void {
    this.panes.set(name, pane);
  }

  async list(): Promise<string[]> {
    return this.facts.filter((fact) => fact.alive).map((fact) => fact.name);
  }

  async listSessionFacts(): Promise<TestSessionFact[]> {
    if (this.failFacts) throw new Error("session facts unavailable");
    return this.facts;
  }

  async listIdentities(): Promise<Record<string, PublicSessionIdentity>> {
    const out: Record<string, PublicSessionIdentity> = {};
    for (const fact of this.facts) {
      if (fact.alive && fact.identity) out[fact.name] = fact.identity;
    }
    return out;
  }

  async capturePane(name: string): Promise<string> {
    this.capturePaneCalls++;
    return this.panes.get(name) ?? "";
  }

}

function testIdentity(name: string, id: string): PublicSessionIdentity {
  const timestamp = new Date(0).toISOString();
  return {
    wolfpackSessionId: id,
    wolfpackSessionName: name,
    projectPath: "",
    agentKind: "custom",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function attachNotificationViewer(session: string): string[] {
  const frames: string[] = [];
  const viewer = {
    readyState: 1,
    bufferedAmount: 0,
    send(data: string | Buffer): void {
      frames.push(typeof data === "string" ? data : data.toString());
    },
  };
  const entries = activePtySessions as unknown as Map<string, {
    viewer: typeof viewer;
    pendingViewer: null;
    proc: null;
    alive: boolean;
  }>;
  entries.set(session, { viewer, pendingViewer: null, proc: null, alive: true });
  return frames;
}

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /api/info", () => {
  test("returns name and version", async () => {
    const res = await get("/api/info");
    expect(res.status).toBe(200);
    const data = await res.json();
    const expectedName = hostname()
      .replace(/\.local$/, "")
      .replace(/\.tail[a-z0-9-]*\.ts\.net$/i, "");
    expect(data.name).toBe(expectedName);
    expect(data.version).toBe(pkg.version);
  });

  test("response is application/json", async () => {
    const res = await get("/api/info");
    expect(res.headers.get("content-type")).toBe("application/json");
  });
});

describe("GET /api/sessions", () => {
  beforeEach(() => {
    // Reset backend to known state
    mockBackend.setSessions(["wolf-1", "wolf-2"]);
    mockBackend.setCapturePane(async (s: string) => `captured output for ${s}\n`);
  });

  test("returns session list with lastLine and triage", async () => {
    const res = await get("/api/sessions");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessions).toHaveLength(2);
    expect(typeof data.sessions[0].lastLine).toBe("string");
    expect(typeof data.sessions[0].triage).toBe("string");
    expect(data.sessions[0].identity).toMatchObject({
      wolfpackSessionName: data.sessions[0].name,
      agentKind: "custom",
    });
    expect(data.sessions[0].identity).not.toHaveProperty("alive");
    expect(data.sessions[0].identity).not.toHaveProperty("triage");
    expect(["running", "idle"]).toContain(data.sessions[0].triage);
  });

  test("returns empty list when no sessions", async () => {
    mockBackend.setSessions([]);
    const res = await get("/api/sessions");
    const data = await res.json();
    expect(data.sessions).toHaveLength(0);
  });

  test("classifies idle when raw PTY output advances but rendered content is unchanged", async () => {
    mockBackend.setCapturePane(async () => "static rendered tui\n");
    mockBackend.setOutputSequence("wolf-1", "1");
    await get("/api/sessions");

    mockBackend.setOutputSequence("wolf-1", "2");
    const data = await (await get("/api/sessions")).json();

    expect(data.sessions[0].triage).toBe("idle");
    expect(data.sessions[0].runtimeState).toMatchObject({ state: "idle" });
  });

  test("classifies running when rendered content changes above a stable three-line footer", async () => {
    mockBackend.setCapturePane(async () => "step one\nseparator\nstatus\nagents\n");
    mockBackend.setOutputSequence("wolf-1", "1");
    await get("/api/sessions");

    mockBackend.setCapturePane(async () => "step two\nseparator\nstatus\nagents\n");
    mockBackend.setOutputSequence("wolf-1", "2");
    const data = await (await get("/api/sessions")).json();

    expect(data.sessions[0].triage).toBe("running");
    expect(data.sessions[0].runtimeState).toMatchObject({ state: "output" });
  });

  test("classifies idle when the rendered snapshot is unavailable", async () => {
    mockBackend.setCapturePane(async () => "last rendered output\n");
    await get("/api/sessions");

    mockBackend.setCapturePane(async () => { throw new Error("snapshot unavailable"); });
    mockBackend.setOutputSequence("wolf-1", "1");
    const data = await (await get("/api/sessions")).json();

    expect(data.sessions[0].triage).toBe("idle");
    expect(data.sessions[0].runtimeState).toMatchObject({ state: "idle" });
    expect(data.sessions[0].activity).toMatchObject({ freshness: "unknown", observedAt: expect.any(String) });
    expect(data.sessions[0].activity).not.toHaveProperty("lastRenderedActivityAt");
    expect(data.sessions[0].activity).not.toHaveProperty("quietSince");
  });

  test("does not notify before the configured quiet interval without a sessions request", async () => {
    const endpoint = `https://fcm.googleapis.com/server-observer-${Date.now()}`;
    const pushes: Array<{ readonly title: string; readonly body: string }> = [];
    addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    pushTesting.sessionPushSender = async (payload) => {
      pushes.push(payload);
      return { sent: 1, failed: 0, pruned: 0 };
    };
    try {
      mockBackend.setCapturePane(async () => "baseline\n");
      await __runSessionNotificationObservationForTests();
      mockBackend.setCapturePane(async () => "changed\n");
      mockBackend.setOutputSequence("wolf-1", "1");
      mockBackend.setOutputSequence("wolf-2", "1");
      await __runSessionNotificationObservationForTests();
      await __runSessionNotificationObservationForTests();

      expect(pushes).toEqual([]);
    } finally {
      pushTesting.sessionPushSender = null;
      removeSubscription(endpoint);
    }
  });

  test("does not turn a dashboard-observed change into an immediate quiet alert", async () => {
    const endpoint = `https://fcm.googleapis.com/dashboard-first-${Date.now()}`;
    const sessionName = "dashboard-first";
    const sessionId = "dashboard-first-id";
    const pushes: Array<{ readonly title: string; readonly body: string }> = [];
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, outputSequence: "61", identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "baseline\n");
    __setTestBackend(factBackend);
    addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    pushTesting.sessionPushSender = async (payload) => {
      pushes.push(payload);
      return { sent: 1, failed: 0, pruned: 0 };
    };
    try {
      await __runSessionNotificationObservationForTests();
      factBackend.setPane(sessionName, "changed\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "62", identity: testIdentity(sessionName, sessionId) },
      ]);
      await get("/api/sessions");
      await __runSessionNotificationObservationForTests();
      await __runSessionNotificationObservationForTests();

      expect(pushes).toEqual([]);
    } finally {
      pushTesting.sessionPushSender = null;
      removeSubscription(endpoint);
      __setTestBackend(mockBackend);
    }
  });

  test("does not notify quiet when the server observer loses its rendered snapshot", async () => {
    const endpoint = `https://fcm.googleapis.com/server-observer-failure-${Date.now()}`;
    const pushes: unknown[] = [];
    addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    pushTesting.sessionPushSender = async (payload) => {
      pushes.push(payload);
      return { sent: 1, failed: 0, pruned: 0 };
    };
    try {
      mockBackend.setCapturePane(async () => "baseline\n");
      await __runSessionNotificationObservationForTests();
      mockBackend.setCapturePane(async () => "changed\n");
      mockBackend.setOutputSequence("wolf-1", "1");
      mockBackend.setOutputSequence("wolf-2", "1");
      await __runSessionNotificationObservationForTests();
      mockBackend.setCapturePane(async () => { throw new Error("snapshot unavailable"); });
      mockBackend.setOutputSequence("wolf-1", "2");
      mockBackend.setOutputSequence("wolf-2", "2");
      await __runSessionNotificationObservationForTests();

      expect(pushes).toEqual([]);
    } finally {
      pushTesting.sessionPushSender = null;
      removeSubscription(endpoint);
    }
  });

  test("requires new activity after a current capture failure before delivering quiet", async () => {
    const originalNow = Date.now;
    let now = 19_000_000;
    Date.now = () => now;
    const sessionName = "capture-gap-continuity";
    const sessionId = "capture-gap-continuity-id";
    const endpoint = `https://fcm.googleapis.com/capture-gap-continuity-${now}`;
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, outputSequence: "301", identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "baseline\n");
    __setTestBackend(factBackend);
    addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    const deliveries: string[] = [];
    pushTesting.sessionPushSender = async (payload) => {
      deliveries.push(payload.title);
      return { sent: 1, failed: 0, pruned: 0 };
    };
    try {
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
      })).status).toBe(200);
      await __runSessionNotificationObservationForTests();

      now += 1;
      factBackend.setPane(sessionName, "armed activity\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "302", identity: testIdentity(sessionName, sessionId) },
      ]);
      await __runSessionNotificationObservationForTests();

      const originalCapturePane = factBackend.capturePane.bind(factBackend);
      now += 1_000;
      factBackend.capturePane = async () => { throw new Error("capture failed"); };
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "303", identity: testIdentity(sessionName, sessionId) },
      ]);
      const failed = await __runSessionNotificationObservationForTests();
      expect(failed[0]).toMatchObject({ activity: { freshness: "unknown" } });
      expect(failed[0]?.quietAlert).toBeUndefined();

      now += 5_000;
      factBackend.capturePane = originalCapturePane;
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "304", identity: testIdentity(sessionName, sessionId) },
      ]);
      const recovered = await __runSessionNotificationObservationForTests();
      expect(recovered[0]?.quietAlert).toBeUndefined();
      expect(deliveries).toEqual([]);

      now += 1;
      factBackend.setPane(sessionName, "new activity\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "305", identity: testIdentity(sessionName, sessionId) },
      ]);
      await __runSessionNotificationObservationForTests();
      now += 5_000;
      const matured = await __runSessionNotificationObservationForTests();
      expect(matured[0]?.quietAlert).toMatchObject({
        sessionId,
        eligibleAtMs: 19_011_002,
      });
      expect(deliveries).toEqual(["Wolfpack: capture-gap-continuity"]);
    } finally {
      Date.now = originalNow;
      pushTesting.sessionPushSender = null;
      removeSubscription(endpoint);
      await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 },
      });
      __setTestBackend(mockBackend);
    }
  });

  test("classifies idle when output sequence is stable despite prompt prose", async () => {
    mockBackend.setCapturePane(async () => "Do you want to continue? (y/n)\n");
    await get("/api/sessions");
    const res = await get("/api/sessions");
    const data = await res.json();
    expect(data.sessions[0].triage).toBe("idle");
  });

  test("classifies idle when output sequence is stable without prompt prose", async () => {
    mockBackend.setCapturePane(async () => "$ \n");
    await get("/api/sessions");
    const res = await get("/api/sessions");
    const data = await res.json();
    expect(data.sessions[0].triage).toBe("idle");
  });

  test("derives dashboard previews from the already-sampled rendered fingerprint", async () => {
    mockBackend.setCapturePane(async () => "real output here\n─────────────\n$ \n\n");

    const listed = await (await get("/api/sessions")).json();
    expect(listed.sessions[0].lastLine).toBe("$");

    const read = await (await get("/api/session-control/read?session=wolf-1")).json();
    expect(read.output).toBe("real output here\n─────────────\n$ \n\n");
  });

  test("sorts sessions by triage priority", async () => {
    mockBackend.setSessions(["idle-sess", "running-sess", "input-sess"]);
    mockBackend.setCapturePane(async (session: string) => session === "running-sess" ? "step one\n" : "quiet\n");
    await get("/api/sessions");
    mockBackend.setCapturePane(async (session: string) => session === "running-sess" ? "step two\n" : "quiet\n");
    mockBackend.setOutputSequence("running-sess", "1");
    const res = await get("/api/sessions");
    const data = await res.json();
    // Sessions sorted alphabetically (5cf260d), triage is per-session metadata
    expect(data.sessions[0].name).toBe("idle-sess");
    expect(data.sessions[0].triage).toBe("idle");
    expect(data.sessions[1].name).toBe("input-sess");
    expect(data.sessions[1].triage).toBe("idle");
    expect(data.sessions[2].name).toBe("running-sess");
    expect(data.sessions[2].triage).toBe("running");
  });

  test("returns canonical runtime state while preserving legacy triage", async () => {
    mockBackend.setCapturePane(async () => "compiling step 1...\n");
    const first = await (await get("/api/sessions")).json();
    expect(first.sessions[0].triage).toBe("idle");
    expect(first.sessions[0].runtimeState).toMatchObject({
      state: "idle",
      authority: "fallback",
      source: "screen-fallback",
      transitionSequence: 1,
      unseen: true,
    });

    mockBackend.setCapturePane(async () => "compiling step 2...\n");
    mockBackend.setOutputSequence("wolf-1", "1");
    const second = await (await get("/api/sessions")).json();
    expect(second.sessions[0].triage).toBe("running");
    expect(second.sessions[0].runtimeState).toMatchObject({
      state: "output",
      authority: "fallback",
      transitionSequence: 2,
    });
  });

  test("uses output watermarks to skip stable snapshots while preserving rendered activity", async () => {
    const sessionName = "rendered-activity";
    const sessionId = "rendered-activity-id";
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, outputSequence: "41", identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "stable rendered tui\n");
    __setTestBackend(factBackend);
    try {
      const initial = await (await get("/api/sessions")).json();
      expect(initial.sessions[0]).toMatchObject({
        name: sessionName,
        lastLine: "stable rendered tui",
        triage: "idle",
        outputSequence: "41",
        runtimeState: { state: "idle" },
      });

      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "42", identity: testIdentity(sessionName, sessionId) },
      ]);
      const redraw = await (await get("/api/sessions")).json();
      expect(redraw.sessions[0]).toMatchObject({
        lastLine: "stable rendered tui",
        triage: "idle",
        outputSequence: "42",
        runtimeState: { state: "idle" },
      });

      const stable = await (await get("/api/sessions")).json();
      expect(stable.sessions[0]).toMatchObject({ triage: "idle", outputSequence: "42" });
      expect(factBackend.capturePaneCalls).toBe(2);

      factBackend.setPane(sessionName, "updated rendered tui\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "43", identity: testIdentity(sessionName, sessionId) },
      ]);
      const renderedOutput = await (await get("/api/sessions")).json();
      expect(renderedOutput.sessions[0]).toMatchObject({
        lastLine: "updated rendered tui",
        triage: "running",
        outputSequence: "43",
        runtimeState: {
          state: "output",
          label: "rendered output activity",
          message: "derived only from broker-rendered terminal changes",
        },
      });
      expect(factBackend.capturePaneCalls).toBe(3);
    } finally {
      __setTestBackend(mockBackend);
    }
  });

  test("projects rendered activity and continuous quiet without inventing initial history", async () => {
    const sessionName = "activity-projection";
    const sessionId = "activity-projection-id";
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, outputSequence: "41", identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "initial screen\n");
    __setTestBackend(factBackend);
    try {
      const initial = await (await get("/api/sessions")).json();
      const initialObservedAt = initial.sessions[0].activity.observedAt;
      expect(initial.sessions[0].activity).toMatchObject({ freshness: "fresh", observedAt: expect.any(String) });
      expect(initial.sessions[0].activity).not.toHaveProperty("lastRenderedActivityAt");
      expect(initial.sessions[0].activity).not.toHaveProperty("quietSince");

      const initiallyQuiet = await (await get("/api/sessions")).json();
      expect(initiallyQuiet.sessions[0].activity).toMatchObject({ freshness: "fresh" });
      expect(initiallyQuiet.sessions[0].activity.quietSince).toBe(initialObservedAt);
      expect(initiallyQuiet.sessions[0].activity).not.toHaveProperty("lastRenderedActivityAt");

      factBackend.setPane(sessionName, "changed screen\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "42", identity: testIdentity(sessionName, sessionId) },
      ]);
      const changed = await (await get("/api/sessions")).json();
      const changedObservedAt = changed.sessions[0].activity.observedAt;
      expect(changed.sessions[0].activity.lastRenderedActivityAt).toBe(changedObservedAt);
      expect(changed.sessions[0].activity).not.toHaveProperty("quietSince");

      const quiet = await (await get("/api/sessions")).json();
      expect(quiet.sessions[0].activity).toMatchObject({
        freshness: "fresh",
        lastRenderedActivityAt: changed.sessions[0].activity.lastRenderedActivityAt,
      });
      expect(quiet.sessions[0].activity.quietSince).toBe(changedObservedAt);

      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "43", identity: testIdentity(sessionName, sessionId) },
      ]);
      const redraw = await (await get("/api/sessions")).json();
      expect(redraw.sessions[0].activity).toMatchObject({
        freshness: "fresh",
        lastRenderedActivityAt: changed.sessions[0].activity.lastRenderedActivityAt,
        quietSince: quiet.sessions[0].activity.quietSince,
      });

      factBackend.setFacts([
        { name: sessionName, alive: false, outputSequence: "43", identity: testIdentity(sessionName, sessionId) },
      ]);
      const dead = await (await get("/api/sessions")).json();
      expect(dead.sessions[0].activity).toMatchObject({ freshness: "unknown", observedAt: expect.any(String) });
      expect(dead.sessions[0].activity).not.toHaveProperty("quietSince");

      factBackend.setPane(sessionName, "recovered changed screen\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "43", identity: testIdentity(sessionName, sessionId) },
      ]);
      const reconnected = await (await get("/api/sessions")).json();
      expect(factBackend.capturePaneCalls).toBe(4);
      expect(reconnected.sessions[0].activity).toMatchObject({
        freshness: "fresh",
        observedAt: expect.any(String),
        display: "activity unobserved",
      });
      expect(reconnected.sessions[0].activity).not.toHaveProperty("lastRenderedActivityAt");
      expect(reconnected.sessions[0].activity).not.toHaveProperty("quietSince");
    } finally {
      __setTestBackend(mockBackend);
    }
  });

  test("projects one quiet fact at the exact threshold across dashboard and observer sampling", async () => {
    const originalNow = Date.now;
    let now = 4_000_000;
    Date.now = () => now;
    const sessionName = "exact-quiet-threshold";
    const sessionId = "exact-quiet-threshold-id";
    const endpoint = `https://fcm.googleapis.com/exact-quiet-threshold-${now}`;
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, outputSequence: "81", identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "baseline\n");
    __setTestBackend(factBackend);
    addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    pushTesting.sessionPushSender = async () => ({ sent: 1, failed: 0, pruned: 0 });
    try {
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
      })).status).toBe(200);
      await get("/api/sessions");

      now += 1;
      factBackend.setPane(sessionName, "changed\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "82", identity: testIdentity(sessionName, sessionId) },
      ]);
      const changed = await (await get("/api/sessions")).json();
      expect(changed.sessions[0].quietAlert).toBeUndefined();

      now += 4_999;
      const beforeThreshold = await __runSessionNotificationObservationForTests();
      expect(beforeThreshold[0].quietAlert).toBeUndefined();

      now += 1;
      const matured = await __runSessionNotificationObservationForTests();
      expect(matured[0].quietAlert).toEqual({
        kind: "quiet",
        sessionId,
        episodeId: expect.any(String),
        eligibleAtMs: 4_005_001,
        observedAtMs: 4_005_001,
      });
      const dashboard = await (await get("/api/sessions")).json();
      expect(dashboard.sessions[0].quietAlert).toEqual(matured[0].quietAlert);
    } finally {
      Date.now = originalNow;
      pushTesting.sessionPushSender = null;
      removeSubscription(endpoint);
      await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 },
      });
      __setTestBackend(mockBackend);
    }
  });

  test("keeps one quiet episode when dashboard observes output before a delayed observer", async () => {
    const originalNow = Date.now;
    let now = 5_000_000;
    Date.now = () => now;
    const sessionName = "shared-quiet-episode";
    const sessionId = "shared-quiet-episode-id";
    const endpoint = `https://fcm.googleapis.com/shared-quiet-episode-${now}`;
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, outputSequence: "91", identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "baseline\n");
    __setTestBackend(factBackend);
    addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    pushTesting.sessionPushSender = async () => ({ sent: 1, failed: 0, pruned: 0 });
    try {
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
      })).status).toBe(200);
      await get("/api/sessions");
      await __runSessionNotificationObservationForTests();

      now += 1;
      factBackend.setPane(sessionName, "changed\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "92", identity: testIdentity(sessionName, sessionId) },
      ]);
      expect((await (await get("/api/sessions")).json()).sessions[0].quietAlert).toBeUndefined();

      now += 4_999;
      expect((await __runSessionNotificationObservationForTests())[0].quietAlert).toBeUndefined();

      now += 1;
      const observerAtThreshold = await __runSessionNotificationObservationForTests();
      expect(observerAtThreshold[0].quietAlert).toMatchObject({
        sessionId,
        eligibleAtMs: 5_005_001,
        observedAtMs: 5_005_001,
      });
      const dashboardAtThreshold = await (await get("/api/sessions")).json();
      expect(dashboardAtThreshold.sessions[0].quietAlert).toEqual(observerAtThreshold[0].quietAlert);
    } finally {
      Date.now = originalNow;
      pushTesting.sessionPushSender = null;
      removeSubscription(endpoint);
      await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 },
      });
      __setTestBackend(mockBackend);
    }
  });

  test("disabling and reenabling quiet alerts between samples cancels an armed episode", async () => {
    const originalNow = Date.now;
    let now = 7_000_000;
    Date.now = () => now;
    const sessionName = "settings-cancel-quiet";
    const sessionId = "settings-cancel-quiet-id";
    const endpoint = `https://fcm.googleapis.com/settings-cancel-quiet-${now}`;
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, outputSequence: "111", identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "baseline\n");
    __setTestBackend(factBackend);
    addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    pushTesting.sessionPushSender = async () => ({ sent: 1, failed: 0, pruned: 0 });
    try {
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
      })).status).toBe(200);
      await get("/api/sessions");
      await __runSessionNotificationObservationForTests();

      now += 1;
      factBackend.setPane(sessionName, "armed activity\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "112", identity: testIdentity(sessionName, sessionId) },
      ]);
      await get("/api/sessions");

      expect((await post("/api/settings", {
        quietAlerts: { mode: "disabled", quietAfterSeconds: 5 },
      })).status).toBe(200);
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
      })).status).toBe(200);

      now += 5_000;
      expect((await __runSessionNotificationObservationForTests())[0].quietAlert).toBeUndefined();

      now += 1;
      factBackend.setPane(sessionName, "new activity after reenable\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "113", identity: testIdentity(sessionName, sessionId) },
      ]);
      await get("/api/sessions");
      now += 5_000;
      expect((await __runSessionNotificationObservationForTests())[0].quietAlert).toMatchObject({
        sessionId,
        eligibleAtMs: 7_010_002,
        observedAtMs: 7_010_002,
      });
    } finally {
      Date.now = originalNow;
      pushTesting.sessionPushSender = null;
      removeSubscription(endpoint);
      await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 },
      });
      __setTestBackend(mockBackend);
    }
  });

  test("does not arm an old capture after quiet alerts are disabled and reenabled", async () => {
    const originalNow = Date.now;
    let now = 8_000_000;
    Date.now = () => now;
    const sessionName = "settings-retire-capture";
    const sessionId = "settings-retire-capture-id";
    const endpoint = `https://fcm.googleapis.com/settings-retire-capture-${now}`;
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, outputSequence: "121", identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "baseline\n");
    __setTestBackend(factBackend);
    addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    pushTesting.sessionPushSender = async () => ({ sent: 1, failed: 0, pruned: 0 });
    try {
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
      })).status).toBe(200);
      await get("/api/sessions");
      await __runSessionNotificationObservationForTests();

      let releaseCapture: (() => void) | undefined;
      const captureReleased = new Promise<void>((resolve) => { releaseCapture = resolve; });
      let captureStarted: (() => void) | undefined;
      const captureStartedPromise = new Promise<void>((resolve) => { captureStarted = resolve; });
      const originalCapturePane = factBackend.capturePane.bind(factBackend);
      factBackend.capturePane = async (name: string) => {
        captureStarted?.();
        await captureReleased;
        return originalCapturePane(name);
      };

      now += 1;
      factBackend.setPane(sessionName, "old captured activity\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "122", identity: testIdentity(sessionName, sessionId) },
      ]);
      const oldCapture = get("/api/sessions");
      await captureStartedPromise;

      expect((await post("/api/settings", {
        quietAlerts: { mode: "disabled", quietAfterSeconds: 5 },
      })).status).toBe(200);
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
      })).status).toBe(200);
      releaseCapture?.();
      await oldCapture;

      now += 5_000;
      expect((await __runSessionNotificationObservationForTests())[0].quietAlert).toBeUndefined();
    } finally {
      Date.now = originalNow;
      pushTesting.sessionPushSender = null;
      removeSubscription(endpoint);
      await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 },
      });
      __setTestBackend(mockBackend);
    }
  });

  test("does not publish a pre-disable quiet fact from a held multi-session dashboard batch", async () => {
    const originalNow = Date.now;
    let now = 9_000_000;
    Date.now = () => now;
    const first = "batch-first";
    const second = "batch-second";
    const factBackend = new FactBackend([
      { name: first, alive: true, outputSequence: "131", identity: testIdentity(first, "batch-first-id") },
      { name: second, alive: true, outputSequence: "131", identity: testIdentity(second, "batch-second-id") },
    ]);
    factBackend.setPane(first, "first baseline\n");
    factBackend.setPane(second, "second baseline\n");
    __setTestBackend(factBackend);
    try {
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
      })).status).toBe(200);
      await get("/api/sessions");

      now += 1;
      factBackend.setPane(first, "first activity\n");
      factBackend.setFacts([
        { name: first, alive: true, outputSequence: "132", identity: testIdentity(first, "batch-first-id") },
        { name: second, alive: true, outputSequence: "131", identity: testIdentity(second, "batch-second-id") },
      ]);
      await get("/api/sessions");

      now += 5_000;
      let releaseSecondCapture: (() => void) | undefined;
      const secondCaptureReleased = new Promise<void>((resolve) => { releaseSecondCapture = resolve; });
      let secondCaptureStarted: (() => void) | undefined;
      const secondCaptureStartedPromise = new Promise<void>((resolve) => { secondCaptureStarted = resolve; });
      const originalCapturePane = factBackend.capturePane.bind(factBackend);
      factBackend.capturePane = async (name: string) => {
        if (name === second) {
          secondCaptureStarted?.();
          await secondCaptureReleased;
        }
        return originalCapturePane(name);
      };
      factBackend.setPane(second, "second delayed activity\n");
      factBackend.setFacts([
        { name: first, alive: true, outputSequence: "132", identity: testIdentity(first, "batch-first-id") },
        { name: second, alive: true, outputSequence: "132", identity: testIdentity(second, "batch-second-id") },
      ]);
      const staleBatch = get("/api/sessions");
      await secondCaptureStartedPromise;

      expect((await post("/api/settings", {
        quietAlerts: { mode: "disabled", quietAfterSeconds: 5 },
      })).status).toBe(200);
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
      })).status).toBe(200);
      releaseSecondCapture?.();
      const retired = await (await staleBatch).json();
      expect(retired.sessions.find((session: { name: string }) => session.name === first)?.quietAlert).toBeUndefined();
      const fresh = await (await get("/api/sessions")).json();
      expect(fresh.sessions.find((session: { name: string }) => session.name === first)?.quietAlert).toBeUndefined();

      now += 1;
      factBackend.setPane(first, "first rearmed activity\n");
      factBackend.setFacts([
        { name: first, alive: true, outputSequence: "133", identity: testIdentity(first, "batch-first-id") },
        { name: second, alive: true, outputSequence: "132", identity: testIdentity(second, "batch-second-id") },
      ]);
      await get("/api/sessions");
      now += 5_000;
      const rearmed = await (await get("/api/sessions")).json();
      expect(rearmed.sessions.find((session: { name: string }) => session.name === first)?.quietAlert).toMatchObject({
        sessionId: "batch-first-id",
        eligibleAtMs: 9_010_002,
      });
    } finally {
      Date.now = originalNow;
      await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 },
      });
      __setTestBackend(mockBackend);
    }
  });

  test("does not deliver already-eligible episodes to initial or re-enrolled subscriptions", async () => {
    const originalNow = Date.now;
    let now = 10_000_000;
    Date.now = () => now;
    const sessionName = "enrollment-quiet";
    const sessionId = "enrollment-quiet-id";
    const endpoint = `https://fcm.googleapis.com/enrollment-quiet-${now}`;
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, outputSequence: "141", identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "baseline\n");
    __setTestBackend(factBackend);
    const delivered: string[] = [];
    pushTesting.sessionPushSender = async (payload) => {
      delivered.push(payload.title);
      return { sent: 1, failed: 0, pruned: 0 };
    };
    try {
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
      })).status).toBe(200);
      await get("/api/sessions");

      now += 1;
      factBackend.setPane(sessionName, "first activity\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "142", identity: testIdentity(sessionName, sessionId) },
      ]);
      await get("/api/sessions");
      now += 5_000;
      expect((await (await get("/api/sessions")).json()).sessions[0].quietAlert).toMatchObject({ sessionId });

      addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
      await __runSessionNotificationObservationForTests();
      expect(delivered).toEqual([]);

      now += 1;
      factBackend.setPane(sessionName, "second activity\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "143", identity: testIdentity(sessionName, sessionId) },
      ]);
      await __runSessionNotificationObservationForTests();
      now += 5_000;
      await __runSessionNotificationObservationForTests();
      expect(delivered).toEqual(["Wolfpack: enrollment-quiet"]);

      removeSubscription(endpoint);
      addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
      await __runSessionNotificationObservationForTests();
      expect(delivered).toEqual(["Wolfpack: enrollment-quiet"]);
    } finally {
      Date.now = originalNow;
      pushTesting.sessionPushSender = null;
      removeSubscription(endpoint);
      await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 },
      });
      __setTestBackend(mockBackend);
    }
  });

  test("freezes recipients when a second endpoint enrolls after dashboard emits", async () => {
    const originalNow = Date.now;
    let now = 11_000_000;
    Date.now = () => now;
    const sessionName = "recipient-snapshot";
    const sessionId = "recipient-snapshot-id";
    const firstEndpoint = `https://fcm.googleapis.com/recipient-first-${now}`;
    const secondEndpoint = `https://fcm.googleapis.com/recipient-second-${now}`;
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, outputSequence: "151", identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "baseline\n");
    __setTestBackend(factBackend);
    const deliveries: string[][] = [];
    pushTesting.sessionPushSender = async (_payload, endpoints) => {
      deliveries.push([...endpoints].sort());
      return { sent: endpoints.size, failed: 0, pruned: 0, successfulEndpoints: [...endpoints], failedEndpoints: [] };
    };
    addSubscription({ endpoint: firstEndpoint, keys: { p256dh: "key", auth: "auth" } });
    try {
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
      })).status).toBe(200);
      await get("/api/sessions");
      now += 1;
      factBackend.setPane(sessionName, "first activity\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "152", identity: testIdentity(sessionName, sessionId) },
      ]);
      await get("/api/sessions");
      now += 5_000;
      expect((await (await get("/api/sessions")).json()).sessions[0].quietAlert).toMatchObject({ sessionId });

      addSubscription({ endpoint: secondEndpoint, keys: { p256dh: "key", auth: "auth" } });
      await __runSessionNotificationObservationForTests();
      expect(deliveries).toEqual([[firstEndpoint]]);

      now += 1;
      factBackend.setPane(sessionName, "second activity\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "153", identity: testIdentity(sessionName, sessionId) },
      ]);
      await __runSessionNotificationObservationForTests();
      // The first A-only delivery starts the per-session 30-second transport debounce.
      // This is a later episode, so wait past that invariant before asserting A+B.
      now += 30_000;
      await __runSessionNotificationObservationForTests();
      expect(deliveries).toEqual([[firstEndpoint], [firstEndpoint, secondEndpoint].sort()]);
    } finally {
      Date.now = originalNow;
      pushTesting.sessionPushSender = null;
      removeSubscription(firstEndpoint);
      removeSubscription(secondEndpoint);
      await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 },
      });
      __setTestBackend(mockBackend);
    }
  });

  test("delivers a duration-reevaluated episode that emits after enrollment", async () => {
    const originalNow = Date.now;
    let now = 12_000_000;
    Date.now = () => now;
    const sessionName = "duration-recipient";
    const sessionId = "duration-recipient-id";
    const endpoint = `https://fcm.googleapis.com/duration-recipient-${now}`;
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, outputSequence: "161", identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "baseline\n");
    __setTestBackend(factBackend);
    const deliveries: string[][] = [];
    pushTesting.sessionPushSender = async (_payload, endpoints) => {
      deliveries.push([...endpoints]);
      return { sent: endpoints.size, failed: 0, pruned: 0, successfulEndpoints: [...endpoints], failedEndpoints: [] };
    };
    try {
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 60 },
      })).status).toBe(200);
      await get("/api/sessions");
      now += 1;
      factBackend.setPane(sessionName, "pending activity\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "162", identity: testIdentity(sessionName, sessionId) },
      ]);
      await get("/api/sessions");

      now += 9_999;
      addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
      })).status).toBe(200);
      await __runSessionNotificationObservationForTests();
      expect(deliveries).toEqual([[endpoint]]);
    } finally {
      Date.now = originalNow;
      pushTesting.sessionPushSender = null;
      removeSubscription(endpoint);
      await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 },
      });
      __setTestBackend(mockBackend);
    }
  });

  test("retires departed dashboard-only recipient snapshots without clearing active empty snapshots", async () => {
    const originalNow = Date.now;
    let now = 13_000_000;
    Date.now = () => now;
    const departed = "departed-empty-recipient";
    const active = "active-empty-recipient";
    const departedId = "departed-empty-recipient-id";
    const activeId = "active-empty-recipient-id";
    const factBackend = new FactBackend([
      { name: departed, alive: true, outputSequence: "171", identity: testIdentity(departed, departedId) },
      { name: active, alive: true, outputSequence: "171", identity: testIdentity(active, activeId) },
    ]);
    factBackend.setPane(departed, "departed baseline\n");
    factBackend.setPane(active, "active baseline\n");
    __setTestBackend(factBackend);
    try {
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
      })).status).toBe(200);
      await get("/api/sessions");
      now += 1;
      factBackend.setPane(departed, "departed activity\n");
      factBackend.setPane(active, "active activity\n");
      factBackend.setFacts([
        { name: departed, alive: true, outputSequence: "172", identity: testIdentity(departed, departedId) },
        { name: active, alive: true, outputSequence: "172", identity: testIdentity(active, activeId) },
      ]);
      await get("/api/sessions");
      now += 5_000;
      await get("/api/sessions");
      expect(pushTesting.quietAlertRecipientSnapshots.has(departedId)).toBe(true);
      expect(pushTesting.quietAlertRecipientSnapshots.has(activeId)).toBe(true);

      factBackend.setFacts([
        { name: active, alive: true, outputSequence: "172", identity: testIdentity(active, activeId) },
      ]);
      await get("/api/sessions");
      expect(pushTesting.quietAlertRecipientSnapshots.has(departedId)).toBe(false);
      expect(pushTesting.quietAlertRecipientSnapshots.has(activeId)).toBe(true);

      forgetSessionObservation(activeId, active);
      expect(pushTesting.quietAlertRecipientSnapshots.has(activeId)).toBe(false);
    } finally {
      Date.now = originalNow;
      await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 },
      });
      __setTestBackend(mockBackend);
    }
  });

  test("retires all dashboard-only recipient snapshots when continuity is unavailable", async () => {
    const originalNow = Date.now;
    let now = 14_000_000;
    Date.now = () => now;
    const sessionName = "unavailable-empty-recipient";
    const sessionId = "unavailable-empty-recipient-id";
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, outputSequence: "181", identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "baseline\n");
    __setTestBackend(factBackend);
    try {
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
      })).status).toBe(200);
      await get("/api/sessions");
      now += 1;
      factBackend.setPane(sessionName, "activity\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "182", identity: testIdentity(sessionName, sessionId) },
      ]);
      await get("/api/sessions");
      now += 5_000;
      await get("/api/sessions");
      expect(pushTesting.quietAlertRecipientSnapshots.has(sessionId)).toBe(true);

      now += 1_001;
      factBackend.listSessionFacts = async () => { throw new Error("broker unavailable"); };
      await get("/api/sessions");
      expect(pushTesting.quietAlertRecipientSnapshots.has(sessionId)).toBe(false);
    } finally {
      Date.now = originalNow;
      await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 },
      });
      __setTestBackend(mockBackend);
    }
  });

  test("observation authority prevents an older notification batch from sending after newer dashboard continuity loss", async () => {
    const originalNow = Date.now;
    let now = 16_000_000;
    Date.now = () => now;
    const first = "stale-notification-a";
    const held = "stale-notification-b";
    const firstId = "stale-notification-a-id";
    const heldId = "stale-notification-b-id";
    const endpoint = `https://fcm.googleapis.com/stale-notification-${now}`;
    const factBackend = new FactBackend([
      { name: first, alive: true, outputSequence: "201", identity: testIdentity(first, firstId) },
      { name: held, alive: true, outputSequence: "201", identity: testIdentity(held, heldId) },
    ]);
    factBackend.setPane(first, "first baseline\n");
    factBackend.setPane(held, "held baseline\n");
    __setTestBackend(factBackend);
    addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    const deliveries: string[] = [];
    pushTesting.sessionPushSender = async (payload) => {
      deliveries.push(payload.title);
      return { sent: 1, failed: 0, pruned: 0 };
    };
    try {
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
      })).status).toBe(200);
      await get("/api/sessions");
      await __runSessionNotificationObservationForTests();

      now += 1;
      factBackend.setPane(first, "first activity\n");
      factBackend.setPane(held, "held dashboard update\n");
      factBackend.setFacts([
        { name: first, alive: true, outputSequence: "202", identity: testIdentity(first, firstId) },
        { name: held, alive: true, outputSequence: "202", identity: testIdentity(held, heldId) },
      ]);
      await get("/api/sessions");
      await __runSessionNotificationObservationForTests();
      now += 5_000;
      const armed = await (await get("/api/sessions")).json();
      expect(armed.sessions.find((session: { name: string }) => session.name === first)?.quietAlert).toMatchObject({ sessionId: firstId });

      let releaseHeldCapture: (() => void) | undefined;
      const heldCaptureReleased = new Promise<void>((resolve) => { releaseHeldCapture = resolve; });
      let heldCaptureStarted: (() => void) | undefined;
      const heldCaptureStartedPromise = new Promise<void>((resolve) => { heldCaptureStarted = resolve; });
      const originalCapturePane = factBackend.capturePane.bind(factBackend);
      factBackend.capturePane = async (name: string) => {
        if (name === held) {
          heldCaptureStarted?.();
          await heldCaptureReleased;
        }
        return originalCapturePane(name);
      };
      factBackend.setPane(held, "held delayed notification update\n");
      factBackend.setFacts([
        { name: first, alive: true, outputSequence: "202", identity: testIdentity(first, firstId) },
        { name: held, alive: true, outputSequence: "203", identity: testIdentity(held, heldId) },
      ]);
      const staleNotification = __runSessionNotificationObservationForTests();
      await heldCaptureStartedPromise;

      factBackend.setFacts([
        { name: first, alive: false, outputSequence: "202", identity: testIdentity(first, firstId) },
      ]);
      const continuityLost = await (await get("/api/sessions")).json();
      expect(continuityLost.sessions).toHaveLength(1);
      expect(continuityLost.sessions[0].activity.freshness).toBe("unknown");
      expect(continuityLost.sessions[0].quietAlert).toBeUndefined();

      releaseHeldCapture?.();
      await staleNotification;
      expect(deliveries).toEqual([]);
    } finally {
      Date.now = originalNow;
      pushTesting.sessionPushSender = null;
      removeSubscription(endpoint);
      await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 },
      });
      __setTestBackend(mockBackend);
    }
  });

  test("observation authority does not return a retired quiet fact from an older dashboard batch", async () => {
    const originalNow = Date.now;
    let now = 17_000_000;
    Date.now = () => now;
    const first = "stale-dashboard-a";
    const held = "stale-dashboard-b";
    const firstId = "stale-dashboard-a-id";
    const heldId = "stale-dashboard-b-id";
    const endpoint = `https://fcm.googleapis.com/stale-dashboard-${now}`;
    const factBackend = new FactBackend([
      { name: first, alive: true, outputSequence: "211", identity: testIdentity(first, firstId) },
      { name: held, alive: true, outputSequence: "211", identity: testIdentity(held, heldId) },
    ]);
    factBackend.setPane(first, "first baseline\n");
    factBackend.setPane(held, "held baseline\n");
    __setTestBackend(factBackend);
    addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    try {
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
      })).status).toBe(200);
      await get("/api/sessions");
      await __runSessionNotificationObservationForTests();

      now += 1;
      factBackend.setPane(first, "first activity\n");
      factBackend.setPane(held, "held ready\n");
      factBackend.setFacts([
        { name: first, alive: true, outputSequence: "212", identity: testIdentity(first, firstId) },
        { name: held, alive: true, outputSequence: "212", identity: testIdentity(held, heldId) },
      ]);
      await get("/api/sessions");
      await __runSessionNotificationObservationForTests();
      now += 5_000;
      await get("/api/sessions");

      let releaseHeldCapture: (() => void) | undefined;
      const heldCaptureReleased = new Promise<void>((resolve) => { releaseHeldCapture = resolve; });
      let heldCaptureStarted: (() => void) | undefined;
      const heldCaptureStartedPromise = new Promise<void>((resolve) => { heldCaptureStarted = resolve; });
      const originalCapturePane = factBackend.capturePane.bind(factBackend);
      factBackend.capturePane = async (name: string) => {
        if (name === held) {
          heldCaptureStarted?.();
          await heldCaptureReleased;
        }
        return originalCapturePane(name);
      };
      factBackend.setPane(held, "held delayed dashboard update\n");
      factBackend.setFacts([
        { name: first, alive: true, outputSequence: "212", identity: testIdentity(first, firstId) },
        { name: held, alive: true, outputSequence: "213", identity: testIdentity(held, heldId) },
      ]);
      const staleDashboard = get("/api/sessions");
      await heldCaptureStartedPromise;

      factBackend.setFacts([
        { name: first, alive: false, outputSequence: "212", identity: testIdentity(first, firstId) },
      ]);
      await __runSessionNotificationObservationForTests();

      releaseHeldCapture?.();
      const retired = await (await staleDashboard).json();
      expect(retired.sessions.find((session: { name: string }) => session.name === first)?.quietAlert).toBeUndefined();
      const fresh = await (await get("/api/sessions")).json();
      expect(fresh.sessions.find((session: { name: string }) => session.name === first)?.quietAlert).toBeUndefined();
    } finally {
      Date.now = originalNow;
      removeSubscription(endpoint);
      await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 },
      });
      __setTestBackend(mockBackend);
    }
  });

  test("observation authority prevents a delayed successful pane from restoring older canonical state", async () => {
    const originalNow = Date.now;
    let now = 18_000_000;
    Date.now = () => now;
    const sessionName = "stale-successful-pane";
    const sessionId = "stale-successful-pane-id";
    const endpoint = `https://fcm.googleapis.com/stale-successful-pane-${now}`;
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, outputSequence: "221", identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "baseline\n");
    __setTestBackend(factBackend);
    addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    try {
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
      })).status).toBe(200);
      await get("/api/sessions");
      await __runSessionNotificationObservationForTests();

      now += 1;
      factBackend.setPane(sessionName, "older successful output\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "222", identity: testIdentity(sessionName, sessionId) },
      ]);
      let releaseOlderCapture: (() => void) | undefined;
      const olderCaptureReleased = new Promise<void>((resolve) => { releaseOlderCapture = resolve; });
      let olderCaptureStarted: (() => void) | undefined;
      const olderCaptureStartedPromise = new Promise<void>((resolve) => { olderCaptureStarted = resolve; });
      const originalCapturePane = factBackend.capturePane.bind(factBackend);
      let captureCount = 0;
      factBackend.capturePane = async (name: string) => {
        const captured = await originalCapturePane(name);
        captureCount += 1;
        if (captureCount === 1) {
          olderCaptureStarted?.();
          await olderCaptureReleased;
        }
        return captured;
      };
      const staleDashboard = get("/api/sessions");
      await olderCaptureStartedPromise;

      now += 1;
      factBackend.setPane(sessionName, "newer authoritative output\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "223", identity: testIdentity(sessionName, sessionId) },
      ]);
      const newer = await __runSessionNotificationObservationForTests();
      expect(newer[0]?.lastLine).toBe("newer authoritative output");

      releaseOlderCapture?.();
      const retired = await (await staleDashboard).json();
      expect(retired.sessions).toHaveLength(1);
      expect(retired.sessions[0].activity.freshness).toBe("unknown");
      expect(retired.sessions[0].quietAlert).toBeUndefined();
      now += 5_000;
      const current = await (await get("/api/sessions")).json();
      expect(current.sessions).toHaveLength(1);
      expect(current.sessions[0].lastLine).toBe("newer authoritative output");
      expect(current.sessions[0].quietAlert).toMatchObject({
        sessionId,
        eligibleAtMs: 18_005_002,
      });
    } finally {
      Date.now = originalNow;
      removeSubscription(endpoint);
      await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 },
      });
      __setTestBackend(mockBackend);
    }
  });

  test("does not let stale same-policy dashboard cleanup cancel a newer notification retry", async () => {
    const originalNow = Date.now;
    let now = 15_000_000;
    Date.now = () => now;
    try {
      for (const staleResult of ["omitted", "unavailable"] as const) {
        const sessionName = `same-policy-${staleResult}`;
        const sessionId = `${sessionName}-id`;
        const endpoint = `https://fcm.googleapis.com/${sessionName}-${now}`;
        const fact = { name: sessionName, alive: true, outputSequence: "191", identity: testIdentity(sessionName, sessionId) };
        const factBackend = new FactBackend([fact]);
        factBackend.setPane(sessionName, "baseline\n");
        __setTestBackend(factBackend);
        addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
        const attempts: string[][] = [];
        pushTesting.sessionPushSender = async (_payload, endpoints) => {
          attempts.push([...endpoints]);
          return attempts.length === 1
            ? { sent: 0, failed: endpoints.size, pruned: 0, successfulEndpoints: [], failedEndpoints: [...endpoints] }
            : { sent: endpoints.size, failed: 0, pruned: 0, successfulEndpoints: [...endpoints], failedEndpoints: [] };
        };
        try {
          expect((await post("/api/settings", {
            quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
          })).status).toBe(200);
          await get("/api/sessions");
          now += 1;
          factBackend.setPane(sessionName, "activity\n");
          factBackend.setFacts([{ ...fact, outputSequence: "192" }]);
          await get("/api/sessions");
          now += 5_000;

          const originalListSessionFacts = factBackend.listSessionFacts.bind(factBackend);
          let releaseOlderList: (() => void) | undefined;
          const olderListReleased = new Promise<void>((resolve) => { releaseOlderList = resolve; });
          let olderListStarted: (() => void) | undefined;
          const olderListStartedPromise = new Promise<void>((resolve) => { olderListStarted = resolve; });
          let listCalls = 0;
          factBackend.listSessionFacts = async () => {
            listCalls += 1;
            if (listCalls === 1) {
              olderListStarted?.();
              await olderListReleased;
              if (staleResult === "unavailable") throw new Error("older broker unavailable");
              return [];
            }
            return originalListSessionFacts();
          };
          const staleDashboard = get("/api/sessions");
          await olderListStartedPromise;

          await __runSessionNotificationObservationForTests();
          expect(attempts).toEqual([[endpoint]]);
          expect(pushTesting.quietAlertRecipientSnapshots.has(sessionId)).toBe(true);

          releaseOlderList?.();
          await staleDashboard;
          expect(pushTesting.quietAlertRecipientSnapshots.has(sessionId)).toBe(true);

          now += pushTesting.PUSH_DEBOUNCE_MS;
          await __runSessionNotificationObservationForTests();
          expect(attempts).toEqual([[endpoint], [endpoint]]);
        } finally {
          pushTesting.sessionPushSender = null;
          removeSubscription(endpoint);
          await post("/api/settings", {
            quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 },
          });
          __resetSessionObservationForTests();
          pushTesting.resetDebounce();
          now += 100_000;
        }
      }
    } finally {
      Date.now = originalNow;
      __setTestBackend(mockBackend);
    }
  });

  test("treats blank rendered snapshots as observable activity", async () => {
    const endpoint = `https://fcm.googleapis.com/blank-activity-${Date.now()}`;
    const sessionName = "blank-activity";
    const sessionId = "blank-activity-id";
    const pushes: Array<{ readonly title: string; readonly body: string }> = [];
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, outputSequence: "71", identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "\n");
    __setTestBackend(factBackend);
    addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    pushTesting.sessionPushSender = async (payload) => {
      pushes.push(payload);
      return { sent: 1, failed: 0, pruned: 0 };
    };
    try {
      const initial = await (await get("/api/sessions")).json();
      expect(initial.sessions[0].activity).toMatchObject({ freshness: "fresh", display: "activity unobserved" });
      await __runSessionNotificationObservationForTests();

      factBackend.setPane(sessionName, "content\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "72", identity: testIdentity(sessionName, sessionId) },
      ]);
      await get("/api/sessions");
      await __runSessionNotificationObservationForTests();

      factBackend.setPane(sessionName, "\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "73", identity: testIdentity(sessionName, sessionId) },
      ]);
      const blank = await (await get("/api/sessions")).json();
      expect(blank.sessions[0]).toMatchObject({ triage: "running", activity: { display: "" } });
      await __runSessionNotificationObservationForTests();
      await __runSessionNotificationObservationForTests();
      expect(pushes).toEqual([]);

      const quiet = await (await get("/api/sessions")).json();
      expect(quiet.sessions[0].activity).toMatchObject({ freshness: "fresh", display: "" });
    } finally {
      pushTesting.sessionPushSender = null;
      removeSubscription(endpoint);
      __setTestBackend(mockBackend);
    }
  });

  test("keeps a recovered capture when a retired capture resolves later", async () => {
    const endpoint = `https://fcm.googleapis.com/overlapping-activity-${Date.now()}`;
    const sessionName = "overlapping-activity";
    const sessionId = "overlapping-activity-id";
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, outputSequence: "46", identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "before loss\n");
    __setTestBackend(factBackend);
    addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    try {
      let releaseFirst: (() => void) | undefined;
      const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let releaseSecond: (() => void) | undefined;
      const secondReleased = new Promise<void>((resolve) => { releaseSecond = resolve; });
      let firstStarted: (() => void) | undefined;
      const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
      let secondStarted: (() => void) | undefined;
      const secondStartedPromise = new Promise<void>((resolve) => { secondStarted = resolve; });
      let captureCount = 0;
      const originalCapturePane = factBackend.capturePane.bind(factBackend);
      factBackend.capturePane = async (name: string) => {
        captureCount += 1;
        if (captureCount === 1) {
          firstStarted?.();
          await firstReleased;
        } else {
          secondStarted?.();
          await secondReleased;
        }
        return originalCapturePane(name);
      };

      const first = get("/api/sessions");
      await firstStartedPromise;
      factBackend.setFacts([
        { name: sessionName, alive: false, outputSequence: "46", identity: testIdentity(sessionName, sessionId) },
      ]);
      await __runSessionNotificationObservationForTests();

      factBackend.setPane(sessionName, "after loss\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "46", identity: testIdentity(sessionName, sessionId) },
      ]);
      const recovered = __runSessionNotificationObservationForTests();
      await secondStartedPromise;

      releaseFirst?.();
      const retired = await (await first).json();
      expect(retired.sessions[0].activity.freshness).toBe("unknown");

      releaseSecond?.();
      const fresh = await recovered;
      expect(fresh[0].activity).toMatchObject({ freshness: "fresh", display: "activity unobserved" });
      expect(fresh[0].activity).not.toHaveProperty("lastRenderedActivityAt");
      expect(fresh[0].activity).not.toHaveProperty("quietSince");

      const quiet = await __runSessionNotificationObservationForTests();
      expect(captureCount).toBe(2);
      expect(quiet[0].activity).toMatchObject({ freshness: "fresh", display: "" });
    } finally {
      removeSubscription(endpoint);
      __setTestBackend(mockBackend);
    }
  });

  test("does not let a retired capture clear a recovered quiet episode", async () => {
    const originalNow = Date.now;
    let now = 6_000_000;
    Date.now = () => now;
    const sessionName = "retired-quiet-episode";
    const sessionId = "retired-quiet-episode-id";
    const endpoint = `https://fcm.googleapis.com/retired-quiet-episode-${now}`;
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, outputSequence: "101", identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "baseline\n");
    __setTestBackend(factBackend);
    addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    pushTesting.sessionPushSender = async () => ({ sent: 1, failed: 0, pruned: 0 });
    try {
      expect((await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 5 },
      })).status).toBe(200);
      await get("/api/sessions");
      await __runSessionNotificationObservationForTests();

      let releaseOldCapture: (() => void) | undefined;
      const oldCaptureReleased = new Promise<void>((resolve) => { releaseOldCapture = resolve; });
      let oldCaptureStarted: (() => void) | undefined;
      const oldCaptureStartedPromise = new Promise<void>((resolve) => { oldCaptureStarted = resolve; });
      const originalCapturePane = factBackend.capturePane.bind(factBackend);
      let holdOldCapture = true;
      factBackend.capturePane = async (name: string) => {
        if (holdOldCapture) {
          oldCaptureStarted?.();
          await oldCaptureReleased;
        }
        return originalCapturePane(name);
      };

      now += 1;
      factBackend.setPane(sessionName, "retired output\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "102", identity: testIdentity(sessionName, sessionId) },
      ]);
      const retiredDashboard = get("/api/sessions");
      await oldCaptureStartedPromise;

      factBackend.setFacts([
        { name: sessionName, alive: false, outputSequence: "102", identity: testIdentity(sessionName, sessionId) },
      ]);
      await __runSessionNotificationObservationForTests();

      holdOldCapture = false;
      factBackend.setPane(sessionName, "recovered baseline\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "102", identity: testIdentity(sessionName, sessionId) },
      ]);
      await __runSessionNotificationObservationForTests();

      now += 1;
      factBackend.setPane(sessionName, "recovered activity\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "103", identity: testIdentity(sessionName, sessionId) },
      ]);
      await __runSessionNotificationObservationForTests();

      releaseOldCapture?.();
      await retiredDashboard;
      now += 5_000;
      const matured = await __runSessionNotificationObservationForTests();
      expect(matured[0].quietAlert).toMatchObject({
        sessionId,
        eligibleAtMs: 6_005_002,
        observedAtMs: 6_005_002,
      });
    } finally {
      Date.now = originalNow;
      pushTesting.sessionPushSender = null;
      removeSubscription(endpoint);
      await post("/api/settings", {
        quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 },
      });
      __setTestBackend(mockBackend);
    }
  });

  test("does not restore activity from a capture retired by a dead observation", async () => {
    const endpoint = `https://fcm.googleapis.com/retired-activity-${Date.now()}`;
    const sessionName = "retired-activity";
    const sessionId = "retired-activity-id";
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, outputSequence: "45", identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "before loss\n");
    __setTestBackend(factBackend);
    addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    try {
      let releaseCapture: (() => void) | undefined;
      const captureReleased = new Promise<void>((resolve) => { releaseCapture = resolve; });
      let captureStarted: (() => void) | undefined;
      const captureStartedPromise = new Promise<void>((resolve) => { captureStarted = resolve; });
      const originalCapturePane = factBackend.capturePane.bind(factBackend);
      factBackend.capturePane = async (name: string) => {
        captureStarted?.();
        await captureReleased;
        return originalCapturePane(name);
      };

      const beforeLoss = get("/api/sessions");
      await captureStartedPromise;
      factBackend.setFacts([
        { name: sessionName, alive: false, outputSequence: "45", identity: testIdentity(sessionName, sessionId) },
      ]);
      await __runSessionNotificationObservationForTests();
      releaseCapture?.();
      const retired = await (await beforeLoss).json();
      expect(retired.sessions[0].activity.freshness).toBe("unknown");

      factBackend.setPane(sessionName, "after loss\n");
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "45", identity: testIdentity(sessionName, sessionId) },
      ]);
      const recovered = await (await get("/api/sessions")).json();
      expect(factBackend.capturePaneCalls).toBe(2);
      expect(recovered.sessions[0].activity).toMatchObject({ freshness: "fresh", display: "activity unobserved" });
      expect(recovered.sessions[0].activity).not.toHaveProperty("lastRenderedActivityAt");
      expect(recovered.sessions[0].activity).not.toHaveProperty("quietSince");
    } finally {
      removeSubscription(endpoint);
      __setTestBackend(mockBackend);
    }
  });

  test("shares a changed activity reduction when notification capture starts before dashboard", async () => {
    const endpoint = `https://fcm.googleapis.com/activity-observation-${Date.now()}`;
    const sessionName = "shared-activity";
    const sessionId = "shared-activity-id";
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, outputSequence: "51", identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "baseline\n");
    __setTestBackend(factBackend);
    addSubscription({ endpoint, keys: { p256dh: "key", auth: "auth" } });
    try {
      await get("/api/sessions");
      await __runSessionNotificationObservationForTests();
      let releaseCapture: (() => void) | undefined;
      const captureReleased = new Promise<void>((resolve) => { releaseCapture = resolve; });
      let captureStarted: (() => void) | undefined;
      const captureStartedPromise = new Promise<void>((resolve) => { captureStarted = resolve; });
      factBackend.setPane(sessionName, "changed\n");
      const originalCapturePane = factBackend.capturePane.bind(factBackend);
      factBackend.capturePane = async (name: string) => {
        captureStarted?.();
        await captureReleased;
        return originalCapturePane(name);
      };
      factBackend.setFacts([
        { name: sessionName, alive: true, outputSequence: "52", identity: testIdentity(sessionName, sessionId) },
      ]);

      const notification = __runSessionNotificationObservationForTests();
      await captureStartedPromise;
      const dashboard = get("/api/sessions");
      releaseCapture?.();
      const [response] = await Promise.all([dashboard, notification]);
      const observed = await response.json();

      expect(factBackend.capturePaneCalls).toBe(2);
      expect(observed.sessions[0].triage).toBe("running");
      expect(observed.sessions[0].activity.lastRenderedActivityAt).toBe(observed.sessions[0].activity.observedAt);
      expect(observed.sessions[0].activity).not.toHaveProperty("quietSince");
      expect(observed.sessions[0].activity.display).toBe("");
      expect(observed.sessions[0].runtimeState.transitionSequence).toBe(2);
    } finally {
      removeSubscription(endpoint);
      __setTestBackend(mockBackend);
    }
  });

  test("first rendered fingerprint initializes baseline without reporting recent output", async () => {
    mockBackend.setSessions(["fresh-baseline"]);
    mockBackend.setCapturePane(async () => "quiet existing screen\n");

    const data = await (await get("/api/sessions")).json();

    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].triage).toBe("idle");
    expect(data.sessions[0].runtimeState).toMatchObject({
      state: "idle",
      authority: "fallback",
      source: "screen-fallback",
      transitionSequence: 1,
    });
    expect(data.sessions[0].activity).toMatchObject({ freshness: "fresh", observedAt: expect.any(String) });
    expect(data.sessions[0].activity).not.toHaveProperty("lastRenderedActivityAt");
    expect(data.sessions[0].activity).not.toHaveProperty("quietSince");
  });

  test("restored acknowledged state stays seen on first rendered sample after restart", async () => {
    mockBackend.setSessions(["restored-baseline"]);
    mockBackend.setCapturePane(async () => "quiet existing screen\n");
    const sessionKey = "mock:restored-baseline";
    const store = new AgentRuntimeStateStore(process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH!);
    const idle = store.reduce({
      sessionKey,
      broker: { state: "alive", observedAt: "2026-07-25T00:00:00.000Z" },
      sources: [],
      fallback: { rawOutputChanged: false, observedAt: "2026-07-25T00:00:00.000Z" },
      currentRun: { runId: sessionKey, runOrder: 0 },
    });
    expect(store.acknowledge(sessionKey, idle.transitionSequence, "2026-07-25T00:01:00.000Z")?.unseen).toBe(false);
    __resetAgentRuntimeStateStoreForTests();

    const data = await (await get("/api/sessions")).json();

    expect(data.sessions[0].runtimeState).toMatchObject({
      state: "idle",
      transitionSequence: idle.transitionSequence,
      acknowledgedSequence: idle.transitionSequence,
      unseen: false,
    });
    expect(data.sessions[0].activity).toMatchObject({ freshness: "fresh", observedAt: expect.any(String) });
    expect(data.sessions[0].activity).not.toHaveProperty("lastRenderedActivityAt");
    expect(data.sessions[0].activity).not.toHaveProperty("quietSince");
  });

  test("preserves known sessions as unknown without pruning ack state when broker list is unavailable", async () => {
    mockBackend.setSessions(["broker-unavailable"]);
    mockBackend.setCapturePane(async () => "quiet existing screen\n");
    const seeded = await (await get("/api/sessions")).json();
    const sessionId = seeded.sessions[0].identity.wolfpackSessionId;
    const sequence = seeded.sessions[0].runtimeState.transitionSequence;
    expect((await post("/api/agent-runtime-state/ack", { sessionId, transitionSequence: sequence })).status).toBe(200);

    const originalList = mockBackend.list.bind(mockBackend);
    (mockBackend as any).list = async () => { throw new Error("broker unavailable"); };
    try {
      const unavailable = await (await get("/api/sessions")).json();

      expect(unavailable.sessions).toHaveLength(1);
      expect(unavailable.sessions[0]).toMatchObject({
        name: "broker-unavailable",
        runtimeState: {
          state: "unknown",
          authority: "liveness",
          source: "broker-liveness",
          acknowledgedSequence: sequence,
          unseen: true,
        },
        activity: { freshness: "unknown" },
      });
      expect(unavailable.sessions[0].activity).toMatchObject({ observedAt: expect.any(String) });
      expect(unavailable.sessions[0].activity).not.toHaveProperty("quietSince");
      const persisted = new AgentRuntimeStateStore(process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH!).get(sessionId);
      expect(persisted?.state).toBe("unknown");
      expect(persisted?.acknowledgedSequence).toBe(sequence);
    } finally {
      (mockBackend as any).list = originalList;
    }
  });

  test("cold broker-unavailable restart projects legacy persisted runtime states as unknown", async () => {
    const sessionKey = "legacy-runtime-session";
    writeFileSync(process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH!, JSON.stringify({
      schemaVersion: 1,
      sessions: {
        [sessionKey]: {
          state: "idle",
          authority: "fallback",
          freshness: "fresh",
          source: "screen-fallback",
          label: "bounded activity idle",
          stale: false,
          observedAt: "2026-07-25T00:00:00.000Z",
          changedAt: "2026-07-25T00:00:00.000Z",
          transitionSequence: 3,
          acknowledgedAt: "2026-07-25T00:01:00.000Z",
          acknowledgedSequence: 3,
          unseen: false,
          runOrder: 7,
        },
      },
    }));
    __resetAgentRuntimeStateStoreForTests();
    __resetSessionObservationForTests();
    const originalList = mockBackend.list.bind(mockBackend);
    (mockBackend as any).list = async () => { throw new Error("broker unavailable after restart"); };
    try {
      const unavailable = await (await get("/api/sessions")).json();

      expect(unavailable.sessions).toHaveLength(1);
      expect(unavailable.sessions[0]).toMatchObject({
        name: sessionKey,
        lastLine: "",
        runtimeState: {
          state: "unknown",
          authority: "liveness",
          source: "broker-liveness",
          transitionSequence: 4,
          acknowledgedSequence: 3,
          unseen: true,
          runOrder: 7,
        },
      });
    } finally {
      (mockBackend as any).list = originalList;
    }

    mockBackend.setSessions([]);
    const recovered = await (await get("/api/sessions")).json();
    expect(recovered.sessions).toHaveLength(0);
    expect(new AgentRuntimeStateStore(process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH!).get(sessionKey)).toBeUndefined();
  });

  test("authoritative empty broker list prunes durable runtime state", async () => {
    const sessionKey = "mock:gone-session";
    const store = new AgentRuntimeStateStore(process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH!);
    store.reduce({
      sessionKey,
      broker: { state: "alive", observedAt: "2026-07-25T00:00:00.000Z" },
      sources: [],
      fallback: { rawOutputChanged: false, observedAt: "2026-07-25T00:00:00.000Z" },
      currentRun: { runId: sessionKey, runOrder: 0 },
    });
    __resetAgentRuntimeStateStoreForTests();
    mockBackend.setSessions([]);

    const data = await (await get("/api/sessions")).json();

    expect(data.sessions).toHaveLength(0);
    expect(new AgentRuntimeStateStore(process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH!).get(sessionKey)).toBeUndefined();
  });

  test("authoritative dead session fact projects off through runtime state", async () => {
    mockBackend.setSessions(["dead-session"]);
    mockBackend.setSessionAlive("dead-session", false);
    mockBackend.setCapturePane(async () => "old screen\n");
    try {
      const data = await (await get("/api/sessions")).json();

      expect(data.sessions).toHaveLength(1);
      expect(data.sessions[0].runtimeState).toMatchObject({
        state: "off",
        authority: "liveness",
        source: "broker-liveness",
      });
    } finally {
      mockBackend.setSessionAlive("dead-session", null);
    }
  });

  test("backend authoritative dead facts project off and preserve ack until omitted", async () => {
    const sessionName = "fact-dead-session";
    const sessionId = "fact-session-id";
    const factBackend = new FactBackend([
      { name: sessionName, alive: false, identity: testIdentity(sessionName, sessionId) },
    ]);
    __setTestBackend(factBackend);
    const store = new AgentRuntimeStateStore(process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH!);
    const idle = store.reduce({
      sessionKey: sessionId,
      broker: { state: "alive", observedAt: "2026-07-25T00:00:00.000Z" },
      sources: [],
      fallback: { rawOutputChanged: false, observedAt: "2026-07-25T00:00:00.000Z" },
      currentRun: { runId: sessionId, runOrder: 0 },
    });
    expect(store.acknowledge(sessionId, idle.transitionSequence, "2026-07-25T00:01:00.000Z")?.unseen).toBe(false);
    __resetAgentRuntimeStateStoreForTests();
    try {
      const dead = await (await get("/api/sessions")).json();

      expect(dead.sessions).toHaveLength(1);
      expect(dead.sessions[0]).toMatchObject({
        name: sessionName,
        lastLine: "",
        identity: { wolfpackSessionId: sessionId, wolfpackSessionName: sessionName },
        runtimeState: {
          state: "off",
          authority: "liveness",
          source: "broker-liveness",
          acknowledgedSequence: idle.transitionSequence,
          unseen: true,
        },
      });
      expect(new AgentRuntimeStateStore(process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH!).get(sessionId)).toMatchObject({ state: "off" });

      factBackend.setFacts([]);
      const omitted = await (await get("/api/sessions")).json();
      expect(omitted.sessions).toHaveLength(0);
      expect(new AgentRuntimeStateStore(process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH!).get(sessionId)).toBeUndefined();
    } finally {
      __setTestBackend(mockBackend);
    }
  });

  test("backend authoritative fact failures preserve known sessions as unknown", async () => {
    const sessionName = "fact-unavailable-session";
    const sessionId = "fact-unavailable-id";
    const factBackend = new FactBackend([
      { name: sessionName, alive: true, identity: testIdentity(sessionName, sessionId) },
    ]);
    factBackend.setPane(sessionName, "quiet screen\n");
    __setTestBackend(factBackend);
    try {
      const seeded = await (await get("/api/sessions")).json();
      expect(seeded.sessions).toHaveLength(1);
      const sequence = seeded.sessions[0].runtimeState.transitionSequence;
      expect((await post("/api/agent-runtime-state/ack", { sessionId, transitionSequence: sequence })).status).toBe(200);

      factBackend.setFactsUnavailable(true);
      const unavailable = await (await get("/api/sessions")).json();

      expect(unavailable.sessions).toHaveLength(1);
      expect(unavailable.sessions[0]).toMatchObject({
        name: sessionName,
        runtimeState: {
          state: "unknown",
          authority: "liveness",
          source: "broker-liveness",
          acknowledgedSequence: sequence,
          unseen: true,
        },
      });
      expect(new AgentRuntimeStateStore(process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH!).get(sessionId)).toMatchObject({ state: "unknown" });
    } finally {
      __setTestBackend(mockBackend);
    }
  });

  test("does not infer semantic state from terminal prose", async () => {
    mockBackend.setCapturePane(async () => "DONE: failed, approve? needs input\n");
    await get("/api/sessions");
    const data = await (await get("/api/sessions")).json();

    expect(data.sessions[0].runtimeState.state).toBe("idle");
    expect(data.sessions[0].runtimeState.state).not.toBe("needs-input");
    expect(data.sessions[0].runtimeState.state).not.toBe("done");
    expect(data.sessions[0].runtimeState.state).not.toBe("failed");
  });

  test("acknowledges runtime transition and invalidates on a newer transition", async () => {
    mockBackend.setCapturePane(async () => "waiting\n");
    const initial = await (await get("/api/sessions")).json();
    const runtimeState = initial.sessions[0].runtimeState;
    const sessionId = initial.sessions[0].identity.wolfpackSessionId;

    const ackRes = await post("/api/agent-runtime-state/ack", {
      sessionId,
      transitionSequence: runtimeState.transitionSequence,
    });
    expect(ackRes.status).toBe(200);
    const acked = await ackRes.json();
    expect(acked.runtimeState.unseen).toBe(false);
    expect(acked.runtimeState.acknowledgedSequence).toBe(runtimeState.transitionSequence);

    mockBackend.setCapturePane(async () => "new output\n");
    mockBackend.setOutputSequence("wolf-1", "1");
    const next = await (await get("/api/sessions")).json();
    expect(next.sessions[0].runtimeState.transitionSequence).toBeGreaterThan(runtimeState.transitionSequence);
    expect(next.sessions[0].runtimeState.unseen).toBe(true);
    expect(next.sessions[0].activity.lastRenderedActivityAt).toBe(next.sessions[0].activity.observedAt);
  });
});

describe("agent-native top-level session control", () => {
  beforeEach(() => {
    mockBackend.setSessions(["wolf-1", "wolf-2"]);
    mockBackend.setCapturePane(async (session: string) => `output for ${session}`);
    mockBackend.lastCreateArgs = null;
    mockBackend.lastSendArgs = null;
    process.env.WOLFPACK_DEV_DIR = TEST_DEV_DIR;
  });

  test("creates a top-level session with one opaque launch prompt and stable id", async () => {
    const initialPrompt = "execute .plans/000-publish-branchout.md";
    const res = await post("/api/session-create", {
      project: "my-app",
      harness: "pi",
      initialPrompt,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      session: "my-app",
      sessionId: "mock:my-app",
      project: "my-app",
      harness: "pi",
    });
    expect(mockBackend.lastCreateArgs).toMatchObject({
      name: "my-app",
      cwd: join(TEST_DEV_DIR, "my-app"),
      cmd: "pi",
      agentKind: "pi",
      initialPrompt,
      parentSession: undefined,
    });
  });

  test("creates a top-level session in an explicitly selected directory outside DEV_DIR", async () => {
    const projectDir = createExplicitProjectDir();
    const res = await post("/api/session-create", {
      projectDir,
      harness: "pi",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      session: "outside_project",
      sessionId: "mock:outside_project",
      project: "outside project",
      harness: "pi",
    });
    expect(mockBackend.lastCreateArgs).toMatchObject({
      name: "outside_project",
      cwd: projectDir,
      cmd: "pi",
    });
  });

  test("rejects unchecked or ambiguous explicit directory selectors before launch", async () => {
    const projectDir = createExplicitProjectDir("ambiguous");
    for (const body of [
      { projectDir: "relative/project", harness: "pi" },
      { project: "my-app", projectDir, harness: "pi" },
    ]) {
      mockBackend.lastCreateArgs = null;
      const res = await post("/api/session-create", body);
      expect(res.status).toBe(400);
      expect(mockBackend.lastCreateArgs).toBeNull();
    }
  });

  test("creates a top-level shell session when explicitly selected", async () => {
    const res = await post("/api/session-create", {
      project: "my-app",
      harness: "shell",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      session: "my-app",
      sessionId: "mock:my-app",
      project: "my-app",
      harness: "shell",
    });
    expect(mockBackend.lastCreateArgs).toMatchObject({
      name: "my-app",
      cwd: join(TEST_DEV_DIR, "my-app"),
      cmd: "shell",
      agentKind: "shell",
      initialPrompt: undefined,
      parentSession: undefined,
    });
  });

  test("rejects malformed create input before backend mutation", async () => {
    const res = await post("/api/session-create", {
      project: "my-app",
      harness: "shell",
      initialPrompt: "run this",
    });

    expect(res.status).toBe(400);
    expect(mockBackend.lastCreateArgs).toBeNull();
  });

  test("rejects task-worker requests without an explicit root, Pi harness, or bounded prompt-free options", async () => {
    const projectDir = createExplicitProjectDir("task-worker");
    for (const body of [
      { project: "my-app", harness: "pi", taskWorker: true },
      { projectDir, harness: "shell", taskWorker: true },
      { projectDir, harness: "pi", taskWorker: true, initialPrompt: "start now" },
      { projectDir, harness: "pi", taskWorker: true, readinessTimeoutMs: 60_001 },
    ]) {
      mockBackend.lastCreateArgs = null;
      const res = await post("/api/session-create", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({
        error: "invalid session-create request",
        code: SESSION_CREATE_ERROR.INVALID_REQUEST,
      });
      expect(mockBackend.lastCreateArgs).toBeNull();
    }
  });

  test("publishes task-worker create/open success and recovery bodies that satisfy generated schemas", async () => {
    const root = createExplicitProjectDir("task-worker-public");
    const executable = join(root, "pi");
    const extension = join(root, "extension.ts");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    writeFileSync(extension, "export {}\n");
    const priorExecutable = process.env.WOLFPACK_TASK_WORKER_PI_EXECUTABLE;
    const priorExtension = process.env.WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION;
    process.env.WOLFPACK_TASK_WORKER_PI_EXECUTABLE = executable;
    process.env.WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION = extension;
    mockBackend.setSessions([]);
    mockBackend.setOnBeforeCreate((name) => {
      queueMicrotask(() => {
        void getTaskRelayGateway().connect({
          callerSession: name,
          generation: `test-${name}`,
          protocolVersions: [2],
        });
      });
    });
    try {
      for (const [path, body, operation] of [
        ["/api/session-create", { projectDir: root, harness: "pi", taskWorker: true, readinessTimeoutMs: 500 }, "createTopLevelSession"],
        ["/api/session-open", { projectDir: root, parentSession: "pi-parent", taskWorker: true, readinessTimeoutMs: 500 }, "openSession"],
      ] as const) {
        if (path === "/api/session-open") {
          await mockBackend.createSession("pi-parent", root, "pi", () => ({ agentCmd: "pi" }), { agentKind: "pi" });
        }
        const response = await post(path, body);
        const responseBody = await response.json();
        expect(response.ok, JSON.stringify(responseBody)).toBeTruthy();
        expect(validateSchema(responseSchema(operation), responseBody, controlApiSchema)).toEqual([]);
        expect(responseBody).toMatchObject({ ok: true, harness: "pi", taskEndpoint: { relay: "wolfpack-pi-tasks-v2" } });
      }

      mockBackend.setOnBeforeCreate(null);
      for (const [path, body] of [
        ["/api/session-create", {
          projectDir: createExplicitProjectDir("task-worker-public-failure"),
          harness: "pi",
          taskWorker: true,
          readinessTimeoutMs: 1,
        }],
        ["/api/session-open", {
          projectDir: root,
          parentSession: "pi-parent",
          taskWorker: true,
          readinessTimeoutMs: 1,
        }],
      ] as const) {
        const failed = await post(path, body);
        const failedBody = await failed.json();
        expect(failed.status).toBe(503);
        expect(validateSchema({ $ref: "#/$defs/TaskWorkerLaunchErrorEnvelope" }, failedBody, controlApiSchema)).toEqual([]);
        expect(failedBody).toMatchObject({
          code: SESSION_CREATE_ERROR.TASK_WORKER_NOT_READY,
          createdSession: { sessionId: expect.any(String) },
          cleanup: "completed",
        });
      }
    } finally {
      mockBackend.setOnBeforeCreate(null);
      if (priorExecutable === undefined) delete process.env.WOLFPACK_TASK_WORKER_PI_EXECUTABLE;
      else process.env.WOLFPACK_TASK_WORKER_PI_EXECUTABLE = priorExecutable;
      if (priorExtension === undefined) delete process.env.WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION;
      else process.env.WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION = priorExtension;
    }
  });

  test("resolves stable ids for list, status, read, send, wait, and kill", async () => {
    const selector = encodeURIComponent("mock:wolf-1");

    const list = await get("/api/session-control/list");
    const listed = (await list.json()).sessions.find(
      (session: { sessionId: string }) => session.sessionId === "mock:wolf-1",
    );
    expect(listed).toEqual({
      ok: true,
      selector: "wolf-1",
      session: "wolf-1",
      sessionId: "mock:wolf-1",
      state: "active",
      project: "",
      projectPath: "",
      projectDir: "",
      harness: "custom",
      terminal: { exists: true, alive: true, status: "ready" },
    });
    expect(listed).not.toHaveProperty("lastLine");

    const status = await get(`/api/session-control/status?session=${selector}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      ok: true,
      selector: "mock:wolf-1",
      session: "wolf-1",
      sessionId: "mock:wolf-1",
      state: "active",
      project: "",
      projectPath: "",
      projectDir: "",
      harness: "custom",
      terminal: { exists: true, alive: true, status: "ready" },
    });

    const read = await get(`/api/session-control/read?session=${selector}`);
    expect(await read.json()).toEqual({
      session: "wolf-1",
      sessionId: "mock:wolf-1",
      output: "output for wolf-1",
    });

    const send = await post("/api/session-control/send", {
      session: "mock:wolf-1",
      text: "execute the plan",
    });
    expect(await send.json()).toEqual({
      ok: true,
      session: "wolf-1",
      sessionId: "mock:wolf-1",
    });
    expect(mockBackend.lastSendArgs?.name).toBe("wolf-1");

    const wait = await post("/api/session-control/wait", {
      session: "mock:wolf-1",
      text: "output for wolf-1",
      timeoutMs: 100,
    });
    expect(await wait.json()).toEqual({
      ok: true,
      session: "wolf-1",
      sessionId: "mock:wolf-1",
      matched: true,
    });

    const kill = await post("/api/kill", { session: "mock:wolf-1" });
    expect(await kill.json()).toEqual({
      ok: true,
      session: "wolf-1",
      sessionId: "mock:wolf-1",
    });
    expect(await mockBackend.hasSession("wolf-1")).toBe(false);
  });
});

describe("POST /api/create", () => {
  beforeEach(() => {
    mockBackend.setSessions(["wolf-1", "wolf-2"]);
    // Re-assert env — other test files in the suite may overwrite it
    process.env.WOLFPACK_DEV_DIR = TEST_DEV_DIR;
  });

  test("creates session for valid project", async () => {
    const res = await post("/api/create", { project: "my-app" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.session).toBe("my-app");
    expect(mockBackend.lastCreateArgs?.agentKind).toBe("shell");
  });

  test("passes an explicit launch instruction without parent transcript context", async () => {
    const initialPrompt = "review the diff only; do not inherit parent context";
    const res = await post("/api/create", {
      project: "my-app",
      sessionName: "wolf-1-sub-agent",
      cmd: "pi",
      parentSession: "wolf-1",
      initialPrompt,
    });

    expect(res.status).toBe(200);
    expect(mockBackend.lastCreateArgs?.initialPrompt).toBe(initialPrompt);
  });

  test("rejects empty launch instructions", async () => {
    mockBackend.lastCreateArgs = null;
    const res = await post("/api/create", {
      project: "my-app",
      sessionName: "wolf-1-sub-agent",
      cmd: "pi",
      parentSession: "wolf-1",
      initialPrompt: "   ",
    });

    expect(res.status).toBe(400);
    expect(mockBackend.lastCreateArgs).toBeNull();
  });

  test("rejects oversized launch instructions", async () => {
    mockBackend.lastCreateArgs = null;
    const res = await post("/api/create", {
      project: "my-app",
      sessionName: "wolf-1-sub-agent",
      cmd: "pi",
      parentSession: "wolf-1",
      initialPrompt: "x".repeat(32_769),
    });

    expect(res.status).toBe(400);
    expect(mockBackend.lastCreateArgs).toBeNull();
  });

  test("rejects launch instructions for plain shells", async () => {
    mockBackend.lastCreateArgs = null;
    const res = await post("/api/create", {
      project: "my-app",
      sessionName: "shell-child",
      cmd: "shell",
      initialPrompt: "run this",
    });

    expect(res.status).toBe(400);
    expect(mockBackend.lastCreateArgs).toBeNull();
  });

  test("notifies the active parent viewer after creating a sub-session", async () => {
    const frames = attachNotificationViewer("wolf-1");
    const res = await post("/api/create", {
      project: "my-app",
      sessionName: "wolf-1-sub-agent",
      cmd: "pi",
      parentSession: "wolf-1",
    });

    expect(res.status).toBe(200);
    expect(mockBackend.lastCreateArgs?.parentSession).toEqual({
      wolfpackSessionId: "mock:wolf-1",
      wolfpackSessionName: "wolf-1",
    });
    expect(frames.map((frame) => JSON.parse(frame))).toContainEqual({
      type: "sub_session_opened",
      parentSession: "wolf-1",
      session: "wolf-1-sub-agent",
    });
  });

  test("creates the child when the parent has no attached viewer", async () => {
    const res = await post("/api/create", {
      project: "my-app",
      sessionName: "wolf-1-sub-agent",
      cmd: "pi",
      parentSession: "wolf-1",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, session: "wolf-1-sub-agent" });
  });

  test("exposes structured parent identity on the created child", async () => {
    const create = await post("/api/create", {
      project: "my-app",
      sessionName: "wolf-1-sub-agent",
      cmd: "pi",
      parentSession: "wolf-1",
    });
    expect(create.status).toBe(200);

    const sessions = await get("/api/sessions");
    const child = (await sessions.json()).sessions.find(
      (session: { name: string }) => session.name === "wolf-1-sub-agent",
    );
    expect(child.identity.parentSession).toEqual({
      wolfpackSessionId: "mock:wolf-1",
      wolfpackSessionName: "wolf-1",
    });
  });

  test("does not notify the parent when child creation fails", async () => {
    const frames = attachNotificationViewer("wolf-1");
    const res = await post("/api/create", {
      project: "my-app",
      sessionName: "wolf-2",
      cmd: "pi",
      parentSession: "wolf-1",
    });

    expect(res.status).toBe(409);
    expect(frames).toEqual([]);
  });

  test("rejects an unavailable parent before creating a sub-session", async () => {
    mockBackend.lastCreateArgs = null;
    const res = await post("/api/create", {
      project: "my-app",
      sessionName: "pi-sub-agent",
      cmd: "pi",
      parentSession: "missing-parent",
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "parent session not found",
      code: "PARENT_SESSION_NOT_FOUND",
    });
    expect(mockBackend.lastCreateArgs).toBeNull();
  });

  test("rejects a non-string parent session", async () => {
    mockBackend.lastCreateArgs = null;
    const res = await post("/api/create", {
      project: "my-app",
      sessionName: "pi-sub-agent",
      cmd: "pi",
      parentSession: 42,
    });

    expect(res.status).toBe(400);
    expect(mockBackend.lastCreateArgs).toBeNull();
  });

  test("captures selected agent kind at launch", async () => {
    const res = await post("/api/create", { project: "my-app", sessionName: "codex-launch", cmd: "codex" });
    expect(res.status).toBe(200);
    expect(mockBackend.lastCreateArgs).toMatchObject({
      name: "codex-launch",
      agentKind: "codex",
    });
  });

  test("generates unique session name on collision", async () => {
    // wolf-1 already exists in sessions
    mkdirSync(join(TEST_DEV_DIR, "wolf-1"), { recursive: true });
    const res = await post("/api/create", { project: "wolf-1" });
    expect(res.status).toBe(200);
    const data = await res.json();
    // should become wolf-1-2 since wolf-1 is taken
    expect(data.session).toBe("wolf-1-2");
  });

  test("rejects invalid project name", async () => {
    const res = await post("/api/create", { project: "../etc" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("invalid project");
  });

  test("rejects empty project name", async () => {
    const res = await post("/api/create", { project: "" });
    expect(res.status).toBe(400);
  });

  test("rejects dot-dot project name", async () => {
    const res = await post("/api/create", { project: ".." });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("invalid project");
  });

  test("rejects missing project entirely", async () => {
    const res = await post("/api/create", {});
    expect(res.status).toBe(400);
  });

  test("rejects non-string project fields without creating a session", async () => {
    mockBackend.lastCreateArgs = null;
    const res = await post("/api/create", { newProject: 42 });
    expect(res.status).toBe(400);
    expect(mockBackend.lastCreateArgs).toBeNull();
  });

  test("opens an explicitly selected existing directory without creating it", async () => {
    const projectDir = createExplicitProjectDir("browser workspace");
    const res = await post("/api/create", { projectDir, cmd: "claude" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, session: "browser_workspace" });
    expect(mockBackend.lastCreateArgs).toMatchObject({
      name: "browser_workspace",
      cwd: projectDir,
      cmd: "claude",
    });
  });

  test("rejects relative and ambiguous explicit directory selections before browser launch", async () => {
    const projectDir = createExplicitProjectDir("browser ambiguous");
    for (const body of [
      { projectDir: "relative/project", cmd: "claude" },
      { project: "my-app", projectDir, cmd: "claude" },
    ]) {
      mockBackend.lastCreateArgs = null;
      const res = await post("/api/create", body);
      expect(res.status).toBe(400);
      expect(mockBackend.lastCreateArgs).toBeNull();
    }
  });

  test("uses newProject field when provided", async () => {
    const res = await post("/api/create", { newProject: "fresh-app" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.session).toBe("fresh-app");
  });

  test("preserves newProject precedence when both legacy project fields are provided", async () => {
    const res = await post("/api/create", {
      project: "my-app",
      newProject: "fresh-override",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, session: "fresh-override" });
    expect(mockBackend.lastCreateArgs?.cwd).toBe(join(TEST_DEV_DIR, "fresh-override"));
  });

  test("creates session with cmd", async () => {
    mockBackend.lastCreateArgs = null;
    const res = await post("/api/create", {
      project: "my-app",
      cmd: "claude",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.session).toBe("my-app");
    expect(mockBackend.lastCreateArgs!.cmd).toBe("claude");
  });

  test("uses custom sessionName when provided", async () => {
    const res = await post("/api/create", {
      project: "my-app",
      sessionName: "auth-refactor",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.session).toBe("auth-refactor");
  });

  test("rejects invalid session name characters", async () => {
    const res = await post("/api/create", {
      project: "my-app",
      sessionName: "foo.bar",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("invalid session name");
  });

  test("rejects taken session name with 409", async () => {
    const res = await post("/api/create", {
      project: "my-app",
      sessionName: "wolf-1",
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("session name already taken");
  });

  test("returns 409 when backend reports duplicate session (race condition)", async () => {
    // Simulate TOCTOU: session doesn't exist during pre-check, but appears
    // between list() and createSession() — so createSession throws DUPLICATE_SESSION.
    mockBackend.setSessions(["wolf-1", "wolf-2"]);
    mockBackend.setOnBeforeCreate((name) => {
      // Inject the session into the set right before createSession checks,
      // simulating another concurrent request that created it first.
      if (name === "race-target") mockBackend.setSessions(["wolf-1", "wolf-2", "race-target"]);
    });
    const res = await post("/api/create", {
      project: "my-app",
      sessionName: "race-target",
    });
    mockBackend.setOnBeforeCreate(null);
    expect(res.status).toBe(409);
    const data = await res.json();
    // This hits the DUPLICATE_SESSION catch path, not the pre-check
    expect(data.error).toBe("session exists");
  });

  test("project dir not found returns 404", async () => {
    const res = await post("/api/create", { project: "nonexistent-proj" });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("project directory not found");
  });
});

describe("POST /api/session-open", () => {
  const originalListIdentities = MockBackend.prototype.listIdentities;

  function useParentHarness(agentKind: string): void {
    mockBackend.listIdentities = async () => {
      const identities = await originalListIdentities.call(mockBackend);
      const parent = identities["wolf-1"];
      if (!parent) return identities;
      return {
        ...identities,
        "wolf-1": { ...parent, agentKind },
      };
    };
  }

  beforeEach(() => {
    mockBackend.setSessions(["wolf-1", "wolf-2"]);
    mockBackend.setOnBeforeCreate(null);
    mockBackend.lastCreateArgs = null;
    useParentHarness("pi");
  });

  afterEach(() => {
    mockBackend.listIdentities = () => originalListIdentities.call(mockBackend);
    mockBackend.setOnBeforeCreate(null);
    activePtySessions.clear();
  });

  test("creates one same-harness child with exact parent identity and prompt", async () => {
    const prompt = "review '$(touch /tmp/not-executed)' \"$HOME\"; done";
    const model = "openrouter/anthropic/claude-sonnet-4";
    const frames = attachNotificationViewer("wolf-1");

    const res = await post("/api/session-open", {
      project: "my-app",
      parentSession: "wolf-1",
      model,
      initialPrompt: prompt,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      session: "wolf-1-sub-agent",
      sessionId: "mock:wolf-1-sub-agent",
      project: "my-app",
      harness: "pi",
    });
    expect(mockBackend.lastCreateArgs).toEqual({
      name: "wolf-1-sub-agent",
      cwd: join(TEST_DEV_DIR, "my-app"),
      cmd: "pi",
      agentKind: "pi",
      parentSession: {
        wolfpackSessionId: "mock:wolf-1",
        wolfpackSessionName: "wolf-1",
      },
      model,
      initialPrompt: prompt,
    });
    expect(frames.map((frame) => JSON.parse(frame))).toEqual([{
      type: "sub_session_opened",
      parentSession: "wolf-1",
      session: "wolf-1-sub-agent",
    }]);
  });

  test("creates a child in an explicitly selected directory outside DEV_DIR", async () => {
    const projectDir = createExplicitProjectDir("child workspace");
    const res = await post("/api/session-open", {
      projectDir,
      parentSession: "wolf-1",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      project: "child workspace",
      harness: "pi",
    });
    expect(mockBackend.lastCreateArgs?.cwd).toBe(projectDir);
  });

  test("rejects relative and ambiguous explicit directory selections before child launch", async () => {
    const projectDir = createExplicitProjectDir("child ambiguous");
    for (const body of [
      { projectDir: "relative/project", parentSession: "wolf-1" },
      { project: "my-app", projectDir, parentSession: "wolf-1" },
    ]) {
      mockBackend.lastCreateArgs = null;
      const res = await post("/api/session-open", body);
      expect(res.status).toBe(400);
      expect(mockBackend.lastCreateArgs).toBeNull();
    }
  });

  test("creates a child with a meaningful requested session name", async () => {
    const frames = attachNotificationViewer("wolf-1");

    const res = await post("/api/session-open", {
      project: "my-app",
      parentSession: "wolf-1",
      sessionName: "issue-200-reviewer",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      session: "issue-200-reviewer",
      sessionId: "mock:issue-200-reviewer",
      project: "my-app",
      harness: "pi",
    });
    expect(mockBackend.lastCreateArgs?.name).toBe("issue-200-reviewer");
    expect(frames.map((frame) => JSON.parse(frame))).toEqual([{
      type: "sub_session_opened",
      parentSession: "wolf-1",
      session: "issue-200-reviewer",
    }]);
  });

  test("allocates a numbered requested child name after a typed stale-name collision", async () => {
    mockBackend.setOnBeforeCreate((name) => {
      if (name === "issue-200-reviewer") {
        mockBackend.setSessions(["wolf-1", "wolf-2", "issue-200-reviewer"]);
        mockBackend.setOnBeforeCreate(null);
      }
    });

    const res = await post("/api/session-open", {
      project: "my-app",
      parentSession: "wolf-1",
      sessionName: "issue-200-reviewer",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      session: "issue-200-reviewer-2",
      sessionId: "mock:issue-200-reviewer-2",
      project: "my-app",
      harness: "pi",
    });
  });

  test("allocates a numbered child after a typed stale-name collision", async () => {
    mockBackend.setOnBeforeCreate((name) => {
      if (name === "wolf-1-sub-agent") {
        mockBackend.setSessions(["wolf-1", "wolf-2", "wolf-1-sub-agent"]);
        mockBackend.setOnBeforeCreate(null);
      }
    });

    const res = await post("/api/session-open", {
      project: "my-app",
      parentSession: "wolf-1",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      session: "wolf-1-sub-agent-2",
      sessionId: "mock:wolf-1-sub-agent-2",
      project: "my-app",
      harness: "pi",
    });
  });

  test("returns coded invalid-request errors for malformed and non-object JSON", async () => {
    const malformed = await fetch(`${base}/api/session-open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"project":',
    });
    expect(malformed.status).toBe(SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.INVALID_REQUEST]);
    expect(await malformed.json()).toEqual({
      error: "invalid session-open request",
      code: SESSION_OPEN_ERROR.INVALID_REQUEST,
    });

    for (const body of [[], null, "wolfpack", 42]) {
      const response = await fetch(`${base}/api/session-open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body)).toBe(
        SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.INVALID_REQUEST],
      );
      expect(await response.json(), JSON.stringify(body)).toEqual({
        error: "invalid session-open request",
        code: SESSION_OPEN_ERROR.INVALID_REQUEST,
      });
    }
  });

  test("terminates an oversized chunked request at the transport limit", async () => {
    const url = new URL(base);
    await new Promise<void>((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("oversized chunked request remained connected"));
      }, 2_000);
      socket.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "ECONNRESET") reject(error);
      });
      socket.on("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.on("connect", () => {
        const chunk = "x".repeat(65 * 1024);
        socket.write([
          "POST /api/session-open HTTP/1.1",
          `Host: ${url.host}`,
          "Content-Type: application/json",
          "Transfer-Encoding: chunked",
          "Connection: keep-alive",
          "",
          `${chunk.length.toString(16)}\r\n${chunk}\r\n`,
        ].join("\r\n"));
      });
    });
  });

  test("strictly rejects unknown fields and client-owned launch overrides", async () => {
    for (const field of ["unknown", "newProject", "cmd"]) {
      mockBackend.lastCreateArgs = null;
      const res = await post("/api/session-open", {
        project: "my-app",
        parentSession: "wolf-1",
        [field]: "override",
      });
      expect(res.status, field).toBe(SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.INVALID_REQUEST]);
      expect(await res.json(), field).toEqual({
        error: "invalid session-open request",
        code: SESSION_OPEN_ERROR.INVALID_REQUEST,
      });
      expect(mockBackend.lastCreateArgs, field).toBeNull();
    }
  });

  test("rejects missing or invalid parent context before creation", async () => {
    for (const body of [
      { project: "my-app" },
      { project: "my-app", parentSession: "" },
      { project: "my-app", parentSession: "bad parent" },
      { project: "my-app", parentSession: "wolf-1", sessionName: "bad session" },
      { project: "my-app", parentSession: 42 },
    ]) {
      mockBackend.lastCreateArgs = null;
      const res = await post("/api/session-open", body);
      expect(res.status).toBe(SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.INVALID_REQUEST]);
      expect(await res.json()).toEqual({
        error: "invalid session-open request",
        code: SESSION_OPEN_ERROR.INVALID_REQUEST,
      });
      expect(mockBackend.lastCreateArgs).toBeNull();
    }
  });

  test("rejects missing, prefix-matched, or invalid projects without creating them", async () => {
    for (const project of ["missing-project", "my", "../my-app"]) {
      mockBackend.lastCreateArgs = null;
      const res = await post("/api/session-open", {
        project,
        parentSession: "wolf-1",
      });
      const expectedCode = project === "../my-app"
        ? SESSION_OPEN_ERROR.INVALID_REQUEST
        : SESSION_OPEN_ERROR.PROJECT_NOT_FOUND;
      expect(res.status, project).toBe(SESSION_OPEN_HTTP_STATUS[expectedCode]);
      expect(await res.json(), project).toEqual({
        error: project === "../my-app" ? "invalid session-open request" : "project not found",
        code: expectedCode,
      });
      expect(mockBackend.lastCreateArgs, project).toBeNull();
      expect(existsSync(join(TEST_DEV_DIR, project))).toBe(false);
    }
  });

  test("rejects blank and oversized model selections", async () => {
    for (const model of ["   ", "x".repeat(SESSION_OPEN_MAX_MODEL_LENGTH + 1)]) {
      mockBackend.lastCreateArgs = null;
      const res = await post("/api/session-open", {
        project: "my-app",
        parentSession: "wolf-1",
        model,
      });
      expect(res.status).toBe(SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.INVALID_REQUEST]);
      expect(await res.json()).toEqual({
        error: "invalid session-open request",
        code: SESSION_OPEN_ERROR.INVALID_REQUEST,
      });
      expect(mockBackend.lastCreateArgs).toBeNull();
    }
  });

  test("rejects model selection for non-pi parents without changing omitted behavior", async () => {
    useParentHarness("claude");
    const rejected = await post("/api/session-open", {
      project: "my-app",
      parentSession: "wolf-1",
      model: "anthropic/claude-opus-4-1",
    });
    expect(rejected.status).toBe(SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.INVALID_REQUEST]);
    expect(await rejected.json()).toEqual({
      error: "invalid session-open request",
      code: SESSION_OPEN_ERROR.INVALID_REQUEST,
    });
    expect(mockBackend.lastCreateArgs).toBeNull();

    const omitted = await post("/api/session-open", {
      project: "my-app",
      parentSession: "wolf-1",
    });
    expect(omitted.status).toBe(200);
    expect(mockBackend.lastCreateArgs?.agentKind).toBe("claude");
    expect(mockBackend.lastCreateArgs).not.toHaveProperty("model");
  });

  test("rejects blank and oversized prompts", async () => {
    for (const initialPrompt of ["   ", "x".repeat(32_769)]) {
      mockBackend.lastCreateArgs = null;
      const res = await post("/api/session-open", {
        project: "my-app",
        parentSession: "wolf-1",
        initialPrompt,
      });
      expect(res.status).toBe(SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.INVALID_REQUEST]);
      expect(await res.json()).toEqual({
        error: "invalid session-open request",
        code: SESSION_OPEN_ERROR.INVALID_REQUEST,
      });
      expect(mockBackend.lastCreateArgs).toBeNull();
    }
  });

  test("returns stable collision exhaustion and backend-unavailable failures", async () => {
    const originalCreateSession = mockBackend.createSession.bind(mockBackend);
    let createAttempts = 0;
    mockBackend.createSession = async () => {
      createAttempts++;
      throw new DuplicateSessionError("wolf-1-sub-agent");
    };
    try {
      const exhausted = await post("/api/session-open", {
        project: "my-app",
        parentSession: "wolf-1",
      });
      expect(exhausted.status).toBe(SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.NAME_COLLISION]);
      expect(await exhausted.json()).toEqual({
        error: "could not allocate a sub-agent session name",
        code: SESSION_OPEN_ERROR.NAME_COLLISION,
      });
      expect(createAttempts).toBe(4);
    } finally {
      mockBackend.createSession = originalCreateSession;
    }

    const originalList = mockBackend.list.bind(mockBackend);
    mockBackend.list = async () => { throw new Error("broker down"); };
    try {
      const unavailable = await post("/api/session-open", {
        project: "my-app",
        parentSession: "wolf-1",
      });
      expect(unavailable.status).toBe(SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.BACKEND_UNAVAILABLE]);
      expect(await unavailable.json()).toEqual({
        error: "backend unavailable",
        code: SESSION_OPEN_ERROR.BACKEND_UNAVAILABLE,
      });
    } finally {
      mockBackend.list = originalList;
    }
  });

  test("rejects missing parents, unavailable identity, and unsupported harnesses", async () => {
    const missing = await post("/api/session-open", {
      project: "my-app",
      parentSession: "missing-parent",
    });
    expect(missing.status).toBe(SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.PARENT_SESSION_NOT_FOUND]);
    expect(await missing.json()).toEqual({
      error: "parent session not found",
      code: SESSION_OPEN_ERROR.PARENT_SESSION_NOT_FOUND,
    });

    mockBackend.listIdentities = async () => ({});
    const unavailable = await post("/api/session-open", {
      project: "my-app",
      parentSession: "wolf-1",
    });
    expect(unavailable.status).toBe(
      SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.PARENT_IDENTITY_UNAVAILABLE],
    );
    expect(await unavailable.json()).toEqual({
      error: "parent session identity unavailable",
      code: SESSION_OPEN_ERROR.PARENT_IDENTITY_UNAVAILABLE,
    });

    for (const harness of ["shell", "custom"]) {
      useParentHarness(harness);
      const unsupported = await post("/api/session-open", {
        project: "my-app",
        parentSession: "wolf-1",
      });
      expect(unsupported.status, harness).toBe(
        SESSION_OPEN_HTTP_STATUS[SESSION_OPEN_ERROR.UNSUPPORTED_HARNESS],
      );
      expect(await unsupported.json(), harness).toEqual({
        error: "parent session is not running a supported agent harness",
        code: SESSION_OPEN_ERROR.UNSUPPORTED_HARNESS,
      });
    }
    expect(mockBackend.lastCreateArgs).toBeNull();
  });
});

describe("session control API", () => {
  beforeEach(() => {
    mockBackend.setSessions(["wolf-1", "wolf-2"]);
    mockBackend.setCapturePane(async (s: string) => `captured output for ${s}\n`);
    mockBackend.setOnAfterPrefill(null);
    mockBackend.lastSendArgs = null;
  });

  test("status exposes stable liveness/project facts by name without reading terminal output", async () => {
    const originalListIdentities = mockBackend.listIdentities.bind(mockBackend);
    mockBackend.listIdentities = async () => {
      const identities = await originalListIdentities();
      return {
        ...identities,
        "wolf-1": {
          ...identities["wolf-1"]!,
          projectPath: join(TEST_DEV_DIR, "my-app"),
          agentKind: "pi",
        },
      };
    };
    mockBackend.setCapturePane(async () => {
      throw new Error("status must not read terminal output");
    });
    try {
      const res = await get("/api/session-control/status?session=wolf-1");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        selector: "wolf-1",
        session: "wolf-1",
        sessionId: "mock:wolf-1",
        state: "active",
        project: "my-app",
        projectPath: join(TEST_DEV_DIR, "my-app"),
        projectDir: join(TEST_DEV_DIR, "my-app"),
        harness: "pi",
        terminal: { exists: true, alive: true, status: "ready" },
      });
    } finally {
      mockBackend.listIdentities = originalListIdentities;
    }
  });

  test("status resolves stable ids and fails closed for dead listed sessions", async () => {
    mockBackend.setSessionAlive("wolf-2", false);
    const res = await get("/api/session-control/status?session=mock%3Awolf-2");
    mockBackend.setSessionAlive("wolf-2", null);

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      ok: false,
      selector: "mock:wolf-2",
      session: "wolf-2",
      sessionId: "mock:wolf-2",
      terminal: { exists: true, alive: false, status: "dead" },
      error: { code: "SESSION_DEAD", message: "session is not alive" },
    });
  });

  test("status returns uniform bounded failures for missing, unknown, ambiguous, and unavailable targets", async () => {
    const missing = await get("/api/session-control/status");
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "missing session selector" },
    });

    const unknown = await get("/api/session-control/status?session=missing-agent");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      ok: false,
      selector: "missing-agent",
      terminal: { exists: false, alive: false, status: "unavailable" },
      error: { code: "SESSION_NOT_FOUND", message: "session not found" },
    });

    const originalInspectSession = mockBackend.inspectSession.bind(mockBackend);
    mockBackend.inspectSession = async () => ({ ok: false, code: "AMBIGUOUS" });
    const ambiguous = await get("/api/session-control/status?session=ambiguous-agent");
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toEqual({
      ok: false,
      selector: "ambiguous-agent",
      terminal: { exists: false, alive: false, status: "unavailable" },
      error: { code: "AMBIGUOUS_SELECTOR", message: "ambiguous session selector" },
    });

    mockBackend.inspectSession = async () => { throw new Error("transport details must stay private"); };
    const unavailable = await get("/api/session-control/status?session=wolf-1");
    mockBackend.inspectSession = originalInspectSession;
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      ok: false,
      selector: "wolf-1",
      terminal: { exists: false, alive: false, status: "unavailable" },
      error: { code: "BACKEND_UNAVAILABLE", message: "backend unavailable" },
    });
  });

  test("reads current output from backend snapshot", async () => {
    const res = await get("/api/session-control/read?session=wolf-1");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      session: "wolf-1",
      sessionId: "mock:wolf-1",
      output: "captured output for wolf-1\n",
    });
  });

  test("send validates session then delegates to backend", async () => {
    const res = await post("/api/session-control/send", {
      session: "wolf-1",
      text: "echo hi",
      noEnter: true,
    });
    expect(res.status).toBe(200);
    expect(mockBackend.lastSendArgs).toEqual({ name: "wolf-1", text: "echo hi", noEnter: true });
  });

  test("send returns 404 for unknown session", async () => {
    const res = await post("/api/session-control/send", {
      session: "ghost",
      text: "echo hi",
    });
    expect(res.status).toBe(404);
    expect(mockBackend.lastSendArgs).toBeNull();
  });

  test("wait succeeds from existing snapshot without subscribing", async () => {
    const res = await post("/api/session-control/wait", {
      session: "wolf-1",
      text: "output for wolf-1",
      timeoutMs: 50,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true, session: "wolf-1", sessionId: "mock:wolf-1", matched: true });
  });

  test("wait succeeds from later broker output", async () => {
    mockBackend.setCapturePane(async () => "booting\n");
    const wait = post("/api/session-control/wait", {
      session: "wolf-1",
      text: "ready",
      timeoutMs: 500,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    mockBackend.emitSessionData("wolf-1", "system ready\n");
    const res = await wait;
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true, session: "wolf-1", sessionId: "mock:wolf-1", matched: true });
  });

  test("wait replays output emitted between snapshot and subscribe", async () => {
    mockBackend.setCapturePane(async () => "booting\n");
    mockBackend.setOnAfterPrefill((session) => {
      mockBackend.emitSessionData(session, "system ready\n");
    });

    const res = await post("/api/session-control/wait", {
      session: "wolf-1",
      text: "ready",
      timeoutMs: 100,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true, session: "wolf-1", sessionId: "mock:wolf-1", matched: true });
  });

  test("wait returns 408 on timeout", async () => {
    mockBackend.setCapturePane(async () => "booting\n");
    const res = await post("/api/session-control/wait", {
      session: "wolf-1",
      text: "never appears",
      timeoutMs: 10,
    });
    expect(res.status).toBe(408);
    const data = await res.json();
    expect(data.matched).toBe(false);
  });

  test("prompt resolves once, pins the stable id, and returns the pre-send boundary", async () => {
    const originalList = mockBackend.list.bind(mockBackend);
    let listCalls = 0;
    const calls: unknown[] = [];
    mockBackend.list = async () => {
      listCalls++;
      return originalList();
    };
    const atomicBackend = mockBackend as unknown as {
      promptAndWaitForOutput: (sessionId: string, options: unknown) => Promise<unknown>;
    };
    atomicBackend.promptAndWaitForOutput = async (sessionId, options) => {
      calls.push({ sessionId, options });
      return { outcome: "matched", outputBoundarySeq: "41" };
    };

    try {
      const res = await post("/api/session-control/prompt", {
        session: "wolf-1",
        prompt: "run the check",
        outputContains: "READY",
        noEnter: false,
        timeoutMs: 250,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        session: "wolf-1",
        sessionId: "mock:wolf-1",
        outcome: "matched",
        outputBoundarySeq: "41",
      });
      expect(listCalls).toBe(1);
      expect(calls).toEqual([{
        sessionId: "mock:wolf-1",
        options: {
          prompt: "run the check",
          outputContains: "READY",
          noEnter: false,
          timeoutMs: 250,
          sessionName: "wolf-1",
        },
      }]);
      expect(mockBackend.lastSendArgs).toBeNull();
    } finally {
      mockBackend.list = originalList;
      delete (atomicBackend as { promptAndWaitForOutput?: unknown }).promptAndWaitForOutput;
    }
  });

  test("prompt accepts schema maxima through the real body parser", async () => {
    const session = "s".repeat(SESSION_PROMPT_SELECTOR_MAX_CHARS);
    const escapedPrompt = "\\u0000".repeat(MAX_INITIAL_PROMPT_LENGTH);
    const escapedOutput = "\\ud83d\\ude80".repeat(SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS);
    mockBackend.setSessions([session]);
    const rawBody = [
      `{"session":${JSON.stringify(session)},`,
      `"prompt":"${escapedPrompt}",`,
      `"outputContains":"${escapedOutput}",`,
      '"noEnter":false,"timeoutMs":600000}',
    ].join("");
    const encodedBytes = Buffer.byteLength(rawBody);
    expect(encodedBytes).toBeGreaterThan(64 * 1024);
    expect(encodedBytes).toBeLessThanOrEqual(SESSION_PROMPT_MAX_REQUEST_BODY_BYTES);
    const atomicBackend = mockBackend as unknown as {
      promptAndWaitForOutput: (sessionId: string, options: {
        prompt: string;
        outputContains: string;
      }) => Promise<unknown>;
    };
    atomicBackend.promptAndWaitForOutput = async (_sessionId, options) => {
      expect(Array.from(options.prompt)).toHaveLength(MAX_INITIAL_PROMPT_LENGTH);
      expect(Array.from(options.outputContains)).toHaveLength(SESSION_PROMPT_OUTPUT_BUFFER_MAX_CHARS);
      return { outcome: "matched", outputBoundarySeq: "42" };
    };

    try {
      const res = await fetch(`${base}/api/session-control/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawBody,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        outcome: "matched",
        outputBoundarySeq: "42",
      });
    } finally {
      delete (atomicBackend as { promptAndWaitForOutput?: unknown }).promptAndWaitForOutput;
    }
  });

  test("prompt returns JSON when the route body cap is exceeded", async () => {
    const res = await post("/api/session-control/prompt", {
      session: "wolf-1",
      prompt: "x".repeat(SESSION_PROMPT_MAX_REQUEST_BODY_BYTES),
      outputContains: "READY",
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "request body too large" });
  });

  test("prompt returns stable non-match outcomes without HTTP error prose", async () => {
    const atomicBackend = mockBackend as unknown as {
      promptAndWaitForOutput: () => Promise<unknown>;
    };
    atomicBackend.promptAndWaitForOutput = async () => ({
      outcome: "target_exited",
      outputBoundarySeq: "9",
    });
    try {
      const res = await post("/api/session-control/prompt", {
        session: "mock:wolf-1",
        prompt: "run",
        outputContains: "READY",
        timeoutMs: 100,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: false,
        session: "wolf-1",
        sessionId: "mock:wolf-1",
        outcome: "target_exited",
        outputBoundarySeq: "9",
      });
    } finally {
      delete (atomicBackend as { promptAndWaitForOutput?: unknown }).promptAndWaitForOutput;
    }
  });
});

describe("GET /api/next-session-name", () => {
  beforeEach(() => {
    mockBackend.setSessions(["wolf-1", "wolf-2"]);
  });

  test("derives a safe name from an explicitly selected directory", async () => {
    mockBackend.setSessions([]);
    const projectDir = createExplicitProjectDir("path with spaces");
    const res = await get(`/api/next-session-name?projectDir=${encodeURIComponent(projectDir)}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "path_with_spaces" });
  });

  test("returns bounded unavailable diagnostics through explicit project route mappings", async () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-explicit-api-unavailable-"));
    const loop = join(root, "loop");
    symlinkSync("loop", loop);
    externalTempRoots.push(root);

    const projectDir = join(loop, "project");
    const expectedError = { error: "project directory unavailable" };
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly request: () => Promise<Response>;
      readonly expectedBody: Readonly<Record<string, string>>;
    }> = [
      {
        name: "next-session-name",
        request: () => get(`/api/next-session-name?projectDir=${encodeURIComponent(projectDir)}`),
        expectedBody: expectedError,
      },
      {
        name: "create",
        request: () => post("/api/create", { projectDir }),
        expectedBody: expectedError,
      },
      {
        name: "session-create",
        request: () => post("/api/session-create", { projectDir, harness: "pi" }),
        expectedBody: { ...expectedError, code: SESSION_CREATE_ERROR.BACKEND_UNAVAILABLE },
      },
      {
        name: "session-open",
        request: () => post("/api/session-open", { projectDir, parentSession: "wolf-1" }),
        expectedBody: { ...expectedError, code: SESSION_OPEN_ERROR.BACKEND_UNAVAILABLE },
      },
    ];

    mockBackend.lastCreateArgs = null;
    for (const routeCase of cases) {
      const res = await routeCase.request();
      expect(res.status, routeCase.name).toBe(503);
      expect(await res.json(), routeCase.name).toEqual(routeCase.expectedBody);
    }
    expect(mockBackend.lastCreateArgs).toBeNull();
  });

  test("rejects relative and ambiguous explicit directory selections", async () => {
    const projectDir = createExplicitProjectDir("name ambiguous");
    for (const query of [
      "projectDir=relative%2Fproject",
      `project=my-app&projectDir=${encodeURIComponent(projectDir)}`,
    ]) {
      const res = await get(`/api/next-session-name?${query}`);
      expect(res.status).toBe(400);
    }
  });

  test("allocates a future new-project name without requiring its directory to exist", async () => {
    const newProject = "future-next-name";
    expect(existsSync(join(TEST_DEV_DIR, newProject))).toBe(false);

    const res = await get(`/api/next-session-name?newProject=${encodeURIComponent(newProject)}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: newProject });
  });

  test("rejects invalid or mixed future new-project selectors", async () => {
    const projectDir = createExplicitProjectDir("future-name-mixed");
    for (const query of [
      `newProject=${encodeURIComponent("../etc")}`,
      "project=my-app&newProject=future-next-name",
      `projectDir=${encodeURIComponent(projectDir)}&newProject=future-next-name`,
    ]) {
      const res = await get(`/api/next-session-name?${query}`);
      expect(res.status).toBe(400);
    }
  });

  test("returns project name when not taken", async () => {
    const res = await fetch(`${base}/api/next-session-name?project=my-app`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("my-app");
  });

  test("returns suffixed name when taken", async () => {
    const res = await fetch(`${base}/api/next-session-name?project=wolf-1`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("wolf-1-2");
  });

  test("rejects invalid project name", async () => {
    const res = await fetch(`${base}/api/next-session-name?project=../etc`);
    expect(res.status).toBe(400);
  });

  test("rejects missing project param", async () => {
    const res = await fetch(`${base}/api/next-session-name`);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/kill", () => {
  beforeEach(() => {
    mockBackend.setSessions(["wolf-1", "wolf-2"]);
  });

  test("kills valid session", async () => {
    const res = await post("/api/kill", { session: "wolf-1" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    // Verify session was actually removed from backend
    const sessions = await get("/api/sessions");
    const list = await sessions.json();
    expect(list.sessions.map((s: any) => s.name)).not.toContain("wolf-1");
  });

  test("rejects unknown session", async () => {
    const res = await post("/api/kill", { session: "ghost" });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("session not found");
  });

  test("rejects missing session", async () => {
    const res = await post("/api/kill", {});
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("missing session");
  });
});

// ─── /api/settings ───────────────────────────────────────────────────────────
//
// These tests use the suite-owned settings file under TEST_DEV_DIR.
// To keep them isolated and idempotent, every test starts by issuing the
// requests it needs and asserting on the deltas in the response (don't read
// the file directly). beforeEach restores the 4 baseline cmds via a sequence
// of remove → add ops so the order is predictable.
async function resetSettingsToDefaults() {
  // Remove every non-default entry, re-add+enable the four defaults.
  const cur = await (await get("/api/settings")).json();
  const knownDefaults = new Set(["shell", "claude", "pi", "codex"]);
  for (const c of cur.settings.cmds as Array<{ cmd: string }>) {
    if (!knownDefaults.has(c.cmd)) {
      await post("/api/settings", { removeCmd: c.cmd });
    }
  }
  // addCmd is idempotent (no-op when present) so this safely re-adds any
  // default a prior test deleted, then setCmdEnabled flips them back on.
  for (const cmd of ["shell", "claude", "pi", "codex"]) {
    await post("/api/settings", { addCmd: cmd });
    await post("/api/settings", { setCmdEnabled: { cmd, enabled: true } });
  }
  await post("/api/settings", { agentCmd: "shell" });
  await post("/api/settings", {
    quietAlerts: { mode: "quiet-after-activity", quietAfterSeconds: 30 },
  });
}

describe("GET /api/providers", () => {
  test("reports allowlisted provider readiness without probing user commands", async () => {
    const providerBin = join(TEST_DEV_DIR, "provider-bin");
    mkdirSync(providerBin, { recursive: true });
    const codexBin = join(providerBin, "codex");
    writeFileSync(codexBin, "#!/bin/sh\nprintf 'codex-cli 7.6.5\\n'\n");
    chmodSync(codexBin, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = providerBin;
    try {
      const res = await get("/api/providers");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.providers).toHaveLength(5);
      expect(data.providers.find((provider: { id: string }) => provider.id === "codex")).toEqual({
        id: "codex",
        displayName: "Codex",
        command: "codex",
        status: "installed",
        executablePath: codexBin,
        version: "codex-cli 7.6.5",
        authStatus: "unknown",
        loginCommand: "codex login",
      });
      expect(data.providers.find((provider: { id: string }) => provider.id === "claude")).toMatchObject({
        status: "missing",
        installGuidance: "npm install -g @anthropic-ai/claude-code",
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});

describe("GET /api/settings", () => {
  beforeEach(async () => { await resetSettingsToDefaults(); });

  test("returns settings + effective values", async () => {
    const res = await get("/api/settings");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.settings.cmds)).toBe(true);
    // The 4 baseline defaults must be present after reset.
    const cmdNames = data.settings.cmds.map((c: { cmd: string }) => c.cmd);
    expect(cmdNames).toEqual(expect.arrayContaining(["shell", "claude", "pi", "codex"]));
    expect(data.effective.cmds).toEqual(expect.arrayContaining(["shell", "claude", "pi", "codex"]));
    expect(data.effective.agentCmd).toBe("shell");
  });

  test("does NOT include the legacy `presets` key", async () => {
    const data = await (await get("/api/settings")).json();
    expect(data.presets).toBeUndefined();
  });

});

describe("POST /api/settings — quiet alerts", () => {
  beforeEach(async () => { await resetSettingsToDefaults(); });

  test("persists the host-wide mode and duration", async () => {
    const res = await post("/api/settings", {
      quietAlerts: { mode: "disabled", quietAfterSeconds: 45 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).settings.quietAlerts).toEqual({ mode: "disabled", quietAfterSeconds: 45 });
  });

  test("rejects fractional, out-of-range, and malformed policies without mutating settings", async () => {
    const before = await (await get("/api/settings")).json();
    for (const quietAlerts of [
      { mode: "quiet-after-activity", quietAfterSeconds: 4 },
      { mode: "quiet-after-activity", quietAfterSeconds: 30.5 },
      { mode: "quiet-after-activity", quietAfterSeconds: 3_601 },
      { mode: "unknown", quietAfterSeconds: 30 },
      { mode: "disabled" },
    ]) {
      expect((await post("/api/settings", { quietAlerts })).status).toBe(400);
    }
    expect(await (await get("/api/settings")).json()).toEqual(before);
  });
});

describe("POST /api/settings — addCmd", () => {
  beforeEach(async () => { await resetSettingsToDefaults(); });

  test("adds a new cmd as enabled", async () => {
    const res = await post("/api/settings", { addCmd: "my-cool-tool" });
    expect(res.status).toBe(200);
    const data = await res.json();
    const entry = data.settings.cmds.find((c: { cmd: string }) => c.cmd === "my-cool-tool");
    expect(entry).toBeDefined();
    expect(entry.enabled).toBe(true);
    expect(data.effective.cmds).toContain("my-cool-tool");
    await post("/api/settings", { removeCmd: "my-cool-tool" });
  });

  test("adding a duplicate is a no-op (does not reset enabled state)", async () => {
    await post("/api/settings", { setCmdEnabled: { cmd: "claude", enabled: false } });
    const res = await post("/api/settings", { addCmd: "claude" });
    const claude = (await res.json()).settings.cmds.find((c: { cmd: string }) => c.cmd === "claude");
    expect(claude.enabled).toBe(false);
  });

  test("rejects malformed cmd with 400", async () => {
    const res = await post("/api/settings", { addCmd: "rm -rf /; echo pwn" });
    expect(res.status).toBe(400);
  });

  test("rejects non-string commands without changing settings", async () => {
    const before = await (await get("/api/settings")).json();
    const res = await post("/api/settings", { addCmd: 42 });
    expect(res.status).toBe(400);
    const after = await (await get("/api/settings")).json();
    expect(after).toEqual(before);
  });
});

describe("POST /api/settings — removeCmd", () => {
  beforeEach(async () => { await resetSettingsToDefaults(); });

  test("removes the entry from cmds", async () => {
    await post("/api/settings", { addCmd: "throwaway" });
    const res = await post("/api/settings", { removeCmd: "throwaway" });
    expect(res.status).toBe(200);
    const cmdNames = (await res.json()).settings.cmds.map((c: { cmd: string }) => c.cmd);
    expect(cmdNames).not.toContain("throwaway");
  });

  test("allows removing shell", async () => {
    const res = await post("/api/settings", { removeCmd: "shell" });
    expect(res.status).toBe(200);
    expect((await res.json()).settings.cmds).not.toContainEqual({ cmd: "shell", enabled: true });
  });

  test("removing the current agentCmd falls through to first enabled", async () => {
    await post("/api/settings", { agentCmd: "claude" });
    const res = await post("/api/settings", { removeCmd: "claude" });
    const data = await res.json();
    // settings.agentCmd was cleared; effective should resolve to first enabled.
    expect(["shell", "pi", "codex"]).toContain(data.effective.agentCmd);
  });
});

describe("POST /api/settings — setCmdEnabled", () => {
  beforeEach(async () => { await resetSettingsToDefaults(); });

  test("toggles enabled state without removing", async () => {
    const res = await post("/api/settings", { setCmdEnabled: { cmd: "claude", enabled: false } });
    expect(res.status).toBe(200);
    const data = await res.json();
    const claude = data.settings.cmds.find((c: { cmd: string }) => c.cmd === "claude");
    expect(claude.enabled).toBe(false);
    expect(data.effective.cmds).not.toContain("claude");
  });

  test("allows disabling shell", async () => {
    const res = await post("/api/settings", { setCmdEnabled: { cmd: "shell", enabled: false } });
    expect(res.status).toBe(200);
    expect((await res.json()).settings.cmds).toContainEqual({ cmd: "shell", enabled: false });
  });

  test("disabling all cmds → effective.cmds is [\"shell\"] fallback", async () => {
    for (const cmd of ["shell", "claude", "pi", "codex"]) {
      await post("/api/settings", { setCmdEnabled: { cmd, enabled: false } });
    }
    const data = await (await get("/api/settings")).json();
    expect(data.effective.cmds).toEqual(["shell"]);
    expect(data.effective.agentCmd).toBe("shell");
  });

  test("rejects malformed payload with 400", async () => {
    const res = await post("/api/settings", { setCmdEnabled: { cmd: "claude" } });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/settings — agentCmd", () => {
  beforeEach(async () => { await resetSettingsToDefaults(); });

  test("changes the default agent", async () => {
    const res = await post("/api/settings", { agentCmd: "pi" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.settings.agentCmd).toBe("pi");
    expect(data.effective.agentCmd).toBe("pi");
  });

  test("setting a disabled cmd as agent still records it; effective falls through", async () => {
    // The endpoint is permissive about agentCmd — it can point at any valid
    // cmd string. Effective resolution decides what actually runs.
    await post("/api/settings", { setCmdEnabled: { cmd: "pi", enabled: false } });
    const res = await post("/api/settings", { agentCmd: "pi" });
    const data = await res.json();
    expect(data.settings.agentCmd).toBe("pi");
    expect(data.effective.agentCmd).not.toBe("pi");
  });

  test("rejects malformed agentCmd with 400", async () => {
    const res = await post("/api/settings", { agentCmd: "rm -rf /; echo pwn" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/backend", () => {
  test("returns broker availability and session counts", async () => {
    const res = await get("/api/backend");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.brokerAvailable).toBe("boolean");
    expect(typeof data.counts).toBe("object");
    expect(typeof data.counts.broker).toBe("number");
  });
});

describe("POST /api/resize", () => {
  beforeEach(() => {
    mockBackend.setSessions(["wolf-1", "wolf-2"]);
  });

  test("resizes with valid params", async () => {
    const res = await post("/api/resize", {
      session: "wolf-1",
      cols: 120,
      rows: 40,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test("clamps cols to minimum 20", async () => {
    mockBackend.lastResizeArgs = null;
    const res = await post("/api/resize", {
      session: "wolf-1",
      cols: 5,
      rows: 40,
    });
    expect(res.status).toBe(200);
    expect(mockBackend.lastResizeArgs!.cols).toBe(20);
    expect(mockBackend.lastResizeArgs!.rows).toBe(40);
  });

  test("clamps cols to maximum 300", async () => {
    mockBackend.lastResizeArgs = null;
    const res = await post("/api/resize", {
      session: "wolf-1",
      cols: 999,
      rows: 40,
    });
    expect(res.status).toBe(200);
    expect(mockBackend.lastResizeArgs!.cols).toBe(300);
    expect(mockBackend.lastResizeArgs!.rows).toBe(40);
  });

  test("clamps rows to minimum 5", async () => {
    mockBackend.lastResizeArgs = null;
    const res = await post("/api/resize", {
      session: "wolf-1",
      cols: 80,
      rows: 1,
    });
    expect(res.status).toBe(200);
    expect(mockBackend.lastResizeArgs!.cols).toBe(80);
    expect(mockBackend.lastResizeArgs!.rows).toBe(5);
  });

  test("clamps rows to maximum 100", async () => {
    mockBackend.lastResizeArgs = null;
    const res = await post("/api/resize", {
      session: "wolf-1",
      cols: 80,
      rows: 999,
    });
    expect(res.status).toBe(200);
    expect(mockBackend.lastResizeArgs!.cols).toBe(80);
    expect(mockBackend.lastResizeArgs!.rows).toBe(100);
  });

  test("rejects missing params", async () => {
    const res = await post("/api/resize", { session: "wolf-1" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("missing params");
  });

  test("returns 503 when backend resize fails", async () => {
    const originalResize = mockBackend.resize.bind(mockBackend);
    mockBackend.resize = async () => { throw new Error("resize transport down"); };
    try {
      const res = await post("/api/resize", {
        session: "wolf-1",
        cols: 80,
        rows: 40,
      });
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toBe("backend unavailable");
    } finally {
      mockBackend.resize = originalResize;
    }
  });

  test("rejects unknown session", async () => {
    const res = await post("/api/resize", {
      session: "ghost",
      cols: 80,
      rows: 40,
    });
    expect(res.status).toBe(404);
  });

  test("boundary: cols=20, rows=5 (minimum)", async () => {
    const res = await post("/api/resize", {
      session: "wolf-1",
      cols: 20,
      rows: 5,
    });
    expect(res.status).toBe(200);
  });

  test("boundary: cols=300, rows=100 (maximum)", async () => {
    const res = await post("/api/resize", {
      session: "wolf-1",
      cols: 300,
      rows: 100,
    });
    expect(res.status).toBe(200);
  });
});

describe("JSON body shape validation", () => {
  test("all JSON-body routes reject non-object values", async () => {
    const paths = [
      "/api/create",
      "/api/session-open",
      "/api/settings",
      "/api/kill",
      "/api/session-control/send",
      "/api/session-control/prompt",
      "/api/session-control/wait",
      "/api/resize",
      "/api/push/subscribe",
      "/api/push/unsubscribe",
      "/api/notify",
    ];
    for (const path of paths) {
      const res = await post(path, []);
      expect(res.status, path).toBe(400);
    }
  });
});

describe("bad JSON body", () => {
  test("returns 400 for unparseable JSON", async () => {
    const res = await fetch(`${base}/api/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "this is not json{{{",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid JSON body");
  });

  test("returns 400 for empty body on POST route", async () => {
    const res = await fetch(`${base}/api/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid JSON body");
  });

  test("returns 400 for truncated JSON", async () => {
    const res = await fetch(`${base}/api/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"session": "wolf-1",',
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid JSON body");
  });
});

describe("body > 64KB", () => {
  test("rejects oversized body", async () => {
    const huge = JSON.stringify({ data: "x".repeat(70 * 1024) });
    try {
      const res = await fetch(`${base}/api/kill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: huge,
      });
      // Either connection reset or 400 — both acceptable
      if (res.ok) {
        expect(res.status).not.toBe(200);
      }
    } catch {
      // Connection reset by server is expected — req.destroy() kills the socket
      expect(true).toBe(true);
    }
  });

  test("accepts body just under 64KB", async () => {
    // 63KB of padding + minimal valid JSON structure
    const padding = "a".repeat(60 * 1024);
    const body = JSON.stringify({ session: "wolf-1", text: padding });
    const res = await fetch(`${base}/api/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    // Should be accepted (body parsed OK) — may be 200 or 404 depending on session
    expect(res.status).toBeLessThan(500);
  });
});

describe("CORS", () => {
  let tailnetServer: TailnetOriginServerFixture;

  test("accepts only an exact structured ready envelope with a valid integer port", () => {
    expect(getTailnetReadyPort({ type: TAILNET_ORIGIN_IPC_MESSAGE_TYPE.READY, port: 1 })).toBe(1);
    expect(getTailnetReadyPort({ type: TAILNET_ORIGIN_IPC_MESSAGE_TYPE.READY, port: 65535 })).toBe(65535);

    for (const message of [
      "xREADY:70000\n",
      { type: "READY", port: 3000 },
      { type: TAILNET_ORIGIN_IPC_MESSAGE_TYPE.READY, port: "3000" },
      { type: TAILNET_ORIGIN_IPC_MESSAGE_TYPE.READY, port: 0 },
      { type: TAILNET_ORIGIN_IPC_MESSAGE_TYPE.READY, port: 65536 },
      { type: TAILNET_ORIGIN_IPC_MESSAGE_TYPE.READY, port: 3000.5 },
      { type: TAILNET_ORIGIN_IPC_MESSAGE_TYPE.READY, port: NaN },
      { port: 3000 },
      { type: TAILNET_ORIGIN_IPC_MESSAGE_TYPE.READY },
    ]) {
      expect(getTailnetReadyPort(message), JSON.stringify(message)).toBeUndefined();
    }
  });

  beforeAll(async () => {
    tailnetServer = await createTailnetOriginServerFixture();
  });

  afterAll(async () => {
    await tailnetServer.stop();
  });

  test("allowed origin gets CORS headers", async () => {
    const res = await get("/api/info", { Origin: base });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(base);
    expect(res.headers.get("vary")).toBe("Origin");
  });

  test("configured sibling Tailnet origin reaches the route with a reflected allow-origin", async () => {
    const res = await fetch(`${tailnetServer.base}/api/info`, { headers: { Origin: TAILNET_SIBLING_ORIGIN } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: expect.any(String), version: pkg.version });
    expect(res.headers.get("access-control-allow-origin")).toBe(TAILNET_SIBLING_ORIGIN);
  });

  test("foreign and lookalike origins get 403", async () => {
    for (const origin of TAILNET_REJECTED_ORIGINS) {
      const res = await fetch(`${tailnetServer.base}/api/info`, { headers: { Origin: origin } });
      expect(res.status, origin).toBe(403);
      expect((await res.json()).error, origin).toBe("origin not allowed");
    }
  });

  test("no origin header → no CORS headers, request proceeds", async () => {
    const res = await get("/api/info");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toBe("Origin, Referer, Tailscale-User-Login");
  });

  test("recovers a stripped Origin only for a local Tailscale Serve request", async () => {
    for (const method of ["GET", "OPTIONS"] as const) {
      const res = await fetch(`${tailnetServer.base}/api/info`, {
        method,
        headers: {
          Referer: `${TAILNET_SIBLING_ORIGIN}/control-room`,
          "Tailscale-User-Login": "user@example.com",
        },
      });
      expect(res.status).toBe(method === "OPTIONS" ? 204 : 200);
      expect(res.headers.get("access-control-allow-origin")).toBe(TAILNET_SIBLING_ORIGIN);
      expect(res.headers.get("vary")).toBe("Origin, Referer, Tailscale-User-Login");
    }
  });

  test("an explicit disallowed Origin remains authoritative over valid Serve recovery headers", async () => {
    const res = await fetch(`${tailnetServer.base}/api/info`, {
      headers: {
        Origin: "https://evil.example",
        Referer: `${TAILNET_SIBLING_ORIGIN}/control-room`,
        "Tailscale-User-Login": "user@example.com",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("generic forwarding headers cannot recover a stripped Origin", async () => {
    const res = await fetch(`${tailnetServer.base}/api/info`, {
      headers: {
        Referer: `${TAILNET_SIBLING_ORIGIN}/control-room`,
        Forwarded: "for=203.0.113.1;proto=https;host=phone.tailnet.ts.net",
        "X-Forwarded-For": "203.0.113.1",
        "X-Forwarded-Host": "phone.tailnet.ts.net",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("OPTIONS preflight with allowed origin → 204", async () => {
    const res = await fetch(`${base}/api/info`, {
      method: "OPTIONS",
      headers: { Origin: base },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(base);
    expect(res.headers.get("access-control-allow-methods")).toBe(
      "GET, POST, OPTIONS",
    );
  });

  test("OPTIONS preflight from a configured sibling Tailnet origin → 204 with reflected allow-origin", async () => {
    const res = await fetch(`${tailnetServer.base}/api/info`, {
      method: "OPTIONS",
      headers: { Origin: TAILNET_SIBLING_ORIGIN },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(TAILNET_SIBLING_ORIGIN);
  });

  test("OPTIONS preflight with rejected origin → 403", async () => {
    const res = await fetch(`${base}/api/info`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.com" },
    });
    expect(res.status).toBe(403);
  });
});

describe("unknown routes", () => {
  test("GET unknown path → 404", async () => {
    const res = await get("/api/nonexistent");
    expect(res.status).toBe(404);
  });

  test("POST to GET-only route → 404", async () => {
    const res = await post("/api/info", {});
    expect(res.status).toBe(404);
  });
});

// ── Push notification endpoint tests ──

describe("GET /api/push/vapid-key", () => {
  test("returns publicKey", async () => {
    const res = await get("/api/push/vapid-key");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.publicKey).toBeString();
    expect(data.publicKey.length).toBeGreaterThan(40);
  });
});

describe("POST /api/push/subscribe", () => {
  // Generate a valid test subscription with proper key lengths
  const { createECDH, randomBytes } = require("node:crypto");
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const p256dh = ecdh.getPublicKey("base64url");
  const auth = randomBytes(16).toString("base64url");

  const validSub = {
    endpoint: "https://fcm.googleapis.com/fcm/send/test-integration",
    keys: { p256dh, auth },
  };

  test("valid subscription → 200", async () => {
    const res = await post("/api/push/subscribe", validSub);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    // cleanup
    await post("/api/push/unsubscribe", { endpoint: validSub.endpoint });
  });

  test("missing endpoint → 400", async () => {
    const res = await post("/api/push/subscribe", { keys: { p256dh, auth } });
    expect(res.status).toBe(400);
  });

  test("missing keys → 400", async () => {
    const res = await post("/api/push/subscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/test-integration" });
    expect(res.status).toBe(400);
  });

  test("invalid endpoint URL → 400", async () => {
    const res = await post("/api/push/subscribe", { endpoint: "not-a-url", keys: { p256dh, auth } });
    expect(res.status).toBe(400);
  });

  test("bad p256dh length → 400", async () => {
    const res = await post("/api/push/subscribe", {
      endpoint: "https://fcm.googleapis.com/fcm/send/test-integration",
      keys: { p256dh: randomBytes(32).toString("base64url"), auth },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("65 bytes");
  });

  test("bad auth length → 400", async () => {
    const res = await post("/api/push/subscribe", {
      endpoint: "https://fcm.googleapis.com/fcm/send/test-integration",
      keys: { p256dh, auth: randomBytes(8).toString("base64url") },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("16 bytes");
  });

  test("http:// endpoint rejected (SSRF prevention) → 400", async () => {
    const res = await post("/api/push/subscribe", {
      endpoint: "http://localhost:8080/internal",
      keys: { p256dh, auth },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("HTTPS");
  });

  test("file:// endpoint rejected → 400", async () => {
    const res = await post("/api/push/subscribe", {
      endpoint: "file:///etc/passwd",
      keys: { p256dh, auth },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("HTTPS");
  });
});

describe("POST /api/push/unsubscribe", () => {
  test("valid unsubscribe → 200", async () => {
    const res = await post("/api/push/unsubscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/test-integration/gone" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test("missing endpoint → 400", async () => {
    const res = await post("/api/push/unsubscribe", {});
    expect(res.status).toBe(400);
  });
});

describe("POST /api/notify", () => {
  test("valid notification → 200", async () => {
    const res = await post("/api/notify", { message: "test notification" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test("accepts a bounded stable session target", async () => {
    const res = await post("/api/notify", {
      message: "parent review needed",
      sessionId: "stable-parent-id",
      sessionName: "parent-agent",
    });
    expect(res.status).toBe(200);
  });

  test("rejects partial and oversized session targets", async () => {
    const partial = await post("/api/notify", {
      message: "parent review needed",
      sessionId: "stable-parent-id",
    });
    expect(partial.status).toBe(400);

    const oversized = await post("/api/notify", {
      message: "parent review needed",
      sessionId: "x".repeat(257),
      sessionName: "parent-agent",
    });
    expect(oversized.status).toBe(400);
  });

  test("missing message → 400", async () => {
    const res = await post("/api/notify", {});
    expect(res.status).toBe(400);
  });

  test("rate limit after 10 rapid calls → 429", async () => {
    // beforeEach resets notifyTimestamps, so this test is self-contained.
    // 10/min limit → calls 11 and 12 should return 429.
    const results: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await post("/api/notify", { message: `rate-test-${i}` });
      results.push(res.status);
    }
    expect(results).toContain(429);
  });
});
