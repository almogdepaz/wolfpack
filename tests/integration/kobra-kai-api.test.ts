import { describe, expect, test, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskDAG, AdvanceResult, OrchestrationStatus } from "../../src/kobra-kai/types.ts";

// ─── Temp project dir setup ──────────────────────────────────────────────────

const TEST_DEV_DIR = join(tmpdir(), `kobra-kai-test-${Date.now()}`);
const TEST_PROJECT = "test-proj";
const TEST_PROJECT_DIR = join(TEST_DEV_DIR, TEST_PROJECT);

// ─── Mock DAG ────────────────────────────────────────────────────────────────

function makeMockDAG(project = TEST_PROJECT): TaskDAG {
  return {
    tasks: [
      {
        id: "1",
        title: "Task A",
        description: "Do thing A",
        depends_on: [],
        estimated_files: ["a.ts"],
        wave: 0,
        status: "pending" as const,
      },
      {
        id: "2",
        title: "Task B",
        description: "Do thing B",
        depends_on: ["1"],
        estimated_files: ["b.ts"],
        wave: 1,
        status: "pending" as const,
      },
    ],
    waves: [
      { wave: 0, task_ids: ["1"], status: "pending" as const },
      { wave: 1, task_ids: ["2"], status: "pending" as const },
    ],
    metadata: {
      project,
      created_at: new Date().toISOString(),
      source: "decomposed" as const,
    },
  };
}

// ─── Mocks for planner + orchestrate ─────────────────────────────────────────

let mockDAG: TaskDAG | null = null;
let activeOrchestrations = new Set<string>();
let lastLaunchArgs: { projectDir: string; dag: TaskDAG; maxConcurrent: number } | null = null;
let pollerStarted = false;
let lastAdvanceResult: AdvanceResult = "waiting";

const mockDecompose = mock(async (_goal: string, _projectDir: string): Promise<TaskDAG> => {
  const dag = makeMockDAG();
  mockDAG = dag;
  return dag;
});

const mockSchedule = mock(async (_content: string, _projectDir: string): Promise<TaskDAG> => {
  const dag = makeMockDAG();
  mockDAG = dag;
  return dag;
});

const mockLoadDAG = mock(async (_projectDir: string): Promise<TaskDAG | null> => {
  return mockDAG;
});

const mockLaunchOrchestration = mock(async (projectDir: string, dag: TaskDAG, maxConcurrent: number): Promise<void> => {
  lastLaunchArgs = { projectDir, dag, maxConcurrent };
  activeOrchestrations.add(projectDir);
});

const mockAdvanceOrchestration = mock(async (_projectDir: string): Promise<AdvanceResult> => {
  return lastAdvanceResult;
});

const mockGetOrchestrationStatus = mock(async (projectDir: string): Promise<OrchestrationStatus> => {
  const project = projectDir.split("/").pop() ?? "unknown";
  return {
    project,
    status: "active",
    currentWave: 0,
    totalWaves: 2,
    tasks: [
      { id: "1", title: "Task A", status: "in_progress", wave: 0 },
      { id: "2", title: "Task B", status: "pending", wave: 1 },
    ],
    waves: [
      { wave: 0, status: "in_progress" },
      { wave: 1, status: "pending" },
    ],
    activeAgents: 1,
    queuedTasks: 0,
    maxConcurrent: 3,
    startedAt: new Date().toISOString(),
  };
});

const mockCancelOrchestration = mock(async (projectDir: string): Promise<void> => {
  activeOrchestrations.delete(projectDir);
});

const mockStartOrchestrationPoller = mock((): void => {
  pollerStarted = true;
});

const mockGetActiveOrchestrations = (): Set<string> => activeOrchestrations;

// ─── Validation ──────────────────────────────────────────────────────────────

function isValidProjectName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && name !== "." && name !== "..";
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

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
      if (size > MAX_BODY) { req.destroy(); reject(new Error("body too large")); return; }
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

// ─── Routes (kobra-kai subset) ───────────────────────────────────────────────

const routes: Record<
  string,
  (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
> = {
  "POST /api/kobra-kai/plan": async (req, res) => {
    const body = await parseBody<{
      mode?: string;
      goal?: string;
      planFile?: string;
      project?: string;
    }>(req, res);
    if (!body) return;
    const { mode, goal, planFile, project } = body;
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid or missing project" }, 400);
    }
    if (mode !== "decompose" && mode !== "schedule") {
      return json(res, { error: "mode must be 'decompose' or 'schedule'" }, 400);
    }
    const projectDir = join(TEST_DEV_DIR, project);
    if (!existsSync(projectDir)) {
      return json(res, { error: "project not found" }, 404);
    }
    if (mode === "decompose") {
      if (!goal) return json(res, { error: "missing goal for decompose mode" }, 400);
      const dag = await mockDecompose(goal, projectDir);
      return json(res, dag);
    }
    // mode === "schedule"
    if (!planFile) return json(res, { error: "missing planFile for schedule mode" }, 400);
    const planPath = join(projectDir, planFile);
    if (!existsSync(planPath)) {
      return json(res, { error: `plan file '${planFile}' not found` }, 404);
    }
    const { readFileSync } = require("node:fs");
    const content = readFileSync(planPath, "utf-8");
    const dag = await mockSchedule(content, projectDir);
    return json(res, dag);
  },

  "POST /api/kobra-kai/launch": async (req, res) => {
    const body = await parseBody<{
      project?: string;
      maxConcurrent?: number;
    }>(req, res);
    if (!body) return;
    const { project, maxConcurrent: mc } = body;
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid or missing project" }, 400);
    }
    const projectDir = join(TEST_DEV_DIR, project);
    if (!existsSync(projectDir)) {
      return json(res, { error: "project not found" }, 404);
    }
    const dag = await mockLoadDAG(projectDir);
    if (!dag) {
      return json(res, { error: "no task-dag.json found in project" }, 400);
    }
    if (mockGetActiveOrchestrations().has(projectDir)) {
      return json(res, { error: "orchestration already running for this project" }, 409);
    }
    const maxConcurrent = mc ?? 3;
    await mockLaunchOrchestration(projectDir, dag, maxConcurrent);
    mockStartOrchestrationPoller();
    json(res, { ok: true, waves: dag.waves.length, tasks: dag.tasks.length });
  },

  "GET /api/kobra-kai/status": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid or missing project" }, 400);
    }
    const projectDir = join(TEST_DEV_DIR, project);
    const dag = await mockLoadDAG(projectDir);
    if (!dag) {
      return json(res, { error: "no DAG found" }, 404);
    }
    const status = await mockGetOrchestrationStatus(projectDir);
    json(res, status);
  },

  "POST /api/kobra-kai/advance": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid or missing project" }, 400);
    }
    const projectDir = join(TEST_DEV_DIR, project);
    const result = await mockAdvanceOrchestration(projectDir);
    json(res, { result });
  },

  "GET /api/kobra-kai/dag": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid or missing project" }, 400);
    }
    const projectDir = join(TEST_DEV_DIR, project);
    const dag = await mockLoadDAG(projectDir);
    if (!dag) {
      return json(res, { error: "no DAG found" }, 404);
    }
    json(res, dag);
  },

  "POST /api/kobra-kai/cancel": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const project = url.searchParams.get("project");
    if (!project || !isValidProjectName(project)) {
      return json(res, { error: "invalid or missing project" }, 400);
    }
    const projectDir = join(TEST_DEV_DIR, project);
    await mockCancelOrchestration(projectDir);
    json(res, { ok: true });
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

// ─── Test lifecycle ──────────────────────────────────────────────────────────

beforeAll(async () => {
  mkdirSync(TEST_PROJECT_DIR, { recursive: true });
  base = await startTestServer();
});

afterAll(() => {
  server?.close();
  try { rmSync(TEST_DEV_DIR, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  mockDAG = null;
  activeOrchestrations.clear();
  lastLaunchArgs = null;
  pollerStarted = false;
  lastAdvanceResult = "waiting";
  mockDecompose.mockClear();
  mockSchedule.mockClear();
  mockLoadDAG.mockClear();
  mockLaunchOrchestration.mockClear();
  mockAdvanceOrchestration.mockClear();
  mockGetOrchestrationStatus.mockClear();
  mockCancelOrchestration.mockClear();
  mockStartOrchestrationPoller.mockClear();
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

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/kobra-kai/plan", () => {
  test("decompose mode returns DAG", async () => {
    const res = await post("/api/kobra-kai/plan", {
      mode: "decompose",
      goal: "Add auth system",
      project: TEST_PROJECT,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toHaveLength(2);
    expect(data.waves).toHaveLength(2);
    expect(mockDecompose).toHaveBeenCalledTimes(1);
  });

  test("schedule mode returns DAG", async () => {
    // Write a plan file
    writeFileSync(join(TEST_PROJECT_DIR, "PLAN.md"), "## 1. Do stuff\n");
    const res = await post("/api/kobra-kai/plan", {
      mode: "schedule",
      planFile: "PLAN.md",
      project: TEST_PROJECT,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toHaveLength(2);
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  test("missing project → 400", async () => {
    const res = await post("/api/kobra-kai/plan", {
      mode: "decompose",
      goal: "something",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("project");
  });

  test("invalid mode → 400", async () => {
    const res = await post("/api/kobra-kai/plan", {
      mode: "invalid",
      project: TEST_PROJECT,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("mode");
  });

  test("nonexistent project → 404", async () => {
    const res = await post("/api/kobra-kai/plan", {
      mode: "decompose",
      goal: "something",
      project: "no-such-project",
    });
    expect(res.status).toBe(404);
  });

  test("decompose without goal → 400", async () => {
    const res = await post("/api/kobra-kai/plan", {
      mode: "decompose",
      project: TEST_PROJECT,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("goal");
  });

  test("schedule without planFile → 400", async () => {
    const res = await post("/api/kobra-kai/plan", {
      mode: "schedule",
      project: TEST_PROJECT,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("planFile");
  });

  test("schedule with missing plan file → 404", async () => {
    const res = await post("/api/kobra-kai/plan", {
      mode: "schedule",
      planFile: "nonexistent.md",
      project: TEST_PROJECT,
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/kobra-kai/launch", () => {
  test("valid launch returns ok with wave/task counts", async () => {
    mockDAG = makeMockDAG();
    mockLoadDAG.mockImplementation(async () => mockDAG);
    const res = await post("/api/kobra-kai/launch", {
      project: TEST_PROJECT,
      maxConcurrent: 5,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.waves).toBe(2);
    expect(data.tasks).toBe(2);
    expect(mockLaunchOrchestration).toHaveBeenCalledTimes(1);
    expect(mockStartOrchestrationPoller).toHaveBeenCalledTimes(1);
  });

  test("defaults maxConcurrent to 3", async () => {
    mockDAG = makeMockDAG();
    mockLoadDAG.mockImplementation(async () => mockDAG);
    const res = await post("/api/kobra-kai/launch", {
      project: TEST_PROJECT,
    });
    expect(res.status).toBe(200);
    // Check the launch was called with maxConcurrent=3
    expect(lastLaunchArgs?.maxConcurrent).toBe(3);
  });

  test("no DAG → 400", async () => {
    // mockDAG is null by default from beforeEach
    const res = await post("/api/kobra-kai/launch", {
      project: TEST_PROJECT,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("task-dag");
  });

  test("already running → 409", async () => {
    mockDAG = makeMockDAG();
    mockLoadDAG.mockImplementation(async () => mockDAG);
    activeOrchestrations.add(TEST_PROJECT_DIR);
    const res = await post("/api/kobra-kai/launch", {
      project: TEST_PROJECT,
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain("already running");
  });

  test("missing project → 400", async () => {
    const res = await post("/api/kobra-kai/launch", {});
    expect(res.status).toBe(400);
  });
});

describe("GET /api/kobra-kai/status", () => {
  test("returns orchestration status", async () => {
    mockDAG = makeMockDAG();
    mockLoadDAG.mockImplementation(async () => mockDAG);
    const res = await get(`/api/kobra-kai/status?project=${TEST_PROJECT}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.project).toBe(TEST_PROJECT);
    expect(data.status).toBe("active");
    expect(data.tasks).toHaveLength(2);
    expect(data.activeAgents).toBe(1);
  });

  test("no DAG → 404", async () => {
    const res = await get(`/api/kobra-kai/status?project=${TEST_PROJECT}`);
    expect(res.status).toBe(404);
  });

  test("missing project param → 400", async () => {
    const res = await get("/api/kobra-kai/status");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/kobra-kai/advance", () => {
  test("returns advance result", async () => {
    lastAdvanceResult = "spawned";
    const res = await post(`/api/kobra-kai/advance?project=${TEST_PROJECT}`, {});
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result).toBe("spawned");
    expect(mockAdvanceOrchestration).toHaveBeenCalledTimes(1);
  });

  test("missing project → 400", async () => {
    const res = await post("/api/kobra-kai/advance", {});
    expect(res.status).toBe(400);
  });
});

describe("GET /api/kobra-kai/dag", () => {
  test("returns raw DAG", async () => {
    mockDAG = makeMockDAG();
    mockLoadDAG.mockImplementation(async () => mockDAG);
    const res = await get(`/api/kobra-kai/dag?project=${TEST_PROJECT}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toHaveLength(2);
    expect(data.metadata.project).toBe(TEST_PROJECT);
  });

  test("no DAG → 404", async () => {
    const res = await get(`/api/kobra-kai/dag?project=${TEST_PROJECT}`);
    expect(res.status).toBe(404);
  });

  test("missing project → 400", async () => {
    const res = await get("/api/kobra-kai/dag");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/kobra-kai/cancel", () => {
  test("cancels orchestration", async () => {
    activeOrchestrations.add(TEST_PROJECT_DIR);
    const res = await post(`/api/kobra-kai/cancel?project=${TEST_PROJECT}`, {});
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(mockCancelOrchestration).toHaveBeenCalledTimes(1);
  });

  test("missing project → 400", async () => {
    const res = await post("/api/kobra-kai/cancel", {});
    expect(res.status).toBe(400);
  });
});
