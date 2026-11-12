/**
 * Shell + agent-command helpers shared across backends.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const _realExec = promisify(execFile);
type ExecFn = (file: string, args: readonly string[], options?: { timeout?: number; encoding?: BufferEncoding; maxBuffer?: number }) => Promise<{ stdout: string; stderr: string }>;
export const exec = _realExec as ExecFn;

// resolve user's shell — Ubuntu defaults to bash, macOS to zsh
export const SHELL = (() => {
  const envShell = process.env.SHELL;
  if (envShell) {
    try { execFileSync("test", ["-x", envShell]); return envShell; } catch { /* probe — shell not executable */ }
  }
  for (const p of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    try { execFileSync("test", ["-x", p]); return p; } catch { /* probe — shell not found */ }
  }
  return "/bin/sh";
})();

export type { ExecFn };
