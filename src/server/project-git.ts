import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

const CONFIG_OUTPUT = 256 * 1024;
const TIMEOUT_MS = 2000;
const MAX_BUFFER_EXCEEDED = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

export interface ProjectGitResult { code: number; stdout: string; stderr: string; /** Output reached `maxOutput` and the subprocess was stopped; stdout is a prefix. */ overflowed: boolean; }
export interface ProjectGitOptions {
  /** Error prefix, e.g. "Git status" → "Git status unavailable". */
  label: string;
  maxOutput: number;
  /** Resolve a buffer overflow as a stopped prefix instead of rejecting. */
  allowOverflow?: boolean;
}

/**
 * Fixed argv, no shell. Isolated Git configuration, neutralized filter drivers and one
 * overall subprocess deadline shared by every invocation of the returned runner.
 */
export async function openProjectGit(projectPath: string, options: ProjectGitOptions): Promise<(args: string[]) => Promise<ProjectGitResult>> {
  if (!isAbsolute(projectPath) || projectPath.includes("\0")) throw new Error("invalid project directory");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });
  const deadline = performance.now() + TIMEOUT_MS;
  const base = ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null", "-C", projectPath];
  const run = (args: string[], maxBuffer: number, allowOverflow: boolean): Promise<ProjectGitResult> => new Promise((resolve, reject) => {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) { reject(new Error(`${options.label} timed out`)); return; }
    execFile("git", [...base, ...args], { env, timeout: remaining, killSignal: "SIGKILL", maxBuffer, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && allowOverflow && (error.code as unknown) === MAX_BUFFER_EXCEEDED) { resolve({ code: 0, stdout, stderr, overflowed: true }); return; }
      if (error && (error.killed || typeof error.code !== "number")) { reject(new Error(`${options.label} unavailable`)); return; }
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr, overflowed: false });
    });
  });
  // Git may run clean/process filters while checking modified tracked files. Neutralize
  // all configured filter drivers (including conditional includes), not just Git LFS.
  const config = await run(["config", "--includes", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"], CONFIG_OUTPUT, false);
  if (config.code !== 0 && config.code !== 1) throw new Error("Git configuration unavailable");
  const keys = config.stdout.split("\0").filter(Boolean);
  if (keys.length > 256 || keys.some(key => !/^filter\.[^\0\r\n]+\.(clean|process|required)$/.test(key))) throw new Error("Git filter configuration exceeds limit");
  const overrides = [...new Set(keys)].flatMap(key => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`]);
  return args => run([...overrides, ...args], options.maxOutput, options.allowOverflow ?? false);
}
