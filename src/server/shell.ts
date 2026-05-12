/**
 * Shell + agent-command helpers shared across backends.
 * Split out of tmux.ts so non-tmux call sites don't pull in the tmux module.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const _realExec = promisify(execFile);
type ExecFn = (file: string, args: readonly string[], options?: { timeout?: number; encoding?: BufferEncoding; maxBuffer?: number }) => Promise<{ stdout: string; stderr: string }>;
let _execOverride: ExecFn | null = null;

export const exec: ExecFn = ((file, args, options) =>
  (_execOverride || (_realExec as unknown as ExecFn))(file, args, options)) as ExecFn;

export function __setExecOverride(fn: ExecFn | null): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__setExecOverride() is only available in test mode");
  _execOverride = fn;
}

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

export const RALPH_AGENTS = new Set(["claude", "codex", "gemini", "cursor"]);

export function detectAgent(agentCmd: string): "claude" | "gemini" | "codex" | "cursor" | null {
  for (const agent of RALPH_AGENTS) {
    if (new RegExp(`^${agent}\\b`).test(agentCmd)) return agent as "claude" | "gemini" | "codex" | "cursor";
  }
  return null;
}

export type { ExecFn };
