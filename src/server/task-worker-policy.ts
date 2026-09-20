import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

export const TASK_WORKER_POLICY_MAX_BYTES = 64 * 1024;
export const TASK_WORKER_POLICY_MAX_EXTENSIONS = 32;
export const TASK_WORKER_POLICY_MAX_ENV_ENTRIES = 64;
export const TASK_WORKER_POLICY_MAX_ENV_VALUE_LENGTH = 8 * 1024;
export const TASK_WORKER_POLICY_MAX_ENV_BYTES = 32 * 1024;

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const POLICY_KEYS = new Set(["extensionPolicy", "extensions", "env", "piOptions"]);
const RESERVED_ENVIRONMENT_NAMES = new Set([
  "HOME",
  "PATH",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "PI_TASK_WORKER",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_PACKAGE_DIR",
  "WOLFPACK_PORT",
  "WOLFPACK_TASK_WORKER_POLICY_PATH",
  "WOLFPACK_TASK_WORKER_PI_EXECUTABLE",
  "WOLFPACK_TASK_WORKER_PI_TASKS_EXTENSION",
]);

export type TaskWorkerExtensionPolicy = "isolated" | "inherit";
export type TaskWorkerPolicySource = "default" | "host" | "project" | "spawn";
export type TaskWorkerPiThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface TaskWorkerPiOptions {
  readonly thinking?: TaskWorkerPiThinking;
  readonly offline?: boolean;
  readonly verbose?: boolean;
}

export interface TaskWorkerPolicyOverride {
  readonly extensionPolicy?: TaskWorkerExtensionPolicy;
  /** Replaces optional extensions; [] explicitly clears them. */
  readonly extensions?: readonly string[];
  /** A null value explicitly removes the inherited key. */
  readonly env?: Readonly<Record<string, string | null>>;
  /** A null value explicitly removes the inherited option. */
  readonly piOptions?: Readonly<Record<keyof TaskWorkerPiOptions, TaskWorkerPiOptions[keyof TaskWorkerPiOptions] | null>>;
}

export interface TaskWorkerPolicyDiagnostics {
  readonly extensionPolicy: TaskWorkerExtensionPolicy;
  readonly extensions: readonly string[];
  readonly envKeys: readonly string[];
  readonly piOptions: TaskWorkerPiOptions;
  readonly sources: {
    readonly extensionPolicy: TaskWorkerPolicySource;
    readonly extensions: TaskWorkerPolicySource;
    readonly env: Readonly<Record<string, TaskWorkerPolicySource>>;
    readonly piOptions: Readonly<Record<string, TaskWorkerPolicySource>>;
  };
}

export interface ResolvedTaskWorkerPolicy {
  readonly extensionPolicy: TaskWorkerExtensionPolicy;
  /** Includes mandatory Pi Tasks as the first canonical resource. */
  readonly extensions: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly piOptions: TaskWorkerPiOptions;
  readonly diagnostics: TaskWorkerPolicyDiagnostics;
}

export class TaskWorkerPolicyError extends Error {
  constructor(message = "invalid task-worker policy configuration") {
    super(message);
    this.name = "TaskWorkerPolicyError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function policyError(): never {
  throw new TaskWorkerPolicyError();
}

function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function canonicalExtension(path: unknown): string {
  if (typeof path !== "string" || !path || path.length > 4_096 || path.includes("\0") || !isAbsolute(path)) policyError();
  try {
    const canonical = realpathSync(path);
    if (!isReadableFile(canonical)) throw new Error("not a file");
    return canonical;
  } catch {
    throw new TaskWorkerPolicyError("task-worker extension is missing or unreadable");
  }
}

function parseOverride(value: unknown): TaskWorkerPolicyOverride {
  if (!isRecord(value) || Object.keys(value).some((key) => !POLICY_KEYS.has(key))) policyError();
  const result: {
    extensionPolicy?: TaskWorkerExtensionPolicy;
    extensions?: string[];
    env?: Record<string, string | null>;
    piOptions?: Record<keyof TaskWorkerPiOptions, TaskWorkerPiOptions[keyof TaskWorkerPiOptions] | null>;
  } = {};
  if (value.extensionPolicy !== undefined) {
    if (value.extensionPolicy !== "isolated" && value.extensionPolicy !== "inherit") policyError();
    result.extensionPolicy = value.extensionPolicy;
  }
  if (value.extensions !== undefined) {
    if (!Array.isArray(value.extensions) || value.extensions.length > TASK_WORKER_POLICY_MAX_EXTENSIONS) policyError();
    result.extensions = value.extensions.map(canonicalExtension);
  }
  if (value.env !== undefined) {
    if (!isRecord(value.env) || Object.keys(value.env).length > TASK_WORKER_POLICY_MAX_ENV_ENTRIES) policyError();
    const env: Record<string, string | null> = {};
    let totalBytes = 0;
    for (const [name, rawValue] of Object.entries(value.env)) {
      if (!ENVIRONMENT_NAME.test(name) || name.startsWith("WOLFPACK_") || RESERVED_ENVIRONMENT_NAMES.has(name)) policyError();
      if (rawValue !== null && (typeof rawValue !== "string" || rawValue.includes("\0") || rawValue.length > TASK_WORKER_POLICY_MAX_ENV_VALUE_LENGTH)) policyError();
      totalBytes += Buffer.byteLength(name) + (rawValue === null ? 0 : Buffer.byteLength(rawValue));
      if (totalBytes > TASK_WORKER_POLICY_MAX_ENV_BYTES) policyError();
      env[name] = rawValue;
    }
    result.env = env;
  }
  if (value.piOptions !== undefined) {
    if (!isRecord(value.piOptions) || Object.keys(value.piOptions).some((key) => key !== "thinking" && key !== "offline" && key !== "verbose")) policyError();
    const piOptions: Record<keyof TaskWorkerPiOptions, TaskWorkerPiOptions[keyof TaskWorkerPiOptions] | null> = {} as Record<keyof TaskWorkerPiOptions, TaskWorkerPiOptions[keyof TaskWorkerPiOptions] | null>;
    for (const [name, option] of Object.entries(value.piOptions) as Array<[keyof TaskWorkerPiOptions, unknown]>) {
      if (option !== null && (
        (name === "thinking" && (typeof option !== "string" || !THINKING_LEVELS.has(option)))
        || ((name === "offline" || name === "verbose") && typeof option !== "boolean")
      )) policyError();
      piOptions[name] = option as TaskWorkerPiOptions[keyof TaskWorkerPiOptions] | null;
    }
    result.piOptions = piOptions;
  }
  return result;
}

export function taskWorkerShellArgs(shell: string): readonly string[] {
  switch (basename(shell)) {
    case "zsh": return ["-dflic"];
    case "bash": return ["--noprofile", "--norc", "-lic"];
    default: throw new TaskWorkerPolicyError("unsupported task-worker login shell");
  }
}

function policyPath(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env.WOLFPACK_TASK_WORKER_POLICY_PATH;
  if (configured === undefined) return `${homedir()}/.wolfpack/task-worker-policy.json`;
  if (!configured || configured.length > 4_096 || configured.includes("\0") || !isAbsolute(configured)) policyError();
  return configured;
}

function loadHostPolicy(env: Readonly<Record<string, string | undefined>>): { readonly defaults: TaskWorkerPolicyOverride; readonly projects: Readonly<Record<string, TaskWorkerPolicyOverride>> } {
  const path = policyPath(env);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { defaults: {}, projects: {} };
    policyError();
  }
  if (Buffer.byteLength(raw) > TASK_WORKER_POLICY_MAX_BYTES) policyError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    policyError();
  }
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => key !== "defaults" && key !== "projects")) policyError();
  const defaults = parsed.defaults === undefined ? {} : parseOverride(parsed.defaults);
  if (parsed.projects === undefined) return { defaults, projects: {} };
  if (!isRecord(parsed.projects) || Object.keys(parsed.projects).length > 256) policyError();
  const projects: Record<string, TaskWorkerPolicyOverride> = {};
  for (const [project, override] of Object.entries(parsed.projects)) {
    try {
      if (!project || project.includes("\0") || !isAbsolute(project) || resolve(project) !== project || !statSync(project).isDirectory() || realpathSync(project) !== project) policyError();
    } catch {
      policyError();
    }
    projects[project] = parseOverride(override);
  }
  return { defaults, projects };
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

export function parseTaskWorkerPolicyOverride(value: unknown): TaskWorkerPolicyOverride {
  return parseOverride(value);
}

export function resolveTaskWorkerPolicy(
  env: Readonly<Record<string, string | undefined>>,
  projectDir: string,
  mandatoryExtension: string,
  spawnOverride: unknown = undefined,
): ResolvedTaskWorkerPolicy {
  const hostPolicy = loadHostPolicy(env);
  const projectOverride = hostPolicy.projects[projectDir] ?? {};
  const override = spawnOverride === undefined ? {} : parseOverride(spawnOverride);
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

  const extensions = [...new Set([canonicalExtension(mandatoryExtension), ...state.extensions])];
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
