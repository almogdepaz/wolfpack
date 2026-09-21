import { unicodeCodePointLength } from "./session-prompt-contract.js";

export type TaskWorkerExtensionPolicy = "isolated" | "inherit";

export const TASK_WORKER_DEFAULT_EXTENSION_POLICY: TaskWorkerExtensionPolicy = "inherit";
export const TASK_WORKER_POLICY_MAX_BYTES = 64 * 1024;
export const TASK_WORKER_POLICY_MAX_EXTENSIONS = 32;
export const TASK_WORKER_POLICY_MAX_EXTENSION_PATH_LENGTH = 4_096;
export const TASK_WORKER_POLICY_MAX_ENV_ENTRIES = 64;
export const TASK_WORKER_POLICY_MAX_ENV_VALUE_LENGTH = 8 * 1024;
export const TASK_WORKER_POLICY_MAX_ENV_BYTES = 32 * 1024;

export const TASK_WORKER_POLICY_ENVIRONMENT_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";
const ENVIRONMENT_NAME = new RegExp(TASK_WORKER_POLICY_ENVIRONMENT_NAME_PATTERN);
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

export type TaskWorkerPolicySource = "default" | "host" | "project" | "spawn";
export type TaskWorkerPiThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface TaskWorkerPiOptions {
  readonly thinking?: TaskWorkerPiThinking;
  readonly offline?: boolean;
  readonly verbose?: boolean;
}

export interface TaskWorkerSettings {
  readonly extensionPolicy: TaskWorkerExtensionPolicy;
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

/** Validates the narrow public host-default settings payload. */
export function parseTaskWorkerSettings(value: unknown): TaskWorkerSettings {
  if (!isRecord(value) || Object.keys(value).length !== 1 || value.extensionPolicy === undefined) policyError();
  if (value.extensionPolicy !== "isolated" && value.extensionPolicy !== "inherit") policyError();
  return { extensionPolicy: value.extensionPolicy };
}

/** Validates transportable policy data without reading target-host resources. */
export function parseTaskWorkerPolicyOverride(value: unknown): TaskWorkerPolicyOverride {
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
    if (value.extensions.some((path) => typeof path !== "string" || !path || unicodeCodePointLength(path) > TASK_WORKER_POLICY_MAX_EXTENSION_PATH_LENGTH || path.includes("\0") || !path.startsWith("/"))) policyError();
    result.extensions = [...value.extensions];
  }
  if (value.env !== undefined) {
    if (!isRecord(value.env) || Object.keys(value.env).length > TASK_WORKER_POLICY_MAX_ENV_ENTRIES) policyError();
    const env = new Map<string, string | null>();
    let totalBytes = 0;
    for (const [name, rawValue] of Object.entries(value.env)) {
      if (!ENVIRONMENT_NAME.test(name) || name.startsWith("WOLFPACK_") || RESERVED_ENVIRONMENT_NAMES.has(name)) policyError();
      const envValue = rawValue === null
        ? null
        : typeof rawValue === "string"
          ? rawValue
          : policyError();
      if (envValue !== null && (envValue.includes("\0") || unicodeCodePointLength(envValue) > TASK_WORKER_POLICY_MAX_ENV_VALUE_LENGTH)) policyError();
      totalBytes += Buffer.byteLength(name) + (envValue === null ? 0 : Buffer.byteLength(envValue));
      if (totalBytes > TASK_WORKER_POLICY_MAX_ENV_BYTES) policyError();
      env.set(name, envValue);
    }
    result.env = Object.fromEntries(env);
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
