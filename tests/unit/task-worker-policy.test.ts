import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  TaskWorkerReadinessError,
  prepareTaskWorkerLaunch,
} from "../../src/server/task-worker-readiness.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-task-worker-policy-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) Bun.spawnSync(["rm", "-rf", root]);
});

describe("task-worker launch policy", () => {
  test("merges host, canonical-project, and spawn policy while retaining mandatory tasks and redacting env values", () => {
    const root = temporaryRoot();
    const project = join(root, "project");
    const executable = join(root, "pi");
    const mandatoryExtension = join(root, "pi-tasks.ts");
    const hostExtension = join(root, "host.ts");
    const projectExtension = join(root, "project.ts");
    const spawnExtension = join(root, "spawn.ts");
    const policyPath = join(root, "task-worker-policy.json");
    Bun.spawnSync(["mkdir", "-p", project]);
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    for (const extension of [mandatoryExtension, hostExtension, projectExtension, spawnExtension]) {
      writeFileSync(extension, "export {};\n");
    }
    writeFileSync(policyPath, JSON.stringify({
      defaults: {
        extensionPolicy: "isolated",
        extensions: [hostExtension],
        env: { HOST_ONLY: "host", SHARED: "host-secret" },
        piOptions: { thinking: "low", verbose: true },
      },
      projects: {
        [realpathSync(project)]: {
          extensionPolicy: "inherit",
          extensions: [projectExtension],
          env: { SHARED: "project-secret", PROJECT_ONLY: "project" },
          piOptions: { thinking: "high", verbose: false },
        },
      },
    }));

    const launch = prepareTaskWorkerLaunch({
      WOLFPACK_TASK_WORKER_PI_EXECUTABLE: executable,
      WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION: mandatoryExtension,
      WOLFPACK_TASK_WORKER_POLICY_PATH: policyPath,
      SHELL: "/bin/zsh",
    }, realpathSync(project), {
      extensions: [spawnExtension],
      env: { SHARED: null, SPAWN_ONLY: "spawn" },
      piOptions: { offline: true },
    });

    expect(launch.extensionPolicy).toBe("inherit");
    expect(launch.extensions).toEqual([realpathSync(mandatoryExtension), realpathSync(spawnExtension)]);
    expect(launch.env).toEqual({ HOST_ONLY: "host", PROJECT_ONLY: "project", SPAWN_ONLY: "spawn" });
    expect(launch.piOptions).toEqual({ thinking: "high", verbose: false, offline: true });
    expect(launch.diagnostics).toEqual({
      extensionPolicy: "inherit",
      extensions: [realpathSync(mandatoryExtension), realpathSync(spawnExtension)],
      envKeys: ["HOST_ONLY", "PROJECT_ONLY", "SPAWN_ONLY"],
      piOptions: { thinking: "high", verbose: false, offline: true },
      sources: {
        extensionPolicy: "project",
        extensions: "spawn",
        env: { HOST_ONLY: "host", PROJECT_ONLY: "project", SPAWN_ONLY: "spawn" },
        piOptions: { thinking: "project", verbose: "project", offline: "spawn" },
      },
    });
  });

  test("rejects reserved env, malformed present policy, and unreadable optional extensions before creation", () => {
    const root = temporaryRoot();
    const executable = join(root, "pi");
    const mandatoryExtension = join(root, "pi-tasks.ts");
    const policyPath = join(root, "task-worker-policy.json");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    writeFileSync(mandatoryExtension, "export {};\n");

    expect(() => prepareTaskWorkerLaunch({
      WOLFPACK_TASK_WORKER_PI_EXECUTABLE: executable,
      WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION: mandatoryExtension,
    }, root, { env: { WOLFPACK_PORT: "9999" } })).toThrow(TaskWorkerReadinessError);

    writeFileSync(policyPath, "{");
    expect(() => prepareTaskWorkerLaunch({
      WOLFPACK_TASK_WORKER_PI_EXECUTABLE: executable,
      WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION: mandatoryExtension,
      WOLFPACK_TASK_WORKER_POLICY_PATH: policyPath,
    }, root)).toThrow("invalid task-worker policy configuration");

    writeFileSync(policyPath, JSON.stringify({ defaults: { extensions: [join(root, "missing.ts")] } }));
    expect(() => prepareTaskWorkerLaunch({
      WOLFPACK_TASK_WORKER_PI_EXECUTABLE: executable,
      WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION: mandatoryExtension,
      WOLFPACK_TASK_WORKER_POLICY_PATH: policyPath,
    }, root)).toThrow("task-worker extension is missing or unreadable");
  });
});
