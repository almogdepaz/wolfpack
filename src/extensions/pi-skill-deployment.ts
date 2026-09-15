import { createHash } from "node:crypto";
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { canonicalJson } from "../canonical-json.ts";
import { writePrivateJsonFile } from "../server/persistence.ts";
import { boundedCanonicalJson, isPlainJsonObject } from "./bounded-json.ts";
import { readBoundedRegularFile } from "./bounded-file.ts";
import { assertPortablePackagePath, portableFileInventory } from "./portable-path.ts";

export const PI_SKILL_LIMITS = {
  maxFiles: 256,
  maxFileBytes: 256 * 1024,
  maxSkillBytes: 1024 * 1024,
  maxFrontmatterBytes: 16 * 1024,
  maxBatchSkills: 32,
  maxOwnedSkills: 128,
  maxRegistryBytes: 8 * 1024 * 1024,
  maxDiscoveryEntries: 4096,
  maxDiscoveryDepth: 8,
} as const;
const EXTENSION_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST = /^[a-f0-9]{64}$/;
const OWNERSHIP_FILE = ".wolfpack-extension-skill-ownership.json";
const LOCK_DIRECTORY = ".wolfpack-extension-skill-lock";

export interface BundledPiSkill {
  readonly name: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
}
interface SkillOwnership {
  readonly extensionId: string;
  readonly sourceDigest: string;
  readonly files: Readonly<Record<string, string>>;
}
interface OwnershipRegistry { readonly version: 1; readonly skills: Readonly<Record<string, SkillOwnership>>; }
export type PiSkillDeploymentResult = {
  readonly name: string;
  readonly status: "installed" | "unchanged" | "removed" | "not_installed" | "collision" | "modified" | "write_failed";
  readonly message?: string;
  /** Retained outside skill discovery, never silently deleted after a cleanup failure. */
  readonly cleanupDirectory?: string;
};
export class PiSkillDeploymentError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "INVALID_ROOT" | "REGISTRY_CORRUPT" | "BUSY" | "RECOVERY_REQUIRED",
    message: string,
    readonly recoveryDirectory?: string,
  ) { super(message); this.name = "PiSkillDeploymentError"; }
}

/** Trusted synchronous host/test I/O only. Never accepted from a package or HTTP input. */
export interface PiSkillFileOperations {
  readonly rename: (from: string, to: string) => void;
  readonly writeRegistry: (file: string, value: unknown) => void;
  readonly writeFile: (file: string, content: string) => void;
  readonly removeTree: (path: string) => void;
}
interface CommonOptions {
  readonly skillsRoot: string;
  readonly extensionId: string;
  readonly operations?: Partial<PiSkillFileOperations>;
}
const defaultOperations: PiSkillFileOperations = {
  rename: renameSync,
  writeRegistry: writePrivateJsonFile,
  writeFile(file, content) {
    const fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); }
    finally { closeSync(fd); }
  },
  removeTree: (path) => rmSync(path, { recursive: true, force: true }),
};
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function validName(name: unknown): name is string {
  if (typeof name !== "string" || name.length > 64 || !SKILL_NAME.test(name)) return false;
  try { assertPortablePackagePath(name); return true; } catch { return false; }
}
function fields(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
}
function ownerOf(registry: OwnershipRegistry, name: string): SkillOwnership | undefined {
  return Object.hasOwn(registry.skills, name) ? registry.skills[name] : undefined;
}

function frontmatter(content: string, expectedName?: string): { name: string; description: string } {
  const opening = /^---\r?\n/.exec(content);
  if (!opening) throw new Error("SKILL.md requires YAML frontmatter");
  const rest = content.slice(opening[0].length);
  const closing = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(rest);
  if (!closing) throw new Error("SKILL.md frontmatter is not closed");
  const source = rest.slice(0, closing.index);
  if (Buffer.byteLength(source, "utf8") > PI_SKILL_LIMITS.maxFrontmatterBytes) throw new Error("skill frontmatter exceeds byte limit");
  const parsed = parseDocument(source, { version: "1.2", strict: true, uniqueKeys: true });
  if (parsed.errors.length || parsed.warnings.length) throw new Error("skill frontmatter is not unambiguous supported YAML");
  let value: unknown;
  try { value = parsed.toJS({ maxAliasCount: 0 }); }
  catch { throw new Error("skill frontmatter aliases are not supported"); }
  boundedCanonicalJson(value, {
    maxBytes: PI_SKILL_LIMITS.maxFrontmatterBytes, maxDepth: 8, maxNodes: 256,
    maxStringBytes: 4096, maxObjectKeys: 64, maxArrayItems: 64,
  });
  if (
    !isPlainJsonObject(value) || !validName(value.name) ||
    (expectedName !== undefined && value.name !== expectedName) ||
    typeof value.description !== "string" || !value.description.trim() || [...value.description].length > 1024
  ) throw new Error("skill frontmatter requires a matching standard name and a nonblank description of at most 1024 characters");
  return { name: value.name, description: value.description };
}

function inventory(skill: BundledPiSkill, extensionId: string): SkillOwnership {
  if (!isPlainJsonObject(skill) || !validName(skill.name) || !Array.isArray(skill.files) || skill.files.length < 1 || skill.files.length > PI_SKILL_LIMITS.maxFiles) {
    throw new Error("skill requires a valid name and bounded nonempty inventory");
  }
  const files: Record<string, string> = Object.create(null);
  const paths: string[] = [];
  let bytes = 0;
  let main: string | undefined;
  for (const file of skill.files) {
    if (!isPlainJsonObject(file) || typeof file.content !== "string") throw new Error("skill inventory accepts UTF-8 text files only");
    assertPortablePackagePath(file.path);
    const length = Buffer.byteLength(file.content, "utf8");
    bytes += length;
    if (length > PI_SKILL_LIMITS.maxFileBytes || bytes > PI_SKILL_LIMITS.maxSkillBytes) throw new Error("skill inventory exceeds byte limit");
    paths.push(file.path);
    files[file.path] = hash(file.content);
    if (file.path === "SKILL.md") main = file.content;
  }
  portableFileInventory(paths);
  if (main === undefined) throw new Error("skill inventory must contain SKILL.md");
  frontmatter(main, skill.name);
  return { extensionId, sourceDigest: hash(canonicalJson(files)), files };
}

function validRegistry(value: unknown): value is OwnershipRegistry {
  if (!isPlainJsonObject(value) || !fields(value, ["version", "skills"]) || value.version !== 1 || !isPlainJsonObject(value.skills)) return false;
  const entries = Object.entries(value.skills);
  if (entries.length > PI_SKILL_LIMITS.maxOwnedSkills) return false;
  try {
    for (const [name, owner] of entries) {
      if (
        !validName(name) || !isPlainJsonObject(owner) || !fields(owner, ["extensionId", "sourceDigest", "files"]) ||
        typeof owner.extensionId !== "string" || !EXTENSION_ID.test(owner.extensionId) ||
        typeof owner.sourceDigest !== "string" || !DIGEST.test(owner.sourceDigest) || !isPlainJsonObject(owner.files)
      ) return false;
      const files = Object.keys(owner.files);
      if (files.length < 1 || files.length > PI_SKILL_LIMITS.maxFiles || !Object.hasOwn(owner.files, "SKILL.md")) return false;
      portableFileInventory(files);
      if (Object.values(owner.files).some((digest) => typeof digest !== "string" || !DIGEST.test(digest))) return false;
      if (owner.sourceDigest !== hash(canonicalJson(owner.files))) return false;
    }
    return true;
  } catch { return false; }
}
function readRegistry(root: string): OwnershipRegistry {
  try {
    const value: unknown = JSON.parse(readBoundedRegularFile(join(root, OWNERSHIP_FILE), PI_SKILL_LIMITS.maxRegistryBytes).toString("utf8"));
    if (!validRegistry(value)) throw new Error("invalid ownership data");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, skills: {} };
    throw new PiSkillDeploymentError("REGISTRY_CORRUPT", "skill ownership registry cannot be read as bounded coherent ownership; no changes made");
  }
}

/** Exact tree, including empty directories and symlinks, not just previously tracked files. */
function treeUnchanged(directory: string, owner: SkillOwnership): boolean {
  try {
    const rootStat = lstatSync(directory);
    if (!rootStat.isDirectory() || (rootStat.mode & 0o777) !== 0o700) return false;
    const expectedDirectories = portableFileInventory(Object.keys(owner.files));
    const seenFiles = new Set<string>();
    const seenDirectories = new Set<string>();
    let bytes = 0;
    const visit = (path: string, prefix: string): boolean => {
      const entries = opendirSync(path);
      try {
        for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          const full = join(path, entry.name);
          const stat = lstatSync(full);
          if (stat.isDirectory()) {
            if (!expectedDirectories.has(relative) || (stat.mode & 0o777) !== 0o700) return false;
            seenDirectories.add(relative);
            if (!visit(full, relative)) return false;
          } else if (stat.isFile()) {
            if (!Object.hasOwn(owner.files, relative) || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) return false;
            const content = readBoundedRegularFile(full, PI_SKILL_LIMITS.maxFileBytes);
            bytes += content.byteLength;
            if (bytes > PI_SKILL_LIMITS.maxSkillBytes || hash(content) !== owner.files[relative]) return false;
            seenFiles.add(relative);
          } else return false;
        }
        return true;
      } finally { entries.closeSync(); }
    };
    return visit(directory, "") && seenFiles.size === Object.keys(owner.files).length && seenDirectories.size === expectedDirectories.size;
  } catch { return false; }
}

/** Scope is this discovery root only, not all of Pi's other global/project/CLI sources. */
function discoveryCollision(root: string, name: string): boolean {
  let count = 0;
  const visit = (directory: string, depth: number): boolean => {
    if (depth > PI_SKILL_LIMITS.maxDiscoveryDepth) return true;
    const entries = opendirSync(directory);
    try {
      for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
        if (++count > PI_SKILL_LIMITS.maxDiscoveryEntries) return true;
        if (depth === 0 && (entry.name === name || entry.name === LOCK_DIRECTORY || entry.name === OWNERSHIP_FILE)) continue;
        if (depth === 0 && entry.name.toLowerCase() === name) return true;
        const path = join(directory, entry.name);
        // Do not silently assume an uninspected symlink tree has no competing skill.
        if (entry.isSymbolicLink()) return true;
        if (entry.isDirectory()) { if (visit(path, depth + 1)) return true; }
        else if (entry.isFile() && (entry.name === "SKILL.md" || (depth === 0 && entry.name.endsWith(".md")))) {
          try {
            const metadata = frontmatter(readBoundedRegularFile(path, PI_SKILL_LIMITS.maxFileBytes).toString("utf8"));
            if (metadata.name === name) return true;
          } catch {
            // A bounded root scan that cannot classify an existing candidate
            // must report a collision/inspection requirement, never overwrite.
            return true;
          }
        }
      }
      return false;
    } finally { entries.closeSync(); }
  };
  return visit(root, 0);
}

function validateNames(names: readonly string[]): void {
  if (!Array.isArray(names) || names.length > PI_SKILL_LIMITS.maxBatchSkills) {
    throw new PiSkillDeploymentError("INVALID_REQUEST", "skill names must be a bounded array");
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (!validName(name) || seen.has(name)) throw new PiSkillDeploymentError("INVALID_REQUEST", "skill names must be valid and unique; sparse batches are not allowed");
    seen.add(name);
  }
}
function withRoot<T>(options: CommonOptions, action: (root: string, registry: OwnershipRegistry, operations: PiSkillFileOperations) => T): T {
  if (!isPlainJsonObject(options) || typeof options.extensionId !== "string" || !EXTENSION_ID.test(options.extensionId)) throw new PiSkillDeploymentError("INVALID_REQUEST", "extension ID must be stable");
  if (typeof options.skillsRoot !== "string" || !isAbsolute(options.skillsRoot) || dirname(resolve(options.skillsRoot)) === resolve(options.skillsRoot)) throw new PiSkillDeploymentError("INVALID_ROOT", "skills root must be an explicit non-root absolute directory");
  const root = resolve(options.skillsRoot);
  try {
    if (!exists(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!lstatSync(root).isDirectory()) throw new Error("not a directory");
  } catch { throw new PiSkillDeploymentError("INVALID_ROOT", "skills root must be a writable non-symlink directory"); }
  const lock = join(root, LOCK_DIRECTORY);
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PiSkillDeploymentError("BUSY", "skill root has an active or unrecovered transaction; no automatic stale-lock deletion");
    throw new PiSkillDeploymentError("INVALID_ROOT", "could not acquire skill root transaction lock");
  }
  let keepLock = false;
  try {
    writePrivateJsonFile(join(lock, "owner.json"), { pid: process.pid, startedAt: new Date().toISOString() });
    return action(root, readRegistry(root), { ...defaultOperations, ...options.operations });
  } catch (error) {
    keepLock = error instanceof PiSkillDeploymentError && error.code === "RECOVERY_REQUIRED";
    throw error;
  } finally {
    if (!keepLock) rmSync(lock, { recursive: true, force: true });
  }
}

interface TransactionResult { readonly registry: OwnershipRegistry; readonly result: PiSkillDeploymentResult; }
function transact(
  root: string, name: string, registry: OwnershipRegistry, nextOwner: SkillOwnership | undefined,
  skill: BundledPiSkill | undefined, operations: PiSkillFileOperations,
): TransactionResult {
  const previousOwner = ownerOf(registry, name);
  const nextSkills = { ...registry.skills };
  if (nextOwner) nextSkills[name] = nextOwner;
  else delete nextSkills[name];
  const next: OwnershipRegistry = { version: 1, skills: nextSkills };
  if (!validRegistry(next) || Buffer.byteLength(JSON.stringify(next, null, 2), "utf8") + 1 > PI_SKILL_LIMITS.maxRegistryBytes) throw new Error("skill ownership quota exceeded");
  // Sibling workspace: backups and incomplete skills are never in the target
  // Pi discovery root. Retain a complete before/after journal for manual recovery.
  const workspace = mkdtempSync(join(dirname(root), ".wolfpack-skill-txn-"));
  const staged = join(workspace, "new");
  const backup = join(workspace, "old");
  const destination = join(root, name);
  const recovery = () => new PiSkillDeploymentError("RECOVERY_REQUIRED", "skill transaction requires explicit recovery; old bytes/journal retained and root remains locked", workspace);
  let committed = false;
  let failure: unknown;
  try {
    writePrivateJsonFile(join(workspace, "transaction.json"), { version: 1, skillsRoot: root, name, before: registry, after: next });
    if (skill && nextOwner) {
      mkdirSync(staged, { mode: 0o700 });
      for (const file of skill.files) {
        const path = join(staged, file.path);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        operations.writeFile(path, file.content);
      }
      if (!treeUnchanged(staged, nextOwner)) throw new Error("staged skill differs from validated inventory");
    }
    if (previousOwner) operations.rename(destination, backup);
    if (skill) operations.rename(staged, destination);
    // Detect edits that raced initial inspection/parking before ownership commit.
    if (previousOwner && !treeUnchanged(backup, previousOwner)) throw new Error("old skill changed during transaction");
    if (nextOwner && !treeUnchanged(destination, nextOwner)) throw new Error("new skill changed during transaction");
    try {
      operations.writeRegistry(join(root, OWNERSHIP_FILE), next);
      if (canonicalJson(readRegistry(root)) !== canonicalJson(next)) throw new Error("registry write did not persist the intended ownership");
    } catch (error) {
      // A write wrapper can fail after atomic replacement. Read authority before
      // rollback; never restore old files under an already-committed new registry.
      let actual: OwnershipRegistry;
      try { actual = readRegistry(root); } catch { throw recovery(); }
      if (canonicalJson(actual) === canonicalJson(next)) committed = true;
      else if (canonicalJson(actual) !== canonicalJson(registry)) throw recovery();
      if (!committed) throw error;
    }
    committed = true;
  } catch (error) {
    if (error instanceof PiSkillDeploymentError && error.code === "RECOVERY_REQUIRED") throw error;
    failure = error;
    // Inspect actual paths rather than trusting flags set after rename: a host
    // wrapper may itself throw after a successful rename.
    try {
      if (exists(backup)) {
        if (exists(destination)) {
          if (!nextOwner || !treeUnchanged(destination, nextOwner) || exists(staged)) throw recovery();
          operations.rename(destination, staged);
        }
        operations.rename(backup, destination);
      } else if (!previousOwner && exists(destination)) {
        if (!nextOwner || !treeUnchanged(destination, nextOwner) || exists(staged)) throw recovery();
        operations.rename(destination, staged);
      } else if (previousOwner && !exists(destination)) throw recovery();
      if (exists(backup) || (!previousOwner && exists(destination))) throw recovery();
    } catch { throw recovery(); }
  }
  let cleanupDirectory: string | undefined;
  // A user/editor may have changed the parked tree after the commit check.
  // Retain those bytes for inspection instead of treating them as disposable.
  if (committed && previousOwner && !treeUnchanged(backup, previousOwner)) cleanupDirectory = workspace;
  else {
    try { operations.removeTree(workspace); if (exists(workspace)) cleanupDirectory = workspace; }
    catch { cleanupDirectory = workspace; }
  }
  if (!committed) {
    return { registry, result: { name, status: "write_failed", message: failure instanceof Error ? failure.message : "skill transaction failed", ...(cleanupDirectory ? { cleanupDirectory } : {}) } };
  }
  return { registry: next, result: { name, status: skill ? "installed" : "removed", ...(cleanupDirectory ? { cleanupDirectory, message: "ownership committed; retained transaction workspace requires inspection outside skill discovery" } : {}) } };
}

/** Per-skill transactions; a batch may partially succeed and must be reported as such. */
export function deployBundledPiSkills(options: CommonOptions & { readonly skills: readonly BundledPiSkill[] }): readonly PiSkillDeploymentResult[] {
  if (!Array.isArray(options?.skills) || options.skills.length > PI_SKILL_LIMITS.maxBatchSkills) throw new PiSkillDeploymentError("INVALID_REQUEST", "skills must be a bounded array");
  validateNames(options.skills.map((skill) => skill?.name));
  return withRoot(options, (root, initialRegistry, operations) => {
    let registry = initialRegistry;
    const results: PiSkillDeploymentResult[] = [];
    for (const skill of options.skills) {
      const owner = ownerOf(registry, skill.name);
      const destination = join(root, skill.name);
      if ((!owner && exists(destination)) || (owner && owner.extensionId !== options.extensionId)) {
        results.push({ name: skill.name, status: "collision", message: "skill path exists without matching extension ownership" });
        continue;
      }
      if (owner && !treeUnchanged(destination, owner)) {
        results.push({ name: skill.name, status: "modified", message: "owned tree has missing, modified, untracked or aliased entries; refusing change" });
        continue;
      }
      try {
        const nextOwner = inventory(skill, options.extensionId);
        if (discoveryCollision(root, skill.name)) {
          results.push({ name: skill.name, status: "collision", message: "discovery root contains a competing skill name or an uninspectable candidate" });
          continue;
        }
        if (owner?.sourceDigest === nextOwner.sourceDigest) {
          results.push({ name: skill.name, status: "unchanged" });
          continue;
        }
        const transaction = transact(root, skill.name, registry, nextOwner, skill, operations);
        registry = transaction.registry;
        results.push(transaction.result);
      } catch (error) {
        if (error instanceof PiSkillDeploymentError) throw error;
        results.push({ name: skill.name, status: "write_failed", message: error instanceof Error ? error.message : "skill validation/write failed" });
      }
    }
    return results;
  });
}

/** Explicit removal only; deploying a smaller/new manifest never implicitly deletes skills. */
export function removeBundledPiSkills(options: CommonOptions & { readonly names?: readonly string[] }): readonly PiSkillDeploymentResult[] {
  if (options?.names !== undefined) validateNames(options.names);
  return withRoot(options, (root, initialRegistry, operations) => {
    let registry = initialRegistry;
    const names = options.names ?? Object.keys(registry.skills).filter((name) => ownerOf(registry, name)?.extensionId === options.extensionId);
    const results: PiSkillDeploymentResult[] = [];
    for (const name of names) {
      const owner = ownerOf(registry, name);
      if (!owner) {
        results.push({ name, status: exists(join(root, name)) ? "collision" : "not_installed" });
      } else if (owner.extensionId !== options.extensionId) {
        results.push({ name, status: "collision", message: "skill belongs to another extension" });
      } else if (!treeUnchanged(join(root, name), owner)) {
        results.push({ name, status: "modified", message: "skill tree differs from ownership; refusing removal" });
      } else {
        const transaction = transact(root, name, registry, undefined, undefined, operations);
        registry = transaction.registry;
        results.push(transaction.result);
      }
    }
    return results;
  });
}
