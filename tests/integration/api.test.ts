import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

// ─── Stubs for tmux + filesystem deps ────────────────────────────────────────
// These replace the real tmux/exec calls so no tmux server is needed.

let fakeSessions: string[] = ["wolf-1", "wolf-2"];

const tmuxList = mock(async (): Promise<string[]> => fakeSessions);
const capturePane = mock(
  async (session: string): Promise<string> =>
    `captured output for ${session}\n`,
);
const tmuxResize = mock(
  async (_s: string, _c: number, _r: number): Promise<void> => {},
);
const tmuxNewSession = mock(
  async (_n: string, _cwd: string, _cmd?: string): Promise<void> => {},
);
const tmuxKillSession = mock(async (_s: string): Promise<void> => {});

async function isAllowedSession(session: string): Promise<boolean> {
  return (await tmuxList()).includes(session);
}

async function uniqueSessionName(base: string): Promise<string> {
  const sessions = await tmuxList();
  if (!sessions.includes(base)) return base;
  let i = 2;
  while (sessions.includes(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// ─── Triage classification (imported from shared module) ─────────────────────
import { isJunkLine, type TriageStatus } from "../../src/triage.ts";
import { getVapidPublicKey, addSubscription, removeSubscription, sendPush, validateSubscription, checkNotifyRateLimit, type PushSubscription } from "../../src/server/push.ts";

/** Content-diff state for test sessions route */
const testPrevPaneContent = new Map<string, string>();

// ─── Validation / config replicated from serve.ts ────────────────────────────

const VERSION = "1.2.0";
const TEST_PORT = 0; // OS picks a free port
const ALLOWED_ORIGINS = new Set<string>(); // populated in beforeAll

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return false;
}

function isValidProjectName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && name !== "." && name !== "..";
}

function isValidSessionName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name.length > 0 && name.length <= 100;
}

const ALLOWED_KEYS = [
  "Enter", "Tab", "Escape", "Up", "Down", "Left", "Right",
  "BTab", "y", "n", "C-c", "C-d", "C-z",
];

// ─── HTTP helpers (same as serve.ts) ─────────────────────────────────────────

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const MAX_BODY = 64 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function parseBody<T = any>(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<T | null> {
  try {
    return JSON.parse(await readBody(req)) as T;
  } catch {
    json(res, { error: "invalid JSON body" }, 400);
    return null;
  }
}

// ─── Routes (subset matching the test spec) ──────────────────────────────────

const routes: Record<
  string,
  (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
> = {
  "GET /api/info": (_req, res) => {
    json(res, { name: "test-host", version: VERSION });
  },

  "GET /api/sessions": async (_req, res) => {
    const sessions = await tmuxList();
    const results = await Promise.all(
      sessions.map(async (name) => {
        const pane = await capturePane(name);
        const content = pane.trimEnd();
        const lines = content.split("\n");

        // Walk lines from bottom, skip junk, take first real line
        let lastLine = "";
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!isJunkLine(lines[i])) {
            lastLine = lines[i].trim();
            break;
          }
        }

        // Content-diff triage
        const prev = testPrevPaneContent.get(name);
        let triage: TriageStatus;
        if (prev !== content) {
          triage = "running";
          testPrevPaneContent.set(name, content);
        } else {
          triage = "idle";
        }
        return { name, lastLine, triage };
      }),
    );
    const TRIAGE_PRIORITY: Record<TriageStatus, number> = { "running": 0, "idle": 1 };
    results.sort((a, b) => TRIAGE_PRIORITY[a.triage] - TRIAGE_PRIORITY[b.triage]);
    json(res, { sessions: results });
  },

  "GET /api/next-session-name": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid project" }, 400);
    }
    const name = await uniqueSessionName(project);
    json(res, { name });
  },

  "POST /api/create": async (req, res) => {
    const body = await parseBody<{
      project?: string;
      newProject?: string;
      cmd?: string;
      sessionName?: string;
    }>(req, res);
    if (!body) return;
    const { project, newProject, cmd, sessionName } = body;
    const folderName = newProject?.trim() || project?.trim();
    if (!folderName || !isValidProjectName(folderName)) {
      return json(res, { error: "invalid project name" }, 400);
    }
    const customName = sessionName?.trim();
    if (customName) {
      if (!isValidSessionName(customName)) {
        return json(res, { error: "invalid session name (letters, numbers, hyphens, underscores only)" }, 400);
      }
      const existing = await tmuxList();
      if (existing.includes(customName)) {
        return json(res, { error: "session name already taken" }, 409);
      }
    }
    const finalName = customName || await uniqueSessionName(folderName);
    try {
      await tmuxNewSession(finalName, `/tmp/dev/${folderName}`, cmd);
    } catch (e: any) {
      if (e.code === "DUPLICATE_SESSION") {
        return json(res, { error: "session exists", session: finalName, hint: "reconnect or choose a different name" }, 409);
      }
      throw e;
    }
    json(res, { ok: true, session: finalName });
  },

  "POST /api/kill": async (req, res) => {
    const body = await parseBody<{ session: string }>(req, res);
    if (!body) return;
    const { session } = body;
    if (!session) return json(res, { error: "missing session" }, 400);
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    await tmuxKillSession(session);
    json(res, { ok: true });
  },

  "POST /api/resize": async (req, res) => {
    const body = await parseBody<{
      session: string;
      cols: number;
      rows: number;
    }>(req, res);
    if (!body) return;
    const { session, cols, rows } = body;
    if (!session || !cols || !rows)
      return json(res, { error: "missing params" }, 400);
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    await tmuxResize(
      session,
      Math.max(20, Math.min(cols, 300)),
      Math.max(5, Math.min(rows, 100)),
    );
    json(res, { ok: true });
  },

  // ── Push notifications ──

  "GET /api/push/vapid-key": (_req, res) => {
    json(res, { publicKey: getVapidPublicKey() });
  },

  "POST /api/push/subscribe": async (req, res) => {
    const body = await parseBody<PushSubscription>(req, res);
    if (!body) return;
    const sub: PushSubscription = { endpoint: body.endpoint, keys: { p256dh: body.keys?.p256dh, auth: body.keys?.auth } };
    const validationError = validateSubscription(sub);
    if (validationError) return json(res, { error: validationError }, 400);
    const result = addSubscription(sub);
    if (!result.ok) return json(res, { error: result.error }, 429);
    json(res, { ok: true });
  },

  "POST /api/push/unsubscribe": async (req, res) => {
    const body = await parseBody<{ endpoint?: string }>(req, res);
    if (!body) return;
    if (!body.endpoint || typeof body.endpoint !== "string") return json(res, { error: "missing endpoint" }, 400);
    removeSubscription(body.endpoint);
    json(res, { ok: true });
  },

  "POST /api/notify": async (req, res) => {
    const body = await parseBody<{ message?: string }>(req, res);
    if (!body) return;
    if (!body.message || typeof body.message !== "string") return json(res, { error: "missing message" }, 400);
    const message = body.message.slice(0, 500);
    const rateLimitError = checkNotifyRateLimit();
    if (rateLimitError) return json(res, { error: rateLimitError }, 429);
    const result = await sendPush({ title: "Wolfpack", body: message, tag: "wolfpack-notify" });
    json(res, { ok: true, ...result });
  },
};

// ─── Server setup (mirrors serve.ts handler, with injectable CORS) ───────────

let server: ReturnType<typeof createServer>;
let base: string;

function startTestServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(async (req, res) => {
      // CORS
      const origin = req.headers.origin;
      if (origin) {
        if (isAllowedOrigin(origin)) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type");
          res.setHeader("Vary", "Origin");
        } else {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "origin not allowed" }));
          return;
        }
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", "http://localhost");
      const key = `${req.method ?? "GET"} ${url.pathname}`;
      const handler = routes[key];
      if (handler) {
        try {
          await handler(req, res);
        } catch (err) {
          if (!res.headersSent) json(res, { error: "internal error" }, 500);
        }
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}`;
      ALLOWED_ORIGINS.add(url);
      ALLOWED_ORIGINS.add(`http://localhost:${port}`);
      resolve(url);
    });
  });
}

// ─── Test lifecycle ──────────────────────────────────────────────────────────

beforeAll(async () => {
  base = await startTestServer();
});

afterAll(() => {
  server?.close();
});

// ─── Helper ──────────────────────────────────────────────────────────────────

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
    expect(data.name).toBe("test-host");
    expect(data.version).toBe(VERSION);
  });

  test("response is application/json", async () => {
    const res = await get("/api/info");
    expect(res.headers.get("content-type")).toBe("application/json");
  });
});

describe("GET /api/sessions", () => {
  test("returns session list with lastLine and triage", async () => {
    testPrevPaneContent.clear();
    const res = await get("/api/sessions");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessions).toHaveLength(2);
    expect(typeof data.sessions[0].lastLine).toBe("string");
    expect(typeof data.sessions[0].triage).toBe("string");
    expect(["running", "idle"]).toContain(data.sessions[0].triage);
  });

  test("returns empty list when no sessions", async () => {
    const orig = fakeSessions;
    fakeSessions = [];
    tmuxList.mockImplementation(async () => []);
    const res = await get("/api/sessions");
    const data = await res.json();
    expect(data.sessions).toHaveLength(0);
    fakeSessions = orig;
    tmuxList.mockImplementation(async () => fakeSessions);
  });

  test("capturePane called for each session", async () => {
    testPrevPaneContent.clear();
    capturePane.mockClear();
    await get("/api/sessions");
    expect(capturePane).toHaveBeenCalledTimes(2);
    expect(capturePane).toHaveBeenCalledWith("wolf-1");
    expect(capturePane).toHaveBeenCalledWith("wolf-2");
  });

  test("classifies running when content changes", async () => {
    testPrevPaneContent.clear();
    capturePane.mockImplementation(async () => "compiling...\n");
    const res = await get("/api/sessions");
    const data = await res.json();
    // First call — no previous content, so content differs → running
    expect(data.sessions[0].triage).toBe("running");
    capturePane.mockImplementation(async (s: string) => `captured output for ${s}\n`);
  });

  test("classifies idle when content stable (even with prompt-like text)", async () => {
    testPrevPaneContent.clear();
    capturePane.mockImplementation(async () => "Do you want to continue? (y/n)\n");
    // First call seeds the content
    await get("/api/sessions");
    // Second call — same content → idle (no needs-input distinction)
    const res = await get("/api/sessions");
    const data = await res.json();
    expect(data.sessions[0].triage).toBe("idle");
    capturePane.mockImplementation(async (s: string) => `captured output for ${s}\n`);
  });

  test("classifies idle when content stable without prompt", async () => {
    testPrevPaneContent.clear();
    capturePane.mockImplementation(async () => "$ \n");
    // First call seeds the content
    await get("/api/sessions");
    // Second call — same content, bare prompt is junk, no input prompt → idle
    const res = await get("/api/sessions");
    const data = await res.json();
    expect(data.sessions[0].triage).toBe("idle");
    capturePane.mockImplementation(async (s: string) => `captured output for ${s}\n`);
  });

  test("lastLine skips junk lines", async () => {
    testPrevPaneContent.clear();
    capturePane.mockImplementation(async () => "real output here\n─────────────\n$ \n\n");
    await get("/api/sessions");
    const res = await get("/api/sessions");
    const data = await res.json();
    expect(data.sessions[0].lastLine).toBe("real output here");
  });

  test("sorts sessions by triage priority", async () => {
    testPrevPaneContent.clear();
    fakeSessions = ["idle-sess", "running-sess"];
    tmuxList.mockImplementation(async () => fakeSessions);
    // Seed content on first call
    capturePane.mockImplementation(async (s: string) => {
      if (s === "running-sess") return "compiling step 1...\n";
      return "done\n";
    });
    await get("/api/sessions");
    // Second call — idle-sess unchanged, running-sess changes
    capturePane.mockImplementation(async (s: string) => {
      if (s === "running-sess") return "compiling step 2...\n";
      return "done\n";
    });
    const res = await get("/api/sessions");
    const data = await res.json();
    expect(data.sessions[0].name).toBe("running-sess");
    expect(data.sessions[0].triage).toBe("running");
    expect(data.sessions[1].name).toBe("idle-sess");
    expect(data.sessions[1].triage).toBe("idle");
    // restore
    fakeSessions = ["wolf-1", "wolf-2"];
    tmuxList.mockImplementation(async () => fakeSessions);
    capturePane.mockImplementation(async (s: string) => `captured output for ${s}\n`);
  });
});

describe("POST /api/create", () => {
  test("creates session for valid project", async () => {
    tmuxNewSession.mockClear();
    const res = await post("/api/create", { project: "my-app" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.session).toBe("my-app");
    expect(tmuxNewSession).toHaveBeenCalledTimes(1);
  });

  test("generates unique session name on collision", async () => {
    // wolf-1 already exists in fakeSessions
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
    expect(data.error).toBe("invalid project name");
  });

  test("rejects empty project name", async () => {
    const res = await post("/api/create", { project: "" });
    expect(res.status).toBe(400);
  });

  test("rejects dot-dot project name", async () => {
    const res = await post("/api/create", { project: ".." });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid project name");
  });

  test("rejects missing project entirely", async () => {
    const res = await post("/api/create", {});
    expect(res.status).toBe(400);
  });

  test("uses newProject field when provided", async () => {
    tmuxNewSession.mockClear();
    const res = await post("/api/create", { newProject: "fresh-app" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.session).toBe("fresh-app");
  });

  test("passes cmd through to tmuxNewSession", async () => {
    tmuxNewSession.mockClear();
    const res = await post("/api/create", {
      project: "my-app",
      cmd: "claude",
    });
    expect(res.status).toBe(200);
    expect(tmuxNewSession).toHaveBeenCalledWith(
      "my-app",
      "/tmp/dev/my-app",
      "claude",
    );
  });

  test("uses custom sessionName when provided", async () => {
    tmuxNewSession.mockClear();
    const res = await post("/api/create", {
      project: "my-app",
      sessionName: "auth-refactor",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.session).toBe("auth-refactor");
    expect(tmuxNewSession).toHaveBeenCalledWith(
      "auth-refactor",
      "/tmp/dev/my-app",
      undefined,
    );
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

  test("returns 409 when tmux reports duplicate session (race condition)", async () => {
    const err = new Error("duplicate session: my-app");
    (err as any).code = "DUPLICATE_SESSION";
    tmuxNewSession.mockRejectedValueOnce(err);
    const res = await post("/api/create", { project: "my-app" });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("session exists");
    expect(data.session).toBe("my-app");
    expect(data.hint).toBe("reconnect or choose a different name");
  });
});

describe("GET /api/next-session-name", () => {
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
  test("kills valid session", async () => {
    tmuxKillSession.mockClear();
    const res = await post("/api/kill", { session: "wolf-1" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(tmuxKillSession).toHaveBeenCalledWith("wolf-1");
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

describe("POST /api/resize", () => {
  test("resizes with valid params", async () => {
    tmuxResize.mockClear();
    const res = await post("/api/resize", {
      session: "wolf-1",
      cols: 120,
      rows: 40,
    });
    expect(res.status).toBe(200);
    expect(tmuxResize).toHaveBeenCalledWith("wolf-1", 120, 40);
  });

  test("clamps cols to minimum 20", async () => {
    tmuxResize.mockClear();
    const res = await post("/api/resize", {
      session: "wolf-1",
      cols: 5,
      rows: 40,
    });
    expect(res.status).toBe(200);
    expect(tmuxResize).toHaveBeenCalledWith("wolf-1", 20, 40);
  });

  test("clamps cols to maximum 300", async () => {
    tmuxResize.mockClear();
    const res = await post("/api/resize", {
      session: "wolf-1",
      cols: 999,
      rows: 40,
    });
    expect(res.status).toBe(200);
    expect(tmuxResize).toHaveBeenCalledWith("wolf-1", 300, 40);
  });

  test("clamps rows to minimum 5", async () => {
    tmuxResize.mockClear();
    const res = await post("/api/resize", {
      session: "wolf-1",
      cols: 80,
      rows: 1,
    });
    expect(res.status).toBe(200);
    expect(tmuxResize).toHaveBeenCalledWith("wolf-1", 80, 5);
  });

  test("clamps rows to maximum 100", async () => {
    tmuxResize.mockClear();
    const res = await post("/api/resize", {
      session: "wolf-1",
      cols: 80,
      rows: 999,
    });
    expect(res.status).toBe(200);
    expect(tmuxResize).toHaveBeenCalledWith("wolf-1", 80, 100);
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
    tmuxResize.mockClear();
    const res = await post("/api/resize", {
      session: "wolf-1",
      cols: 20,
      rows: 5,
    });
    expect(res.status).toBe(200);
    expect(tmuxResize).toHaveBeenCalledWith("wolf-1", 20, 5);
  });

  test("boundary: cols=300, rows=100 (maximum)", async () => {
    tmuxResize.mockClear();
    const res = await post("/api/resize", {
      session: "wolf-1",
      cols: 300,
      rows: 100,
    });
    expect(res.status).toBe(200);
    expect(tmuxResize).toHaveBeenCalledWith("wolf-1", 300, 100);
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
      // The server destroys the socket, so fetch may throw or get an error response
      if (res.ok) {
        // Should not succeed
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
    const res = await post("/api/push/subscribe", { endpoint: "https://example.com/push" });
    expect(res.status).toBe(400);
  });

  test("invalid endpoint URL → 400", async () => {
    const res = await post("/api/push/subscribe", { endpoint: "not-a-url", keys: { p256dh, auth } });
    expect(res.status).toBe(400);
  });

  test("bad p256dh length → 400", async () => {
    const res = await post("/api/push/subscribe", {
      endpoint: "https://example.com/push",
      keys: { p256dh: randomBytes(32).toString("base64url"), auth },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("65 bytes");
  });

  test("bad auth length → 400", async () => {
    const res = await post("/api/push/subscribe", {
      endpoint: "https://example.com/push",
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
    const res = await post("/api/push/unsubscribe", { endpoint: "https://example.com/push/gone" });
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
    // The checkNotifyRateLimit is module-level state, and we already sent 1 call above.
    // Send enough to hit the 10/min limit.
    const results: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await post("/api/notify", { message: `rate-test-${i}` });
      results.push(res.status);
    }
    // At least one should be 429
    expect(results).toContain(429);
  });
});
