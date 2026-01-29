import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function tmuxSessionExists(session: string): Promise<boolean> {
  try {
    await exec("tmux", ["has-session", "-t", session]);
    return true;
  } catch {
    return false;
  }
}

export async function tmuxSendText(
  session: string,
  text: string
): Promise<void> {
  // Use -l (literal) to avoid tmux interpreting special characters
  await exec("tmux", ["send-keys", "-l", "-t", session, text]);
  // Send Enter separately since -l mode doesn't interpret key names
  await exec("tmux", ["send-keys", "-t", session, "Enter"]);
}

export async function tmuxStartPipePane(
  session: string,
  logPath: string
): Promise<void> {
  // Shell-escape the path to prevent injection via tmux's shell execution
  const escaped = logPath.replace(/'/g, "'\\''");
  await exec("tmux", [
    "pipe-pane",
    "-t",
    session,
    `cat >> '${escaped}'`,
  ]);
}

export async function tmuxStopPipePane(session: string): Promise<void> {
  // Empty string disables pipe-pane
  await exec("tmux", ["pipe-pane", "-t", session, ""]);
}

export async function tmuxListSessions(): Promise<string[]> {
  try {
    const { stdout } = await exec("tmux", [
      "list-sessions",
      "-F",
      "#{session_name}",
    ]);
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
