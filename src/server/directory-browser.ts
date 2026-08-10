import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";

import { MAX_PROJECT_DIR_LENGTH } from "./validate-project-dir.js";

export const DIRECTORY_BROWSE_LIMIT = 200;
export const DIRECTORY_BROWSE_SCAN_LIMIT = 1_000;
export const DIRECTORY_BREADCRUMB_LIMIT = 12;

const NOT_FOUND_FILESYSTEM_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);
const PERMISSION_DENIED_FILESYSTEM_CODES: ReadonlySet<string> = new Set(["EACCES", "EPERM"]);

export interface DirectoryBrowseEntry {
  readonly name: string;
  readonly path: string;
}

export interface DirectoryBrowseValue {
  readonly current: string;
  readonly parent: string | null;
  readonly breadcrumbs: readonly DirectoryBrowseEntry[];
  readonly directories: readonly DirectoryBrowseEntry[];
}

export type DirectoryBrowseResult =
  | { readonly ok: true; readonly value: DirectoryBrowseValue }
  | {
      readonly ok: false;
      readonly code: "invalid" | "not_found" | "permission_denied" | "too_many_entries" | "unavailable";
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
      let entriesInspected = 0;
      let entry = directory.readSync();
      while (entry) {
        entriesInspected++;
        if (entriesInspected > DIRECTORY_BROWSE_SCAN_LIMIT) return tooManyEntries();
        if (!entry.name.startsWith(".")) {
          const entryPath = join(current, entry.name);
          try {
            const entryStat = lstatSync(entryPath);
            if (!entryStat.isSymbolicLink() && entryStat.isDirectory()) {
              directories.push({ name: entry.name, path: realpathSync(entryPath) });
              directories.sort(compareDirectoryEntries);
              if (directories.length > DIRECTORY_BROWSE_LIMIT) directories.pop();
            }
          } catch (error: unknown) {
            const code = filesystemCode(error);
            if (code !== "ENOENT") {
              if (code && PERMISSION_DENIED_FILESYSTEM_CODES.has(code)) return permissionDeniedDirectory();
              return unavailableDirectory();
            }
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
        breadcrumbs: directoryBreadcrumbs(current),
        directories,
      },
    };
  } catch (error: unknown) {
    const code = filesystemCode(error);
    if (code && NOT_FOUND_FILESYSTEM_CODES.has(code)) {
      return { ok: false, code: "not_found", error: "directory not found" };
    }
    if (code && PERMISSION_DENIED_FILESYSTEM_CODES.has(code)) return permissionDeniedDirectory();
    return unavailableDirectory();
  }
}

function compareDirectoryEntries(left: DirectoryBrowseEntry, right: DirectoryBrowseEntry): number {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

function directoryBreadcrumbs(current: string): readonly DirectoryBrowseEntry[] {
  const root = parse(current).root;
  const relativePath = relative(root, current);
  if (!relativePath) return [{ name: root, path: root }];

  const segments = relativePath.split(sep);
  const truncated = segments.length > DIRECTORY_BREADCRUMB_LIMIT - 1;
  const visibleSegmentCount = truncated ? DIRECTORY_BREADCRUMB_LIMIT - 2 : segments.length;
  const firstVisibleIndex = segments.length - visibleSegmentCount;
  const breadcrumbs: DirectoryBrowseEntry[] = [{ name: root, path: root }];

  if (truncated) {
    breadcrumbs.push({
      name: "…",
      path: join(root, ...segments.slice(0, firstVisibleIndex)),
    });
  }
  for (let index = firstVisibleIndex; index < segments.length; index++) {
    const name = segments[index];
    if (!name) continue;
    breadcrumbs.push({
      name,
      path: join(root, ...segments.slice(0, index + 1)),
    });
  }
  return breadcrumbs;
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

function permissionDeniedDirectory(): DirectoryBrowseResult {
  return { ok: false, code: "permission_denied", error: "directory permission denied" };
}

function tooManyEntries(): DirectoryBrowseResult {
  return {
    ok: false,
    code: "too_many_entries",
    error: "directory contains too many entries",
  };
}

function unavailableDirectory(): DirectoryBrowseResult {
  return { ok: false, code: "unavailable", error: "directory unavailable" };
}
