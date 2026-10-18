import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { errMsg } from "../log.js";

/** A slow or prompting rc file must not stall server start (and the service readiness wait). */
const LOGIN_SHELL_PATH_TIMEOUT_MS = 5000;

export interface LoginShellPathOptions {
  readonly shell: string;
  readonly currentPath: string;
  readonly home: string | undefined;
  readonly timeoutMs?: number;
  readonly run?: (file: string, args: readonly string[], options: ExecFileSyncOptions) => string | Buffer;
  readonly exists?: (path: string) => boolean;
}

export type LoginShellPathResult =
  | { readonly path: string; readonly source: "login-shell" }
  | { readonly path: string; readonly source: "fallback"; readonly reason: string };

/**
 * The user's full PATH from their login shell (launchd/systemd PATH is
 * minimal). On any failure, prepend the common user bin dirs that exist.
 */
export function resolveLoginShellPath(options: LoginShellPathOptions): LoginShellPathResult {
  const run = options.run ?? execFileSync;
  let reason: string;
  try {
    const output = run(options.shell, ["-lic", "echo $PATH"], {
      timeout: options.timeoutMs ?? LOGIN_SHELL_PATH_TIMEOUT_MS,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const shellPath = output.toString().trim();
    if (shellPath) return { path: shellPath, source: "login-shell" };
    reason = "login shell printed an empty PATH";
  } catch (error: unknown) {
    reason = errMsg(error);
  }
  const exists = options.exists ?? existsSync;
  const extra = [`${options.home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin"];
  const have = new Set(options.currentPath.split(":"));
  const add = extra.filter(p => !have.has(p) && exists(p));
  return { path: add.length ? [...add, options.currentPath].join(":") : options.currentPath, source: "fallback", reason };
}
