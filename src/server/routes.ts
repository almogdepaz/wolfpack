/**
 * HTTP route handlers.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  statSync,
  lstatSync,
  realpathSync,
  existsSync,
  unlinkSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { hostname, homedir } from "node:os";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createLogger, errMsg } from "../log.js";
import {
  CMD_REGEX,
  BRANCH_REGEX,
  isValidProjectName,
  isValidSessionName,
  isValidPlanFile,
  SAFE_FILENAME,
  clampCols,
  clampRows,
} from "../validation.js";
import { cleanupAllExceptFinal } from "../worktree.js";
import { assets } from "../public-assets.js";
import { isJunkLine, type TriageStatus } from "../triage.js";
import { getVapidPublicKey, addSubscription, removeSubscription, sendPush, validateSubscription, checkSessionTransitions, checkRalphLoopTransitions, checkNotifyRateLimit, type PushSubscription } from "./push.js";
import pkg from "../../package.json";

const log = createLogger("routes");
import {
  DEV_DIR,
  RALPH_AGENTS,
  isUnderDevDir,
  exec,
} from "./tmux.js";
import { getBackend, getRouter, type BackendType } from "./backend.js";
import {
  listDevProjects,
  parseRalphLog,
  scanRalphLoops,
  countPlanTasks,
} from "./ralph.js";

// ── Constants ──
const PEER_FETCH_TIMEOUT_MS = 3_000;
const RALPH_LOG_MAX_TAIL_BYTES = 128 * 1024;
const RALPH_LOG_MAX_LINES = 500;

// ── Peer ralph-response validation ──

/** Allowed keys on a ralph loop entry from a remote peer. */
const RALPH_LOOP_SCHEMA: Record<string, "string" | "number" | "boolean"> = {
  project: "string",
  active: "boolean",
  completed: "boolean",
  audit: "boolean",
  cleanup: "boolean",
  cleanupEnabled: "boolean",
  auditFixEnabled: "boolean",
  iteration: "number",
  totalIterations: "number",
  agent: "string",
  planFile: "string",
  progressFile: "string",
  started: "string",
  finished: "string",
  lastOutput: "string",
  pid: "number",
  tasksDone: "number",
  tasksTotal: "number",
  worktreeMode: "string",
  worktreeBranch: "string",
};

/**
 * Validate and sanitize a peer's ralph response.
 * Returns validated loop entries or null if the response is malformed.
 * Strips unexpected keys from each entry.
 */
export function validatePeerLoops(peerName: string, data: unknown): Record<string, unknown>[] | null {
  if (typeof data !== "object" || data === null || !("loops" in data)) {
    log.warn(`malformed peer response from ${peerName}: missing 'loops' key`);
    return null;
  }
  const { loops } = data as { loops: unknown };
  if (!Array.isArray(loops)) {
    log.warn(`malformed peer response from ${peerName}: 'loops' is not an array`);
    return null;
  }
  const validated: Record<string, unknown>[] = [];
  for (const entry of loops) {
    if (typeof entry !== "object" || entry === null) {
      log.warn(`malformed peer loop entry from ${peerName}: not an object, skipping`);
      continue;
    }
    const obj = entry as Record<string, unknown>;
    // project is required — skip entries without it
    if (typeof obj.project !== "string") {
      log.warn(`malformed peer loop entry from ${peerName}: missing 'project', skipping`);
      continue;
    }
    const clean: Record<string, unknown> = {};
    for (const [key, expectedType] of Object.entries(RALPH_LOOP_SCHEMA)) {
      if (key in obj && typeof obj[key] === expectedType) {
        clean[key] = obj[key];
      }
    }
    validated.push(clean);
  }
  return validated;
}

/** Validate project name param. Returns project string or sends 400 and returns null. */
function validateProject(res: ServerResponse, project: string | null | undefined): project is string {
  if (!project || !isValidProjectName(project)) {
    json(res, { error: "invalid project" }, 400);
    return false;
  }
  return true;
}

/** Validate project directory exists, is not a symlink, and resolves under DEV_DIR. */
function validateProjectDir(res: ServerResponse, projectDir: string): boolean {
  try {
    if (lstatSync(projectDir).isSymbolicLink() || !statSync(projectDir).isDirectory()) {
      json(res, { error: "not a directory" }, 400);
      return false;
    }
    // defense-in-depth: verify realpath is contained under DEV_DIR
    if (!isUnderDevDir(realpathSync(projectDir))) {
      json(res, { error: "not a directory" }, 400);
      return false;
    }
  } catch { /* expected: stat fails when project dir doesn't exist */
    json(res, { error: "project directory not found" }, 404);
    return false;
  }
  return true;
}

import {
  uniqueSessionName,
  isAllowedSession,
  json,
  parseBody,
  serveFile,
  cachedPeers,
  discoverPeers,
} from "./http.js";
import { activePtySessions, teardownPty } from "./websocket.js";

/** Validate project name + directory in one call. Returns resolved path or sends error and returns null. */
function resolveProjectDir(res: ServerResponse, project: string | null | undefined): string | null {
  if (!validateProject(res, project)) return null;
  const dir = join(DEV_DIR, project);
  if (!validateProjectDir(res, dir)) return null;
  return dir;
}

const VERSION: string = pkg.version;
const SETTINGS_PATH = join(homedir(), ".wolfpack", "bridge-settings.json");

/** Previous pane content per session — used for content-diff triage. */
const prevPaneContent = new Map<string, string>();

const AGENT_PRESETS: Record<string, string> = {
  shell: "shell",
  claude: "claude",
  "claude --dangerously-skip-permissions":
    "claude --dangerously-skip-permissions",
  codex: "codex",
  agent: "agent",
};

interface Settings {
  agentCmd: string;
  customCmds?: string[];
}

export function loadSettings(): Settings {
  try {
    const s = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    const agentCmd = s.agentCmd && CMD_REGEX.test(s.agentCmd) ? s.agentCmd : "claude";
    const customCmds = (s.customCmds || []).filter((c: string) => CMD_REGEX.test(c));
    return { agentCmd, customCmds };
  } catch { /* expected: settings file doesn't exist yet */
    return { agentCmd: "claude", customCmds: [] };
  }
}

function saveSettings(s: Settings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

// Ralph worker is invoked as a subcommand: `wolfpack worker --plan ...`
const RALPH_BIN_ARGS = (() => {
  const exe = process.execPath;
  const isBunRuntime = exe.endsWith("/bun") || exe.endsWith("/bun.exe");
  if (isBunRuntime) return [exe, join(import.meta.dir, "..", "cli", "index.ts")];
  return [exe];
})();

export const routes: Record<
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
    const sw = assets["sw-push.js"];
    if (sw) {
      res.writeHead(200, { "Content-Type": "application/javascript", "Service-Worker-Allowed": "/" });
      res.end(sw);
    } else {
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
    const sessions = await getBackend().list();
    const activeNames = new Set<string>();
    const results = await Promise.all(
      sessions.map(async (name) => {
        activeNames.add(name);
        const pane = await getBackend().capturePaneForTriage(name);
        const content = pane.trimEnd();

        // Walk lines from bottom, skip junk, take first real line for preview
        const lines = content.split("\n");
        let lastLine = "";
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!isJunkLine(lines[i])) {
            lastLine = lines[i].trim();
            break;
          }
        }

        // Content-diff triage
        const prev = prevPaneContent.get(name);
        let triage: TriageStatus;
        if (prev !== content) {
          triage = "running";
          prevPaneContent.set(name, content);
        } else {
          triage = "idle";
        }

        const backend = getRouter().getBackendTypeForSession(name);
        return { name, lastLine, triage, backend };
      }),
    );
    results.sort((a, b) => a.name.localeCompare(b.name));
    // prune prevPaneContent for sessions that no longer exist
    for (const key of prevPaneContent.keys()) {
      if (!activeNames.has(key)) prevPaneContent.delete(key);
    }
    json(res, { sessions: results });

    // Fire push notifications for running → idle transitions (async, don't block response)
    checkSessionTransitions(results);
  },

  "GET /api/projects": async (_req, res) => {
    const projects = listDevProjects();
    json(res, { projects });
  },

  "GET /api/next-session-name": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    if (!validateProject(res, project)) return;
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
    if (!validateProject(res, folderName)) return;
    if (cmd && cmd !== "shell" && !CMD_REGEX.test(cmd)) {
      return json(res, { error: "invalid characters in command" }, 400);
    }
    const customName = sessionName?.trim();
    if (customName) {
      if (!isValidSessionName(customName)) {
        return json(res, { error: "invalid session name (letters, numbers, hyphens, underscores only)" }, 400);
      }
      const existing = await getBackend().list();
      if (existing.includes(customName)) {
        return json(res, { error: "session name already taken" }, 409);
      }
    }
    const projectDir = join(DEV_DIR, folderName);
    if (newProject) {
      try { mkdirSync(projectDir, { recursive: true }); } catch (e: unknown) {
        log.error("/api/create: failed to create project directory", { path: projectDir, error: errMsg(e) });
      }
    }
    if (!validateProjectDir(res, projectDir)) return;
    const finalName = customName || await uniqueSessionName(folderName);
    try {
      await getBackend().createSession(finalName, projectDir, cmd, loadSettings);
    } catch (e: any) {
      if (e.code === "DUPLICATE_SESSION") {
        return json(res, { error: "session exists", session: finalName, hint: "reconnect or choose a different name" }, 409);
      }
      throw e;
    }
    json(res, { ok: true, session: finalName });
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

  "GET /api/backend": async (_req, res) => {
    const router = getRouter();
    const counts = await router.getSessionCounts();
    json(res, {
      default: router.getDefaultBackend(),
      tmuxAvailable: router.isTmuxAvailable(),
      counts,
    });
  },

  "POST /api/backend": async (req, res) => {
    const body = await parseBody<{ default?: BackendType }>(req, res);
    if (!body) return;
    const type = body.default;
    if (type !== "pty" && type !== "tmux") {
      return json(res, { error: "invalid backend type — must be 'pty' or 'tmux'" }, 400);
    }
    const router = getRouter();
    if (type === "tmux") router.recheckTmux(); // re-probe in case tmux was installed after server start
    if (type === "tmux" && !router.isTmuxAvailable()) {
      return json(res, { error: "tmux is not installed" }, 400);
    }
    router.setDefaultBackend(type);
    // Persist to config so it survives restarts
    let persisted = false;
    try {
      const { loadConfig, saveConfig } = await import("../cli/config.js");
      const config = loadConfig();
      if (config) {
        config.backend = type;
        saveConfig(config);
        persisted = true;
      }
    } catch (e: unknown) {
      log.warn("failed to persist backend choice to config", { error: errMsg(e) });
    }
    const resp: any = { ok: true, default: type };
    if (!persisted) resp.warning = "backend changed but could not persist to config";
    json(res, resp);
  },

  "POST /api/kill": async (req, res) => {
    const body = await parseBody<{ session: string }>(req, res);
    if (!body) return;
    const { session } = body;
    if (!session) return json(res, { error: "missing session" }, 400);
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    // Clean up any associated desktop PTY session (wp_*) before killing
    teardownPty(session);
    prevPaneContent.delete(session);
    await getBackend().killSession(session);
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
    if (!activePtySessions.has(session)) {
      await getBackend().resize(session, clampCols(cols), clampRows(rows));
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
    const pane = await getBackend().capturePane(session);
    json(res, { pane });
  },

  "GET /api/git-status": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const session = url.searchParams.get("session");
    if (!validateProject(res, session)) return;
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    const projectDir = getBackend().sessionDir(session);
    if (!projectDir || !existsSync(projectDir))
      return json(res, { error: "project directory not found" }, 404);
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile("git", ["status", "--short", "--branch"], { cwd: projectDir }, (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr || err.message));
          resolve(stdout);
        });
      });
      json(res, { status: output });
    } catch (e: any) {
      json(res, { error: e.message || "git status failed" }, 500);
    }
  },

  // ── Ralph loop API ──

  "GET /api/ralph": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const aggregate = url.searchParams.get("aggregate") === "true";
    const selfHost = hostname().replace(/\.local$/, "").replace(/\.tail[a-z0-9-]*\.ts\.net$/i, "");
    const localLoops = scanRalphLoops().map(l => ({ ...l, machineName: selfHost, machineUrl: "" }));

    if (!aggregate || cachedPeers.length === 0) {
      json(res, { loops: localLoops });
      checkRalphLoopTransitions(localLoops);
      return;
    }

    const remotePeers = cachedPeers.filter(p => p.name !== selfHost);
    const peerResults = await Promise.all(
      remotePeers.map(async (peer) => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), PEER_FETCH_TIMEOUT_MS);
          const authHeader = Array.isArray(req.headers.authorization)
            ? req.headers.authorization[0]
            : req.headers.authorization;
          const headers = authHeader ? { Authorization: authHeader } : undefined;
          const r = await fetch(peer.url + "/api/ralph", {
            signal: ctrl.signal,
            headers,
          });
          clearTimeout(timer);
          const data = await r.json();
          const loops = validatePeerLoops(peer.name, data);
          if (!loops) return [];
          return loops.map(l => ({ ...l, machineName: peer.name, machineUrl: peer.url }));
        } catch { /* expected: peer unreachable or non-wolfpack — skip silently */
          return [];
        }
      })
    );

    const allLoops = [...localLoops, ...peerResults.flat()];
    json(res, { loops: allLoops });
    checkRalphLoopTransitions(allLoops);
  },

  "GET /api/ralph/branches": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    const projectDir = resolveProjectDir(res, project);
    if (!projectDir) return;
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
    const projectDir = resolveProjectDir(res, project);
    if (!projectDir) return;
    try {
      const files = readdirSync(projectDir)
        .filter((f) => f.endsWith(".md") && !f.startsWith(".") && !/^(readme|doc|changelog|contributing|license|code.of.conduct)\.md$/i.test(f))
        .filter((f) => { try { return statSync(join(projectDir, f)).isFile(); } catch { /* race: file removed between readdir and stat */ return false; } })
        .sort();
      json(res, { plans: files });
    } catch (e: unknown) {
      log.warn("failed to list plan files", { error: errMsg(e) });
      json(res, { plans: [] });
    }
  },

  "GET /api/ralph/log": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    const projectDir = resolveProjectDir(res, project);
    if (!projectDir) return;
    const logPath = join(projectDir, ".ralph.log");
    if (!existsSync(logPath)) {
      return json(res, { error: "no ralph log found" }, 404);
    }
    try {
      const fd = openSync(logPath, "r");
      try {
        const size = statSync(logPath).size;
        const offset = Math.max(0, size - RALPH_LOG_MAX_TAIL_BYTES);
        const buf = Buffer.alloc(Math.min(size, RALPH_LOG_MAX_TAIL_BYTES));
        readSync(fd, buf, 0, buf.length, offset);
        const content = buf.toString("utf-8");
        const lines = content.split("\n");
        if (offset > 0) lines.shift();
        const totalLines = lines.length;
        const log = lines.slice(-RALPH_LOG_MAX_LINES).join("\n");
        json(res, { log, totalLines });
      } finally {
        closeSync(fd);
      }
    } catch (e: unknown) {
      log.error("failed to read ralph log", { error: errMsg(e) });
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
      cleanup?: boolean;
      auditFix?: boolean;
      worktree?: false | "plan" | "task";
      worktreeBranch?: string;
      worktreeBase?: string;
      sandbox?: boolean;
    }>(req, res);
    if (!body) return;
    const { project, iterations, planFile, agent, newBranch, sourceBranch, format, cleanup, auditFix, worktree, worktreeBranch, worktreeBase, sandbox } = body;
    const projectDir = resolveProjectDir(res, project);
    if (!projectDir) return;
    const existing = parseRalphLog(projectDir);
    if (existing?.active) {
      return json(res, { error: "ralph loop already running", pid: existing.pid }, 409);
    }

    const lockPath = join(projectDir, ".ralph.lock");
    // Try atomic create first — avoids TOCTOU between stale-check and create
    try {
      writeFileSync(lockPath, "", { flag: "wx" });
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") {
        return json(res, { error: "failed to acquire lock" }, 500);
      }
      // Lock exists — check if it's stale
      let lockPid = 0;
      try { lockPid = Number(readFileSync(lockPath, "utf-8").trim()); } catch { /* lock may have been removed between wx and read */ }
      if (lockPid > 1) {
        try {
          process.kill(lockPid, 0);
          // PID is alive — verify it's actually a ralph process (not a reused PID)
          try {
            const cmdline = execFileSync("ps", ["-p", String(lockPid), "-o", "command="], { encoding: "utf-8", timeout: 3000 });
            if (cmdline.includes("ralph-macchio") || cmdline.includes("worker")) {
              return json(res, { error: "ralph loop already running (lock held)", pid: lockPid }, 409);
            }
            log.warn("lock PID belongs to unrelated process, removing stale lock", { pid: lockPid, command: cmdline.trim() });
          } catch { /* ps failed — process may have exited between kill(0) and ps, treat as stale */ }
        } catch { /* expected: process dead — stale lock */ }
      }
      // Stale lock — remove and retry atomic create
      try { unlinkSync(lockPath); } catch (e2: unknown) {
        if ((e2 as NodeJS.ErrnoException)?.code !== "ENOENT") log.warn("ralph start: failed to remove stale lock", { error: errMsg(e2) });
      }
      try {
        writeFileSync(lockPath, "", { flag: "wx" });
      } catch (e2: unknown) {
        if ((e2 as NodeJS.ErrnoException)?.code === "EEXIST") {
          return json(res, { error: "ralph loop already starting (lock contention)" }, 409);
        }
        return json(res, { error: "failed to acquire lock" }, 500);
      }
    }

    const removeLock = () => {
      try { unlinkSync(lockPath); } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") log.warn("ralph start: failed to remove lock on validation failure", { error: errMsg(e) });
      }
    };

    let spawned = false;
    try {
    const iters = Math.max(1, Math.min(500, iterations ?? 5));
    const resolvedPlan = planFile || "PLAN.md";
    if (!isValidPlanFile(resolvedPlan)) {
      return json(res, { error: "invalid plan file name" }, 400);
    }
    if (cleanup != null && typeof cleanup !== "boolean") {
      return json(res, { error: "invalid cleanup flag" }, 400);
    }
    if (auditFix != null && typeof auditFix !== "boolean") {
      return json(res, { error: "invalid auditFix flag" }, 400);
    }
    const VALID_WORKTREE_MODES = [false, "false", "plan", "task"];
    if (worktree != null && !VALID_WORKTREE_MODES.includes(worktree as any)) {
      return json(res, { error: "invalid worktree mode — must be false, \"plan\", or \"task\"" }, 400);
    }
    const worktreeMode = (worktree === "plan" || worktree === "task") ? worktree : "false";
    if (worktreeBranch != null && typeof worktreeBranch !== "string") {
      return json(res, { error: "invalid worktreeBranch" }, 400);
    }
    if (worktreeBranch && !BRANCH_REGEX.test(worktreeBranch)) {
      return json(res, { error: "invalid worktree branch name" }, 400);
    }
    if (worktreeBase != null && typeof worktreeBase !== "string") {
      return json(res, { error: "invalid worktreeBase" }, 400);
    }
    if (worktreeBase && !BRANCH_REGEX.test(worktreeBase)) {
      return json(res, { error: "invalid worktree base branch name" }, 400);
    }
    const cleanupEnabled = cleanup ?? true;
    const auditFixEnabled = auditFix ?? false;

    if (newBranch) {
      if (!BRANCH_REGEX.test(newBranch)) {
        return json(res, { error: "invalid branch name" }, 400);
      }
      const source = sourceBranch || "main";
      if (!BRANCH_REGEX.test(source)) {
        return json(res, { error: "invalid source branch name" }, 400);
      }
      try {
        execFileSync("git", ["fetch", "origin", `${source}:${source}`], {
          cwd: projectDir, encoding: "utf-8", timeout: 30000,
        });
      } catch (e: any) {
        const stderr = e.stderr || e.message || "";
        try {
          execFileSync("git", ["rev-parse", "--verify", source], {
            cwd: projectDir, encoding: "utf-8", timeout: 5000,
          });
        } catch { /* local ref also not found — report fetch failure to user */
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

    if (!existsSync(join(projectDir, resolvedPlan))) {
      return json(res, { error: `plan file '${resolvedPlan}' not found` }, 404);
    }

    // Worktree creation is handled by the worker process itself
    // (plan mode creates one worktree at startup, task mode creates per-iteration).
    // The route only passes the mode flag — the worker manages the lifecycle.

    const workerArgs = [
      ...RALPH_BIN_ARGS.slice(1),
      "worker",
      "--plan", resolvedPlan,
      "--iterations", String(iters),
      "--agent", RALPH_AGENTS.has(agent || "claude") ? (agent || "claude") : "claude",
      "--progress", "progress.txt",
      "--cleanup", String(cleanupEnabled),
      "--audit-fix", String(auditFixEnabled),
      ...(format ? ["--format"] : []),
      "--worktree", worktreeMode,
      ...(worktreeBranch ? ["--worktree-branch", worktreeBranch] : []),
      ...(worktreeBase ? ["--worktree-base", worktreeBase] : []),
      "--sandbox", String(sandbox !== false),
    ];
    const child = spawn(RALPH_BIN_ARGS[0], workerArgs, {
      cwd: projectDir,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    spawned = true;

    try { writeFileSync(lockPath, String(child.pid ?? 0)); } catch (e: unknown) {
      log.error("ralph start: failed to write lock file", { error: errMsg(e) });
    }

    json(res, {
      ok: true,
      pid: child.pid ?? 0,
      branch: newBranch || undefined,
      worktree: worktreeMode !== "false" ? worktreeMode : undefined,
    });
    } finally {
      if (!spawned) removeLock();
    }
  },

  "GET /api/ralph/task-count": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    const plan = url.searchParams.get("plan");
    const projectDir = resolveProjectDir(res, project);
    if (!projectDir) return;
    if (!plan || !isValidPlanFile(plan)) {
      return json(res, { error: "invalid plan file" }, 400);
    }
    const planPath = join(projectDir, plan);
    if (!existsSync(planPath)) {
      return json(res, { error: "plan not found" }, 404);
    }
    json(res, countPlanTasks(planPath));
  },

  "POST /api/ralph/cancel": async (req, res) => {
    const body = await parseBody<{ project?: string }>(req, res);
    if (!body) return;
    const { project } = body;
    const projectDir = resolveProjectDir(res, project);
    if (!projectDir) return;
    const status = parseRalphLog(projectDir);
    if (!status?.active || !status.pid || status.pid <= 1) {
      return json(res, { error: "no active ralph loop found" }, 404);
    }
    try {
      const { stdout: cmdline } = await exec("ps", ["-p", String(status.pid), "-o", "command="]);
      if (!cmdline.includes("ralph-macchio") && !cmdline.includes("worker")) {
        return json(res, { error: "PID does not belong to a ralph process" }, 400);
      }
    } catch { /* expected: process already exited */
      return json(res, { error: "process not found" }, 404);
    }
    try {
      process.kill(status.pid, "SIGTERM");
      try { process.kill(-status.pid, "SIGTERM"); } catch (e: unknown) {
        log.warn("ralph cancel: failed to SIGTERM process group", { error: errMsg(e) });
      }
      // Clean up progress file so cancelled loop starts fresh on next continue
      if (status.progressFile && SAFE_FILENAME.test(status.progressFile) && !status.progressFile.includes("..")) {
        try { unlinkSync(join(projectDir, status.progressFile)); } catch { /* may not exist */ }
      }
      json(res, { ok: true, killed: status.pid });
    } catch (e: unknown) {
      log.error("failed to kill ralph process", { pid: status.pid, error: errMsg(e) });
      json(res, { error: "failed to kill process" }, 500);
    }
  },

  "POST /api/ralph/dismiss": async (req, res) => {
    const body = await parseBody<{ project?: string; deletePlan?: boolean }>(req, res);
    if (!body) return;
    const { project, deletePlan } = body;
    const projectDir = resolveProjectDir(res, project);
    if (!projectDir) return;
    const status = parseRalphLog(projectDir);
    if (status?.active) {
      return json(res, { error: "cannot dismiss active loop — cancel it first" }, 409);
    }
    if (!status) {
      return json(res, { error: "no ralph log found" }, 404);
    }

    const deleted: string[] = [];
    const failed: string[] = [];

    const tryDelete = (path: string, label: string) => {
      try {
        if (existsSync(path)) { unlinkSync(path); deleted.push(label); }
      } catch (e: unknown) { log.warn(`dismiss: failed to delete ${label}`, { error: errMsg(e) }); failed.push(label); }
    };

    tryDelete(join(projectDir, ".ralph.log"), ".ralph.log");
    tryDelete(join(projectDir, ".ralph.lock"), ".ralph.lock");

    if (status.progressFile && SAFE_FILENAME.test(status.progressFile) && !status.progressFile.includes("..")) {
      tryDelete(join(projectDir, status.progressFile), status.progressFile);
    }

    if (deletePlan && status.planFile) {
      if (SAFE_FILENAME.test(status.planFile) && !status.planFile.includes("..")) {
        tryDelete(join(projectDir, status.planFile), status.planFile);
      } else {
        failed.push(status.planFile);
      }
    }

    // Clean up worktrees if the worktree directory exists
    let worktreeCleanup: { removed: string[]; kept: string } | undefined;
    const worktreeDir = join(projectDir, ".wolfpack", "worktrees");
    if (existsSync(worktreeDir)) {
      try {
        const result = cleanupAllExceptFinal(projectDir);
        if (result.removed.length > 0 || result.kept) {
          worktreeCleanup = result;
        }
      } catch (e: unknown) {
        log.warn("dismiss: worktree cleanup failed", { error: errMsg(e) });
      }
    }

    json(res, { ok: true, deleted, failed, ...(worktreeCleanup && { worktreeCleanup }) });
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

  // ── Agent-triggered notifications ──

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
