/**
 * Graceful shutdown: tell attached viewers the server is restarting (1012)
 * before the process exits, so clients can show "server restarting" instead
 * of a generic connection drop.
 */
import type { WebSocketServer } from "ws";
import { CLOSE_CODE_SERVICE_RESTART, WS_CLOSE_REASONS } from "../ws-constants.js";
import { createLogger, errMsg } from "../log.js";

const log = createLogger("server");

/** Upper bound on how long shutdown waits for close handshakes. */
export const SHUTDOWN_CLOSE_DEADLINE_MS = 1_000;

export interface ShutdownSocket {
  close(code: number, reason: string): void;
  once(event: "close", listener: () => void): unknown;
  terminate(): void;
}

/** Close every socket with 1012; resolves when all have closed or at the deadline. */
export function closeWebSocketsForShutdown(
  sockets: Iterable<ShutdownSocket>,
  deadlineMs = SHUTDOWN_CLOSE_DEADLINE_MS,
): Promise<void> {
  const pending = Array.from(sockets);
  if (pending.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let open = pending.length;
    const finish = (): void => {
      clearTimeout(deadline);
      resolve();
    };
    const deadline = setTimeout(() => {
      for (const socket of pending) {
        try { socket.terminate(); } catch { /* already gone */ }
      }
      resolve();
    }, deadlineMs);
    for (const socket of pending) {
      socket.once("close", () => { if (--open === 0) finish(); });
      try {
        socket.close(CLOSE_CODE_SERVICE_RESTART, WS_CLOSE_REASONS.SERVICE_RESTART);
      } catch (e: unknown) {
        log.debug("shutdown: viewer close failed", { error: errMsg(e) });
      }
    }
  });
}

/**
 * On SIGTERM/SIGINT, close viewers with 1012 and then re-raise the signal
 * with default handling so the exit status is unchanged.
 */
export function installShutdownSignalHandlers(wss: WebSocketServer): void {
  const onSignal = (signal: NodeJS.Signals): void => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    log.info("shutting down", { signal, viewers: wss.clients.size });
    void closeWebSocketsForShutdown(wss.clients).finally(() => process.kill(process.pid, signal));
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}
