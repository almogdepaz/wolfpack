import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { canonicalReadableRegularFile } from "./task-worker-resource.js";
import { readBoundedTaskWorkerPolicyFile } from "../task-worker-policy-file.js";
import {
  parseTaskWorkerPolicyOverride,
  TASK_WORKER_POLICY_MAX_BYTES,
  TASK_WORKER_POLICY_MAX_ENV_BYTES,
  TASK_WORKER_POLICY_MAX_ENV_ENTRIES,
  TaskWorkerPolicyError,
} from "../task-worker-policy-contract.js";
import type {
  TaskWorkerExtensionPolicy,
  TaskWorkerPiOptions,
  TaskWorkerPolicyDiagnostics,
  TaskWorkerPolicyOverride,
  TaskWorkerPolicySource,
} from "../task-worker-policy-contract.js";

export {
  parseTaskWorkerPolicyOverride,
  TASK_WORKER_POLICY_MAX_BYTES,
  TASK_WORKER_POLICY_MAX_ENV_BYTES,
  TASK_WORKER_POLICY_MAX_ENV_ENTRIES,
  TaskWorkerPolicyError,
} from "../task-worker-policy-contract.js";
export type {
  TaskWorkerExtensionPolicy,
  TaskWorkerPiOptions,
  TaskWorkerPolicyDiagnostics,
  TaskWorkerPolicyOverride,
  TaskWorkerPolicySource,
} from "../task-worker-policy-contract.js";

export interface ResolvedTaskWorkerPolicy {
  readonly extensionPolicy: TaskWorkerExtensionPolicy;
  /** Includes mandatory Pi Tasks as the first canonical resource. */
  readonly extensions: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly piOptions: TaskWorkerPiOptions;
  readonly diagnostics: TaskWorkerPolicyDiagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function policyError(): never {
  throw new TaskWorkerPolicyError();
}

function canonicalExtension(path: string): string {
  const canonical = canonicalReadableRegularFile(path);
  if (canonical === undefined) {
    throw new TaskWorkerPolicyError("task-worker extension is missing or unreadable");
  }
  return canonical;
}

function policyPath(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env.WOLFPACK_TASK_WORKER_POLICY_PATH;
  if (configured === undefined) return `${homedir()}/.wolfpack/task-worker-policy.json`;
  if (!configured || configured.length > 4_096 || configured.includes("\0") || !isAbsolute(configured)) policyError();
  return configured;
}

function loadHostPolicy(env: Readonly<Record<string, string | undefined>>): { readonly defaults: TaskWorkerPolicyOverride; readonly projects: Readonly<Record<string, TaskWorkerPolicyOverride>> } {
  let raw: string | undefined;
  try {
    raw = readBoundedTaskWorkerPolicyFile(policyPath(env));
  } catch {
    policyError();
  }
  if (raw === undefined) return { defaults: {}, projects: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    policyError();
  }
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => key !== "defaults" && key !== "projects")) policyError();
  const defaults = parsed.defaults === undefined ? {} : parseTaskWorkerPolicyOverride(parsed.defaults);
  if (parsed.projects === undefined) return { defaults, projects: {} };
  if (!isRecord(parsed.projects) || Object.keys(parsed.projects).length > 256) policyError();
  const projects: Record<string, TaskWorkerPolicyOverride> = {};
  for (const [project, override] of Object.entries(parsed.projects)) {
    try {
      if (!project || project.includes("\0") || !isAbsolute(project) || resolve(project) !== project || !statSync(project).isDirectory() || realpathSync(project) !== project) policyError();
    } catch {
      policyError();
    }
    projects[project] = parseTaskWorkerPolicyOverride(override);
  }
  return { defaults, projects };
}

function validateEffectiveEnv(env: ReadonlyMap<string, string>): void {
  if (env.size > TASK_WORKER_POLICY_MAX_ENV_ENTRIES) policyError();
  let totalBytes = 0;
  for (const [name, value] of env) {
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (totalBytes > TASK_WORKER_POLICY_MAX_ENV_BYTES) policyError();
  }
}

function applyOverride(
  state: {
    extensionPolicy: TaskWorkerExtensionPolicy;
    extensions: readonly string[];
    env: Map<string, string>;
    piOptions: Map<keyof TaskWorkerPiOptions, TaskWorkerPiOptions[keyof TaskWorkerPiOptions]>;
    extensionPolicySource: TaskWorkerPolicySource;
    extensionsSource: TaskWorkerPolicySource;
    envSources: Map<string, TaskWorkerPolicySource>;
    piOptionSources: Map<string, TaskWorkerPolicySource>;
  },
  override: TaskWorkerPolicyOverride,
  source: TaskWorkerPolicySource,
): void {
  if (override.extensionPolicy !== undefined) {
    state.extensionPolicy = override.extensionPolicy;
    state.extensionPolicySource = source;
  }
  if (override.extensions !== undefined) {
    state.extensions = override.extensions;
    state.extensionsSource = source;
  }
  for (const [name, value] of Object.entries(override.env ?? {})) {
    if (value === null) {
      state.env.delete(name);
      state.envSources.delete(name);
    } else {
      state.env.set(name, value);
      state.envSources.set(name, source);
    }
  }
  for (const [name, value] of Object.entries(override.piOptions ?? {}) as Array<[keyof TaskWorkerPiOptions, TaskWorkerPiOptions[keyof TaskWorkerPiOptions] | null]>) {
    if (value === null) {
      state.piOptions.delete(name);
      state.piOptionSources.delete(name);
    } else {
      state.piOptions.set(name, value);
      state.piOptionSources.set(name, source);
    }
  }
}

export function resolveTaskWorkerPolicy(
  env: Readonly<Record<string, string | undefined>>,
  projectDir: string,
  mandatoryExtension: string,
  spawnOverride: unknown = undefined,
): ResolvedTaskWorkerPolicy {
  const hostPolicy = loadHostPolicy(env);
  const projectOverride = hostPolicy.projects[projectDir] ?? {};
  const override = spawnOverride === undefined ? {} : parseTaskWorkerPolicyOverride(spawnOverride);
  const state = {
    extensionPolicy: "isolated" as TaskWorkerExtensionPolicy,
    extensions: [] as readonly string[],
    env: new Map<string, string>(),
    piOptions: new Map<keyof TaskWorkerPiOptions, TaskWorkerPiOptions[keyof TaskWorkerPiOptions]>(),
    extensionPolicySource: "default" as TaskWorkerPolicySource,
    extensionsSource: "default" as TaskWorkerPolicySource,
    envSources: new Map<string, TaskWorkerPolicySource>(),
    piOptionSources: new Map<string, TaskWorkerPolicySource>(),
  };
  applyOverride(state, hostPolicy.defaults, "host");
  applyOverride(state, projectOverride, "project");
  applyOverride(state, override, "spawn");
  validateEffectiveEnv(state.env);

  const extensions = [...new Set([canonicalExtension(mandatoryExtension), ...state.extensions.map(canonicalExtension)])];
  const sortedEnv = Object.fromEntries([...state.env.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const piOptions = Object.fromEntries(state.piOptions.entries()) as TaskWorkerPiOptions;
  return {
    extensionPolicy: state.extensionPolicy,
    extensions,
    env: sortedEnv,
    piOptions,
    diagnostics: {
      extensionPolicy: state.extensionPolicy,
      extensions,
      envKeys: Object.keys(sortedEnv),
      piOptions,
      sources: {
        extensionPolicy: state.extensionPolicySource,
        extensions: state.extensionsSource,
        env: Object.fromEntries([...state.envSources.entries()].sort(([left], [right]) => left.localeCompare(right))),
        piOptions: Object.fromEntries(state.piOptionSources.entries()),
      },
    },
  };
}
