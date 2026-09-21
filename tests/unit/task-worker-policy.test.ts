import { chmodSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  TaskWorkerReadinessError,
  prepareTaskWorkerLaunch,
} from "../../src/server/task-worker-readiness.ts";
import { unicodeCodePointLength } from "../../src/session-prompt-contract.ts";
import {
  parseTaskWorkerPolicyOverride,
  TASK_WORKER_POLICY_MAX_BYTES,
  TASK_WORKER_POLICY_MAX_ENV_VALUE_LENGTH,
  TASK_WORKER_POLICY_MAX_EXTENSION_PATH_LENGTH,
  TASK_WORKER_POLICY_MAX_EXTENSIONS,
} from "../../src/task-worker-policy-contract.ts";

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
    const unselectedHostExtension = join(root, "host.ts");
    const projectExtension = join(root, "project.ts");
    const spawnExtension = join(root, "spawn.ts");
    const policyPath = join(root, "task-worker-policy.json");
    Bun.spawnSync(["mkdir", "-p", project]);
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    for (const extension of [mandatoryExtension, projectExtension, spawnExtension]) {
      writeFileSync(extension, "export {};\n");
    }
    writeFileSync(policyPath, JSON.stringify({
      defaults: {
        extensionPolicy: "isolated",
        extensions: [unselectedHostExtension],
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

  test("uses inherited discovery for a missing owned policy file while explicit isolation still wins", () => {
    const root = temporaryRoot();
    const executable = join(root, "pi");
    const mandatoryExtension = join(root, "pi-tasks.ts");
    const missingPolicyPath = join(root, "missing-policy.json");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    writeFileSync(mandatoryExtension, "export {};\n");
    const env = {
      WOLFPACK_TASK_WORKER_PI_EXECUTABLE: executable,
      WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION: mandatoryExtension,
      WOLFPACK_TASK_WORKER_POLICY_PATH: missingPolicyPath,
    };

    expect(prepareTaskWorkerLaunch(env, root)).toMatchObject({
      extensionPolicy: "inherit",
      diagnostics: { sources: { extensionPolicy: "default" } },
    });
    expect(prepareTaskWorkerLaunch(env, root, { extensionPolicy: "isolated" })).toMatchObject({
      extensionPolicy: "isolated",
      diagnostics: { sources: { extensionPolicy: "spawn" } },
    });
  });

  test("keeps shared parser extension and env-value boundaries aligned with the published contract", () => {
    const extension = "/" + "x".repeat(TASK_WORKER_POLICY_MAX_EXTENSION_PATH_LENGTH - 1);
    expect(parseTaskWorkerPolicyOverride({
      extensions: Array.from({ length: TASK_WORKER_POLICY_MAX_EXTENSIONS }, () => extension),
      env: { VALUE: "x".repeat(TASK_WORKER_POLICY_MAX_ENV_VALUE_LENGTH) },
    })).toEqual({
      extensions: Array.from({ length: TASK_WORKER_POLICY_MAX_EXTENSIONS }, () => extension),
      env: { VALUE: "x".repeat(TASK_WORKER_POLICY_MAX_ENV_VALUE_LENGTH) },
    });
    expect(() => parseTaskWorkerPolicyOverride({ extensions: Array.from({ length: TASK_WORKER_POLICY_MAX_EXTENSIONS + 1 }, () => extension) })).toThrow();
    expect(() => parseTaskWorkerPolicyOverride({ extensions: ["/" + "x".repeat(TASK_WORKER_POLICY_MAX_EXTENSION_PATH_LENGTH)] })).toThrow();
    expect(() => parseTaskWorkerPolicyOverride({ env: { VALUE: "x".repeat(TASK_WORKER_POLICY_MAX_ENV_VALUE_LENGTH + 1) } })).toThrow();
  });

  test("uses Unicode code-point bounds for policy strings independently of UTF-8 aggregate bytes", () => {
    const exactEnvValue = "x".repeat(TASK_WORKER_POLICY_MAX_ENV_VALUE_LENGTH - 1) + "😀";
    const overEnvValue = exactEnvValue + "😀";
    const reviewerEnvValue = "😀".repeat(4_097);
    const exactExtension = "/" + "x".repeat(TASK_WORKER_POLICY_MAX_EXTENSION_PATH_LENGTH - 2) + "😀";
    const overExtension = exactExtension + "😀";

    expect(unicodeCodePointLength(exactEnvValue)).toBe(TASK_WORKER_POLICY_MAX_ENV_VALUE_LENGTH);
    expect(unicodeCodePointLength(exactExtension)).toBe(TASK_WORKER_POLICY_MAX_EXTENSION_PATH_LENGTH);
    expect(parseTaskWorkerPolicyOverride({ env: { VALUE: exactEnvValue }, extensions: [exactExtension] }))
      .toEqual({ env: { VALUE: exactEnvValue }, extensions: [exactExtension] });
    expect(parseTaskWorkerPolicyOverride({ env: { REVIEWER: reviewerEnvValue } }))
      .toEqual({ env: { REVIEWER: reviewerEnvValue } });
    expect(() => parseTaskWorkerPolicyOverride({ env: { VALUE: overEnvValue } })).toThrow();
    expect(() => parseTaskWorkerPolicyOverride({ extensions: [overExtension] })).toThrow();
  });

  test("preserves __proto__ env set and clear operations with diagnostics", () => {
    const root = temporaryRoot();
    const executable = join(root, "pi");
    const mandatoryExtension = join(root, "pi-tasks.ts");
    const policyPath = join(root, "task-worker-policy.json");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    writeFileSync(mandatoryExtension, "export {};\n");
    writeFileSync(policyPath, '{"defaults":{"env":{"__proto__":"host"}}}');
    const env = {
      WOLFPACK_TASK_WORKER_PI_EXECUTABLE: executable,
      WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION: mandatoryExtension,
      WOLFPACK_TASK_WORKER_POLICY_PATH: policyPath,
    };

    const setLaunch = prepareTaskWorkerLaunch(env, root, JSON.parse('{"env":{"__proto__":"spawn"}}'));
    expect(Object.getOwnPropertyDescriptor(setLaunch.env, "__proto__")?.value).toBe("spawn");
    expect(setLaunch.diagnostics.envKeys).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(setLaunch.diagnostics.sources.env, "__proto__")?.value).toBe("spawn");

    const clearedLaunch = prepareTaskWorkerLaunch(env, root, JSON.parse('{"env":{"__proto__":null}}'));
    expect(clearedLaunch.env).toEqual({});
    expect(clearedLaunch.diagnostics.envKeys).toEqual([]);
    expect(clearedLaunch.diagnostics.sources.env).toEqual({});
  });

  test("enforces final env count and UTF-8 byte limits after cross-layer merging and clearing", () => {
    const root = realpathSync(temporaryRoot());
    const executable = join(root, "pi");
    const mandatoryExtension = join(root, "pi-tasks.ts");
    const policyPath = join(root, "task-worker-policy.json");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    writeFileSync(mandatoryExtension, "export {};\n");
    const env = {
      WOLFPACK_TASK_WORKER_PI_EXECUTABLE: executable,
      WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION: mandatoryExtension,
      WOLFPACK_TASK_WORKER_POLICY_PATH: policyPath,
    };
    const hostCountEnv = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`HOST_${index}`, "h"]));
    const projectCountEnv = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`PROJECT_${index}`, "p"]));
    writeFileSync(policyPath, JSON.stringify({
      defaults: { env: hostCountEnv },
      projects: { [root]: { env: projectCountEnv } },
    }));

    const clearedCount = prepareTaskWorkerLaunch(env, root, { env: { HOST_0: null, SPAWN: "s" } });
    expect(Object.keys(clearedCount.env)).toHaveLength(64);
    expect(() => prepareTaskWorkerLaunch(env, root, { env: { SPAWN: "s" } }))
      .toThrow("invalid task-worker policy configuration");

    const boundaryValue = "é".repeat(4_095) + "x";
    writeFileSync(policyPath, JSON.stringify({
      defaults: { env: { A: boundaryValue, B: boundaryValue } },
      projects: { [root]: { env: { C: boundaryValue } } },
    }));
    expect(prepareTaskWorkerLaunch(env, root, { env: { D: boundaryValue } }).env)
      .toEqual({ A: boundaryValue, B: boundaryValue, C: boundaryValue, D: boundaryValue });
    expect(() => prepareTaskWorkerLaunch(env, root, { env: { D: boundaryValue, E: "x" } }))
      .toThrow("invalid task-worker policy configuration");
  });

  test("treats only absent host policy files as defaults and rejects dangling or oversized present files", () => {
    const root = temporaryRoot();
    const executable = join(root, "pi");
    const mandatoryExtension = join(root, "pi-tasks.ts");
    const policyPath = join(root, "task-worker-policy.json");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    writeFileSync(mandatoryExtension, "export {};\n");
    const env = {
      WOLFPACK_TASK_WORKER_PI_EXECUTABLE: executable,
      WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION: mandatoryExtension,
      WOLFPACK_TASK_WORKER_POLICY_PATH: policyPath,
    };

    expect(prepareTaskWorkerLaunch(env, root).env).toEqual({});
    symlinkSync(join(root, "missing-policy.json"), policyPath);
    expect(() => prepareTaskWorkerLaunch(env, root)).toThrow("invalid task-worker policy configuration");
    Bun.spawnSync(["rm", policyPath]);
    Bun.spawnSync(["mkdir", policyPath]);
    expect(() => prepareTaskWorkerLaunch(env, root)).toThrow("invalid task-worker policy configuration");
    Bun.spawnSync(["rmdir", policyPath]);
    writeFileSync(policyPath, "{}");
    if (process.getuid?.() !== 0) {
      chmodSync(policyPath, 0);
      expect(() => prepareTaskWorkerLaunch(env, root)).toThrow("invalid task-worker policy configuration");
      chmodSync(policyPath, 0o600);
    }
    const exactPolicy = "{}" + " ".repeat(TASK_WORKER_POLICY_MAX_BYTES - 2);
    writeFileSync(policyPath, exactPolicy);
    expect(prepareTaskWorkerLaunch(env, root).env).toEqual({});
    writeFileSync(policyPath, `${exactPolicy} `);
    expect(() => prepareTaskWorkerLaunch(env, root)).toThrow("invalid task-worker policy configuration");
  });

  test("rejects a FIFO policy file before a bounded deadline", async () => {
    const root = temporaryRoot();
    const executable = join(root, "pi");
    const mandatoryExtension = join(root, "pi-tasks.ts");
    const policyPath = join(root, "task-worker-policy.fifo");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    writeFileSync(mandatoryExtension, "export {};\n");
    expect(Bun.spawnSync(["mkfifo", policyPath]).exitCode).toBe(0);
    const script = `
      const { TaskWorkerReadinessError, prepareTaskWorkerLaunch } = await import("./src/server/task-worker-readiness.ts");
      try {
        prepareTaskWorkerLaunch({
          WOLFPACK_TASK_WORKER_PI_EXECUTABLE: ${JSON.stringify(executable)},
          WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION: ${JSON.stringify(mandatoryExtension)},
          WOLFPACK_TASK_WORKER_POLICY_PATH: ${JSON.stringify(policyPath)},
        }, ${JSON.stringify(root)});
        process.exit(1);
      } catch (error) {
        if (
          error instanceof TaskWorkerReadinessError
          && error.code === "TASK_WORKER_PREFLIGHT_FAILED"
          && error.message === "invalid task-worker policy configuration"
        ) process.exit(0);
        console.error(error);
        process.exit(2);
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const exitCode = await Promise.race([
      child.exited,
      new Promise<"deadline">((resolve) => {
        deadline = setTimeout(() => resolve("deadline"), 500);
      }),
    ]);
    if (deadline) clearTimeout(deadline);
    if (exitCode === "deadline") {
      child.kill();
      await child.exited;
    }
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, stderr).toBe(0);
  });

  test.skipIf(process.getuid?.() === 0)("canonicalizes readable optional symlinks and rejects unreadable optional files", () => {
    const root = temporaryRoot();
    const executable = join(root, "pi");
    const mandatoryExtension = join(root, "pi-tasks.ts");
    const extensionTarget = join(root, "extension-target.ts");
    const extensionLink = join(root, "extension-link.ts");
    const unreadableExtension = join(root, "unreadable.ts");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    writeFileSync(mandatoryExtension, "export {};\n");
    writeFileSync(extensionTarget, "export {};\n");
    symlinkSync(extensionTarget, extensionLink);
    writeFileSync(unreadableExtension, "export {};\n");
    chmodSync(unreadableExtension, 0);

    expect(prepareTaskWorkerLaunch({
      WOLFPACK_TASK_WORKER_PI_EXECUTABLE: executable,
      WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION: mandatoryExtension,
      WOLFPACK_TASK_WORKER_POLICY_PATH: join(root, "missing-policy.json"),
    }, root, { extensions: [extensionLink] }).extensions).toEqual([
      realpathSync(mandatoryExtension),
      realpathSync(extensionTarget),
    ]);
    expect(() => prepareTaskWorkerLaunch({
      WOLFPACK_TASK_WORKER_PI_EXECUTABLE: executable,
      WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION: mandatoryExtension,
      WOLFPACK_TASK_WORKER_POLICY_PATH: join(root, "missing-policy.json"),
    }, root, { extensions: [unreadableExtension] })).toThrow("task-worker extension is missing or unreadable");
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
      WOLFPACK_TASK_WORKER_POLICY_PATH: join(root, "missing-policy.json"),
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
