import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { TaskRelayGateway } from "../../src/task-relay/gateway.ts";
import {
  TaskWorkerReadinessError,
  prepareTaskWorkerLaunch,
  waitForTaskWorkerReadiness,
} from "../../src/server/task-worker-readiness.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-task-worker-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) Bun.spawnSync(["rm", "-rf", root]);
});

describe("task worker launch preflight", () => {
  test("accepts an executable symlink and an explicit readable Pi Tasks extension", () => {
    const root = temporaryRoot();
    const executable = join(root, "pi-real");
    const executableLink = join(root, "pi");
    const extension = join(root, "extension.ts");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    symlinkSync(executable, executableLink);
    writeFileSync(extension, "export default function () {}\n");

    expect(prepareTaskWorkerLaunch({
      WOLFPACK_TASK_WORKER_PI_EXECUTABLE: executableLink,
      WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION: extension,
    })).toEqual({ executable: executableLink, extension });
  });

  test("rejects dangling launch resources before a session can be created", () => {
    const root = temporaryRoot();
    const danglingExecutable = join(root, "pi");
    symlinkSync(join(root, "missing-pi"), danglingExecutable);

    expect(() => prepareTaskWorkerLaunch({
      WOLFPACK_TASK_WORKER_PI_EXECUTABLE: danglingExecutable,
      WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION: join(root, "missing-extension.ts"),
    })).toThrow(TaskWorkerReadinessError);
  });

  test("validates a missing extension after accepting a valid executable", () => {
    const root = temporaryRoot();
    const executable = join(root, "pi");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);

    expect(() => prepareTaskWorkerLaunch({
      WOLFPACK_TASK_WORKER_PI_EXECUTABLE: executable,
      WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION: join(root, "missing-extension.ts"),
    })).toThrow("task-worker Pi Tasks extension is missing or unreadable");
  });

  test("rejects a regular file that is not executable by this process", () => {
    const root = temporaryRoot();
    const executable = join(root, "pi");
    const extension = join(root, "extension.ts");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o001);
    writeFileSync(extension, "export default function () {}\n");

    expect(() => prepareTaskWorkerLaunch({
      WOLFPACK_TASK_WORKER_PI_EXECUTABLE: executable,
      WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION: extension,
    })).toThrow(TaskWorkerReadinessError);
  });
});

describe("task worker readiness", () => {
  test("returns only a live endpoint for the exact session id and project root", async () => {
    const endpoint = { relay: "wolfpack-pi-tasks-v2", id: "e4ef9a6c-90e2-4e08-a74e-904a2e4f59f5" };
    let attempts = 0;
    const result = await waitForTaskWorkerReadiness({
      backend: {
        async inspectSession() {
          return {
            ok: true,
            session: "worker",
            sessionId: "worker-id",
            projectPath: "/worktree",
            harness: "pi",
            alive: true,
          };
        },
      },
      endpointForSession: async () => ++attempts === 2 ? endpoint : undefined,
      sessionId: "worker-id",
      projectDir: "/worktree",
      timeoutMs: 100,
      pollIntervalMs: 0,
    });

    expect(result).toEqual(endpoint);
  });

  test("does not return an endpoint observed after the readiness deadline", async () => {
    let alive = true;
    await expect(waitForTaskWorkerReadiness({
      backend: {
        async inspectSession() {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return {
            ok: true,
            session: "worker",
            sessionId: "worker-id",
            projectPath: "/worktree",
            harness: "pi",
            alive,
          };
        },
        async killSessionById() { alive = false; },
      },
      endpointForSession: async () => ({ relay: "wolfpack-pi-tasks-v2", id: "e4ef9a6c-90e2-4e08-a74e-904a2e4f59f5" }),
      sessionId: "worker-id",
      projectDir: "/worktree",
      timeoutMs: 1,
      pollIntervalMs: 0,
    })).rejects.toMatchObject({
      code: "TASK_WORKER_NOT_READY",
      cleanup: "completed",
    });
  });

  test("rejects final liveness that completes at the absolute deadline", async () => {
    const originalNow = Date.now;
    let now = 0;
    let inspections = 0;
    let alive = true;
    const killed: string[] = [];
    Date.now = () => now;
    try {
      await expect(waitForTaskWorkerReadiness({
        backend: {
          async inspectSession() {
            inspections++;
            const inspection = {
              ok: true as const,
              session: "worker",
              sessionId: "worker-id",
              projectPath: "/worktree",
              harness: "pi",
              alive,
            };
            if (inspections !== 2) return inspection;
            return new Promise((resolve) => queueMicrotask(() => {
              now = 5;
              resolve(inspection);
            }));
          },
          async killSessionById(sessionId) {
            killed.push(sessionId);
            alive = false;
          },
        },
        endpointForSession: async () => ({
          relay: "wolfpack-pi-tasks-v2",
          id: "e4ef9a6c-90e2-4e08-a74e-904a2e4f59f5",
        }),
        sessionId: "worker-id",
        projectDir: "/worktree",
        timeoutMs: 5,
        pollIntervalMs: 0,
      })).rejects.toMatchObject({
        code: "TASK_WORKER_NOT_READY",
        cleanup: "completed",
      });
      expect(killed).toEqual(["worker-id"]);
    } finally {
      Date.now = originalNow;
    }
  });

  test("bounds a readiness inspection that never settles", async () => {
    const outcome = await Promise.race([
      waitForTaskWorkerReadiness({
        backend: {
          inspectSession: async () => new Promise(() => {}),
          async killSessionById() {},
        },
        endpointForSession: async () => undefined,
        sessionId: "worker-id",
        projectDir: "/worktree",
        timeoutMs: 1,
        pollIntervalMs: 0,
        cleanupTimeoutMs: 1,
      }).then(() => "resolved", () => "rejected"),
      new Promise<"test-timeout">((resolve) => setTimeout(() => resolve("test-timeout"), 30)),
    ]);

    expect(outcome).toBe("rejected");
  });

  test("times out a live exact-root worker with no relay endpoint", async () => {
    let alive = true;
    const killed: string[] = [];
    await expect(waitForTaskWorkerReadiness({
      backend: {
        async inspectSession() {
          return {
            ok: true,
            session: "worker",
            sessionId: "worker-id",
            projectPath: "/worktree",
            harness: "pi",
            alive,
          };
        },
        async killSessionById(sessionId) {
          killed.push(sessionId);
          alive = false;
        },
      },
      endpointForSession: async () => undefined,
      sessionId: "worker-id",
      projectDir: "/worktree",
      timeoutMs: 5,
      pollIntervalMs: 0,
    })).rejects.toMatchObject({ code: "TASK_WORKER_NOT_READY", cleanup: "completed" });
    expect(killed).toEqual(["worker-id"]);
  });

  test("rejects expired and foreign relay registrations through the real gateway store", async () => {
    const root = temporaryRoot();
    let now = new Date("2026-01-01T00:00:00.000Z");
    let alive = true;
    const killed: string[] = [];
    const gateway = new TaskRelayGateway({
      root,
      now: () => now,
      inspectSession: async (selector) => {
        if (selector === "foreign") {
          return {
            ok: true,
            session: "foreign",
            sessionId: "foreign-id",
            projectPath: "/worktree",
            harness: "pi",
            alive: true,
          };
        }
        return {
          ok: true,
          session: "worker",
          sessionId: "worker-id",
          projectPath: "/worktree",
          harness: "pi",
          alive,
        };
      },
    });
    try {
      const foreign = await gateway.connect({
        callerSession: "foreign",
        generation: "foreign-generation",
        protocolVersions: [2],
      });
      expect(foreign.ok).toBe(true);
      const expired = await gateway.connect({
        callerSession: "worker",
        generation: "expired-generation",
        protocolVersions: [2],
        leaseMs: 1,
      });
      expect(expired.ok).toBe(true);
      now = new Date(now.getTime() + 2);

      await expect(waitForTaskWorkerReadiness({
        backend: {
          async inspectSession() {
            return {
              ok: true,
              session: "worker",
              sessionId: "worker-id",
              projectPath: "/worktree",
              harness: "pi",
              alive,
            };
          },
          async killSessionById(sessionId) {
            killed.push(sessionId);
            alive = false;
          },
        },
        endpointForSession: (sessionId) => gateway.endpointForSession(sessionId),
        sessionId: "worker-id",
        projectDir: "/worktree",
        timeoutMs: 5,
        pollIntervalMs: 0,
      })).rejects.toMatchObject({ code: "TASK_WORKER_NOT_READY", cleanup: "completed" });
      expect(killed).toEqual(["worker-id"]);
    } finally {
      gateway.close();
    }
  });

  test("reports unconfirmed cleanup when the exact-id kill cannot be verified", async () => {
    await expect(waitForTaskWorkerReadiness({
      backend: {
        async inspectSession() {
          return {
            ok: true,
            session: "worker",
            sessionId: "worker-id",
            projectPath: "/worktree",
            harness: "pi",
            alive: false,
          };
        },
        async killSessionById() {
          throw new Error("broker unavailable");
        },
      },
      endpointForSession: async () => undefined,
      sessionId: "worker-id",
      projectDir: "/worktree",
      timeoutMs: 100,
      pollIntervalMs: 0,
    })).rejects.toMatchObject({
      code: "TASK_WORKER_NOT_READY",
      cleanup: "unconfirmed",
    });
  });

  test("reports ambiguous cleanup verification as unconfirmed", async () => {
    const killed: string[] = [];
    let inspections = 0;
    await expect(waitForTaskWorkerReadiness({
      backend: {
        async inspectSession() {
          inspections++;
          return inspections === 1
            ? {
                ok: true,
                session: "worker",
                sessionId: "worker-id",
                projectPath: "/wrong-root",
                harness: "pi",
                alive: true,
              }
            : { ok: false, code: "AMBIGUOUS" };
        },
        async killSessionById(sessionId) { killed.push(sessionId); },
      },
      endpointForSession: async () => undefined,
      sessionId: "worker-id",
      projectDir: "/worktree",
      timeoutMs: 100,
      pollIntervalMs: 0,
    })).rejects.toMatchObject({
      code: "TASK_WORKER_NOT_READY",
      cleanup: "unconfirmed",
    });
    expect(killed).toEqual(["worker-id"]);
  });

  test("fails and cleans up the exact created id when a reused name resolves elsewhere", async () => {
    const killed: string[] = [];
    let inspected = 0;
    await expect(waitForTaskWorkerReadiness({
      backend: {
        async inspectSession() {
          inspected++;
          return inspected === 1
            ? {
                ok: true,
                session: "worker",
                sessionId: "replacement-id",
                projectPath: "/worktree",
                harness: "pi",
                alive: true,
              }
            : { ok: false, code: "NOT_FOUND" };
        },
        async killSessionById(sessionId) {
          killed.push(sessionId);
        },
      },
      endpointForSession: async () => undefined,
      sessionId: "created-id",
      projectDir: "/worktree",
      timeoutMs: 100,
      pollIntervalMs: 0,
    })).rejects.toMatchObject({
      code: "TASK_WORKER_NOT_READY",
      createdSession: { sessionId: "created-id" },
      cleanup: "completed",
    });
    expect(killed).toEqual(["created-id"]);
  });
});
