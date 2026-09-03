import type { Dir, Dirent, PathLike, Stats } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";

import { MAX_PROJECT_DIR_LENGTH } from "./validate-project-dir.js";

export const DIRECTORY_BROWSE_LIMIT = 200;
export const DIRECTORY_BROWSE_SCAN_LIMIT = 1_000;
export const DIRECTORY_BREADCRUMB_LIMIT = 12;

// One stalled authorization still leaves capacity for an independent browse.
const DIRECTORY_BROWSE_CONCURRENCY_LIMIT = 2;
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
  | DirectoryBrowseFailure;

type DirectoryBrowseFailure = {
  readonly ok: false;
  readonly code: "invalid" | "not_found" | "permission_denied" | "too_many_entries" | "unavailable";
  readonly error: string;
};

type DirectoryScanResult =
  | { readonly ok: true; readonly directories: readonly DirectoryBrowseEntry[] }
  | DirectoryBrowseFailure;

interface DirectoryBrowserFilesystem {
  readonly lstat: (path: PathLike) => Promise<Stats>;
  readonly opendir: (path: PathLike) => Promise<Dir>;
  readonly realpath: (path: PathLike) => Promise<string>;
}

const NODE_DIRECTORY_BROWSER_FILESYSTEM: DirectoryBrowserFilesystem = {
  lstat,
  opendir,
  realpath,
};

let activeDirectoryBrowses = 0;

export async function browseServerDirectory(
  requestedDirectory: string,
  filesystem: DirectoryBrowserFilesystem = NODE_DIRECTORY_BROWSER_FILESYSTEM,
): Promise<DirectoryBrowseResult> {
  if (
    !requestedDirectory
    || requestedDirectory.length > MAX_PROJECT_DIR_LENGTH
    || requestedDirectory.includes("\0")
    || !isAbsolute(requestedDirectory)
  ) {
    return invalidDirectory();
  }

  if (activeDirectoryBrowses >= DIRECTORY_BROWSE_CONCURRENCY_LIMIT) return unavailableDirectory();
  activeDirectoryBrowses++;

  try {
    const requestedStat = await filesystem.lstat(requestedDirectory);
    if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory()) return invalidDirectory();

    const current = await filesystem.realpath(requestedDirectory);
    const parentCandidate = dirname(current);
    const scanResult = await scanDirectoryEntries(current, filesystem);
    if (!scanResult.ok) return scanResult;

    return {
      ok: true,
      value: {
        current,
        parent: parentCandidate === current ? null : parentCandidate,
        breadcrumbs: directoryBreadcrumbs(current),
        directories: scanResult.directories,
      },
    };
  } catch (error: unknown) {
    const code = filesystemCode(error);
    if (code && NOT_FOUND_FILESYSTEM_CODES.has(code)) {
      return { ok: false, code: "not_found", error: "directory not found" };
    }
    if (code && PERMISSION_DENIED_FILESYSTEM_CODES.has(code)) return permissionDeniedDirectory();
    return unavailableDirectory();
  } finally {
    activeDirectoryBrowses--;
  }
}

async function scanDirectoryEntries(
  current: string,
  filesystem: DirectoryBrowserFilesystem,
): Promise<DirectoryScanResult> {
  const directories: DirectoryBrowseEntry[] = [];
  const directory = await filesystem.opendir(current);
  try {
    let entriesInspected = 0;
    let entry = await directory.read();
    while (entry) {
      entriesInspected++;
      if (entriesInspected > DIRECTORY_BROWSE_SCAN_LIMIT) return tooManyEntries();
      if (!entry.name.startsWith(".")) {
        const entryPath = join(current, entry.name);
        let isDirectory = entry.isDirectory();
        if (!isDirectory && directoryEntryTypeIsUnknown(entry)) {
          try {
            const entryStat = await filesystem.lstat(entryPath);
            isDirectory = !entryStat.isSymbolicLink() && entryStat.isDirectory();
          } catch (error: unknown) {
            const code = filesystemCode(error);
            if (!code || !NOT_FOUND_FILESYSTEM_CODES.has(code)) {
              if (code && PERMISSION_DENIED_FILESYSTEM_CODES.has(code)) return permissionDeniedDirectory();
              return unavailableDirectory();
            }
          }
        }
        if (isDirectory) {
          directories.push({ name: entry.name, path: entryPath });
          directories.sort(compareDirectoryEntries);
          if (directories.length > DIRECTORY_BROWSE_LIMIT) directories.pop();
        }
      }
      entry = await directory.read();
    }
  } finally {
    await directory.close();
  }
  return { ok: true, directories };
}

function directoryEntryTypeIsUnknown(entry: Dirent): boolean {
  return !entry.isFile()
    && !entry.isDirectory()
    && !entry.isBlockDevice()
    && !entry.isCharacterDevice()
    && !entry.isSymbolicLink()
    && !entry.isFIFO()
    && !entry.isSocket();
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

function invalidDirectory(): DirectoryBrowseFailure {
  return { ok: false, code: "invalid", error: "invalid directory" };
}

function permissionDeniedDirectory(): DirectoryBrowseFailure {
  return { ok: false, code: "permission_denied", error: "directory permission denied" };
}

function tooManyEntries(): DirectoryBrowseFailure {
  return {
    ok: false,
    code: "too_many_entries",
    error: "directory contains too many entries",
  };
}

function unavailableDirectory(): DirectoryBrowseFailure {
  return { ok: false, code: "unavailable", error: "directory unavailable" };
}
