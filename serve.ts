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
import { WebSocketServer, type WebSocket } from "ws";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  statSync,
  lstatSync,
  existsSync,
  unlinkSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { assets } from "./public-assets.js";
import { hostname, homedir } from "node:os";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { WOLFPACK_CONTEXT, TASK_HEADER } from "./wolfpack-context.js";
import {
  WS_ALLOWED_KEYS,
  CMD_REGEX,
  isValidProjectName,
  shellEscape,
  clampCols,
  clampRows,
} from "./validation.js";
import pkg from "./package.json";

const exec = promisify(execFile);

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

// inherit user's full PATH from login shell — launchd PATH is minimal
try {
  const shellPath = execFileSync(SHELL, ["-lic", "echo $PATH"]).toString().trim();
  if (shellPath) process.env.PATH = shellPath;
} catch {
  // fallback: manually add common dirs
  const extra = [
    `${process.env.HOME}/.local/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const cur = process.env.PATH || "";
  const have = new Set(cur.split(":"));
  const add = extra.filter(p => !have.has(p) && existsSync(p));
  if (add.length) process.env.PATH = [...add, cur].join(":");
}

const TMUX = "tmux";

const PORT =
  Number(process.env.WOLFPACK_PORT) || Number(process.argv[2]) || 18790;
const DEV_DIR =
  process.env.WOLFPACK_DEV_DIR || join(homedir(), "Dev");
const SETTINGS_PATH = join(homedir(), ".wolfpack", "bridge-settings.json");
const VERSION: string = pkg.version;

// CORS origin allowlist — replaces wildcard "*"
const ALLOWED_ORIGINS = new Set<string>([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);

// Extract tailnet suffix (e.g. "tailnet-name.ts.net") from config
const TAILNET_SUFFIX = (() => {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".wolfpack", "config.json"), "utf-8"));
    const h = cfg.tailscaleHostname as string; // e.g. "machine.tailnet-name.ts.net"
    const dot = h.indexOf(".");
    if (dot !== -1) return h.substring(dot + 1); // "tailnet-name.ts.net"
  } catch {}
  return "";
})();

if (!TAILNET_SUFFIX) {
  console.warn("⚠ No tailscaleHostname in config — remote browser access will be blocked by CORS. Run 'wolfpack setup' to fix.");
}

// Cached peer list for server-side aggregation (populated by /api/discover)
let cachedPeers: { url: string; name: string }[] = [];

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
};

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

// Default tmuxList — overridable via __setTmuxList for testing
let _tmuxListFn: () => Promise<string[]> = _realTmuxList;

/** Test hook: override tmuxList to avoid requiring real tmux */
export function __setTmuxList(fn: () => Promise<string[]>): void {
  _tmuxListFn = fn;
}

/** Test hook: expose activePtySessions for assertions */
export function __getActivePtySessions(): Map<string, { viewers: Set<any>; alive: boolean }> {
  return activePtySessions as any;
}

async function tmuxList(): Promise<string[]> {
  return _tmuxListFn();
}

async function _realTmuxList(): Promise<string[]> {
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
      .map((line) => line.substring(0, line.indexOf(SEP)))
      .filter((name) => !name.startsWith("wp_"));
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
    const { stdout } = await exec(TMUX, [
      "capture-pane", "-t", session, "-p", "-J", "-S", "-2000",
    ]);
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
  if (agentCmd === "shell") {
    await exec(TMUX, ["new-session", "-d", "-s", name, "-c", cwd, SHELL]);
    return;
  }
  // Inject wolfpack context into claude sessions (try with flag, fall back without)
  let fullCmd = agentCmd;
  if (/^claude\b/.test(agentCmd)) {
    const withContext = agentCmd + " --append-system-prompt " + shellEscape(WOLFPACK_CONTEXT);
    fullCmd = withContext + " || " + agentCmd;
  }
  const shellCmd = `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT ${SHELL} -lic ${shellEscape(fullCmd + "; exec " + SHELL)}`;
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

// Ralph worker is invoked as a subcommand: `wolfpack worker --plan ...`
// Works in both compiled binary and `bun cli.ts` modes.
const RALPH_BIN_ARGS = (() => {
  const exe = process.execPath;
  const isBunRuntime = exe.endsWith("/bun") || exe.endsWith("/bun.exe");
  if (isBunRuntime) return [exe, join(import.meta.dir, "cli.ts")];
  return [exe];
})();
const RALPH_AGENTS = new Set(["claude", "codex", "gemini"]);

interface RalphStatus {
  project: string;
  active: boolean;
  completed: boolean;
  cleanup: boolean;
  iteration: number;
  totalIterations: number;
  agent: string;
  planFile: string;
  progressFile: string;
  started: string;
  finished: string;
  lastOutput: string;
  pid: number;
  tasksDone: number;
  tasksTotal: number;
}

function countPlanTasks(planPath: string): { done: number; total: number } {
  try {
    const plan = readFileSync(planPath, "utf-8");
    // checkbox mode
    if (/^- \[[ x]\] /m.test(plan)) {
      const done = (plan.match(/^- \[x\] /gm) || []).length;
      const pending = (plan.match(/^- \[ \] /gm) || []).length;
      return { done, total: done + pending };
    }
    // section mode: ## or ### numbered headers (with optional ~~ strikethrough)
    let total = 0;
    let done = 0;
    for (const line of plan.split("\n")) {
      if (TASK_HEADER.test(line)) {
        total++;
        if (line.includes("~~")) done++;
      }
    }
    return { done, total };
  } catch {
    return { done: 0, total: 0 };
  }
}

function parseRalphLog(projectDir: string): RalphStatus | null {
  const logPath = join(projectDir, ".ralph.log");
  if (!existsSync(logPath)) return null;

  const project = projectDir.split("/").pop() ?? "";
  const status: RalphStatus = {
    project,
    active: false,
    completed: false,
    cleanup: false,
    iteration: 0,
    totalIterations: 0,
    agent: "",
    planFile: "",
    progressFile: "",
    started: "",
    finished: "",
    lastOutput: "",
    pid: 0,
    tasksDone: 0,
    tasksTotal: 0,
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
      status.finished = finishedMatch[1].trim();
    }
    // completion is determined by plan file only (all tasks struck through)

    // detect active: pid alive check
    if (status.pid > 1) {
      try {
        process.kill(status.pid, 0);
        status.active = true;
        status.completed = false; // still running
        // detect cleanup phase: "Wax Off" started but not completed
        // match the actual log marker, not task descriptions that mention "Wax Off"
        if (content.includes("🥋 Wax Off") && !content.includes("Wax Off complete") && !content.includes("Wax Off FAILED")) {
          status.cleanup = true;
        }
      } catch {
        status.active = false;
        // auto-heal stale lock file if PID is dead
        const lockPath = join(projectDir, ".ralph.lock");
        try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch {}
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

    // count tasks from plan file
    if (status.planFile) {
      const tasks = countPlanTasks(join(projectDir, status.planFile));
      status.tasksDone = tasks.done;
      status.tasksTotal = tasks.total;
      // all tasks done in plan → mark completed regardless of how loop ended
      if (tasks.done > 0 && tasks.done === tasks.total && !status.active) {
        status.completed = true;
      }
    }

    return status;
  } catch {
    return null;
  }
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

async function parseBody<T = any>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  try {
    return JSON.parse(await readBody(req)) as T;
  } catch {
    json(res, { error: "invalid JSON body" }, 400);
    return null;
  }
}

const CSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' wss: https:; img-src 'self' data:";

function serveFile(res: ServerResponse, filename: string): void {
  const asset = assets.get(filename);
  if (!asset) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }
  const headers: Record<string, string> = { "Content-Type": asset.mime };
  if (asset.mime === "text/html") {
    headers["Content-Security-Policy"] = CSP;
  }
  res.writeHead(200, headers);
  res.end(asset.content);
}

// ── Peer discovery (shared by /api/discover endpoint and startup) ──

async function discoverPeers(): Promise<{ peers: any[]; error?: string }> {
  const tsBin = [
    "/usr/local/bin/tailscale",
    "/usr/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ].find((p) => { try { execFileSync("test", ["-x", p]); return true; } catch { return false; } });
  if (!tsBin) return { peers: [], error: "tailscale not found" };

  try {
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
    const wolfpackPeers = results.filter((r) => r.wolfpack);
    cachedPeers = wolfpackPeers.map(p => ({ url: p.url, name: p.name }));
    return { peers: wolfpackPeers };
  } catch (e: any) {
    console.error("discover error:", e?.message || e);
    return { peers: [], error: "failed to query tailscale" };
  }
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
      const safeName = customName.replace(/[^\w\s\-().]/g, "").slice(0, 50);
      manifest.name = safeName;
      manifest.short_name = safeName;
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
        const lastLine = lines.filter(l => l.trim()).slice(-2).map(l => l.trim()).join("\n") || "";
        return { name, lastLine };
      }),
    );
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

  "GET /api/projects": async (_req, res) => {
    const projects = listDevProjects();
    json(res, { projects });
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

    // Validate cmd if provided
    if (cmd && cmd !== "shell" && !CMD_REGEX.test(cmd)) {
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
    const body = await parseBody<{ session: string; key: string }>(req, res);
    if (!body) return;
    const { session, key } = body;
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
    const body = await parseBody<{
      agentCmd?: string;
      addCustomCmd?: string;
      deleteCustomCmd?: string;
    }>(req, res);
    if (!body) return;
    const settings = loadSettings();

    if (body.agentCmd != null) {
      const cmd = body.agentCmd.trim();
      if (cmd !== "shell" && !CMD_REGEX.test(cmd)) {
        return json(res, { error: "invalid characters in agent command" }, 400);
      }
      settings.agentCmd = cmd;
    }
    if (body.addCustomCmd != null) {
      const cmd = body.addCustomCmd.trim();
      if (!CMD_REGEX.test(cmd)) {
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
    const body = await parseBody<{ session: string }>(req, res);
    if (!body) return;
    const { session } = body;
    if (!session) return json(res, { error: "missing session" }, 400);
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    await exec(TMUX, ["kill-session", "-t", session]);
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
    // Skip resize if desktop PTY is active (avoid shrinking shared window)
    if (!activePtySessions.has(session)) {
      await tmuxResize(
        session,
        clampCols(cols),
        clampRows(rows),
      );
    }
    json(res, { ok: true });
  },

  "GET /api/discover": async (_req, res) => {
    const result = await discoverPeers();
    if (result.error) return json(res, { peers: [], error: result.error });
    json(res, { peers: result.peers });
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

  "GET /api/ralph": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const aggregate = url.searchParams.get("aggregate") === "true";
    const selfHost = hostname().replace(/\.local$/, "").replace(/\.tail[a-z0-9-]*\.ts\.net$/i, "");
    const localLoops = scanRalphLoops().map(l => ({ ...l, machineName: selfHost, machineUrl: "" }));

    if (!aggregate || cachedPeers.length === 0) {
      return json(res, { loops: localLoops });
    }

    // Aggregate from all peers (without ?aggregate to get local-only from each)
    const remotePeers = cachedPeers.filter(p => p.name !== selfHost);
    const peerResults = await Promise.all(
      remotePeers.map(async (peer) => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 3000);
          const r = await fetch(peer.url + "/api/ralph", { signal: ctrl.signal });
          clearTimeout(timer);
          const data = await r.json() as { loops: any[] };
          return (data.loops || []).map((l: any) => ({ ...l, machineName: peer.name, machineUrl: peer.url }));
        } catch {
          return [];
        }
      })
    );

    json(res, { loops: [...localLoops, ...peerResults.flat()] });
  },

  "GET /api/ralph/branches": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid project" }, 400);
    }
    const projectDir = join(DEV_DIR, project);
    try {
      if (lstatSync(projectDir).isSymbolicLink() || !statSync(projectDir).isDirectory()) {
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
        .filter((f) => f.endsWith(".md") && !f.startsWith(".") && !/^(readme|doc|changelog|contributing|license|code.of.conduct)\.md$/i.test(f))
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
      const MAX_TAIL = 128 * 1024; // read last 128KB max
      const fd = openSync(logPath, "r");
      try {
        const size = statSync(logPath).size;
        const offset = Math.max(0, size - MAX_TAIL);
        const buf = Buffer.alloc(Math.min(size, MAX_TAIL));
        readSync(fd, buf, 0, buf.length, offset);
        const content = buf.toString("utf-8");
        const lines = content.split("\n");
        // if we read a partial file, drop the first (likely truncated) line
        if (offset > 0) lines.shift();
        const totalLines = lines.length;
        const log = lines.slice(-500).join("\n");
        json(res, { log, totalLines });
      } finally {
        closeSync(fd);
      }
    } catch {
      json(res, { error: "failed to read log" }, 500);
    }
  },

  "POST /api/ralph/start": async (req, res) => {
    const body = await parseBody<{
      project?: string;
      iterations?: number;
      planFile?: string;
      agent?: string;
      newBranch?: string;
      sourceBranch?: string;
      format?: boolean;
    }>(req, res);
    if (!body) return;
    const { project, iterations, planFile, agent, newBranch, sourceBranch, format } = body;
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

    // Acquire lock file atomically to prevent TOCTOU race
    const lockPath = join(projectDir, ".ralph.lock");
    try {
      // check for stale lock — if PID is dead, remove it
      if (existsSync(lockPath)) {
        try {
          const lockPid = Number(readFileSync(lockPath, "utf-8").trim());
          if (lockPid > 1) {
            process.kill(lockPid, 0); // throws if dead
            return json(res, { error: "ralph loop already running (lock held)", pid: lockPid }, 409);
          }
        } catch {
          // PID is dead — stale lock, remove it
          try { unlinkSync(lockPath); } catch {}
        }
      }
      writeFileSync(lockPath, "", { flag: "wx" }); // create-exclusive
    } catch (e: any) {
      if (e?.code === "EEXIST") {
        return json(res, { error: "ralph loop already starting (lock contention)" }, 409);
      }
      return json(res, { error: "failed to acquire lock" }, 500);
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

    const workerArgs = [
      ...RALPH_BIN_ARGS.slice(1),
      "worker",
      "--plan", resolvedPlan,
      "--iterations", String(iters),
      "--agent", RALPH_AGENTS.has(agent || "claude") ? (agent || "claude") : "claude",
      "--progress", "progress.txt",
      ...(format ? ["--format"] : []),
    ];
    const child = spawn(RALPH_BIN_ARGS[0], workerArgs, {
      cwd: projectDir,
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // Write PID to lock file so stale lock detection works
    try { writeFileSync(lockPath, String(child.pid ?? 0)); } catch {}

    json(res, { ok: true, pid: child.pid ?? 0, branch: newBranch || undefined });
  },

  "GET /api/ralph/task-count": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    const plan = url.searchParams.get("plan");
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid project" }, 400);
    }
    if (!plan || !/^[a-zA-Z0-9._\- ]+\.md$/.test(plan)) {
      return json(res, { error: "invalid plan file" }, 400);
    }
    const planPath = join(DEV_DIR, project, plan);
    if (!existsSync(planPath)) {
      return json(res, { error: "plan not found" }, 404);
    }
    json(res, countPlanTasks(planPath));
  },

  "POST /api/ralph/cancel": async (req, res) => {
    const body = await parseBody<{ project?: string }>(req, res);
    if (!body) return;
    const { project } = body;
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid project name" }, 400);
    }
    const projectDir = join(DEV_DIR, project);
    const status = parseRalphLog(projectDir);
    if (!status?.active || !status.pid || status.pid <= 1) {
      return json(res, { error: "no active ralph loop found" }, 404);
    }
    // verify PID is actually a ralph-macchio process before killing
    try {
      const { stdout: cmdline } = await exec("ps", ["-p", String(status.pid), "-o", "command="]);
      if (!cmdline.includes("ralph-macchio") && !cmdline.includes("worker")) {
        return json(res, { error: "PID does not belong to a ralph process" }, 400);
      }
    } catch {
      return json(res, { error: "process not found" }, 404);
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
    const body = await parseBody<{ project?: string; deletePlan?: boolean }>(req, res);
    if (!body) return;
    const { project, deletePlan } = body;
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid project name" }, 400);
    }
    const projectDir = join(DEV_DIR, project);
    const status = parseRalphLog(projectDir);
    if (status?.active) {
      return json(res, { error: "cannot dismiss active loop — cancel it first" }, 409);
    }
    if (!status) {
      return json(res, { error: "no ralph log found" }, 404);
    }

    const SAFE_FILENAME = /^[a-zA-Z0-9._\- ]+$/;
    const deleted: string[] = [];
    const failed: string[] = [];

    const tryDelete = (path: string, label: string) => {
      try {
        if (existsSync(path)) { unlinkSync(path); deleted.push(label); }
      } catch { failed.push(label); }
    };

    // always delete .ralph.log (hides the card)
    tryDelete(join(projectDir, ".ralph.log"), ".ralph.log");

    // always clean up stale .ralph.lock
    tryDelete(join(projectDir, ".ralph.lock"), ".ralph.lock");

    // always delete progress file if valid
    if (status.progressFile && SAFE_FILENAME.test(status.progressFile) && !status.progressFile.includes("..")) {
      tryDelete(join(projectDir, status.progressFile), status.progressFile);
    }

    // conditionally delete plan file
    if (deletePlan && status.planFile) {
      if (SAFE_FILENAME.test(status.planFile) && !status.planFile.includes("..")) {
        tryDelete(join(projectDir, status.planFile), status.planFile);
      } else {
        failed.push(status.planFile);
      }
    }

    json(res, { ok: true, deleted, failed });
  },
};

// ── WebSocket ──

const wss = new WebSocketServer({ noServer: true });

async function capturePaneAnsi(session: string): Promise<string> {
  try {
    // -e: include ANSI escapes for color rendering
    // -S -2000: capture scrollback history so desktop terminal can scroll back
    const { stdout } = await exec(TMUX, ["capture-pane", "-t", session, "-p", "-e", "-S", "-2000"]);
    return stdout;
  } catch {
    return "";
  }
}

function handleTerminalWs(ws: WebSocket, session: string): void {
  let prev = "";
  let alive = true;
  let sized = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let updating = false;

  async function sendUpdate() {
    if (!alive || updating) return;
    updating = true;
    try {
      const pane = await capturePaneAnsi(session);
      if (pane !== prev) {
        prev = pane;
        ws.send(JSON.stringify({ type: "output", data: pane }));
      }
    } catch {}
    updating = false;
    schedulePoll();
  }

  function schedulePoll() {
    if (!alive) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(sendUpdate, 100);
  }

  // kick off the initial poll immediately
  schedulePoll();

  // Heartbeat ping every 25s to keep WS alive through reverse proxies
  const pingTimer = setInterval(() => {
    if (alive && ws.readyState === 1) {
      try { ws.ping(); } catch {}
    } else {
      clearInterval(pingTimer);
    }
  }, 25000);

  // Rate limit: 60 msg/s token bucket
  let rlTokens = 60;
  let rlLast = Date.now();

  ws.on("message", async (raw) => {
    // Rate limit check
    const now = Date.now();
    rlTokens = Math.min(60, rlTokens + ((now - rlLast) / 1000) * 60);
    rlLast = now;
    if (rlTokens < 1) return; // drop silently
    rlTokens--;

    try {
      const str = String(raw);
      if (str.length > 65536) return; // 64KB message size cap
      const msg = JSON.parse(str);
      if (msg.type === "input" && typeof msg.data === "string") {
        await tmuxSend(session, msg.data, true);
        // immediate update after input for snappy feedback
        setTimeout(sendUpdate, 15);
      } else if (msg.type === "key" && typeof msg.key === "string") {
        // SE-03: allowlist matching HTTP /api/key + desktop terminal keys
        if (WS_ALLOWED_KEYS.has(msg.key)) {
          await tmuxSendKey(session, msg.key);
          setTimeout(sendUpdate, 15);
        }
      } else if (
        msg.type === "resize" &&
        typeof msg.cols === "number" &&
        typeof msg.rows === "number"
      ) {
        // SE-04: clamp bounds matching HTTP /api/resize
        // Skip resize if a desktop PTY session is active (avoid shrinking shared window)
        if (!activePtySessions.has(session)) {
          await tmuxResize(
            session,
            clampCols(msg.cols),
            clampRows(msg.rows),
          );
        }
        if (!sized) {
          sized = true;
          setTimeout(sendUpdate, 50);
        }
      }
    } catch (err: any) {
      // SE-15: log operational errors, silently drop parse errors
      if (err instanceof SyntaxError) return;
      console.error(`WS error [${session}]:`, err?.message || err);
    }
  });

  ws.on("close", () => {
    alive = false;
    clearInterval(pingTimer);
    if (pollTimer) clearTimeout(pollTimer);
  });

  ws.on("error", () => {
    alive = false;
    clearInterval(pingTimer);
    if (pollTimer) clearTimeout(pollTimer);
  });
}

// ── PTY WebSocket handler (xterm.js direct) ──

// Track ownership with a generation counter to prevent cross-connection cleanup races
const PTY_TEARDOWN_GRACE_MS = 10_000; // keep PTY alive 10s after last viewer disconnects

const activePtySessions = new Map<string, {
  viewers: Set<WebSocket>;
  proc: ReturnType<typeof Bun.spawn>;
  ptySession: string;
  alive: boolean;
  teardownTimer?: ReturnType<typeof setTimeout> | null;
}>();

async function cleanupOrphanPtySessions() {
  try {
    const { stdout } = await exec(TMUX, ["list-sessions", "-F", "#{session_name}"], { timeout: 3000 });
    for (const name of stdout.split("\n")) {
      if (name.startsWith("wp_")) {
        await exec(TMUX, ["kill-session", "-t", name], { timeout: 2000 }).catch(() => {});
      }
    }
  } catch {}
}

function handlePtyWs(ws: WebSocket, session: string): void {
  const ptySession = `wp_${session}`;
  const existing = activePtySessions.get(session);

  // If a PTY entry already exists for this session, just add this viewer
  if (existing && existing.alive) {
    // Cancel pending teardown — a viewer reconnected in time
    if (existing.teardownTimer) {
      clearTimeout(existing.teardownTimer);
      existing.teardownTimer = null;
    }
    if (!existing.proc) {
      // Entry exists but proc not spawned yet — just add as viewer
      existing.viewers.add(ws);
      // Still need detach handler
      const pingTimer = setInterval(() => {
        if (ws.readyState === 1) { try { ws.ping(); } catch {} }
        else clearInterval(pingTimer);
      }, 25000);
      function detach() {
        clearInterval(pingTimer);
        existing.viewers.delete(ws);
        if (existing.viewers.size === 0) schedulePtyTeardown(session);
      }
      ws.on("close", detach);
      ws.on("error", detach);
      return;
    }
    existing.viewers.add(ws);
    const pingTimer = setInterval(() => {
      if (ws.readyState === 1) { try { ws.ping(); } catch {} }
      else clearInterval(pingTimer);
    }, 25000);

    // Rate limit per viewer
    let rlTokens = 60;
    let rlLast = Date.now();
    ws.on("message", (raw: Buffer | string) => {
      if (!existing.alive) return;
      const now = Date.now();
      rlTokens = Math.min(60, rlTokens + ((now - rlLast) / 1000) * 60);
      rlLast = now;
      if (rlTokens < 1) return;
      rlTokens--;
      try {
        if (typeof raw === "string" || (Buffer.isBuffer(raw) && raw[0] === 0x7b)) {
          const msg = JSON.parse(String(raw));
          if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
            const cols = clampCols(msg.cols);
            const rows = clampRows(msg.rows);
            // Force SIGWINCH even if size matches — new viewer needs full redraw
            try {
              existing.proc.terminal!.resize(Math.max(20, cols - 1), rows);
            } catch {}
            existing.proc.terminal!.resize(cols, rows);
          }
        } else if (existing.proc) {
          if (Buffer.isBuffer(raw) && raw.length > 16384) return;
          existing.proc.terminal!.write(raw as Buffer);
        }
      } catch (err: any) {
        if (err instanceof SyntaxError) return;
        console.error(`PTY WS error [${session}]:`, err?.message || err);
      }
    });

    function detach() {
      clearInterval(pingTimer);
      existing.viewers.delete(ws);
      if (existing.viewers.size === 0) schedulePtyTeardown(session);
    }
    ws.on("close", detach);
    ws.on("error", detach);
    return;
  }

  // First viewer — create new PTY entry
  const entry = {
    viewers: new Set<WebSocket>([ws]),
    proc: null as ReturnType<typeof Bun.spawn> | null,
    ptySession,
    alive: true,
  };
  activePtySessions.set(session, entry as any);

  async function spawnPty(cols: number, rows: number) {
    if (entry.proc) return;

    // Verify target session actually exists before creating grouped PTY session.
    // Without this check, tmux new-session -t creates an orphan standalone session
    // when the target is dead, leading to infinite reconnect loops showing "(exited)".
    try {
      await exec(TMUX, ["has-session", "-t", session], { timeout: 2000 });
    } catch {
      entry.alive = false;
      activePtySessions.delete(session);
      for (const viewer of entry.viewers) {
        try { viewer.close(4001, "session unavailable"); } catch {}
      }
      entry.viewers.clear();
      return;
    }

    await exec(TMUX, ["kill-session", "-t", ptySession], { timeout: 2000 }).catch(() => {});
    await exec(TMUX, ["new-session", "-d", "-t", session, "-s", ptySession], { timeout: 3000 }).catch(() => {});
    await exec(TMUX, ["set-option", "-t", ptySession, "status", "off"], { timeout: 2000 }).catch(() => {});
    await exec(TMUX, ["set-option", "-t", ptySession, "mouse", "on"], { timeout: 2000 }).catch(() => {});
    await exec(TMUX, ["set-option", "-t", ptySession, "window-size", "largest"], { timeout: 2000 }).catch(() => {});

    if (!entry.alive) return;

    const spawnedAt = Date.now();
    entry.proc = Bun.spawn([TMUX, "attach-session", "-t", ptySession], {
      env: { ...process.env, TERM: "xterm-256color" },
      terminal: {
        cols,
        rows,
        data(_terminal: unknown, data: Buffer) {
          if (!entry.alive) return;
          for (const viewer of entry.viewers) {
            if (viewer.readyState === 1) {
              try { viewer.send(data); } catch {}
            }
          }
        },
        exit(_terminal: unknown, _code: number, _signal?: number) {
          if (!entry.alive) return;
          entry.alive = false;
          activePtySessions.delete(session);
          // If PTY died within 3s of spawn, the session/pane is dead —
          // use 4001 so the client won't reconnect in an infinite loop.
          const rapid = Date.now() - spawnedAt < 3000;
          const code = rapid ? 4001 : 1000;
          const reason = rapid ? "session unavailable" : "pty exited";
          for (const viewer of entry.viewers) {
            try { viewer.close(code, reason); } catch {}
          }
          entry.viewers.clear();
          exec(TMUX, ["kill-session", "-t", ptySession], { timeout: 2000 }).catch(() => {});
        },
      },
    });
    activePtySessions.set(session, entry as any);
    // Force tmux redraw via SIGWINCH — must change size to actually trigger signal
    setTimeout(() => {
      if (entry.alive && entry.proc) {
        try {
          entry.proc.terminal!.resize(Math.max(20, cols - 1), rows);
          entry.proc.terminal!.resize(cols, rows);
        } catch {}
      }
    }, 100);
  }

  // Rate limit per viewer
  let rlTokens = 60;
  let rlLast = Date.now();

  ws.on("message", (raw: Buffer | string) => {
    if (!entry.alive) return;
    const now = Date.now();
    rlTokens = Math.min(60, rlTokens + ((now - rlLast) / 1000) * 60);
    rlLast = now;
    if (rlTokens < 1) return;
    rlTokens--;
    try {
      if (typeof raw === "string" || (Buffer.isBuffer(raw) && raw[0] === 0x7b)) {
        const msg = JSON.parse(String(raw));
        if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          const cols = clampCols(msg.cols);
          const rows = clampRows(msg.rows);
          if (!entry.proc) {
            spawnPty(cols, rows);
          } else {
            entry.proc.terminal!.resize(cols, rows);
          }
        }
      } else if (entry.proc) {
        if (Buffer.isBuffer(raw) && raw.length > 16384) return;
        entry.proc.terminal!.write(raw as Buffer);
      }
    } catch (err: any) {
      if (err instanceof SyntaxError) return;
      console.error(`PTY WS error [${session}]:`, err?.message || err);
    }
  });

  const pingTimer = setInterval(() => {
    if (ws.readyState === 1) { try { ws.ping(); } catch {} }
    else clearInterval(pingTimer);
  }, 25000);

  function detach() {
    clearInterval(pingTimer);
    entry.viewers.delete(ws);
    if (entry.viewers.size === 0) schedulePtyTeardown(session);
  }
  ws.on("close", detach);
  ws.on("error", detach);
}

/** Schedule PTY teardown after grace period — allows viewer to reconnect without destroying the PTY */
function schedulePtyTeardown(session: string): void {
  const entry = activePtySessions.get(session);
  if (!entry || !entry.alive) return;
  if (entry.teardownTimer) return; // already scheduled
  entry.teardownTimer = setTimeout(() => {
    entry.teardownTimer = null;
    // Only tear down if still no viewers
    if (entry.viewers.size === 0) teardownPty(session);
  }, PTY_TEARDOWN_GRACE_MS);
}

function teardownPty(session: string): void {
  const entry = activePtySessions.get(session);
  if (!entry) return;
  if (entry.teardownTimer) {
    clearTimeout(entry.teardownTimer);
    entry.teardownTimer = null;
  }
  entry.alive = false;
  activePtySessions.delete(session);
  if (entry.proc) {
    try { entry.proc.terminal!.close(); } catch {}
    try { entry.proc.kill(); } catch {}
  }
  exec(TMUX, ["kill-session", "-t", entry.ptySession], { timeout: 2000 }).catch(() => {});
}

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
      serveFile(res, safePath);
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  }
});

server.on("upgrade", async (req, socket, head) => {
  // SE-01: enforce same origin check as HTTP routes
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/ws/terminal") {
    const session = url.searchParams.get("session");
    if (!session || !(await isAllowedSession(session))) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleTerminalWs(ws, session);
    });
  } else if (url.pathname === "/ws/pty") {
    const session = url.searchParams.get("session");
    if (!session || !(await isAllowedSession(session))) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handlePtyWs(ws, session);
    });
  } else {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  }
});

// SE-18: bind to localhost only — Tailscale proxy handles external access
export function startServer(port = PORT, host = "127.0.0.1"): void {
  // Kill orphaned PTY sessions from previous crashes
  cleanupOrphanPtySessions();

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`wolfpack: port ${port} is already in use.`);
      console.error("Run 'wolfpack service stop' first, or choose a different port.");
      process.exit(1);
    }
    console.error(`wolfpack: server error — ${err.message}`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    console.log(`Wolfpack PWA: http://localhost:${port}/`);
    // Warm peer cache in background so /api/ralph aggregation works immediately
    discoverPeers().then(() => {
      if (cachedPeers.length) console.log(`Discovered ${cachedPeers.length} peer(s): ${cachedPeers.map(p => p.name).join(", ")}`);
    }).catch(() => {});
  });
}

export { server, wss };

// Auto-start unless in test mode
if (!process.env.WOLFPACK_TEST) {
  startServer();
}
