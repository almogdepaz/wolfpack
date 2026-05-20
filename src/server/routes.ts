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
import { isRalphAgent } from "../ralph-agent.js";
import { isProcessAlive, isRalphProcessAlive } from "../shared/process-cleanup.js";
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
import { DEV_DIR } from "./dev-dir.js";
import { validateProjectDir as validateProjectDirPure } from "./validate-project-dir.js";
import { getBackend, getRouter, DuplicateSessionError } from "./backend.js";
import {
  listDevProjects,
  parseRalphLog,
  pruneStaleRalphLock,
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

/** Validate project directory exists, is not a symlink, and resolves under DEV_DIR.
 *  Thin HTTP wrapper around the pure `validateProjectDirPure` so the security-sensitive
 *  containment logic lives in one tested place. */
function validateProjectDir(res: ServerResponse, projectDir: string): boolean {
  const result = validateProjectDirPure(projectDir);
  if (result.ok) return true;
  json(res, { error: result.error }, result.code === "not_found" ? 404 : 400);
  return false;
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
/** Tests override this with WOLFPACK_SETTINGS_PATH so loadSettings/saveSettings
 *  hit a temp file instead of the user's real ~/.wolfpack/bridge-settings.json.
 *  Resolved at every call so test setup that mutates env mid-process is honored. */
function settingsPath(): string {
  return process.env.WOLFPACK_SETTINGS_PATH || join(homedir(), ".wolfpack", "bridge-settings.json");
}

/** Previous pane content per session — used for content-diff triage. */
const prevPaneContent = new Map<string, string>();

/**
 * Default agent commands shown in a fresh install. Order matters — it's
 * the order they appear in the settings list and the session-create picker.
 * `shell` is the always-on fallback when nothing is enabled, so it sits
 * first.
 */
const DEFAULT_CMDS: ReadonlyArray<{ cmd: string; enabled: boolean }> = [
  { cmd: "shell",  enabled: true },
  { cmd: "claude", enabled: true },
  { cmd: "pi",     enabled: true },
  { cmd: "codex",  enabled: true },
];

interface CmdEntry {
  cmd: string;
  enabled: boolean;
}

interface Settings {
  /** User's selected default agent for new sessions. May be disabled or absent
   *  from `cmds`; `effectiveAgentCmd()` resolves the actual fallback. */
  agentCmd: string;
  /** Full list of known commands. Each toggleable independently. */
  cmds: CmdEntry[];
}

/** A command is valid if it's literally `"shell"` or matches CMD_REGEX. */
function isValidCmd(cmd: string): boolean {
  return cmd === "shell" || CMD_REGEX.test(cmd);
}

export function loadSettings(): Settings {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(settingsPath(), "utf-8")) as Record<string, unknown>;
  } catch { /* expected: settings file doesn't exist yet */ }

  const agentCmd =
    typeof raw.agentCmd === "string" && isValidCmd(raw.agentCmd) ? raw.agentCmd : "shell";

  // New shape: `cmds: [{cmd, enabled}, ...]` — normalize and drop bad entries.
  if (Array.isArray(raw.cmds)) {
    const cmds: CmdEntry[] = [];
    const seen = new Set<string>();
    for (const e of raw.cmds as unknown[]) {
      if (!e || typeof e !== "object") continue;
      const obj = e as Record<string, unknown>;
      if (typeof obj.cmd !== "string" || !isValidCmd(obj.cmd)) continue;
      if (seen.has(obj.cmd)) continue;
      seen.add(obj.cmd);
      cmds.push({ cmd: obj.cmd, enabled: obj.enabled !== false });
    }
    if (cmds.length === 0) return { agentCmd, cmds: DEFAULT_CMDS.map(c => ({ ...c })) };
    return { agentCmd, cmds };
  }

  // Legacy shape (pre-PR): `customCmds: string[]`. Merge with the new defaults
  // so users keep their custom additions without losing the new presets.
  // Migration runs once per settings file — the next saveSettings() rewrites
  // it in the new shape and the legacy branch is never hit again.
  const cmds: CmdEntry[] = DEFAULT_CMDS.map(c => ({ ...c }));
  const seen = new Set(cmds.map(c => c.cmd));
  if (Array.isArray(raw.customCmds)) {
    for (const c of raw.customCmds as unknown[]) {
      if (typeof c !== "string" || !isValidCmd(c) || seen.has(c)) continue;
      seen.add(c);
      cmds.push({ cmd: c, enabled: true });
    }
  }
  return { agentCmd, cmds };
}

function saveSettings(s: Settings): void {
  // Persist exactly what we expose in the API response — a clean { agentCmd, cmds }
  // object. Drop any legacy keys (customCmds) that may still be in the file.
  writeFileSync(settingsPath(), JSON.stringify({ agentCmd: s.agentCmd, cmds: s.cmds }, null, 2));
}

/** Resolve the agent that should actually run for a new session.
 *  Priority: settings.agentCmd if it's enabled → first enabled cmd → "shell". */
export function effectiveAgentCmd(s: Settings): string {
  const enabled = s.cmds.filter(c => c.enabled);
  const requested = enabled.find(c => c.cmd === s.agentCmd);
  if (requested) return requested.cmd;
  if (enabled.length > 0) return enabled[0].cmd;
  return "shell";
}

/** What the session-create picker should show: enabled cmds, or ["shell"] if
 *  the user has disabled everything (always-on fallback). */
export function effectiveCmds(s: Settings): string[] {
  const enabled = s.cmds.filter(c => c.enabled).map(c => c.cmd);
  return enabled.length > 0 ? enabled : ["shell"];
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

        return { name, lastLine, triage };
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
      // Backends accept a `loadSettings` thunk that returns the agent to spawn.
      // Resolve the effective agent (respecting enabled-state + fallbacks) here
      // so the backend never sees a disabled or missing agentCmd.
      const settingsResolver = () => ({ agentCmd: effectiveAgentCmd(loadSettings()) });
      await getBackend().createSession(finalName, projectDir, cmd, settingsResolver);
    } catch (e: unknown) {
      if (e instanceof DuplicateSessionError) {
        return json(res, { error: "session exists", session: finalName, hint: "reconnect or choose a different name" }, 409);
      }
      throw e;
    }
    json(res, { ok: true, session: finalName });
  },

  "GET /api/settings": async (_req, res) => {
    const settings = loadSettings();
    // Surface the effective values so the frontend doesn't reimplement the
    // fallback rules. `effective.cmds` is what the picker should render;
    // `effective.agentCmd` is the pre-selected default.
    //
    // If the stored `settings.agentCmd` points to a disabled command, the
    // runtime already resolves correctly via effectiveAgentCmd(). Normalize
    // the raw field in the response so a future settings-UI consumer that
    // reads `settings.agentCmd` directly doesn't surface a stale/disabled
    // selection. We don't mutate the on-disk settings — just the returned
    // view.
    const enabled = new Set((settings.cmds ?? []).filter((c) => c.enabled).map((c) => c.cmd));
    const view = settings.agentCmd && !enabled.has(settings.agentCmd)
      ? { ...settings, agentCmd: "" }
      : settings;
    json(res, {
      settings: view,
      effective: {
        cmds: effectiveCmds(settings),
        agentCmd: effectiveAgentCmd(settings),
      },
    });
  },

  "POST /api/settings": async (req, res) => {
    // Single endpoint, multiple ops — each is independently optional and
    // applied in order. agentCmd is applied last so it can target a cmd added
    // in the same request. All ops validate strict inputs and reject quietly
    // with 400 on malformed bodies; on success the full settings + effective
    // values are echoed back so the frontend can re-render without a refetch.
    const body = await parseBody<{
      agentCmd?: string;
      addCmd?: string;
      removeCmd?: string;
      setCmdEnabled?: { cmd: string; enabled: boolean };
    }>(req, res);
    if (!body) return;
    const settings = loadSettings();

    if (body.addCmd != null) {
      const cmd = body.addCmd.trim();
      if (!isValidCmd(cmd)) {
        return json(res, { error: "invalid characters in command" }, 400);
      }
      if (!settings.cmds.some(c => c.cmd === cmd)) {
        settings.cmds.push({ cmd, enabled: true });
      }
    }

    if (body.removeCmd != null) {
      const cmd = body.removeCmd;
      settings.cmds = settings.cmds.filter(c => c.cmd !== cmd);
      // If we removed the current default, drop it back to whatever
      // effectiveAgentCmd would resolve next time — setting it to "" lets the
      // resolver fall through to first-enabled → "shell".
      if (settings.agentCmd === cmd) settings.agentCmd = "";
    }

    if (body.setCmdEnabled != null) {
      const target = body.setCmdEnabled;
      if (typeof target.cmd !== "string" || typeof target.enabled !== "boolean") {
        return json(res, { error: "setCmdEnabled requires { cmd: string; enabled: boolean }" }, 400);
      }
      const entry = settings.cmds.find(c => c.cmd === target.cmd);
      if (entry) entry.enabled = target.enabled;
    }

    if (body.agentCmd != null) {
      const cmd = body.agentCmd.trim();
      if (!isValidCmd(cmd)) {
        return json(res, { error: "invalid characters in agent command" }, 400);
      }
      settings.agentCmd = cmd;
    }

    saveSettings(settings);
    json(res, {
      ok: true,
      settings,
      effective: {
        cmds: effectiveCmds(settings),
        agentCmd: effectiveAgentCmd(settings),
      },
    });
  },

  "GET /api/backend": async (_req, res) => {
    const router = getRouter();
    const counts = await router.getSessionCounts();
    json(res, {
      brokerAvailable: router.isBrokerAvailable(),
      counts,
    });
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

  "GET /api/copy-text": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const session = url.searchParams.get("session");
    if (!session) return json(res, { error: "missing session param" }, 400);
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    const text = await getBackend().capturePane(session);
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(text);
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
    } catch (e: unknown) {
      json(res, { error: errMsg(e) || "git status failed" }, 500);
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
    // Only fire transitions for LOCAL loops — each peer machine runs its own
    // /api/ralph poll and fires transitions for its own loops, so feeding
    // peer loops here would double-notify (once per peer per machine).
    checkRalphLoopTransitions(localLoops);
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
    } catch (e: unknown) {
      const msg = (e as { stderr?: string })?.stderr || errMsg(e) || "git not available";
      json(res, { error: msg }, 500);
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
    if (existing && existing.pid > 1) {
      pruneStaleRalphLock(projectDir, existing.pid);
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
      if (isRalphProcessAlive(lockPid)) {
        return json(res, { error: "ralph loop already running (lock held)", pid: lockPid }, 409);
      }
      if (lockPid > 1 && isProcessAlive(lockPid)) {
        // Process at PID exists but is not ralph (PID reuse / unrelated
        // proc). Lock is stale; fall through to remove + retry.
        log.warn("lock PID belongs to unrelated process, removing stale lock", { pid: lockPid });
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
    const VALID_WORKTREE_MODES: readonly (boolean | string)[] = [false, "false", "plan", "task"];
    if (worktree != null && !VALID_WORKTREE_MODES.includes(worktree)) {
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
      } catch (e: unknown) {
        const stderr = (e as { stderr?: string })?.stderr || errMsg(e) || "";
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
      } catch (e: unknown) {
        const stderr = (e as { stderr?: string })?.stderr || errMsg(e) || "branch creation failed";
        return json(res, { error: stderr }, 400);
      }
    }

    if (!existsSync(join(projectDir, resolvedPlan))) {
      return json(res, { error: `plan file '${resolvedPlan}' not found` }, 404);
    }

    // Worktree creation is handled by the worker process itself
    // (plan mode creates one worktree at startup, task mode creates per-iteration).
    // The route only passes the mode flag — the worker manages the lifecycle.

    const selectedAgent = isRalphAgent(agent || "claude") ? (agent || "claude") : "claude";
    const workerArgs = [
      ...RALPH_BIN_ARGS.slice(1),
      "worker",
      "--plan", resolvedPlan,
      "--iterations", String(iters),
      "--agent", selectedAgent,
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
    // Reuse the same PID-reuse-safe filter parseRalphLog applies so the
    // cancel and active-detection paths agree. ps -o command= confirms
    // it's actually a ralph worker, not a reused PID slot.
    if (!isRalphProcessAlive(status.pid)) {
      return json(res, { error: "PID does not belong to a ralph process or process not found" }, 404);
    }
    try {
      process.kill(status.pid, "SIGTERM");
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
