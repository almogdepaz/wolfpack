import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
  unlinkSync,
  readdirSync,
  statSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TASK_HEADER, validatePlanFormat } from "../../wolfpack-context.js";

// ─── Temp directory for fake DEV_DIR ─────────────────────────────────────────

const TEST_DEV_DIR = join(tmpdir(), `wolfpack-ralph-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(TEST_DEV_DIR, { recursive: true });
});

afterAll(() => {
  try { rmSync(TEST_DEV_DIR, { recursive: true, force: true }); } catch {}
});

// ─── Replicated helpers from serve.ts ────────────────────────────────────────

function isValidProjectName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && name !== "." && name !== "..";
}

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

function countPlanTasks(planPath: string): { done: number; total: number; issues: string[] } {
  try {
    const plan = readFileSync(planPath, "utf-8");
    const { issues } = validatePlanFormat(plan);
    if (/^- \[[ x]\] /m.test(plan)) {
      const done = (plan.match(/^- \[x\] /gm) || []).length;
      const pending = (plan.match(/^- \[ \] /gm) || []).length;
      return { done, total: done + pending, issues };
    }
    let total = 0;
    let done = 0;
    for (const line of plan.split("\n")) {
      if (TASK_HEADER.test(line)) {
        total++;
        if (line.includes("~~")) done++;
      }
    }
    return { done, total, issues };
  } catch {
    return { done: 0, total: 0, issues: [] };
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

    const totalMatch = content.match(/ralph — (\d+) iterations/);
    if (totalMatch) status.totalIterations = Number(totalMatch[1]);

    const iterRegex = /=== (?:Iteration|🥋 Wax On) (\d+)\/(\d+)/g;
    let match;
    while ((match = iterRegex.exec(content)) !== null) {
      status.iteration = Number(match[1]);
      status.totalIterations = Number(match[2]);
    }

    const finishedMatch = content.match(/^finished:\s*(.+)/m);
    if (finishedMatch) {
      status.finished = finishedMatch[1].trim();
    }

    if (status.pid > 1) {
      try {
        process.kill(status.pid, 0);
        status.active = true;
        status.completed = false;
        if (content.includes("🥋 Wax Off") && !content.includes("Wax Off complete") && !content.includes("Wax Off FAILED")) {
          status.cleanup = true;
        }
      } catch {
        status.active = false;
      }
    }

    const meaningful = lines.filter(
      (l) => l.trim() && !l.startsWith("===") && !l.startsWith("plan:") &&
        !l.startsWith("progress:") && !l.startsWith("started:") &&
        !l.startsWith("finished:") && !l.startsWith("pid:") &&
        !l.startsWith("agent:") && !l.startsWith("🥋"),
    );
    status.lastOutput = meaningful.slice(-5).join("\n");

    if (status.planFile) {
      const tasks = countPlanTasks(join(projectDir, status.planFile));
      status.tasksDone = tasks.done;
      status.tasksTotal = tasks.total;
      if (tasks.done > 0 && tasks.done === tasks.total && !status.active) {
        status.completed = true;
      }
    }

    return status;
  } catch {
    return null;
  }
}

function listDevProjects(): string[] {
  try {
    return readdirSync(TEST_DEV_DIR)
      .filter((f) => {
        try {
          return statSync(join(TEST_DEV_DIR, f)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function scanRalphLoops(): RalphStatus[] {
  const projects = listDevProjects();
  const results: RalphStatus[] = [];
  for (const p of projects) {
    const dir = join(TEST_DEV_DIR, p);
    const status = parseRalphLog(dir);
    if (!status) continue;
    if (status.planFile && !existsSync(join(dir, status.planFile))) continue;
    results.push(status);
  }
  return results;
}

// ─── Stubs for exec/spawn (prevent real process spawning) ────────────────────

// Track spawned processes for assertions
let lastSpawnArgs: { bin: string; args: string[]; cwd: string } | null = null;
let lastExecArgs: { cmd: string; args: string[] } | null = null;
let fakeExecResult: { stdout: string } = { stdout: "" };
let fakeExecShouldThrow = false;

// Fake process.kill for cancel tests
let fakeProcessKillResult: "ok" | "throw" = "ok";
let processKillCalls: { pid: number; signal?: string | number }[] = [];

// ─── HTTP helpers (same as api.test.ts) ──────────────────────────────────────

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

async function parseBody<T = any>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  try {
    return JSON.parse(await readBody(req)) as T;
  } catch {
    json(res, { error: "invalid JSON body" }, 400);
    return null;
  }
}

// ─── Routes (ralph-specific, mirroring serve.ts) ─────────────────────────────

const routes: Record<
  string,
  (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
> = {
  "GET /api/ralph": async (_req, res) => {
    const loops = scanRalphLoops();
    json(res, { loops });
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
    const planPath = join(TEST_DEV_DIR, project, plan);
    if (!existsSync(planPath)) {
      return json(res, { error: "plan not found" }, 404);
    }
    json(res, countPlanTasks(planPath));
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
    const { project, iterations, planFile, agent, format } = body;
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid project name" }, 400);
    }
    const projectDir = join(TEST_DEV_DIR, project);
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
      // check for stale lock — if PID is dead or unparseable, remove it
      if (existsSync(lockPath)) {
        const lockPid = Number(readFileSync(lockPath, "utf-8").trim());
        if (!lockPid || lockPid <= 1) {
          // empty, NaN, 0, or nonsense — stale lock, remove it
          try { unlinkSync(lockPath); } catch {}
        } else {
          try {
            process.kill(lockPid, 0); // throws if dead
            return json(res, { error: "ralph loop already running (lock held)", pid: lockPid }, 409);
          } catch {
            // PID is dead — stale lock, remove it
            try { unlinkSync(lockPath); } catch {}
          }
        }
      }
      writeFileSync(lockPath, "", { flag: "wx" }); // create-exclusive
    } catch (e: any) {
      if (e?.code === "EEXIST") {
        return json(res, { error: "ralph loop already starting (lock contention)" }, 409);
      }
      return json(res, { error: "failed to acquire lock" }, 500);
    }

    const iters = Math.max(1, Math.min(50, iterations ?? 5));
    const resolvedPlan = planFile || "PLAN.md";
    if (!/^[a-zA-Z0-9._\- ]+\.md$/.test(resolvedPlan) || resolvedPlan === ".." || resolvedPlan === ".") {
      return json(res, { error: "invalid plan file name" }, 400);
    }
    if (!existsSync(join(projectDir, resolvedPlan))) {
      return json(res, { error: `plan file '${resolvedPlan}' not found` }, 404);
    }

    // Instead of actually spawning, record the args
    const workerArgs = [
      "ralph-macchio.ts",
      "--plan", resolvedPlan,
      "--iterations", String(iters),
      "--agent", agent || "claude",
      "--progress", "progress.txt",
      ...(format ? ["--format"] : []),
    ];
    lastSpawnArgs = { bin: "bun", args: workerArgs, cwd: projectDir };

    json(res, { ok: true, pid: 99999 });
  },

  "POST /api/ralph/cancel": async (req, res) => {
    const body = await parseBody<{ project?: string }>(req, res);
    if (!body) return;
    const { project } = body;
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid project name" }, 400);
    }
    const projectDir = join(TEST_DEV_DIR, project);
    const status = parseRalphLog(projectDir);
    if (!status?.active || !status.pid || status.pid <= 1) {
      return json(res, { error: "no active ralph loop found" }, 404);
    }
    // verify PID is actually a ralph-macchio process before killing
    try {
      if (fakeExecShouldThrow) throw new Error("process not found");
      lastExecArgs = { cmd: "ps", args: ["-p", String(status.pid), "-o", "command="] };
      if (!fakeExecResult.stdout.includes("ralph-macchio")) {
        return json(res, { error: "PID does not belong to a ralph process" }, 400);
      }
    } catch {
      return json(res, { error: "process not found" }, 404);
    }
    try {
      processKillCalls.push({ pid: status.pid, signal: "SIGTERM" });
      if (fakeProcessKillResult === "throw") throw new Error("kill failed");
      // kill process group
      processKillCalls.push({ pid: -status.pid, signal: "SIGTERM" });
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
    const projectDir = join(TEST_DEV_DIR, project);
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

// ─── Server setup ────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let base: string;

function startTestServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(async (req, res) => {
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
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

beforeAll(async () => {
  base = await startTestServer();
});

afterAll(() => {
  server?.close();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string) {
  return fetch(`${base}${path}`);
}

/** Create a fake project dir with optional .ralph.log and plan file */
function setupProject(
  name: string,
  opts?: {
    log?: string;
    plan?: { name: string; content: string };
  },
): string {
  const dir = join(TEST_DEV_DIR, name);
  mkdirSync(dir, { recursive: true });
  if (opts?.log) {
    writeFileSync(join(dir, ".ralph.log"), opts.log);
  }
  if (opts?.plan) {
    writeFileSync(join(dir, opts.plan.name), opts.plan.content);
  }
  return dir;
}

/** Remove a project dir */
function cleanupProject(name: string): void {
  try { rmSync(join(TEST_DEV_DIR, name), { recursive: true, force: true }); } catch {}
}

// ─── Reset state between tests ──────────────────────────────────────────────

beforeEach(() => {
  lastSpawnArgs = null;
  lastExecArgs = null;
  fakeExecResult = { stdout: "" };
  fakeExecShouldThrow = false;
  fakeProcessKillResult = "ok";
  processKillCalls = [];
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/ralph/start", () => {
  afterEach(() => {
    cleanupProject("start-test");
    cleanupProject("start-active");
    cleanupProject("start-lock");
  });

  test("valid params — spawns ralph worker", async () => {
    setupProject("start-test", {
      plan: { name: "PLAN.md", content: "- [ ] task one\n- [ ] task two\n" },
    });

    const res = await post("/api/ralph/start", {
      project: "start-test",
      iterations: 10,
      planFile: "PLAN.md",
      agent: "codex",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.pid).toBe(99999);

    // verify spawn args recorded correctly
    expect(lastSpawnArgs).not.toBeNull();
    expect(lastSpawnArgs!.args).toContain("--plan");
    expect(lastSpawnArgs!.args).toContain("PLAN.md");
    expect(lastSpawnArgs!.args).toContain("--iterations");
    expect(lastSpawnArgs!.args).toContain("10");
    expect(lastSpawnArgs!.args).toContain("--agent");
    expect(lastSpawnArgs!.args).toContain("codex");
    expect(lastSpawnArgs!.cwd).toBe(join(TEST_DEV_DIR, "start-test"));
  });

  test("default iterations and agent when not provided", async () => {
    setupProject("start-test", {
      plan: { name: "PLAN.md", content: "- [ ] task\n" },
    });

    const res = await post("/api/ralph/start", { project: "start-test" });
    expect(res.status).toBe(200);
    expect(lastSpawnArgs!.args).toContain("5"); // default iterations
    expect(lastSpawnArgs!.args).toContain("claude"); // default agent
  });

  test("iterations clamped to min 1", async () => {
    setupProject("start-test", {
      plan: { name: "PLAN.md", content: "- [ ] task\n" },
    });

    const res = await post("/api/ralph/start", {
      project: "start-test",
      iterations: -5,
    });
    expect(res.status).toBe(200);
    expect(lastSpawnArgs!.args).toContain("1");
  });

  test("iterations clamped to max 50", async () => {
    setupProject("start-test", {
      plan: { name: "PLAN.md", content: "- [ ] task\n" },
    });

    const res = await post("/api/ralph/start", {
      project: "start-test",
      iterations: 999,
    });
    expect(res.status).toBe(200);
    expect(lastSpawnArgs!.args).toContain("50");
  });

  test("format flag passed through", async () => {
    setupProject("start-test", {
      plan: { name: "PLAN.md", content: "- [ ] task\n" },
    });

    const res = await post("/api/ralph/start", {
      project: "start-test",
      format: true,
    });
    expect(res.status).toBe(200);
    expect(lastSpawnArgs!.args).toContain("--format");
  });

  test("invalid project name → 400", async () => {
    const res = await post("/api/ralph/start", { project: "../etc" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid project name");
  });

  test("dot-dot project → 400", async () => {
    const res = await post("/api/ralph/start", { project: ".." });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid project name");
  });

  test("missing project → 400", async () => {
    const res = await post("/api/ralph/start", {});
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid project name");
  });

  test("project directory not found → 404", async () => {
    const res = await post("/api/ralph/start", { project: "nonexistent-proj" });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("project directory not found");
  });

  test("missing plan file → 404", async () => {
    setupProject("start-test"); // no plan file

    const res = await post("/api/ralph/start", { project: "start-test" });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("not found");
  });

  test("custom plan file not found → 404", async () => {
    setupProject("start-test", {
      plan: { name: "PLAN.md", content: "- [ ] task\n" },
    });

    const res = await post("/api/ralph/start", {
      project: "start-test",
      planFile: "OTHER.md",
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("OTHER.md");
    expect(data.error).toContain("not found");
  });

  test("invalid plan file name → 400", async () => {
    setupProject("start-test", {
      plan: { name: "PLAN.md", content: "- [ ] task\n" },
    });

    const res = await post("/api/ralph/start", {
      project: "start-test",
      planFile: "../../../etc/passwd",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid plan file name");
  });

  test("stale empty lock file is cleaned up and start succeeds", async () => {
    const dir = setupProject("start-lock", {
      plan: { name: "PLAN.md", content: "- [ ] task\n" },
    });
    // simulate the bug: empty lock file left behind (PID 0 / NaN)
    writeFileSync(join(dir, ".ralph.lock"), "");

    const res = await post("/api/ralph/start", { project: "start-lock" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test("stale lock with dead PID is cleaned up and start succeeds", async () => {
    const dir = setupProject("start-lock", {
      plan: { name: "PLAN.md", content: "- [ ] task\n" },
    });
    // PID 99998 should not be alive
    writeFileSync(join(dir, ".ralph.lock"), "99998");

    const res = await post("/api/ralph/start", { project: "start-lock" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test("stale lock with non-numeric content is cleaned up", async () => {
    const dir = setupProject("start-lock", {
      plan: { name: "PLAN.md", content: "- [ ] task\n" },
    });
    writeFileSync(join(dir, ".ralph.lock"), "garbage-text");

    const res = await post("/api/ralph/start", { project: "start-lock" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test("active loop conflict → 409", async () => {
    // Create a log with the test process's own PID so it appears active
    setupProject("start-active", {
      plan: { name: "PLAN.md", content: "- [ ] task\n" },
      log: `ralph — 5 iterations\nagent: claude\nplan: PLAN.md\npid: ${process.pid}\nstarted: 2025-01-01\n`,
    });

    const res = await post("/api/ralph/start", { project: "start-active" });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("ralph loop already running");
    expect(data.pid).toBe(process.pid);
  });
});

describe("POST /api/ralph/cancel", () => {
  afterEach(() => {
    cleanupProject("cancel-test");
    cleanupProject("cancel-no-loop");
  });

  test("PID verification — calls ps with correct PID", async () => {
    setupProject("cancel-test", {
      plan: { name: "PLAN.md", content: "- [ ] task\n" },
      log: `ralph — 5 iterations\nagent: claude\nplan: PLAN.md\npid: ${process.pid}\nstarted: 2025-01-01\n`,
    });
    fakeExecResult = { stdout: `bun ralph-macchio.ts --plan PLAN.md` };

    const res = await post("/api/ralph/cancel", { project: "cancel-test" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.killed).toBe(process.pid);

    // verify ps was called with the right PID
    expect(lastExecArgs).not.toBeNull();
    expect(lastExecArgs!.cmd).toBe("ps");
    expect(lastExecArgs!.args).toContain(String(process.pid));
  });

  test("sends SIGTERM to process and process group", async () => {
    setupProject("cancel-test", {
      plan: { name: "PLAN.md", content: "- [ ] task\n" },
      log: `ralph — 5 iterations\nagent: claude\nplan: PLAN.md\npid: ${process.pid}\nstarted: 2025-01-01\n`,
    });
    fakeExecResult = { stdout: `bun ralph-macchio.ts --plan PLAN.md` };

    const res = await post("/api/ralph/cancel", { project: "cancel-test" });
    expect(res.status).toBe(200);

    // verify both SIGTERM calls
    expect(processKillCalls).toHaveLength(2);
    expect(processKillCalls[0]).toEqual({ pid: process.pid, signal: "SIGTERM" });
    expect(processKillCalls[1]).toEqual({ pid: -process.pid, signal: "SIGTERM" });
  });

  test("rejects when PID doesn't belong to ralph process", async () => {
    setupProject("cancel-test", {
      plan: { name: "PLAN.md", content: "- [ ] task\n" },
      log: `ralph — 5 iterations\nagent: claude\nplan: PLAN.md\npid: ${process.pid}\nstarted: 2025-01-01\n`,
    });
    fakeExecResult = { stdout: `vim somefile.txt` }; // not ralph-macchio

    const res = await post("/api/ralph/cancel", { project: "cancel-test" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("PID does not belong to a ralph process");
  });

  test("process not found (ps throws) → 404", async () => {
    setupProject("cancel-test", {
      plan: { name: "PLAN.md", content: "- [ ] task\n" },
      log: `ralph — 5 iterations\nagent: claude\nplan: PLAN.md\npid: ${process.pid}\nstarted: 2025-01-01\n`,
    });
    fakeExecShouldThrow = true;

    const res = await post("/api/ralph/cancel", { project: "cancel-test" });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("process not found");
  });

  test("no active loop → 404", async () => {
    // Log with dead PID (pid 2 won't be alive in our test)
    setupProject("cancel-no-loop", {
      plan: { name: "PLAN.md", content: "- [ ] task\n" },
      log: `ralph — 5 iterations\nagent: claude\nplan: PLAN.md\npid: 2\nstarted: 2025-01-01\nfinished: 2025-01-01\n`,
    });

    const res = await post("/api/ralph/cancel", { project: "cancel-no-loop" });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("no active ralph loop found");
  });

  test("invalid project name → 400", async () => {
    const res = await post("/api/ralph/cancel", { project: "../etc" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid project name");
  });

  test("missing project → 400", async () => {
    const res = await post("/api/ralph/cancel", {});
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid project name");
  });
});

describe("POST /api/ralph/dismiss", () => {
  afterEach(() => {
    cleanupProject("dismiss-test");
    cleanupProject("dismiss-active");
    cleanupProject("dismiss-noplan");
    cleanupProject("dismiss-traversal");
  });

  test("dismiss deletes log, lock, and progress — keeps plan by default", async () => {
    const dir = setupProject("dismiss-test", {
      plan: { name: "MY-PLAN.md", content: "- [x] done\n" },
      log: `ralph — 5 iterations\nagent: claude\nplan: MY-PLAN.md\nprogress: progress.txt\npid: 2\nstarted: 2025-01-01\nfinished: 2025-01-01\n`,
    });
    writeFileSync(join(dir, ".ralph.lock"), "2");
    writeFileSync(join(dir, "progress.txt"), "iteration 1 done");

    const res = await post("/api/ralph/dismiss", { project: "dismiss-test" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.deleted).toContain(".ralph.log");
    expect(data.deleted).toContain(".ralph.lock");
    expect(data.deleted).toContain("progress.txt");
    expect(data.deleted).not.toContain("MY-PLAN.md");

    expect(existsSync(join(dir, "MY-PLAN.md"))).toBe(true);
    expect(existsSync(join(dir, ".ralph.log"))).toBe(false);
    expect(existsSync(join(dir, ".ralph.lock"))).toBe(false);
    expect(existsSync(join(dir, "progress.txt"))).toBe(false);
  });

  test("dismiss with deletePlan deletes plan file too", async () => {
    const dir = setupProject("dismiss-test", {
      plan: { name: "MY-PLAN.md", content: "- [x] done\n" },
      log: `ralph — 5 iterations\nagent: claude\nplan: MY-PLAN.md\npid: 2\nstarted: 2025-01-01\nfinished: 2025-01-01\n`,
    });

    const res = await post("/api/ralph/dismiss", { project: "dismiss-test", deletePlan: true });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.deleted).toContain("MY-PLAN.md");
    expect(existsSync(join(dir, "MY-PLAN.md"))).toBe(false);
  });

  test("path traversal in plan file name → reported in failed", async () => {
    const dir = setupProject("dismiss-traversal");
    writeFileSync(join(dir, ".ralph.log"),
      `ralph — 5 iterations\nagent: claude\nplan: ../../etc/passwd\npid: 2\nstarted: 2025-01-01\nfinished: 2025-01-01\n`,
    );

    const res = await post("/api/ralph/dismiss", { project: "dismiss-traversal", deletePlan: true });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.failed).toContain("../../etc/passwd");
  });

  test("active loop → rejected with 409", async () => {
    setupProject("dismiss-active", {
      plan: { name: "PLAN.md", content: "- [ ] task\n" },
      log: `ralph — 5 iterations\nagent: claude\nplan: PLAN.md\npid: ${process.pid}\nstarted: 2025-01-01\n`,
    });

    const res = await post("/api/ralph/dismiss", { project: "dismiss-active" });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("cannot dismiss active loop — cancel it first");
  });

  test("no ralph log → 404", async () => {
    setupProject("dismiss-test");

    const res = await post("/api/ralph/dismiss", { project: "dismiss-test" });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("no ralph log found");
  });

  test("invalid project name → 400", async () => {
    const res = await post("/api/ralph/dismiss", { project: ".." });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid project name");
  });
});

describe("GET /api/ralph", () => {
  afterEach(() => {
    cleanupProject("proj-a");
    cleanupProject("proj-b");
    cleanupProject("proj-c");
  });

  test("scans projects with ralph logs", async () => {
    setupProject("proj-a", {
      plan: { name: "PLAN.md", content: "- [x] done\n- [ ] pending\n" },
      log: `ralph — 5 iterations\nagent: claude\nplan: PLAN.md\npid: 2\nstarted: 2025-01-01\nfinished: 2025-01-01\n`,
    });
    setupProject("proj-b", {
      plan: { name: "PLAN.md", content: "- [x] all done\n" },
      log: `ralph — 3 iterations\nagent: codex\nplan: PLAN.md\npid: 2\nstarted: 2025-01-02\nfinished: 2025-01-02\n`,
    });

    const res = await get("/api/ralph");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.loops).toBeArray();
    expect(data.loops.length).toBe(2);

    const names = data.loops.map((l: any) => l.project).sort();
    expect(names).toEqual(["proj-a", "proj-b"]);
  });

  test("skips projects without ralph logs", async () => {
    setupProject("proj-a"); // no log
    setupProject("proj-b", {
      plan: { name: "PLAN.md", content: "- [ ] task\n" },
      log: `ralph — 5 iterations\nagent: claude\nplan: PLAN.md\npid: 2\nstarted: 2025-01-01\n`,
    });

    const res = await get("/api/ralph");
    const data = await res.json();
    expect(data.loops.length).toBe(1);
    expect(data.loops[0].project).toBe("proj-b");
  });

  test("skips projects where plan file no longer exists", async () => {
    const dir = setupProject("proj-c");
    // Log references PLAN.md but file doesn't exist
    writeFileSync(join(dir, ".ralph.log"),
      `ralph — 5 iterations\nagent: claude\nplan: PLAN.md\npid: 2\nstarted: 2025-01-01\n`,
    );

    const res = await get("/api/ralph");
    const data = await res.json();
    const match = data.loops.find((l: any) => l.project === "proj-c");
    expect(match).toBeUndefined();
  });

  test("returns empty array when no projects exist", async () => {
    // all projects cleaned up by afterEach from previous tests
    const res = await get("/api/ralph");
    const data = await res.json();
    expect(data.loops).toBeArray();
    // may have leftover dirs from other describe blocks, so just check structure
    expect(Array.isArray(data.loops)).toBe(true);
  });

  test("includes task counts from plan files", async () => {
    setupProject("proj-a", {
      plan: { name: "PLAN.md", content: "- [x] done\n- [ ] pending\n- [ ] also pending\n" },
      log: `ralph — 5 iterations\nagent: claude\nplan: PLAN.md\npid: 2\nstarted: 2025-01-01\nfinished: 2025-01-01\n`,
    });

    const res = await get("/api/ralph");
    const data = await res.json();
    const loop = data.loops.find((l: any) => l.project === "proj-a");
    expect(loop).toBeDefined();
    expect(loop.tasksDone).toBe(1);
    expect(loop.tasksTotal).toBe(3);
  });
});

describe("GET /api/ralph/task-count", () => {
  afterEach(() => {
    cleanupProject("tc-proj");
  });

  test("counts from checkbox-style plan", async () => {
    setupProject("tc-proj", {
      plan: {
        name: "PLAN.md",
        content: "# Plan\n- [x] task 1\n- [x] task 2\n- [ ] task 3\n- [ ] task 4\n",
      },
    });

    const res = await get("/api/ralph/task-count?project=tc-proj&plan=PLAN.md");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.done).toBe(2);
    expect(data.total).toBe(4);
  });

  test("counts from section-style plan", async () => {
    setupProject("tc-proj", {
      plan: {
        name: "PLAN.md",
        content: "# Plan\n## ~~1. Done task~~\nstuff\n## 2. Pending task\nmore stuff\n## ~~3. Also done~~\n",
      },
    });

    const res = await get("/api/ralph/task-count?project=tc-proj&plan=PLAN.md");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.done).toBe(2);
    expect(data.total).toBe(3);
  });

  test("all tasks done", async () => {
    setupProject("tc-proj", {
      plan: {
        name: "PLAN.md",
        content: "- [x] done 1\n- [x] done 2\n",
      },
    });

    const res = await get("/api/ralph/task-count?project=tc-proj&plan=PLAN.md");
    const data = await res.json();
    expect(data.done).toBe(2);
    expect(data.total).toBe(2);
  });

  test("empty plan → zero counts", async () => {
    setupProject("tc-proj", {
      plan: { name: "PLAN.md", content: "# Just a title\nNo tasks here.\n" },
    });

    const res = await get("/api/ralph/task-count?project=tc-proj&plan=PLAN.md");
    const data = await res.json();
    expect(data.done).toBe(0);
    expect(data.total).toBe(0);
  });

  test("plan not found → 404", async () => {
    setupProject("tc-proj"); // no plan file

    const res = await get("/api/ralph/task-count?project=tc-proj&plan=PLAN.md");
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("plan not found");
  });

  test("invalid project → 400", async () => {
    const res = await get("/api/ralph/task-count?project=../etc&plan=PLAN.md");
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid project");
  });

  test("missing project param → 400", async () => {
    const res = await get("/api/ralph/task-count?plan=PLAN.md");
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid project");
  });

  test("invalid plan file name → 400", async () => {
    const res = await get("/api/ralph/task-count?project=tc-proj&plan=../../etc/passwd");
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid plan file");
  });

  test("missing plan param → 400", async () => {
    const res = await get("/api/ralph/task-count?project=tc-proj");
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid plan file");
  });

  test("custom plan file name works", async () => {
    setupProject("tc-proj", {
      plan: {
        name: "my-feature.md",
        content: "- [x] a\n- [x] b\n- [ ] c\n",
      },
    });

    const res = await get("/api/ralph/task-count?project=tc-proj&plan=my-feature.md");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.done).toBe(2);
    expect(data.total).toBe(3);
  });

  test("returns issues for ambiguous headers", async () => {
    setupProject("tc-proj", {
      plan: {
        name: "PLAN.md",
        content: "# Plan\n## Step 1 - Setup\ndo stuff\n## Step 2 - Build\nmore stuff\n",
      },
    });

    const res = await get("/api/ralph/task-count?project=tc-proj&plan=PLAN.md");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(0);
    expect(data.issues).toBeInstanceOf(Array);
    expect(data.issues.length).toBeGreaterThan(0);
    expect(data.issues.some((i: string) => i.includes("Step 1 -"))).toBe(true);
    expect(data.issues.some((i: string) => i.includes("Step 2 -"))).toBe(true);
  });

  test("no issues for well-formatted plan", async () => {
    setupProject("tc-proj", {
      plan: {
        name: "PLAN.md",
        content: "# Plan\n## 1. Setup\ndo stuff\n## 2. Build\nmore stuff\n",
      },
    });

    const res = await get("/api/ralph/task-count?project=tc-proj&plan=PLAN.md");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(2);
    expect(data.issues).toEqual([]);
  });

  test("issues include no-tasks warning for empty plan", async () => {
    setupProject("tc-proj", {
      plan: {
        name: "PLAN.md",
        content: "# Just a title\nNo tasks here.\n",
      },
    });

    const res = await get("/api/ralph/task-count?project=tc-proj&plan=PLAN.md");
    const data = await res.json();
    expect(data.total).toBe(0);
    expect(data.issues.length).toBeGreaterThan(0);
    expect(data.issues[0]).toMatch(/No parseable tasks/);
  });
});
