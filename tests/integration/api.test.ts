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
let fakeSessionActivity: Record<string, number> = {};

const tmuxList = mock(async (): Promise<string[]> => fakeSessions);
const tmuxListWithActivity = mock(async (): Promise<{ name: string; activity: number }[]> =>
  fakeSessions.map((name) => ({ name, activity: fakeSessionActivity[name] || 0 }))
);
const capturePane = mock(
  async (session: string): Promise<string> =>
    `captured output for ${session}\n`,
);
const tmuxSend = mock(
  async (_s: string, _t: string, _noEnter?: boolean): Promise<void> => {},
);
const tmuxSendKey = mock(
  async (_s: string, _key: string): Promise<void> => {},
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
import { classifySession, TRIAGE_ORDER, type TriageStatus } from "../../triage.ts";

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
    const sessionsWithActivity = await tmuxListWithActivity();
    const now = Math.floor(Date.now() / 1000);
    const results = await Promise.all(
      sessionsWithActivity.map(async ({ name, activity }) => {
        const pane = await capturePane(name);
        const lines = pane.trimEnd().split("\n");
        const lastLine = lines.filter(l => l.trim()).slice(-2).map(l => l.trim()).join("\n") || "";
        const activityAge = now - activity;
        const triage = classifySession(lastLine, activityAge);
        return { name, lastLine, triage };
      }),
    );
    results.sort((a, b) => TRIAGE_ORDER[a.triage] - TRIAGE_ORDER[b.triage]);
    json(res, { sessions: results });
  },

  "POST /api/send": async (req, res) => {
    const body = await parseBody(req, res);
    if (!body) return;
    const { session, text, noEnter } = body;
    if (!session || !text)
      return json(res, { error: "missing session or text" }, 400);
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    await tmuxSend(session, text, !!noEnter);
    json(res, { ok: true });
  },

  "POST /api/create": async (req, res) => {
    const body = await parseBody<{
      project?: string;
      newProject?: string;
      cmd?: string;
    }>(req, res);
    if (!body) return;
    const { project, newProject, cmd } = body;
    const folderName = newProject?.trim() || project?.trim();
    if (!folderName || !isValidProjectName(folderName)) {
      return json(res, { error: "invalid project name" }, 400);
    }
    const sessionName = await uniqueSessionName(folderName);
    await tmuxNewSession(sessionName, `/tmp/dev/${folderName}`, cmd);
    json(res, { ok: true, session: sessionName });
  },

  "POST /api/key": async (req, res) => {
    const body = await parseBody<{ session: string; key: string }>(req, res);
    if (!body) return;
    const { session, key } = body;
    if (!session || !key)
      return json(res, { error: "missing session or key" }, 400);
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    if (!ALLOWED_KEYS.includes(key))
      return json(res, { error: "key not allowed" }, 400);
    await tmuxSendKey(session, key);
    json(res, { ok: true });
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
    const res = await get("/api/sessions");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessions).toHaveLength(2);
    expect(typeof data.sessions[0].lastLine).toBe("string");
    expect(typeof data.sessions[0].triage).toBe("string");
    expect(["needs-input", "error", "running", "idle"]).toContain(data.sessions[0].triage);
  });

  test("returns empty list when no sessions", async () => {
    const orig = fakeSessions;
    fakeSessions = [];
    tmuxListWithActivity.mockImplementation(async () => []);
    const res = await get("/api/sessions");
    const data = await res.json();
    expect(data.sessions).toHaveLength(0);
    fakeSessions = orig;
    tmuxListWithActivity.mockImplementation(async () =>
      fakeSessions.map((name) => ({ name, activity: fakeSessionActivity[name] || 0 }))
    );
  });

  test("capturePane called for each session", async () => {
    capturePane.mockClear();
    await get("/api/sessions");
    expect(capturePane).toHaveBeenCalledTimes(2);
    expect(capturePane).toHaveBeenCalledWith("wolf-1");
    expect(capturePane).toHaveBeenCalledWith("wolf-2");
  });

  test("classifies needs-input from prompt patterns", async () => {
    capturePane.mockImplementation(async () => "Do you want to continue? (y/n)\n");
    fakeSessionActivity = { "wolf-1": 0, "wolf-2": 0 };
    const res = await get("/api/sessions");
    const data = await res.json();
    expect(data.sessions[0].triage).toBe("needs-input");
    capturePane.mockImplementation(async (s: string) => `captured output for ${s}\n`);
    fakeSessionActivity = {};
  });

  test("classifies error from error patterns", async () => {
    capturePane.mockImplementation(async () => "Error: something went wrong\n");
    fakeSessionActivity = { "wolf-1": 0, "wolf-2": 0 };
    const res = await get("/api/sessions");
    const data = await res.json();
    expect(data.sessions[0].triage).toBe("error");
    capturePane.mockImplementation(async (s: string) => `captured output for ${s}\n`);
    fakeSessionActivity = {};
  });

  test("classifies running when activity is recent", async () => {
    const now = Math.floor(Date.now() / 1000);
    capturePane.mockImplementation(async () => "$ compiling...\n");
    fakeSessionActivity = { "wolf-1": now - 5, "wolf-2": now - 5 };
    const res = await get("/api/sessions");
    const data = await res.json();
    expect(data.sessions[0].triage).toBe("running");
    capturePane.mockImplementation(async (s: string) => `captured output for ${s}\n`);
    fakeSessionActivity = {};
  });

  test("classifies idle when activity is old", async () => {
    capturePane.mockImplementation(async () => "$ \n");
    fakeSessionActivity = { "wolf-1": 0, "wolf-2": 0 };
    const res = await get("/api/sessions");
    const data = await res.json();
    expect(data.sessions[0].triage).toBe("idle");
    capturePane.mockImplementation(async (s: string) => `captured output for ${s}\n`);
    fakeSessionActivity = {};
  });

  test("sorts sessions by triage priority", async () => {
    fakeSessions = ["idle-sess", "error-sess", "input-sess"];
    const now = Math.floor(Date.now() / 1000);
    fakeSessionActivity = {
      "idle-sess": 0,
      "error-sess": 0,
      "input-sess": 0,
    };
    tmuxListWithActivity.mockImplementation(async () =>
      fakeSessions.map((name) => ({ name, activity: fakeSessionActivity[name] || 0 }))
    );
    capturePane.mockImplementation(async (s: string) => {
      if (s === "input-sess") return "Continue? (y/n)\n";
      if (s === "error-sess") return "Error: build failed\n";
      return "$ \n";
    });
    const res = await get("/api/sessions");
    const data = await res.json();
    expect(data.sessions[0].name).toBe("input-sess");
    expect(data.sessions[0].triage).toBe("needs-input");
    expect(data.sessions[1].name).toBe("error-sess");
    expect(data.sessions[1].triage).toBe("error");
    expect(data.sessions[2].name).toBe("idle-sess");
    expect(data.sessions[2].triage).toBe("idle");
    // restore
    fakeSessions = ["wolf-1", "wolf-2"];
    fakeSessionActivity = {};
    tmuxListWithActivity.mockImplementation(async () =>
      fakeSessions.map((name) => ({ name, activity: fakeSessionActivity[name] || 0 }))
    );
    capturePane.mockImplementation(async (s: string) => `captured output for ${s}\n`);
  });
});

describe("POST /api/send", () => {
  test("sends text to valid session", async () => {
    tmuxSend.mockClear();
    const res = await post("/api/send", {
      session: "wolf-1",
      text: "hello world",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(tmuxSend).toHaveBeenCalledWith("wolf-1", "hello world", false);
  });

  test("passes noEnter flag through", async () => {
    tmuxSend.mockClear();
    const res = await post("/api/send", {
      session: "wolf-1",
      text: "partial",
      noEnter: true,
    });
    expect(res.status).toBe(200);
    expect(tmuxSend).toHaveBeenCalledWith("wolf-1", "partial", true);
  });

  test("rejects missing session", async () => {
    const res = await post("/api/send", { text: "hello" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("missing session or text");
  });

  test("rejects missing text", async () => {
    const res = await post("/api/send", { session: "wolf-1" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("missing session or text");
  });

  test("rejects unknown session (404)", async () => {
    const res = await post("/api/send", {
      session: "ghost",
      text: "hello",
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("session not found");
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
});

describe("POST /api/key", () => {
  test("sends allowed key to valid session", async () => {
    tmuxSendKey.mockClear();
    const res = await post("/api/key", {
      session: "wolf-1",
      key: "Enter",
    });
    expect(res.status).toBe(200);
    expect(tmuxSendKey).toHaveBeenCalledWith("wolf-1", "Enter");
  });

  test("allows all whitelisted keys", async () => {
    for (const key of ALLOWED_KEYS) {
      const res = await post("/api/key", { session: "wolf-1", key });
      expect(res.status).toBe(200);
    }
  });

  test("rejects disallowed key", async () => {
    const res = await post("/api/key", {
      session: "wolf-1",
      key: "Delete",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("key not allowed");
  });

  test("rejects arbitrary string as key", async () => {
    const res = await post("/api/key", {
      session: "wolf-1",
      key: "rm -rf /",
    });
    expect(res.status).toBe(400);
  });

  test("rejects unknown session", async () => {
    const res = await post("/api/key", {
      session: "ghost",
      key: "Enter",
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("session not found");
  });

  test("rejects missing session", async () => {
    const res = await post("/api/key", { key: "Enter" });
    expect(res.status).toBe(400);
  });

  test("rejects missing key", async () => {
    const res = await post("/api/key", { session: "wolf-1" });
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
    const res = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "this is not json{{{",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid JSON body");
  });

  test("returns 400 for empty body on POST route", async () => {
    const res = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid JSON body");
  });

  test("returns 400 for truncated JSON", async () => {
    const res = await fetch(`${base}/api/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"session": "wolf-1", "key":',
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
      const res = await fetch(`${base}/api/send`, {
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
    const res = await fetch(`${base}/api/send`, {
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
