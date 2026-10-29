#!/usr/bin/env bun
/**
 * Keeps the static homepage's content-hashed filenames honest.
 *
 * Managed files: `site/*.css`, `site/*.js` and everything in `site/assets/`.
 * Each is named `<stem>.<first 16 hex of sha256(bytes)>.<ext>`. The only
 * unhashed exception is `assets/wolfpack-icon.svg`, a byte-equal compatibility
 * copy that `public/index.html` loads by its canonical URL.
 *
 * Run: bun run site:assets          # hash new/edited files, drop stale siblings, rewrite site/index.html
 *      bun run site:check           # verify names, hashes, references and git visibility; non-zero on drift
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export const CANONICAL_HOMEPAGE_URL = "https://almogdepaz.github.io/wolfpack/";
const ASSETS_DIRECTORY = "assets";
const ROOT_MANAGED_EXTENSIONS = new Set([".css", ".js"]);
/** Unhashed copies that must stay byte-equal to their hashed sibling. */
const COMPATIBILITY_FILES = new Set(["assets/wolfpack-icon.svg"]);
const REFERENCE_ATTRIBUTES = ["href", "src", "poster", "content", "srcset"] as const;
const HASH_LENGTH = 16;
const HASHED_NAME = new RegExp(`^(.+)\\.([0-9a-f]{${HASH_LENGTH}})(\\.[^.]+)$`);
const PLAIN_NAME = /^(.+?)(\.[^.]+)$/;

interface ManagedFile {
  /** Path relative to the site root, e.g. `assets/desktop-sessions.0123456789abcdef.png`. */
  readonly path: string;
  /** Hash encoded in the name, or undefined for an unhashed file. */
  readonly encodedHash: string | undefined;
}

interface AssetGroup {
  /** `<directory>/<stem><ext>`, e.g. `assets/desktop-sessions.png` or `styles.css`. */
  readonly key: string;
  readonly directory: string;
  readonly stem: string;
  readonly extension: string;
  readonly hashed: ManagedFile[];
  readonly unhashed: ManagedFile[];
}

export interface CheckOptions {
  /** Repository root for the `git check-ignore --no-index` visibility check; skipped when absent. */
  readonly gitRoot?: string;
  /** Additional repository-relative files that must not be git-ignored (e.g. docs media). */
  readonly extraVisiblePaths?: readonly string[];
}

export interface NormalizeResult {
  readonly renamed: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly removed: readonly string[];
  readonly indexRewritten: boolean;
}

function contentHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, HASH_LENGTH);
}

function joinRelative(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => statSync(join(directory, name)).isFile());
}

function collectGroups(siteRoot: string): AssetGroup[] {
  const names = [
    ...listFiles(siteRoot)
      .filter((name) => ROOT_MANAGED_EXTENSIONS.has(name.slice(name.lastIndexOf("."))))
      .map((name) => ({ directory: "", name })),
    ...listFiles(join(siteRoot, ASSETS_DIRECTORY)).map((name) => ({ directory: ASSETS_DIRECTORY, name })),
  ];
  const groups = new Map<string, AssetGroup>();
  for (const { directory, name } of names) {
    const hashedMatch = name.match(HASHED_NAME);
    const plainMatch = hashedMatch ? null : name.match(PLAIN_NAME);
    const stem = hashedMatch?.[1] ?? plainMatch?.[1] ?? name;
    const extension = hashedMatch?.[3] ?? plainMatch?.[2] ?? "";
    const key = joinRelative(directory, `${stem}${extension}`);
    let group = groups.get(key);
    if (!group) {
      group = { key, directory, stem, extension, hashed: [], unhashed: [] };
      groups.set(key, group);
    }
    const file = { path: joinRelative(directory, name), encodedHash: hashedMatch?.[2] };
    (file.encodedHash ? group.hashed : group.unhashed).push(file);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces `from` with `to` where it appears as a whole site-relative path (optionally behind the canonical URL). */
function replaceReference(document: string, from: string, to: string): string {
  const pattern = new RegExp(
    `(?<![\\w./-])(${escapeRegExp(CANONICAL_HOMEPAGE_URL)})?${escapeRegExp(from)}(?![\\w.-])`,
    "g",
  );
  return document.replace(pattern, (_match, prefix: string | undefined) => `${prefix ?? ""}${to}`);
}

/**
 * Renames unhashed or stale-hashed managed files to their content hash, removes
 * stale hashed siblings, refreshes compatibility copies and rewrites
 * `site/index.html`. Throws when a stem has several hashed files and no
 * unhashed source, because the intended version is ambiguous.
 */
export function normalizeSiteAssets(siteRoot: string): NormalizeResult {
  const renamed: Array<{ from: string; to: string }> = [];
  const removed: string[] = [];
  const indexPath = join(siteRoot, "index.html");
  const originalIndex = readFileSync(indexPath, "utf8");
  let index = originalIndex;

  for (const group of collectGroups(siteRoot)) {
    const isCompatibility = COMPATIBILITY_FILES.has(group.key);
    const source = group.unhashed[0] ?? (group.hashed.length === 1 ? group.hashed[0] : undefined);
    if (group.unhashed.length > 1 || !source) {
      throw new Error(
        `${group.key}: cannot pick a source among ${[...group.unhashed, ...group.hashed].map((f) => f.path).join(", ")}; leave exactly one`,
      );
    }
    const target = joinRelative(
      group.directory,
      `${group.stem}.${contentHash(join(siteRoot, source.path))}${group.extension}`,
    );
    if (isCompatibility && source.encodedHash === undefined) {
      if (!existsSync(join(siteRoot, target))) {
        copyFileSync(join(siteRoot, source.path), join(siteRoot, target));
        renamed.push({ from: source.path, to: target });
      }
    } else if (source.path !== target) {
      renameSync(join(siteRoot, source.path), join(siteRoot, target));
      renamed.push({ from: source.path, to: target });
    }
    if (isCompatibility && source.encodedHash !== undefined) {
      copyFileSync(join(siteRoot, target), join(siteRoot, group.key));
    }
    for (const sibling of group.hashed) {
      if (sibling.path === target || sibling.path === source.path) continue;
      rmSync(join(siteRoot, sibling.path));
      removed.push(sibling.path);
    }
    const replaced = [...group.hashed.map((f) => f.path), ...(isCompatibility ? [] : group.unhashed.map((f) => f.path))];
    for (const oldPath of replaced) {
      if (oldPath !== target) index = replaceReference(index, oldPath, target);
    }
  }

  if (index !== originalIndex) writeFileSync(indexPath, index);
  return { renamed, removed, indexRewritten: index !== originalIndex };
}

function attributeValues(document: string): string[] {
  const values: string[] = [];
  const rewriter = new HTMLRewriter().on("*", {
    element(element) {
      for (const name of REFERENCE_ATTRIBUTES) {
        const value = element.getAttribute(name);
        if (value === null) continue;
        if (name === "content" && !/^https?:\/\//.test(value)) continue; // meta text, not a URL
        if (name === "srcset") {
          values.push(...value.split(",").map((part) => part.trim().split(/\s+/)[0] ?? "").filter(Boolean));
        } else {
          values.push(value);
        }
      }
    },
  });
  rewriter.transform(document);
  return values;
}

/** Site-relative paths of every first-party file referenced from `index.html`. */
function referencedSitePaths(document: string, errors: string[]): Set<string> {
  const canonical = new URL(CANONICAL_HOMEPAGE_URL);
  const paths = new Set<string>();
  for (const value of attributeValues(document)) {
    if (value.startsWith("/") && !value.startsWith("//")) {
      errors.push(`index.html: ${value} has a leading slash; site paths must be relative`);
      continue;
    }
    let url: URL;
    try {
      url = new URL(value, CANONICAL_HOMEPAGE_URL);
    } catch {
      continue;
    }
    if (url.origin !== canonical.origin || !url.pathname.startsWith(canonical.pathname)) continue;
    const path = decodeURIComponent(url.pathname.slice(canonical.pathname.length));
    if (path) paths.add(path);
  }
  return paths;
}

function ignoredPaths(gitRoot: string, repositoryPaths: readonly string[]): string[] {
  if (repositoryPaths.length === 0) return [];
  const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
    cwd: gitRoot,
    input: repositoryPaths.join("\n"),
    encoding: "utf8",
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout.split("\n").filter(Boolean);
}

/** Returns human-readable drift findings; an empty array means the site is consistent. */
export function checkSiteAssets(siteRoot: string, options: CheckOptions = {}): string[] {
  const errors: string[] = [];
  const managedHashed = new Set<string>();

  for (const group of collectGroups(siteRoot)) {
    const isCompatibility = COMPATIBILITY_FILES.has(group.key);
    for (const file of group.unhashed) {
      if (!isCompatibility) errors.push(`${file.path}: unhashed; run bun run site:assets`);
    }
    if (group.hashed.length !== 1) {
      errors.push(
        `${group.key}: expected exactly one hashed file, found ${group.hashed.length}${group.hashed.length ? ` (${group.hashed.map((f) => f.path).join(", ")})` : ""}`,
      );
    }
    for (const file of group.hashed) {
      managedHashed.add(file.path);
      const actual = contentHash(join(siteRoot, file.path));
      if (actual !== file.encodedHash) {
        errors.push(`${file.path}: name hash does not match content hash ${actual}; run bun run site:assets`);
      }
    }
    if (isCompatibility) {
      const compatibility = join(siteRoot, group.key);
      const hashedPath = group.hashed[0]?.path;
      if (!existsSync(compatibility)) {
        errors.push(`${group.key}: compatibility copy is missing`);
      } else if (hashedPath && !readFileSync(compatibility).equals(readFileSync(join(siteRoot, hashedPath)))) {
        errors.push(`${group.key}: compatibility copy differs from ${hashedPath}`);
      }
    }
  }

  const references = referencedSitePaths(readFileSync(join(siteRoot, "index.html"), "utf8"), errors);
  for (const path of references) {
    if (!existsSync(join(siteRoot, path))) {
      errors.push(`index.html references missing file ${path}`);
    } else if (COMPATIBILITY_FILES.has(path)) {
      errors.push(`index.html references unhashed compatibility file ${path}; use its hashed sibling`);
    }
  }
  for (const path of managedHashed) {
    if (!references.has(path)) errors.push(`${path}: not referenced from index.html; delete it or reference it`);
  }

  if (options.gitRoot) {
    const siteFromRepository = relative(options.gitRoot, siteRoot);
    const candidates = new Set<string>([
      ...[...managedHashed, ...references, ...COMPATIBILITY_FILES].map((path) => `${siteFromRepository}/${path}`),
      ...(options.extraVisiblePaths ?? []),
    ]);
    for (const path of ignoredPaths(options.gitRoot, [...candidates].sort())) {
      errors.push(`${path}: ignored by .gitignore; a regenerated file would be silently untracked`);
    }
  }

  return errors;
}

const DOCS_MEDIA = /\.(png|gif|webp|svg|jpe?g)$/;

function docsMediaPaths(repositoryRoot: string): string[] {
  return [
    ...listFiles(join(repositoryRoot, "docs")).map((name) => `docs/${name}`),
    ...listFiles(join(repositoryRoot, "docs", ASSETS_DIRECTORY)).map((name) => `docs/${ASSETS_DIRECTORY}/${name}`),
  ].filter((path) => DOCS_MEDIA.test(path));
}

if (import.meta.main) {
  const repositoryRoot = join(import.meta.dirname, "..");
  const siteRoot = join(repositoryRoot, "site");
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    console.error(`usage: bun run scripts/site-assets.ts [--check]\nunknown argument: ${unknown.join(" ")}`);
    process.exit(2);
  }
  if (!args.includes("--check")) {
    const result = normalizeSiteAssets(siteRoot);
    for (const { from, to } of result.renamed) console.log(`renamed site/${from} -> site/${to}`);
    for (const path of result.removed) console.log(`removed site/${path}`);
    if (result.indexRewritten) console.log("rewrote site/index.html references");
  }
  const errors = checkSiteAssets(siteRoot, {
    gitRoot: repositoryRoot,
    extraVisiblePaths: docsMediaPaths(repositoryRoot),
  });
  if (errors.length > 0) {
    for (const error of errors) console.error(`site:check: ${error}`);
    process.exit(1);
  }
  console.log("site:check: ok");
}
