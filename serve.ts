#!/usr/bin/env -S npx tsx
/**
 * Standalone Wolfpack PWA server.
 * Serves a live tmux pane viewer via capture-pane.
 *
 * Usage: npx tsx serve.ts [port]
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join, basename } from "node:path";
import { hostname } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// resolve absolute path to tmux — launchd doesn't have homebrew in PATH
const TMUX = (() => {
  for (const p of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    try { execFileSync("test", ["-x", p]); return p; } catch {}
  }
  return "tmux"; // fallback to PATH lookup
})();

// resolve user's shell — Ubuntu defaults to bash, macOS to zsh
const SHELL = (() => {
  const envShell = process.env.SHELL;
  if (envShell) {
    try { execFileSync("test", ["-x", envShell]); return envShell; } catch {}
  }
  for (const p of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    try { execFileSync("test", ["-x", p]); return p; } catch {}
  }
  return "/bin/sh";
})();
const PORT =
  Number(process.env.WOLFPACK_PORT) || Number(process.argv[2]) || 18790;
const PUBLIC_DIR = join(import.meta.dirname, "public");
const DEV_DIR =
  process.env.WOLFPACK_DEV_DIR || join(process.env.HOME ?? "~", "Dev");
const SETTINGS_PATH = join(import.meta.dirname, "bridge-settings.json");
const VERSION = "1.1.0";

// CORS origin allowlist — replaces wildcard "*"
const ALLOWED_ORIGINS = new Set<string>([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);

// Extract tailnet suffix (e.g. "tailnet-name.ts.net") from config
const TAILNET_SUFFIX = (() => {
  try {
    const cfg = JSON.parse(readFileSync(join(process.env.HOME ?? "~", ".wolfpack", "config.json"), "utf-8"));
    const h = cfg.tailscaleHostname as string; // e.g. "machine.tailnet-name.ts.net"
    const dot = h.indexOf(".");
    if (dot !== -1) return h.substring(dot + 1); // "tailnet-name.ts.net"
  } catch {}
  return "";
})();

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Allow devices on the same tailnet only
  if (TAILNET_SUFFIX) {
    try {
      const url = new URL(origin);
      if (url.protocol === "https:" && url.hostname.endsWith("." + TAILNET_SUFFIX)) return true;
    } catch {}
  }
  return false;
}

interface Settings {
  agentCmd: string;
  customCmds?: string[];
}

const AGENT_PRESETS: Record<string, string> = {
  shell: "shell",
  claude: "claude",
  "claude --dangerously-skip-permissions":
    "claude --dangerously-skip-permissions",
  codex: "codex",
  agent: "agent",
  gemini: "gemini",
};

function loadSettings(): Settings {
  try {
    const s = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    return { agentCmd: s.agentCmd || "claude", customCmds: s.customCmds || [] };
  } catch {
    return { agentCmd: "claude", customCmds: [] };
  }
}

function saveSettings(s: Settings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

// ── tmux helpers ──

async function tmuxList(): Promise<string[]> {
  try {
    const { stdout } = await exec(TMUX, [
      "list-sessions",
      "-F",
      "#{session_name}|||#{pane_current_path}",
    ]);
    const SEP = "|||";
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        const idx = line.indexOf(SEP);
        return idx !== -1 && line.substring(idx + SEP.length).startsWith(DEV_DIR);
      })
      .map((line) => line.substring(0, line.indexOf(SEP)));
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tmuxSend(
  session: string,
  text: string,
  noEnter = false,
): Promise<void> {
  await exec(TMUX, ["send-keys", "-l", "-t", session, text]);
  if (!noEnter) {
    await sleep(50);
    await exec(TMUX, ["send-keys", "-t", session, "Enter"]);
  }
}

async function tmuxSendKey(session: string, key: string): Promise<void> {
  await exec(TMUX, ["send-keys", "-t", session, key]);
}

async function tmuxResize(
  session: string,
  cols: number,
  rows: number,
): Promise<void> {
  await exec(TMUX, [
    "resize-window",
    "-t",
    session,
    "-x",
    String(cols),
    "-y",
    String(rows),
  ]);
}

async function capturePane(session: string): Promise<string> {
  try {
    const args = ["capture-pane", "-t", session, "-p", "-J"];
    // Always capture some scrollback so the PWA terminal can scroll
    args.push("-S", "-2000");
    const { stdout } = await exec(TMUX, args);
    return stdout;
  } catch {
    return "";
  }
}

async function tmuxNewSession(
  name: string,
  cwd: string,
  cmd?: string,
): Promise<void> {
  const agentCmd = cmd || loadSettings().agentCmd || "claude";
  // "shell" = plain interactive shell, no command
  const shellCmd = agentCmd === "shell"
    ? SHELL
    : `${SHELL} -lic '${agentCmd.replace(/'/g, "'\\''")}; exec ${SHELL}'`;
  await exec(TMUX, [
    "new-session",
    "-d",
    "-s",
    name,
    "-c",
    cwd,
    shellCmd,
  ]);
}

function listDevProjects(): string[] {
  try {
    return readdirSync(DEV_DIR)
      .filter((f) => {
        try {
          return statSync(join(DEV_DIR, f)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

async function uniqueSessionName(base: string): Promise<string> {
  const sessions = await tmuxList();
  if (!sessions.includes(base)) return base;
  let i = 2;
  while (sessions.includes(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

async function isAllowedSession(session: string): Promise<boolean> {
  const allowed = await tmuxList();
  return allowed.includes(session);
}

// ── HTTP helpers ──

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const MAX_BODY = 64 * 1024; // 64KB

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

function serveFile(
  res: ServerResponse,
  filename: string,
  contentType: string,
): void {
  try {
    const isText = /text\/|json|javascript|xml|css/.test(contentType);
    const content = isText
      ? readFileSync(join(PUBLIC_DIR, filename), "utf-8")
      : readFileSync(join(PUBLIC_DIR, filename));
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
}

// ── Routes ──

const routes: Record<
  string,
  (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
> = {
  "GET /": (_req, res) =>
    serveFile(res, "index.html", "text/html; charset=utf-8"),
  "GET /manifest.json": (_req, res) => {
    try {
      const manifest = JSON.parse(
        readFileSync(join(PUBLIC_DIR, "manifest.json"), "utf-8"),
      );
      res.writeHead(200, { "Content-Type": "application/manifest+json" });
      res.end(JSON.stringify(manifest, null, 2));
    } catch {
      res.writeHead(404);
      res.end("Not Found");
    }
  },
  "GET /sw.js": (_req, res) => {
    try {
      const content = readFileSync(join(PUBLIC_DIR, "sw.js"), "utf-8");
      res.writeHead(200, {
        "Content-Type": "application/javascript",
        "Service-Worker-Allowed": "/",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not Found");
    }
  },

  "GET /api/info": (_req, res) => {
    const name = hostname()
      .replace(/\.local$/, "")
      .replace(/\.tail[a-z0-9-]*\.ts\.net$/i, "");
    json(res, { name, version: VERSION });
  },

  "GET /api/sessions": async (_req, res) => {
    const sessions = await tmuxList();
    const results = await Promise.all(
      sessions.map(async (name) => {
        const pane = await capturePane(name);
        const lines = pane.trimEnd().split("\n");
        const lastLine = lines[lines.length - 1]?.trim() || "";
        return { name, lastLine };
      }),
    );
    json(res, { sessions: results });
  },

  "POST /api/send": async (req, res) => {
    const { session, text, noEnter } = JSON.parse(await readBody(req));
    if (!session || !text)
      return json(res, { error: "missing session or text" }, 400);
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    await tmuxSend(session, text, !!noEnter);
    json(res, { ok: true });
  },

  "GET /api/projects": async (_req, res) => {
    const projects = listDevProjects();
    json(res, { projects });
  },

  "POST /api/create": async (req, res) => {
    const { project, newProject, cmd } = JSON.parse(await readBody(req)) as {
      project?: string;
      newProject?: string;
      cmd?: string;
    };
    const folderName = newProject?.trim() || project?.trim();
    if (!folderName || !/^[a-zA-Z0-9._-]+$/.test(folderName)) {
      return json(res, { error: "invalid project name" }, 400);
    }

    // Validate cmd if provided
    if (cmd && cmd !== "shell" && !/^[a-zA-Z0-9 \-._/=]+$/.test(cmd)) {
      return json(res, { error: "invalid characters in command" }, 400);
    }

    const projectDir = join(DEV_DIR, folderName);

    // Create dir if it doesn't exist (new project)
    if (newProject) {
      try {
        mkdirSync(projectDir, { recursive: true });
      } catch {}
    }

    // Verify dir exists
    try {
      if (!statSync(projectDir).isDirectory())
        return json(res, { error: "not a directory" }, 400);
    } catch {
      return json(res, { error: "project directory not found" }, 404);
    }

    const sessionName = await uniqueSessionName(folderName);
    await tmuxNewSession(sessionName, projectDir, cmd);
    json(res, { ok: true, session: sessionName });
  },

  "POST /api/key": async (req, res) => {
    const { session, key } = JSON.parse(await readBody(req)) as {
      session: string;
      key: string;
    };
    if (!session || !key)
      return json(res, { error: "missing session or key" }, 400);
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    // Only allow known safe key names
    const allowed = [
      "Enter",
      "Tab",
      "Escape",
      "Up",
      "Down",
      "Left",
      "Right",
      "BTab",
      "y",
      "n",
      "C-c",
      "C-d",
      "C-z",
    ];
    if (!allowed.includes(key))
      return json(res, { error: "key not allowed" }, 400);
    await tmuxSendKey(session, key);
    json(res, { ok: true });
  },

  "GET /api/settings": async (_req, res) => {
    const settings = loadSettings();
    json(res, { settings, presets: AGENT_PRESETS });
  },

  "POST /api/settings": async (req, res) => {
    const body = JSON.parse(await readBody(req)) as {
      agentCmd?: string;
      addCustomCmd?: string;
      deleteCustomCmd?: string;
    };
    const settings = loadSettings();
    const cmdRegex = /^[a-zA-Z0-9 \-._/=]+$/;

    if (body.agentCmd != null) {
      const cmd = body.agentCmd.trim();
      if (cmd !== "shell" && !cmdRegex.test(cmd)) {
        return json(res, { error: "invalid characters in agent command" }, 400);
      }
      settings.agentCmd = cmd;
    }
    if (body.addCustomCmd != null) {
      const cmd = body.addCustomCmd.trim();
      if (!cmdRegex.test(cmd)) {
        return json(res, { error: "invalid characters in command" }, 400);
      }
      if (!settings.customCmds) settings.customCmds = [];
      if (!settings.customCmds.includes(cmd) && !AGENT_PRESETS[cmd]) {
        settings.customCmds.push(cmd);
      }
      settings.agentCmd = cmd;
    }
    if (body.deleteCustomCmd != null) {
      settings.customCmds = (settings.customCmds || []).filter(c => c !== body.deleteCustomCmd);
      if (settings.agentCmd === body.deleteCustomCmd) {
        settings.agentCmd = "claude";
      }
    }
    saveSettings(settings);
    json(res, { ok: true, settings });
  },

  "GET /api/claude-config": async (_req, res) => {
    const configPath = join(process.env.HOME ?? "~", ".claude", "CLAUDE.md");
    try {
      const content = readFileSync(configPath, "utf-8");
      json(res, { content });
    } catch {
      json(res, { content: "", exists: false });
    }
  },

  "POST /api/claude-config": async (req, res) => {
    const { content } = JSON.parse(await readBody(req)) as { content: string };
    if (typeof content !== "string") {
      return json(res, { error: "missing content" }, 400);
    }
    const configDir = join(process.env.HOME ?? "~", ".claude");
    const configPath = join(configDir, "CLAUDE.md");
    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, content, "utf-8");
      json(res, { ok: true });
    } catch (e) {
      json(res, { error: "failed to write config" }, 500);
    }
  },

  "POST /api/kill": async (req, res) => {
    const { session } = JSON.parse(await readBody(req)) as { session: string };
    if (!session) return json(res, { error: "missing session" }, 400);
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    await exec(TMUX, ["kill-session", "-t", session]);
    json(res, { ok: true });
  },

  "POST /api/resize": async (req, res) => {
    const { session, cols, rows } = JSON.parse(await readBody(req)) as {
      session: string;
      cols: number;
      rows: number;
    };
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

  "GET /api/poll": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const session = url.searchParams.get("session");
    if (!session) return json(res, { error: "missing session param" }, 400);
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    const pane = await capturePane(session);
    json(res, { pane });
  },
};

// ── Server ──

const server = createServer(async (req, res) => {
  // CORS origin check
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

  // CORS preflight
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
      console.error("Route error:", err);
      if (!res.headersSent) json(res, { error: "internal error" }, 500);
    }
  } else {
    // Static file fallback from public/
    const safePath = url.pathname.replace(/^\/+/, "");
    if (safePath && !safePath.includes("\0")) {
      const filePath = join(PUBLIC_DIR, safePath);
      // Prevent path traversal — resolved path must stay inside PUBLIC_DIR
      if (!filePath.startsWith(PUBLIC_DIR + "/")) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      try {
        const stat = await import("node:fs/promises").then((fs) => fs.stat(filePath));
        if (stat.isFile()) {
          const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
          const mimeMap: Record<string, string> = {
            png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
            svg: "image/svg+xml", ico: "image/x-icon", webp: "image/webp",
            js: "application/javascript", css: "text/css",
            json: "application/json", html: "text/html",
            woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf",
          };
          serveFile(res, safePath, mimeMap[ext] ?? "application/octet-stream");
          return;
        }
      } catch {}
    }
    res.writeHead(404);
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`Wolfpack PWA: http://localhost:${PORT}/`);
});
