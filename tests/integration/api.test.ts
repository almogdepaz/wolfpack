import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";
import pkg from "../../package.json";

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
// Isolate the settings file so the /api/settings tests don't mutate the
// developer's real ~/.wolfpack/bridge-settings.json. The path is read at
// every loadSettings/saveSettings call so this works as long as it's set
// before the first request.
const TEST_SETTINGS_PATH = join(TEST_DEV_DIR, "bridge-settings.json");
process.env.WOLFPACK_SETTINGS_PATH = TEST_SETTINGS_PATH;

const { __resetJwtAuthConfig, __setDevDir } = await import("../../src/test-hooks.ts");
const { __setTestBackend } = await import("../../src/server/backend.ts");
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
const { _testing: pushTesting } = await import("../../src/server/push.ts");
const { activePtySessions } = await import("../../src/server/websocket.ts");

const { server } = createServerInstance();

let base = "";

// Test project names used by /api/create tests
const TEST_PROJECTS = ["my-app", "wolf-1", "fresh-app"];

// Track dirs we actually created so we only clean up what we own
const createdDirs: string[] = [];

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

  test("classifies running when content changes", async () => {
    mockBackend.setCapturePane(async () => "compiling...\n");
    const res = await get("/api/sessions");
    const data = await res.json();
    // First call — no previous content, so content differs → running
    expect(data.sessions[0].triage).toBe("running");
  });

  test("classifies idle when content stable with prompt", async () => {
    mockBackend.setCapturePane(async () => "Do you want to continue? (y/n)\n");
    // First call seeds the content
    await get("/api/sessions");
    // Second call — same content → idle
    const res = await get("/api/sessions");
    const data = await res.json();
    expect(data.sessions[0].triage).toBe("idle");
  });

  test("classifies idle when content stable without prompt", async () => {
    mockBackend.setCapturePane(async () => "$ \n");
    // First call seeds the content
    await get("/api/sessions");
    // Second call — same content, bare prompt is junk, no input prompt → idle
    const res = await get("/api/sessions");
    const data = await res.json();
    expect(data.sessions[0].triage).toBe("idle");
  });

  test("lastLine skips junk lines", async () => {
    mockBackend.setCapturePane(async () => "real output here\n─────────────\n$ \n\n");
    await get("/api/sessions");
    const res = await get("/api/sessions");
    const data = await res.json();
    expect(data.sessions[0].lastLine).toBe("real output here");
  });

  test("sorts sessions by triage priority", async () => {
    mockBackend.setSessions(["idle-sess", "running-sess", "input-sess"]);
    // Seed content on first call
    mockBackend.setCapturePane(async (s: string) => {
      if (s === "input-sess") return "Continue? (y/n)\n";
      if (s === "running-sess") return "compiling step 1...\n";
      return "done\n";
    });
    await get("/api/sessions");
    // Second call — input-sess and idle-sess unchanged, running-sess changes
    mockBackend.setCapturePane(async (s: string) => {
      if (s === "input-sess") return "Continue? (y/n)\n";
      if (s === "running-sess") return "compiling step 2...\n";
      return "done\n";
    });
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
});

describe("GET /api/ralph status authority", () => {
  test("returns source authority diagnostics for malformed manifest without blocking response", async () => {
    const project = "status-authority-malformed";
    const dir = join(TEST_DEV_DIR, project);
    mkdirSync(join(dir, ".wolfpack"), { recursive: true });
    createdDirs.push(dir);
    writeFileSync(join(dir, "PLAN.md"), "- [ ] task\n");
    writeFileSync(join(dir, ".wolfpack", "agent-status.json"), "{ nope");
    writeFileSync(join(dir, ".ralph.log"), [
      "🥋 ralph — 5 iterations",
      "agent: codex",
      "plan: PLAN.md",
      "progress: progress.txt",
      "pid: 999999",
      "started: Sat Jul 11 2026 12:00:00",
      "",
    ].join("\n"));

    const res = await get("/api/ralph");
    expect(res.status).toBe(200);
    const data = await res.json();
    const loop = data.loops.find((entry: any) => entry.project === project);
    expect(loop).toBeTruthy();
    expect(loop.statusSource).toMatchObject({
      state: "idle",
      authority: "fallback",
      freshness: "fresh",
    });
    expect(loop.statusSources).toContainEqual(expect.objectContaining({
      authority: "manifest",
      freshness: "malformed",
      source: "local-manifest",
    }));
  });

  test("returns structured manifest status when fresh", async () => {
    const project = "status-authority-manifest";
    const dir = join(TEST_DEV_DIR, project);
    mkdirSync(join(dir, ".wolfpack"), { recursive: true });
    createdDirs.push(dir);
    writeFileSync(join(dir, "PLAN.md"), "- [ ] task\n");
    writeFileSync(join(dir, ".wolfpack", "agent-status.json"), JSON.stringify({ state: "running", observedAt: "2026-07-11T00:00:00Z" }));
    writeFileSync(join(dir, ".ralph.log"), [
      "🥋 ralph — 5 iterations",
      "agent: codex",
      "plan: PLAN.md",
      "progress: progress.txt",
      "pid: 999999",
      "started: Sat Jul 11 2026 12:00:00",
      "",
    ].join("\n"));

    const res = await get("/api/ralph");
    expect(res.status).toBe(200);
    const data = await res.json();
    const loop = data.loops.find((entry: any) => entry.project === project);
    expect(loop.statusSource).toMatchObject({
      state: "running",
      authority: "manifest",
      freshness: "fresh",
    });
  });
});

describe("POST /api/ralph/start validation ordering", () => {
  test("missing plan does not mutate locks or Git branches", async () => {
    const project = "ralph-missing-plan";
    const projectDir = join(TEST_DEV_DIR, project);
    const lockPath = join(projectDir, ".ralph.lock");
    mkdirSync(projectDir, { recursive: true });
    createdDirs.push(projectDir);
    execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Wolfpack Test"], { cwd: projectDir });
    execFileSync("git", ["config", "user.email", "wolfpack@example.test"], { cwd: projectDir });
    execFileSync("git", ["remote", "add", "origin", join(projectDir, "missing-origin")], { cwd: projectDir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: projectDir, stdio: "pipe" });
    writeFileSync(lockPath, "preexisting-stale-lock");

    const res = await post("/api/ralph/start", {
      project,
      planFile: "MISSING.md",
      newBranch: "fix/missing-plan",
      sourceBranch: "main",
    });

    expect(res.status).toBe(404);
    expect({
      currentBranch: execFileSync("git", ["branch", "--show-current"], {
        cwd: projectDir,
        encoding: "utf-8",
      }).trim(),
      createdBranch: execFileSync("git", ["branch", "--list", "fix/missing-plan"], {
        cwd: projectDir,
        encoding: "utf-8",
      }).trim(),
      lockContent: existsSync(lockPath) ? readFileSync(lockPath, "utf-8") : null,
    }).toEqual({
      currentBranch: "main",
      createdBranch: "",
      lockContent: "preexisting-stale-lock",
    });
  }, 30_000);
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

describe("session control API", () => {
  beforeEach(() => {
    mockBackend.setSessions(["wolf-1", "wolf-2"]);
    mockBackend.setCapturePane(async (s: string) => `captured output for ${s}\n`);
    mockBackend.setOnAfterPrefill(null);
    mockBackend.lastSendArgs = null;
  });

  test("reads current output from backend snapshot", async () => {
    const res = await get("/api/session-control/read?session=wolf-1");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ session: "wolf-1", output: "captured output for wolf-1\n" });
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
    expect(data).toEqual({ ok: true, session: "wolf-1", matched: true });
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
    expect(data).toEqual({ ok: true, session: "wolf-1", matched: true });
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
    expect(data).toEqual({ ok: true, session: "wolf-1", matched: true });
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
});

describe("GET /api/next-session-name", () => {
  beforeEach(() => {
    mockBackend.setSessions(["wolf-1", "wolf-2"]);
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

describe("POST /api/ralph/start agent authorization", () => {
  beforeEach(() => {
    writeFileSync(join(TEST_DEV_DIR, "my-app", "PLAN.md"), "- [ ] authorization test\n");
  });

  const restoreConfiguredAgents = () => writeFileSync(TEST_SETTINGS_PATH, JSON.stringify({
    agentCmd: "shell",
    cmds: [
      { cmd: "shell", enabled: true },
      { cmd: "claude", enabled: true },
      { cmd: "pi", enabled: true },
      { cmd: "codex", enabled: true },
    ],
  }));

  test("rejects synthesized defaults when the settings file is missing", async () => {
    rmSync(TEST_SETTINGS_PATH, { force: true });
    try {
      const res = await post("/api/ralph/start", {
        project: "my-app",
        planFile: "PLAN.md",
        agent: "claude",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "ralph agent is not configured and enabled" });
    } finally {
      restoreConfiguredAgents();
    }
  });

  test("rejects synthesized defaults when persisted commands are empty", async () => {
    writeFileSync(TEST_SETTINGS_PATH, JSON.stringify({ agentCmd: "shell", cmds: [] }));
    try {
      const res = await post("/api/ralph/start", {
        project: "my-app",
        planFile: "PLAN.md",
        agent: "claude",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "ralph agent is not configured and enabled" });
    } finally {
      restoreConfiguredAgents();
    }
  });

  test("rejects a supported agent when it is disabled in settings", async () => {
    writeFileSync(TEST_SETTINGS_PATH, JSON.stringify({
      agentCmd: "codex",
      cmds: [
        { cmd: "claude", enabled: false },
        { cmd: "codex", enabled: true },
      ],
    }));

    try {
      const res = await post("/api/ralph/start", {
        project: "my-app",
        planFile: "PLAN.md",
        agent: "claude",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "ralph agent is not configured and enabled" });
    } finally {
      restoreConfiguredAgents();
    }
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
      "/api/settings",
      "/api/kill",
      "/api/session-control/send",
      "/api/session-control/wait",
      "/api/resize",
      "/api/ralph/start",
      "/api/ralph/cancel",
      "/api/ralph/dismiss",
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
  test("allowed origin gets CORS headers", async () => {
    const res = await get("/api/info", { Origin: base });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(base);
    expect(res.headers.get("vary")).toBe("Origin");
  });

  test("rejected origin gets 403", async () => {
    const res = await get("/api/info", { Origin: "https://evil.com" });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("origin not allowed");
  });

  test("no origin header → no CORS headers, request proceeds", async () => {
    const res = await get("/api/info");
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
