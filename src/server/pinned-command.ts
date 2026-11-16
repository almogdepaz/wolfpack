import { SHELL } from "./shell.js";

/** One exec-only wrapper is used for pinned/task-worker launches and their broker-recorded provenance. */
export const EXEC_SESSION_COMMAND = '{ setopt nonotify nomonitor 2>/dev/null; set +m 2>/dev/null; } ; clear; exec "$@"';
export function recordedPinnedCommand(command: readonly string[] | undefined): readonly string[] | undefined {
  return command && command.length >= 5 && command[0] === SHELL && command[1] === "-lic"
    && command[2] === EXEC_SESSION_COMMAND && command[3] === "wolfpack-agent" ? command.slice(4) : undefined;
}
