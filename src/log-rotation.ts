import { copyFileSync, existsSync, renameSync, statSync, truncateSync } from "node:fs";

export const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
export const LOG_RETENTION = 5;
export const LOG_ROTATION_INTERVAL_MS = 10_000;

export function rotateLogFile(
  path: string,
  maxBytes = LOG_ROTATE_BYTES,
  retention = LOG_RETENTION,
): boolean {
  if (!existsSync(path) || statSync(path).size < maxBytes) return false;
  for (let generation = retention; generation >= 2; generation--) {
    const source = `${path}.${generation - 1}`;
    const destination = `${path}.${generation}`;
    if (existsSync(source)) renameSync(source, destination);
  }
  copyFileSync(path, `${path}.1`);
  // Truncation preserves an already-open service-manager file descriptor.
  truncateSync(path, 0);
  return true;
}

export interface LogRotationScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(timer: unknown): void;
}

export interface LogRotationMonitorOptions {
  readonly maxBytes?: number;
  readonly retention?: number;
  readonly intervalMs?: number;
  readonly scheduler?: LogRotationScheduler;
  readonly onError?: (path: string, error: unknown) => void;
}

const defaultScheduler: LogRotationScheduler = {
  setInterval(callback, delayMs) {
    const timer = setInterval(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearInterval(timer) {
    clearInterval(timer as ReturnType<typeof setInterval>);
  },
};

export function startLogRotationMonitor(
  paths: readonly string[],
  options: LogRotationMonitorOptions = {},
): () => void {
  const maxBytes = options.maxBytes ?? LOG_ROTATE_BYTES;
  const retention = options.retention ?? LOG_RETENTION;
  const intervalMs = options.intervalMs ?? LOG_ROTATION_INTERVAL_MS;
  const scheduler = options.scheduler ?? defaultScheduler;
  const onError = options.onError ?? ((path, error) => {
    console.error(`failed to rotate service log ${path}:`, error);
  });

  const rotate = (): void => {
    for (const path of paths) {
      try {
        rotateLogFile(path, maxBytes, retention);
      } catch (error: unknown) {
        onError(path, error);
      }
    }
  };

  rotate();
  const timer = scheduler.setInterval(rotate, intervalMs);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    scheduler.clearInterval(timer);
  };
}
