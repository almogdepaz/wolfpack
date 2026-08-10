import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeLogLine, parseLogsOptions, rotateLogFile } from "../../src/cli/logs";
import { LOG_ROTATION_INTERVAL_MS, startLogRotationMonitor } from "../../src/log-rotation";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("logs CLI", () => {
  test("parses only bounded explicit options", () => {
    expect(parseLogsOptions(["--follow", "--json"])).toEqual({ follow: true, json: true, broker: false });
    expect(parseLogsOptions(["--wat"])).toBeNull();
  });
  test("normalizes JSON and plain service output", () => {
    expect(normalizeLogLine('{"level":"info"}')).toEqual({ level: "info" });
    expect(normalizeLogLine("broker started")).toEqual({ raw: "broker started" });
  });
  test("rotates by bytes and retains bounded generations", () => {
    const dir = mkdtempSync(join(tmpdir(), "wolfpack-logs-")); dirs.push(dir);
    const path = join(dir, "wolfpack.log");
    for (const value of ["one", "two", "three"]) {
      writeFileSync(path, value);
      expect(rotateLogFile(path, 1, 2)).toBe(true);
    }
    expect(readFileSync(path, "utf-8")).toBe("");
    expect(readFileSync(`${path}.1`, "utf-8")).toBe("three");
    expect(readFileSync(`${path}.2`, "utf-8")).toBe("two");
  });

  test("keeps rotating live service logs without a service restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "wolfpack-log-monitor-")); dirs.push(dir);
    const path = join(dir, "broker.log");
    const callbacks: Array<() => void> = [];
    const cleared: unknown[] = [];
    writeFileSync(path, "first");

    const stop = startLogRotationMonitor([path], {
      maxBytes: 1,
      retention: 2,
      scheduler: {
        setInterval(callback, delayMs) {
          expect(delayMs).toBe(LOG_ROTATION_INTERVAL_MS);
          callbacks.push(callback);
          return "rotation-timer";
        },
        clearInterval(timer) { cleared.push(timer); },
      },
    });

    expect(readFileSync(path, "utf-8")).toBe("");
    expect(readFileSync(`${path}.1`, "utf-8")).toBe("first");
    writeFileSync(path, "second");
    callbacks[0]?.();
    expect(readFileSync(path, "utf-8")).toBe("");
    expect(readFileSync(`${path}.1`, "utf-8")).toBe("second");
    expect(readFileSync(`${path}.2`, "utf-8")).toBe("first");

    stop();
    expect(cleared).toEqual(["rotation-timer"]);
  });
});
