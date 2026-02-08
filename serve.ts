#!/usr/bin/env bun
/**
 * Standalone Wolfpack PWA server.
 * Serves a live tmux pane viewer via capture-pane.
 *
 * Usage: bun serve.ts [port]
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
  lstatSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { assets } from "./public-assets.js";
import { hostname } from "node:os";
import { execFile, execFileSync, spawn } from "node:child_process";
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
const DEV_DIR =
  process.env.WOLFPACK_DEV_DIR || join(process.env.HOME ?? "~", "Dev");
const SETTINGS_PATH = join(process.env.HOME ?? "~", ".wolfpack", "bridge-settings.json");
const VERSION = "1.2.0";

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

const CMD_REGEX = /^[a-zA-Z0-9 \-._/=]+$/;

function loadSettings(): Settings {
  try {
    const s = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    const agentCmd = s.agentCmd && CMD_REGEX.test(s.agentCmd) ? s.agentCmd : "claude";
    const customCmds = (s.customCmds || []).filter((c: string) => CMD_REGEX.test(c));
    return { agentCmd, customCmds };
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

// ── Ralph loop helpers ──

const BUN_BIN = process.execPath;
const RALPH_WORKER = join(import.meta.dir, "ralph-macchio.ts");

interface RalphStatus {
  project: string;
  active: boolean;
  completed: boolean;
  iteration: number;
  totalIterations: number;
  agent: string;
  planFile: string;
  progressFile: string;
  started: string;
  finished: string;
  lastOutput: string;
  pid: number;
}

function parseRalphLog(projectDir: string): RalphStatus | null {
  const logPath = join(projectDir, ".ralph.log");
  if (!existsSync(logPath)) return null;

  const project = projectDir.split("/").pop() ?? "";
  const status: RalphStatus = {
    project,
    active: false,
    completed: false,
    iteration: 0,
    totalIterations: 0,
    agent: "",
    planFile: "",
    progressFile: "",
    started: "",
    finished: "",
    lastOutput: "",
    pid: 0,
  };

  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.split("\n");

    // parse header
    for (const line of lines.slice(0, 10)) {
      const agentMatch = line.match(/^agent:\s*(.+)/);
      if (agentMatch) status.agent = agentMatch[1].trim();
      const planMatch = line.match(/^plan:\s*(.+)/);
      if (planMatch) status.planFile = planMatch[1].trim();
      const progMatch = line.match(/^progress:\s*(.+)/);
      if (progMatch) status.progressFile = progMatch[1].trim();
      const startMatch = line.match(/^started:\s*(.+)/);
      if (startMatch) status.started = startMatch[1].trim();
      const pidMatch = line.match(/^pid:\s*(\d+)/);
      if (pidMatch) status.pid = Number(pidMatch[1]);
    }

    // parse total iterations from header line
    const totalMatch = content.match(/ralph — (\d+) iterations/);
    if (totalMatch) status.totalIterations = Number(totalMatch[1]);

    // find iterations (supports both old "Iteration" and new "Wax On" format)
    const iterRegex = /=== (?:Iteration|🥋 Wax On) (\d+)\/(\d+)/g;
    let match;
    while ((match = iterRegex.exec(content)) !== null) {
      status.iteration = Number(match[1]);
      status.totalIterations = Number(match[2]);
    }

    // check completion
    const finishedMatch = content.match(/^finished:\s*(.+)/m);
    if (finishedMatch) {
      status.completed = true;
      status.finished = finishedMatch[1].trim();
    }
    if (content.includes("<done>COMPLETE</done>") || content.includes("No unchecked tasks remain")) {
      status.completed = true;
      status.iteration = status.totalIterations;
    }

    // detect active: pid alive check (process may still be in Wax Off phase)
    if (status.pid > 1) {
      try {
        process.kill(status.pid, 0);
        status.active = true;
        status.completed = false; // still running
      } catch {
        status.active = false;
      }
    }

    // last output lines (skip markers and blanks)
    const meaningful = lines.filter(
      (l) => l.trim() && !l.startsWith("===") && !l.startsWith("plan:") &&
        !l.startsWith("progress:") && !l.startsWith("started:") &&
        !l.startsWith("finished:") && !l.startsWith("pid:") &&
        !l.startsWith("agent:") && !l.startsWith("🥋"),
    );
    status.lastOutput = meaningful.slice(-5).join("\n");

    return status;
  } catch {
    return null;
  }
}

function isValidProjectName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && name !== "." && name !== "..";
}


function scanRalphLoops(): RalphStatus[] {
  const projects = listDevProjects();
  const results: RalphStatus[] = [];
  for (const p of projects) {
    const dir = join(DEV_DIR, p);
    const status = parseRalphLog(dir);
    if (!status) continue;
    // hide loop if plan file no longer exists
    if (status.planFile && !existsSync(join(dir, status.planFile))) continue;
    results.push(status);
  }
  return results;
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

function serveFile(res: ServerResponse, filename: string): void {
  const asset = assets.get(filename);
  if (!asset) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }
  res.writeHead(200, { "Content-Type": asset.mime });
  res.end(asset.content);
}

// ── Routes ──

const routes: Record<
  string,
  (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
> = {
  "GET /": (_req, res) => serveFile(res, "index.html"),
  "GET /manifest.json": (req, res) => {
    const asset = assets.get("manifest.json");
    if (!asset) { res.writeHead(404); res.end("Not Found"); return; }
    const url = new URL(req.url ?? "/", "http://localhost");
    const customName = url.searchParams.get("name");
    const host = (req.headers.host ?? "localhost").replace(/[:.]/g, "-");
    const manifest = JSON.parse(asset.content as string);
    manifest.id = `/?host=${host}`;
    if (customName) {
      manifest.name = customName;
      manifest.short_name = customName;
    } else {
      const label = host.split("-").slice(0, -1).join("-") || host;
      manifest.name = `Wolfpack (${label})`;
      manifest.short_name = label;
    }
    res.writeHead(200, { "Content-Type": "application/manifest+json" });
    res.end(JSON.stringify(manifest, null, 2));
  },
  "GET /sw.js": (_req, res) => {
    // Return 404 for SW to prevent Brave from treating as installable PWA
    res.writeHead(404);
    res.end("Not Found");
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
    if (!folderName || !isValidProjectName(folderName)) {
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
      if (lstatSync(projectDir).isSymbolicLink() || !statSync(projectDir).isDirectory())
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

  "GET /api/discover": async (_req, res) => {
    // Find wolfpack instances on the tailnet
    // System binary first — macOS GUI CLI fails without GUI context
    const tsBin = [
      "/usr/local/bin/tailscale",
      "/usr/bin/tailscale",
      "/opt/homebrew/bin/tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ].find((p) => { try { execFileSync("test", ["-x", p]); return true; } catch { return false; } });
    if (!tsBin) return json(res, { peers: [], error: "tailscale not found" });

    try {
      // Use login shell so macOS Tailscale GUI CLI gets the Aqua session context
      // (direct execFile fails from launchd services — no Mach bootstrap namespace)
      const { stdout } = await exec(
        "/bin/sh", ["-l", "-c", `"${tsBin}" status --json`],
        { maxBuffer: 10 * 1024 * 1024 },
      );
      const status = JSON.parse(stdout);
      const self = status.Self?.DNSName?.replace(/\.$/, "");
      const peers: { hostname: string; url: string }[] = [];
      for (const [, peer] of Object.entries(status.Peer || {}) as [string, any][]) {
        if (!peer.Online) continue;
        const dns = peer.DNSName?.replace(/\.$/, "");
        if (!dns || dns === self) continue;
        peers.push({ hostname: dns, url: `https://${dns}` });
      }

      // Probe each peer for wolfpack (parallel, 3s timeout)
      const results = await Promise.all(
        peers.map(async (p) => {
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 3000);
            const r = await fetch(p.url + "/api/info", { signal: ctrl.signal });
            clearTimeout(timer);
            const info = await r.json();
            return { ...p, name: info.name || p.hostname, version: info.version, wolfpack: true };
          } catch {
            return { ...p, wolfpack: false };
          }
        }),
      );
      json(res, { peers: results.filter((r) => r.wolfpack) });
    } catch (e: any) {
      console.error("discover error:", e?.message || e);
      json(res, { peers: [], error: "failed to query tailscale" });
    }
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

  // ── Ralph loop API ──

  "GET /api/ralph": async (_req, res) => {
    const loops = scanRalphLoops();
    json(res, { loops });
  },

  "GET /api/ralph/branches": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid project" }, 400);
    }
    const projectDir = join(DEV_DIR, project);
    try {
      if (!statSync(projectDir).isDirectory()) {
        return json(res, { error: "not a directory" }, 400);
      }
    } catch {
      return json(res, { error: "project not found" }, 404);
    }
    try {
      const out = execFileSync("git", ["branch", "--list", "--no-color"], {
        cwd: projectDir,
        encoding: "utf-8",
        timeout: 5000,
      });
      let current = "";
      const branches: string[] = [];
      for (const line of out.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("* ")) {
          const name = trimmed.slice(2).trim();
          current = name;
          branches.push(name);
        } else {
          branches.push(trimmed);
        }
      }
      json(res, { branches, current });
    } catch (e: any) {
      json(res, { error: e.stderr || e.message || "git not available" }, 500);
    }
  },

  "GET /api/ralph/plans": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid project" }, 400);
    }
    const projectDir = join(DEV_DIR, project);
    try {
      const files = readdirSync(projectDir)
        .filter((f) => f.endsWith(".md") && !f.startsWith("."))
        .filter((f) => { try { return statSync(join(projectDir, f)).isFile(); } catch { return false; } })
        .sort();
      json(res, { plans: files });
    } catch {
      json(res, { plans: [] });
    }
  },

  "GET /api/ralph/log": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid project" }, 400);
    }
    const logPath = join(DEV_DIR, project, ".ralph.log");
    if (!existsSync(logPath)) {
      return json(res, { error: "no ralph log found" }, 404);
    }
    try {
      const content = readFileSync(logPath, "utf-8");
      const lines = content.split("\n");
      const totalLines = lines.length;
      const log = lines.slice(-500).join("\n");
      json(res, { log, totalLines });
    } catch {
      json(res, { error: "failed to read log" }, 500);
    }
  },

  "POST /api/ralph/start": async (req, res) => {
    const { project, iterations, planFile, agent, newBranch, sourceBranch } = JSON.parse(await readBody(req)) as {
      project?: string;
      iterations?: number;
      planFile?: string;
      agent?: string;
      newBranch?: string;
      sourceBranch?: string;
    };
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid project name" }, 400);
    }
    const projectDir = join(DEV_DIR, project);
    try {
      if (lstatSync(projectDir).isSymbolicLink() || !statSync(projectDir).isDirectory()) {
        return json(res, { error: "not a directory" }, 400);
      }
    } catch {
      return json(res, { error: "project directory not found" }, 404);
    }
    // check no existing active loop
    const existing = parseRalphLog(projectDir);
    if (existing?.active) {
      return json(res, { error: "ralph loop already running", pid: existing.pid }, 409);
    }

    // Branch creation (optional)
    const BRANCH_REGEX = /^[a-zA-Z0-9._\-/]+$/;
    if (newBranch) {
      if (!BRANCH_REGEX.test(newBranch)) {
        return json(res, { error: "invalid branch name" }, 400);
      }
      const source = sourceBranch || "main";
      if (!BRANCH_REGEX.test(source)) {
        return json(res, { error: "invalid source branch name" }, 400);
      }
      try {
        // Update local ref from remote
        execFileSync("git", ["fetch", "origin", `${source}:${source}`], {
          cwd: projectDir, encoding: "utf-8", timeout: 30000,
        });
      } catch (e: any) {
        // fetch can fail if no remote — try to proceed with local branch
        const stderr = e.stderr || e.message || "";
        // Only fail if the source branch doesn't exist locally either
        try {
          execFileSync("git", ["rev-parse", "--verify", source], {
            cwd: projectDir, encoding: "utf-8", timeout: 5000,
          });
        } catch {
          return json(res, { error: `failed to fetch source branch '${source}': ${stderr}` }, 400);
        }
      }
      try {
        execFileSync("git", ["checkout", "-b", newBranch, source], {
          cwd: projectDir, encoding: "utf-8", timeout: 10000,
        });
      } catch (e: any) {
        const stderr = e.stderr || e.message || "branch creation failed";
        return json(res, { error: stderr }, 400);
      }
    }

    const iters = Math.max(1, Math.min(50, iterations ?? 5));
    const resolvedPlan = planFile || "PLAN.md";
    if (!/^[a-zA-Z0-9._\- ]+\.md$/.test(resolvedPlan) || resolvedPlan === ".." || resolvedPlan === ".") {
      return json(res, { error: "invalid plan file name" }, 400);
    }
    if (!existsSync(join(projectDir, resolvedPlan))) {
      return json(res, { error: `plan file '${resolvedPlan}' not found` }, 404);
    }

    const child = spawn(BUN_BIN, [RALPH_WORKER], {
      cwd: projectDir,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        RALPH_AGENT: agent || "claude",
        RALPH_ITERATIONS: String(iters),
        RALPH_PLAN: resolvedPlan,
        RALPH_PROGRESS: "progress.txt",
      },
    });
    child.unref();

    json(res, { ok: true, pid: child.pid ?? 0, branch: newBranch || undefined });
  },

  "POST /api/ralph/cancel": async (req, res) => {
    const { project } = JSON.parse(await readBody(req)) as {
      project?: string;
    };
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid project name" }, 400);
    }
    const projectDir = join(DEV_DIR, project);
    const status = parseRalphLog(projectDir);
    if (!status?.active || !status.pid || status.pid <= 1) {
      return json(res, { error: "no active ralph loop found" }, 404);
    }
    try {
      process.kill(status.pid, "SIGTERM");
      // kill process group (child claude processes)
      try { process.kill(-status.pid, "SIGTERM"); } catch {}
      json(res, { ok: true, killed: status.pid });
    } catch {
      json(res, { error: "failed to kill process" }, 500);
    }
  },

  "POST /api/ralph/dismiss": async (req, res) => {
    const { project } = JSON.parse(await readBody(req)) as {
      project?: string;
    };
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid project name" }, 400);
    }
    const projectDir = join(DEV_DIR, project);
    const status = parseRalphLog(projectDir);
    if (status?.active) {
      return json(res, { error: "cannot dismiss active loop — cancel it first" }, 409);
    }
    if (!status?.planFile) {
      return json(res, { error: "no plan file found" }, 404);
    }
    const planPath = join(projectDir, status.planFile);
    if (!existsSync(planPath)) {
      return json(res, { error: "plan file already deleted" }, 404);
    }
    try {
      unlinkSync(planPath);
      json(res, { ok: true, deleted: status.planFile });
    } catch {
      json(res, { error: "failed to delete plan file" }, 500);
    }
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
    // Static file fallback from embedded assets
    const safePath = url.pathname.replace(/^\/+/, "");
    if (safePath && !safePath.includes("\0") && !safePath.includes("/")) {
      const asset = assets.get(safePath);
      if (asset) {
        res.writeHead(200, { "Content-Type": asset.mime });
        res.end(asset.content);
        return;
      }
    }
    res.writeHead(404);
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`Wolfpack PWA: http://localhost:${PORT}/`);
});
