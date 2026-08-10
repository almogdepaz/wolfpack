import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import type { Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";
import pkg from "../../package.json";
import {
  SESSION_OPEN_ERROR,
  SESSION_OPEN_HTTP_STATUS,
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

// ─── Environment setup (must precede imports that read env) ──────────────────
process.env.WOLFPACK_TEST = "1";
delete process.env.WOLFPACK_JWT_SECRET;

// Create a real temp dir for test project directories.
// realpathSync resolves macOS /var → /private/var so isUnderDevDir agrees.
const _rawTmpDir = join(tmpdir(), `wolfpack-api-test-${process.pid}`);
mkdirSync(_rawTmpDir, { recursive: true });
const TEST_DEV_DIR = realpathSync(_rawTmpDir);
process.env.WOLFPACK_DEV_DIR = TEST_DEV_DIR;
process.env.WOLFPACK_SESSION_IDENTITY_PATH = join(process.cwd(), ".wolfpack", `api-session-identities-${process.pid}.json`);
process.env.WOLFPACK_AGENT_RUNTIME_STATE_PATH = join(TEST_DEV_DIR, `api-agent-runtime-state-${process.pid}.json`);
// Isolate the settings file so the /api/settings tests don't mutate the
// developer's real ~/.wolfpack/bridge-settings.json. The path is read at
// every loadSettings/saveSettings call so this works as long as it's set
// before the first request.
const TEST_SETTINGS_PATH = join(TEST_DEV_DIR, "bridge-settings.json");
process.env.WOLFPACK_SETTINGS_PATH = TEST_SETTINGS_PATH;

const { __resetJwtAuthConfig, __setDevDir } = await import("../../src/test-hooks.ts");
const { __setTestBackend, DuplicateSessionError } = await import("../../src/server/backend.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");
__resetJwtAuthConfig();

// Override cached DEV_DIR so routes.ts join(DEV_DIR, ...) uses our temp path.
// Other test files may have imported tmux.ts first with a different env value.
__setDevDir(TEST_DEV_DIR);
process.env.WOLFPACK_DEV_DIR = TEST_DEV_DIR;

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

const {
  __resetSessionObservationForTests,
  __runSessionNotificationObservationForTests,
} = await import("../../src/server/routes.ts");

const { server } = createServerInstance();

let base = "";

// Test project names used by /api/create tests
const TEST_PROJECTS = ["my-app", "wolf-1", "fresh-app"];

// Track dirs we actually created so we only clean up what we own
const createdDirs: string[] = [];

function createExplicitProjectDir(name = "outside project"): string {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-explicit-api-"));
  const projectDir = join(root, name);
  mkdirSync(projectDir);
  createdDirs.push(root);
  return realpathSync(projectDir);
}

function ensureTestProjectDirs(): void {
  mkdirSync(TEST_DEV_DIR, { recursive: true });
  for (const name of TEST_PROJECTS) {
    const dir = join(TEST_DEV_DIR, name);
    mkdirSync(dir, { recursive: true });
    createdDirs.push(dir);
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
  // Clean up only dirs we created (not TEST_DEV_DIR itself)
  for (const dir of createdDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
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
    agentKind: "unknown",
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
      agentKind: "unknown",
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
  });

  test("observes and notifies on the server without a sessions request", async () => {
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

      expect(pushes.map(({ title, body }) => ({ title, body }))).toEqual([
        { title: "Wolfpack: wolf-1", body: "Quiet" },
        { title: "Wolfpack: wolf-2", body: "Quiet" },
      ]);
    } finally {
      pushTesting.sessionPushSender = null;
      removeSubscription(endpoint);
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
      });
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
      harness: "unknown",
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
      harness: "unknown",
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
    const frames = attachNotificationViewer("wolf-1");

    const res = await post("/api/session-open", {
      project: "my-app",
      parentSession: "wolf-1",
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

    for (const harness of ["shell", "unknown"]) {
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
// These tests run with the production-default settings file (no override),
// which means each test mutates real state in ~/.wolfpack/bridge-settings.json.
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
