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
import {
  CMD_REGEX,
  BRANCH_REGEX,
  isValidProjectName,
  isValidSessionName,
  isValidPlanFile,
  clampCols,
  clampRows,
} from "../validation.js";
import { cleanupAllExceptFinal } from "../worktree.js";
import { assets } from "../public-assets.js";
import { isInputPrompt, isJunkLine, type TriageStatus } from "../triage.js";
import { errMsg } from "../shared/process-cleanup.js";
import pkg from "../../package.json";
import {
  DEV_DIR,
  TMUX,
  RALPH_AGENTS,
  isUnderDevDir,
  tmuxList,
  tmuxResize,
  tmuxNewSession,
  capturePane,
  capturePaneForTriage,
  sessionDirMap,
  exec,
} from "./tmux.js";
import {
  listDevProjects,
  parseRalphLog,
  scanRalphLoops,
  countPlanTasks,
} from "./ralph.js";

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
  } catch {
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

const TRIAGE_PRIORITY: Record<TriageStatus, number> = {
  "needs-input": 0,
  "running": 1,
  "idle": 2,
};

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
  } catch {
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
    const activeNames = new Set<string>();
    const results = await Promise.all(
      sessions.map(async (name) => {
        activeNames.add(name);
        const pane = await capturePaneForTriage(name);
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
          // Stable — check last non-junk lines for input prompts
          const tail: string[] = [];
          for (let i = lines.length - 1; i >= 0 && tail.length < 3; i--) {
            if (!isJunkLine(lines[i])) tail.push(lines[i].trim());
          }
          triage = tail.some(isInputPrompt) ? "needs-input" : "idle";
        }

        return { name, lastLine, triage };
      }),
    );
    results.sort((a, b) => TRIAGE_PRIORITY[a.triage] - TRIAGE_PRIORITY[b.triage]);
    json(res, { sessions: results });
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
      const existing = await tmuxList();
      if (existing.includes(customName)) {
        return json(res, { error: "session name already taken" }, 409);
      }
    }
    const projectDir = join(DEV_DIR, folderName);
    if (newProject) {
      try { mkdirSync(projectDir, { recursive: true }); } catch (e: unknown) {
        console.error(`/api/create: failed to create project directory ${projectDir}:`, errMsg(e));
      }
    }
    if (!validateProjectDir(res, projectDir)) return;
    const finalName = customName || await uniqueSessionName(folderName);
    try {
      await tmuxNewSession(finalName, projectDir, cmd, loadSettings);
    } catch (e: any) {
      if (e.code === "DUPLICATE_SESSION") {
        return json(res, { error: "session name already exists" }, 409);
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
    if (!activePtySessions.has(session)) {
      await tmuxResize(session, clampCols(cols), clampRows(rows));
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

  "GET /api/git-status": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const session = url.searchParams.get("session");
    if (!validateProject(res, session)) return;
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    const projectDir = sessionDirMap.get(session);
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
      return json(res, { loops: localLoops });
    }

    const remotePeers = cachedPeers.filter(p => p.name !== selfHost);
    const peerResults = await Promise.all(
      remotePeers.map(async (peer) => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 3000);
          const authHeader = Array.isArray(req.headers.authorization)
            ? req.headers.authorization[0]
            : req.headers.authorization;
          const headers = authHeader ? { Authorization: authHeader } : undefined;
          const r = await fetch(peer.url + "/api/ralph", {
            signal: ctrl.signal,
            headers,
          });
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
    const projectDir = resolveProjectDir(res, project);
    if (!projectDir) return;
    const logPath = join(projectDir, ".ralph.log");
    if (!existsSync(logPath)) {
      return json(res, { error: "no ralph log found" }, 404);
    }
    try {
      const MAX_TAIL = 128 * 1024;
      const fd = openSync(logPath, "r");
      try {
        const size = statSync(logPath).size;
        const offset = Math.max(0, size - MAX_TAIL);
        const buf = Buffer.alloc(Math.min(size, MAX_TAIL));
        readSync(fd, buf, 0, buf.length, offset);
        const content = buf.toString("utf-8");
        const lines = content.split("\n");
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
      cleanup?: boolean;
      auditFix?: boolean;
      worktree?: false | "plan" | "task";
    }>(req, res);
    if (!body) return;
    const { project, iterations, planFile, agent, newBranch, sourceBranch, format, cleanup, auditFix, worktree } = body;
    const projectDir = resolveProjectDir(res, project);
    if (!projectDir) return;
    const existing = parseRalphLog(projectDir);
    if (existing?.active) {
      return json(res, { error: "ralph loop already running", pid: existing.pid }, 409);
    }

    const lockPath = join(projectDir, ".ralph.lock");
    try {
      if (existsSync(lockPath)) {
        const lockPid = Number(readFileSync(lockPath, "utf-8").trim());
        if (!lockPid || lockPid <= 1) {
          try { unlinkSync(lockPath); } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") console.warn(`ralph start: failed to remove invalid lock:`, errMsg(e));
          }
        } else {
          try {
            process.kill(lockPid, 0);
            return json(res, { error: "ralph loop already running (lock held)", pid: lockPid }, 409);
          } catch {
            try { unlinkSync(lockPath); } catch (e: unknown) {
              if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") console.warn(`ralph start: failed to remove stale lock:`, errMsg(e));
            }
          }
        }
      }
      writeFileSync(lockPath, "", { flag: "wx" });
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") {
        return json(res, { error: "ralph loop already starting (lock contention)" }, 409);
      }
      return json(res, { error: "failed to acquire lock" }, 500);
    }

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
    ];
    const child = spawn(RALPH_BIN_ARGS[0], workerArgs, {
      cwd: projectDir,
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    try { writeFileSync(lockPath, String(child.pid ?? 0)); } catch (e: unknown) {
      console.error(`ralph start: failed to write lock file with PID:`, errMsg(e));
    }

    json(res, {
      ok: true,
      pid: child.pid ?? 0,
      branch: newBranch || undefined,
      worktree: worktreeMode !== "false" ? worktreeMode : undefined,
    });
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
    } catch {
      return json(res, { error: "process not found" }, 404);
    }
    try {
      process.kill(status.pid, "SIGTERM");
      try { process.kill(-status.pid, "SIGTERM"); } catch (e: unknown) {
        console.warn(`ralph cancel: failed to SIGTERM process group:`, errMsg(e));
      }
      json(res, { ok: true, killed: status.pid });
    } catch {
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

    const SAFE_FILENAME = /^[a-zA-Z0-9._\- ]+$/;
    const deleted: string[] = [];
    const failed: string[] = [];

    const tryDelete = (path: string, label: string) => {
      try {
        if (existsSync(path)) { unlinkSync(path); deleted.push(label); }
      } catch { failed.push(label); }
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
      } catch {
        // Cleanup failed — not critical
      }
    }

    json(res, { ok: true, deleted, failed, ...(worktreeCleanup && { worktreeCleanup }) });
  },
};
