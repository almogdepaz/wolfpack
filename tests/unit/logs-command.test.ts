import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeLogLine, parseLogsOptions, rotateLogFile } from "../../src/cli/logs";

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
});
