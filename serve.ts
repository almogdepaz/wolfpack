#!/usr/bin/env npx tsx
/**
 * Standalone Claude Bridge PWA server.
 * Zero clawdbot dependencies. Serves a live tmux pane viewer via capture-pane.
 *
 * Usage: npx tsx serve.ts [port]
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const PORT = Number(process.env.WOLFPACK_PORT) || Number(process.argv[2]) || 18790;
const PUBLIC_DIR = join(import.meta.dirname, "public");
const DEV_DIR = process.env.WOLFPACK_DEV_DIR || join(process.env.HOME ?? "~", "Dev");
const SETTINGS_PATH = join(import.meta.dirname, "bridge-settings.json");

interface Settings {
  agentCmd: string;
}

const AGENT_PRESETS: Record<string, string> = {
  "claude": "claude",
  "claude --dangerously-skip-permissions": "claude --dangerously-skip-permissions",
  "codex": "codex",
  "agent": "agent",
  "gemini": "gemini",
};

function loadSettings(): Settings {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  } catch {
    return { agentCmd: "claude" };
  }
}

function saveSettings(s: Settings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

// ── tmux helpers ──

async function tmuxList(): Promise<string[]> {
  try {
    const { stdout } = await exec("tmux", ["list-sessions", "-F", "#{session_name}:#{pane_current_path}"]);
    return stdout.trim().split("\n").filter(Boolean)
      .filter(line => line.split(":").slice(1).join(":").startsWith(DEV_DIR))
      .map(line => line.split(":")[0]);
  } catch { return []; }
}

async function tmuxExists(session: string): Promise<boolean> {
  try { await exec("tmux", ["has-session", "-t", session]); return true; } catch { return false; }
}

async function tmuxSend(session: string, text: string): Promise<void> {
  await exec("tmux", ["send-keys", "-l", "-t", session, text]);
  await exec("tmux", ["send-keys", "-t", session, "Enter"]);
}

async function tmuxSendKey(session: string, key: string): Promise<void> {
  await exec("tmux", ["send-keys", "-t", session, key]);
}

async function tmuxResize(session: string, cols: number, rows: number): Promise<void> {
  await exec("tmux", ["resize-window", "-t", session, "-x", String(cols), "-y", String(rows)]);
}

async function capturePane(session: string): Promise<string> {
  try {
    const { stdout } = await exec("tmux", ["capture-pane", "-t", session, "-p", "-J"]);
    return stdout;
  } catch { return ""; }
}

async function tmuxNewSession(name: string, cwd: string, cmd?: string): Promise<void> {
  const agentCmd = cmd || loadSettings().agentCmd || "claude";
  await exec("tmux", ["new-session", "-d", "-s", name, "-c", cwd, ...agentCmd.split(/\s+/)]);
}

function listDevProjects(): string[] {
  try {
    return readdirSync(DEV_DIR)
      .filter((f) => {
        try { return statSync(join(DEV_DIR, f)).isDirectory(); } catch { return false; }
      })
      .sort();
  } catch { return []; }
}

async function uniqueSessionName(base: string): Promise<string> {
  const sessions = await tmuxList();
  if (!sessions.includes(base)) return base;
  let i = 2;
  while (sessions.includes(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// ── HTTP helpers ──

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function serveFile(res: ServerResponse, filename: string, contentType: string): void {
  try {
    const content = readFileSync(join(PUBLIC_DIR, filename), "utf-8");
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
}

// ── Routes ──

const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>> = {
  "GET /": (_req, res) => serveFile(res, "index.html", "text/html; charset=utf-8"),
  "GET /manifest.json": (_req, res) => serveFile(res, "manifest.json", "application/json"),
  "GET /sw.js": (_req, res) => {
    try {
      const content = readFileSync(join(PUBLIC_DIR, "sw.js"), "utf-8");
      res.writeHead(200, { "Content-Type": "application/javascript", "Service-Worker-Allowed": "/" });
      res.end(content);
    } catch { res.writeHead(404); res.end("Not Found"); }
  },

  "GET /api/sessions": async (_req, res) => {
    const sessions = await tmuxList();
    json(res, { sessions: sessions.map((name) => ({ name })) });
  },

  "POST /api/send": async (req, res) => {
    const { session, text } = JSON.parse(await readBody(req));
    if (!session || !text) return json(res, { error: "missing session or text" }, 400);
    if (!(await tmuxExists(session))) return json(res, { error: "session not found" }, 404);
    await tmuxSend(session, text);
    json(res, { ok: true });
  },

  "GET /api/projects": async (_req, res) => {
    const projects = listDevProjects();
    json(res, { projects });
  },

  "POST /api/create": async (req, res) => {
    const { project, newProject } = JSON.parse(await readBody(req)) as { project?: string; newProject?: string };
    const folderName = newProject?.trim() || project?.trim();
    if (!folderName || !/^[a-zA-Z0-9._-]+$/.test(folderName)) {
      return json(res, { error: "invalid project name" }, 400);
    }

    const projectDir = join(DEV_DIR, folderName);

    // Create dir if it doesn't exist (new project)
    if (newProject) {
      try { mkdirSync(projectDir, { recursive: true }); } catch {}
    }

    // Verify dir exists
    try {
      if (!statSync(projectDir).isDirectory()) return json(res, { error: "not a directory" }, 400);
    } catch {
      return json(res, { error: "project directory not found" }, 404);
    }

    const sessionName = await uniqueSessionName(folderName);
    await tmuxNewSession(sessionName, projectDir);
    json(res, { ok: true, session: sessionName });
  },

  "POST /api/key": async (req, res) => {
    const { session, key } = JSON.parse(await readBody(req)) as { session: string; key: string };
    if (!session || !key) return json(res, { error: "missing session or key" }, 400);
    if (!(await tmuxExists(session))) return json(res, { error: "session not found" }, 404);
    // Only allow known safe key names
    const allowed = ["Enter", "Tab", "Escape", "Up", "Down", "Left", "Right", "BTab", "y", "n", "C-c", "C-d", "C-z"];
    if (!allowed.includes(key)) return json(res, { error: "key not allowed" }, 400);
    await tmuxSendKey(session, key);
    json(res, { ok: true });
  },

  "GET /api/settings": async (_req, res) => {
    const settings = loadSettings();
    json(res, { settings, presets: AGENT_PRESETS });
  },

  "POST /api/settings": async (req, res) => {
    const body = JSON.parse(await readBody(req)) as Partial<Settings>;
    const settings = loadSettings();
    if (body.agentCmd != null) settings.agentCmd = body.agentCmd.trim();
    saveSettings(settings);
    json(res, { ok: true, settings });
  },

  "POST /api/kill": async (req, res) => {
    const { session } = JSON.parse(await readBody(req)) as { session: string };
    if (!session) return json(res, { error: "missing session" }, 400);
    if (!(await tmuxExists(session))) return json(res, { error: "session not found" }, 404);
    await exec("tmux", ["kill-session", "-t", session]);
    json(res, { ok: true });
  },

  "POST /api/resize": async (req, res) => {
    const { session, cols, rows } = JSON.parse(await readBody(req)) as { session: string; cols: number; rows: number };
    if (!session || !cols || !rows) return json(res, { error: "missing params" }, 400);
    if (!(await tmuxExists(session))) return json(res, { error: "session not found" }, 404);
    await tmuxResize(session, Math.max(20, Math.min(cols, 300)), Math.max(5, Math.min(rows, 100)));
    json(res, { ok: true });
  },

  "GET /api/poll": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const session = url.searchParams.get("session");
    if (!session) return json(res, { error: "missing session param" }, 400);
    if (!(await tmuxExists(session))) return json(res, { error: "session not found" }, 404);
    const pane = await capturePane(session);
    json(res, { pane });
  },
};

// ── Server ──

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const key = `${req.method ?? "GET"} ${url.pathname}`;
  const handler = routes[key];
  if (handler) {
    try { await handler(req, res); } catch (err) {
      if (!res.headersSent) json(res, { error: String(err) }, 500);
    }
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`Claude Bridge PWA: http://localhost:${PORT}/`);
});
