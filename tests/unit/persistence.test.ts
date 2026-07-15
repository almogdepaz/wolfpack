import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PersistenceReadError,
  readValidatedJsonFile,
} from "../../src/server/persistence.ts";

interface StoredValue {
  readonly value: string;
}

function isStoredValue(input: unknown): input is StoredValue {
  return typeof input === "object" && input !== null && "value" in input &&
    typeof input.value === "string";
}

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
