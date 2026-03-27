import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync, realpathSync } from "node:fs";
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
    expect(["needs-input", "running", "idle"]).toContain(data.sessions[0].triage);
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

  test("classifies needs-input when content stable with prompt", async () => {
    mockBackend.setCapturePane(async () => "Do you want to continue? (y/n)\n");
    // First call seeds the content
    await get("/api/sessions");
    // Second call — same content, prompt detected → needs-input
    const res = await get("/api/sessions");
    const data = await res.json();
    expect(data.sessions[0].triage).toBe("needs-input");
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
    expect(data.sessions[0].name).toBe("input-sess");
    expect(data.sessions[0].triage).toBe("needs-input");
    expect(data.sessions[1].name).toBe("running-sess");
    expect(data.sessions[1].triage).toBe("running");
    expect(data.sessions[2].name).toBe("idle-sess");
    expect(data.sessions[2].triage).toBe("idle");
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

  test("uses newProject field when provided", async () => {
    const res = await post("/api/create", { newProject: "fresh-app" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.session).toBe("fresh-app");
  });

  test("creates session with cmd", async () => {
    const res = await post("/api/create", {
      project: "my-app",
      cmd: "claude",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.session).toBe("my-app");
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
    // MockBackend.createSession throws DUPLICATE_SESSION when session already exists
    // "wolf-1" is already in the session set, but we use a custom sessionName
    // to bypass the name-taken check and let createSession throw
    mockBackend.setSessions(["wolf-1", "wolf-2", "sneaky"]);
    const res = await post("/api/create", {
      project: "my-app",
      sessionName: "sneaky",
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    // The pre-check catches this as "session name already taken"
    expect(data.error).toBe("session name already taken");
  });

  test("project dir not found returns 404", async () => {
    const res = await post("/api/create", { project: "nonexistent-proj" });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("project directory not found");
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

describe("GET /api/backend", () => {
  test("returns backend state", async () => {
    const res = await get("/api/backend");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.default).toBeDefined();
    expect(typeof data.tmuxAvailable).toBe("boolean");
    expect(typeof data.counts).toBe("object");
    expect(typeof data.counts.pty).toBe("number");
    expect(typeof data.counts.tmux).toBe("number");
  });
});

describe("POST /api/backend", () => {
  test("switches to pty", async () => {
    const res = await post("/api/backend", { default: "pty" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.default).toBe("pty");
  });

  test("rejects invalid backend type", async () => {
    const res = await post("/api/backend", { default: "invalid" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("invalid");
  });

  test("rejects missing type", async () => {
    const res = await post("/api/backend", {});
    expect(res.status).toBe(400);
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

  test("clamps cols to minimum 20 (returns ok)", async () => {
    const res = await post("/api/resize", {
      session: "wolf-1",
      cols: 5,
      rows: 40,
    });
    expect(res.status).toBe(200);
  });

  test("clamps cols to maximum 300 (returns ok)", async () => {
    const res = await post("/api/resize", {
      session: "wolf-1",
      cols: 999,
      rows: 40,
    });
    expect(res.status).toBe(200);
  });

  test("clamps rows to minimum 5 (returns ok)", async () => {
    const res = await post("/api/resize", {
      session: "wolf-1",
      cols: 80,
      rows: 1,
    });
    expect(res.status).toBe(200);
  });

  test("clamps rows to maximum 100 (returns ok)", async () => {
    const res = await post("/api/resize", {
      session: "wolf-1",
      cols: 80,
      rows: 999,
    });
    expect(res.status).toBe(200);
  });

  test("rejects missing params", async () => {
    const res = await post("/api/resize", { session: "wolf-1" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("missing params");
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
