import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PersistenceReadError,
  readValidatedJsonFile,
  writePrivateJsonFile,
} from "../../src/server/persistence.ts";

interface StoredValue {
  readonly value: string;
}

function isStoredValue(input: unknown): input is StoredValue {
  return typeof input === "object" && input !== null && "value" in input &&
    typeof input.value === "string";
}

describe("private JSON persistence writes", () => {
  test("writes pretty JSON with a newline, private modes, and no leftover temporaries", () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-persistence-write-")), dir = join(root, "private"), path = join(dir, "value.json");
    try {
      writePrivateJsonFile(path, { value: "first" });
      expect(fs.readFileSync(path, "utf8")).toBe('{\n  "value": "first"\n}\n');
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700); expect(fs.statSync(path).mode & 0o777).toBe(0o600);
      writePrivateJsonFile(path, { value: "replacement" });
      expect(fs.readFileSync(path, "utf8")).toBe('{\n  "value": "replacement"\n}\n'); expect(fs.readdirSync(dir)).toEqual(["value.json"]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  test("keeps directory fsync best-effort while actually syncing the private file", () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-persistence-portable-")), path = join(root, "value.json"), sync = fs.fsyncSync, attempts: string[] = [];
    const probe = spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) { attempts.push("directory"); throw Object.assign(new Error("unsupported directory fsync"), { code: "EINVAL" }); }
      attempts.push("file"); sync(fd);
    });
    try { writePrivateJsonFile(path, { value: "portable" }); expect(attempts).toEqual(["file", "directory"]); expect(fs.readFileSync(path, "utf8")).toBe('{\n  "value": "portable"\n}\n'); expect(fs.statSync(path).mode & 0o777).toBe(0o600); expect(fs.readdirSync(root)).toEqual(["value.json"]); }
    finally { probe.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  test("failed file fsync leaves the previous JSON intact and cleans up the temporary fd/file", () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-persistence-failed-")), path = join(root, "value.json"); writePrivateJsonFile(path, { value: "old" });
    let failedFd: number | undefined;
    const probe = spyOn(fs, "fsyncSync").mockImplementation(fd => { failedFd = fd; expect(fs.fstatSync(fd).isFile()).toBe(true); throw new Error("file fsync failed"); });
    try { expect(() => writePrivateJsonFile(path, { value: "new" })).toThrow("file fsync failed"); expect(fs.readFileSync(path, "utf8")).toBe('{\n  "value": "old"\n}\n'); expect(fs.readdirSync(root)).toEqual(["value.json"]); expect(failedFd).toBeDefined(); expect(() => fs.fstatSync(failedFd!)).toThrow(); }
    finally { probe.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe("validated JSON persistence reads", () => {
  test("treats only a missing file as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "wolfpack-persistence-"));
    expect(readValidatedJsonFile(join(dir, "missing.json"), "test", isStoredValue)).toBeNull();
  });

  test("classifies invalid JSON and invalid shapes as malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "wolfpack-persistence-"));
    const malformedPath = join(dir, "malformed.json");
    const invalidPath = join(dir, "invalid.json");
    writeFileSync(malformedPath, "{not-json");
    writeFileSync(invalidPath, JSON.stringify({ value: 42 }));

    for (const path of [malformedPath, invalidPath]) {
      try {
        readValidatedJsonFile(path, "test", isStoredValue);
        throw new Error("expected persistence read to fail");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(PersistenceReadError);
        expect((error as PersistenceReadError).failure).toBe("malformed");
      }
    }
  });

  test("classifies non-ENOENT read failures as unreadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "wolfpack-persistence-"));
    const directoryPath = join(dir, "not-a-file.json");
    mkdirSync(directoryPath);

    try {
      readValidatedJsonFile(directoryPath, "test", isStoredValue);
      throw new Error("expected persistence read to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PersistenceReadError);
      expect((error as PersistenceReadError).failure).toBe("unreadable");
    }
  });
});
