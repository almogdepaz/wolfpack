/**
 * TmuxBackend — SessionBackend implementation wrapping existing tmux.ts functions.
 */
import type { SessionBackend } from "./backend.js";
import {
  tmuxList,
  tmuxNewSession,
  tmuxResize,
  tmuxSend,
  tmuxSendKey,
  capturePane,
  capturePaneForTriage,
  sessionDirMap,
  cleanupOrphanPtySessions,
  exec,
  TMUX,
} from "./tmux.js";

export class TmuxBackend implements SessionBackend {
  async list(): Promise<string[]> {
    return tmuxList();
  }

  async createSession(
    name: string,
    cwd: string,
    cmd: string | undefined,
    loadSettings: () => { agentCmd: string },
  ): Promise<void> {
    return tmuxNewSession(name, cwd, cmd, loadSettings);
  }

  async killSession(name: string): Promise<void> {
    await exec(TMUX, ["kill-session", "-t", name]);
    sessionDirMap.delete(name);
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await exec(TMUX, ["has-session", "-t", name], { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  async capturePane(name: string): Promise<string> {
    return capturePane(name);
  }

  async capturePaneForTriage(name: string): Promise<string> {
    return capturePaneForTriage(name);
  }

  async resize(name: string, cols: number, rows: number): Promise<void> {
    return tmuxResize(name, cols, rows);
  }

  async send(name: string, text: string, noEnter?: boolean): Promise<void> {
    return tmuxSend(name, text, noEnter);
  }

  async sendKey(name: string, key: string): Promise<void> {
    return tmuxSendKey(name, key);
  }

  sessionDir(name: string): string | undefined {
    return sessionDirMap.get(name);
  }

  async cleanupOrphans(): Promise<void> {
    return cleanupOrphanPtySessions();
  }
}
