import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { MAX_PROJECT_DIR_LENGTH } from "./validate-project-dir.js";

export const DIRECTORY_BROWSE_LIMIT = 200;

const NOT_FOUND_FILESYSTEM_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

export interface DirectoryBrowseEntry {
  readonly name: string;
  readonly path: string;
}

export interface DirectoryBrowseValue {
  readonly current: string;
  readonly parent: string | null;
  readonly directories: readonly DirectoryBrowseEntry[];
}

export type DirectoryBrowseResult =
  | { readonly ok: true; readonly value: DirectoryBrowseValue }
  | {
      readonly ok: false;
      readonly code: "invalid" | "not_found" | "unavailable";
      readonly error: string;
    };

export function browseServerDirectory(requestedDirectory: string): DirectoryBrowseResult {
  if (
    !requestedDirectory
    || requestedDirectory.length > MAX_PROJECT_DIR_LENGTH
    || requestedDirectory.includes("\0")
    || !isAbsolute(requestedDirectory)
  ) {
    return invalidDirectory();
  }

  try {
    const requestedStat = lstatSync(requestedDirectory);
    if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory()) return invalidDirectory();

    const current = realpathSync(requestedDirectory);
    const parentCandidate = dirname(current);
    const directories: DirectoryBrowseEntry[] = [];
    const directory = opendirSync(current);
    try {
      let entry = directory.readSync();
      while (entry) {
        if (!entry.name.startsWith(".") && entry.isDirectory()) {
          const entryPath = join(current, entry.name);
          try {
            const entryStat = lstatSync(entryPath);
            if (!entryStat.isSymbolicLink() && entryStat.isDirectory()) {
              directories.push({ name: entry.name, path: realpathSync(entryPath) });
              directories.sort(compareDirectoryEntries);
              if (directories.length > DIRECTORY_BROWSE_LIMIT) directories.pop();
            }
          } catch (error: unknown) {
            if (filesystemCode(error) !== "ENOENT") return unavailableDirectory();
          }
        }
        entry = directory.readSync();
      }
    } finally {
      directory.closeSync();
    }

    return {
      ok: true,
      value: {
        current,
        parent: parentCandidate === current ? null : realpathSync(parentCandidate),
        directories,
      },
    };
  } catch (error: unknown) {
    const code = filesystemCode(error);
    if (code && NOT_FOUND_FILESYSTEM_CODES.has(code)) {
      return { ok: false, code: "not_found", error: "directory not found" };
    }
    return unavailableDirectory();
  }
}

function compareDirectoryEntries(left: DirectoryBrowseEntry, right: DirectoryBrowseEntry): number {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

function filesystemCode(error: unknown): string | undefined {
  return error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function invalidDirectory(): DirectoryBrowseResult {
  return { ok: false, code: "invalid", error: "invalid directory" };
}

function unavailableDirectory(): DirectoryBrowseResult {
  return { ok: false, code: "unavailable", error: "directory unavailable" };
}
