import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { readValidatedJsonFile, writePrivateJsonFile } from "../server/persistence.ts";

const SKILL_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const FILE_NAME = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@/+-]{1,256}$/;
const OWNERSHIP_FILE = ".wolfpack-extension-skill-ownership.json";

export interface BundledPiSkill {
  readonly name: string;
  readonly sourceDigest: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
}
interface SkillOwnership { readonly extensionId: string; readonly sourceDigest: string; readonly files: readonly string[]; }
interface OwnershipRegistry { readonly version: 1; readonly skills: Readonly<Record<string, SkillOwnership>>; }

export type PiSkillDeploymentResult =
  | { readonly name: string; readonly status: "installed" | "unchanged" }
  | { readonly name: string; readonly status: "collision" | "modified" | "write_failed"; readonly message: string };

function registryPath(skillsRoot: string): string { return join(skillsRoot, OWNERSHIP_FILE); }
function isRegistry(value: unknown): value is OwnershipRegistry {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (value as { version?: unknown }).version === 1
    && typeof (value as { skills?: unknown }).skills === "object" && (value as { skills: unknown }).skills !== null;
}
function fileDigest(content: string): string { return createHash("sha256").update(content, "utf8").digest("hex"); }
function skillDirectory(root: string, name: string): string {
  const directory = resolve(root, name);
  if (relative(resolve(root), directory).startsWith("..")) throw new Error("skill path escaped skills root");
  return directory;
}

/**
 * Installs only manifest-declared static skills into a caller-selected Pi skills root.
 * This is intentionally not invoked by setup: consent and the root selection belong
 * to the future extensions CLI. Existing user files and modified owned files fail closed.
 */
export function deployBundledPiSkills(options: { readonly skillsRoot: string; readonly extensionId: string; readonly skills: readonly BundledPiSkill[] }): readonly PiSkillDeploymentResult[] {
  if (!SKILL_NAME.test(options.extensionId)) throw new Error("extension ID must be a stable identifier");
  mkdirSync(options.skillsRoot, { recursive: true, mode: 0o700 });
  const registry = readValidatedJsonFile(registryPath(options.skillsRoot), "Pi extension skill ownership", isRegistry) ?? { version: 1 as const, skills: {} };
  const next: Record<string, SkillOwnership> = { ...registry.skills };
  const results: PiSkillDeploymentResult[] = [];
  for (const skill of options.skills) {
    if (!SKILL_NAME.test(skill.name) || !/^[a-f0-9]{64}$/.test(skill.sourceDigest) || skill.files.length === 0 || !skill.files.some((file) => file.path === "SKILL.md") || skill.files.some((file) => !FILE_NAME.test(file.path))) {
      results.push({ name: skill.name, status: "write_failed", message: "invalid static skill declaration" }); continue;
    }
    const owner = registry.skills[skill.name]; const directory = skillDirectory(options.skillsRoot, skill.name);
    if (!owner && existsSync(directory)) { results.push({ name: skill.name, status: "collision", message: "skill name already exists and is not installer-owned" }); continue; }
    if (owner && owner.extensionId !== options.extensionId) { results.push({ name: skill.name, status: "collision", message: "skill is owned by another extension" }); continue; }
    if (owner && owner.files.some((path) => !existsSync(join(directory, path)) || fileDigest(readFileSync(join(directory, path), "utf8")) !== fileDigest(skill.files.find((file) => file.path === path)?.content ?? ""))) {
      results.push({ name: skill.name, status: "modified", message: "owned skill was modified; refusing overwrite" }); continue;
    }
    if (owner?.sourceDigest === skill.sourceDigest) { results.push({ name: skill.name, status: "unchanged" }); continue; }
    const temporary = skillDirectory(options.skillsRoot, `.${skill.name}-staging-${process.pid}`);
    const backup = skillDirectory(options.skillsRoot, `.${skill.name}-backup-${process.pid}`);
    try {
      rmSync(temporary, { recursive: true, force: true }); rmSync(backup, { recursive: true, force: true });
      mkdirSync(temporary, { recursive: true, mode: 0o700 });
      for (const file of skill.files) { const target = join(temporary, file.path); mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 }); writeFileSync(target, file.content, { mode: 0o600 }); }
      // Same-filesystem renames preserve the old owned skill until replacement bytes are ready.
      if (existsSync(directory)) renameSync(directory, backup);
      renameSync(temporary, directory);
      rmSync(backup, { recursive: true, force: true });
      next[skill.name] = { extensionId: options.extensionId, sourceDigest: skill.sourceDigest, files: skill.files.map((file) => file.path) };
      results.push({ name: skill.name, status: "installed" });
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      if (!existsSync(directory) && existsSync(backup)) renameSync(backup, directory);
      results.push({ name: skill.name, status: "write_failed", message: (error as Error).message });
    }
  }
  writePrivateJsonFile(registryPath(options.skillsRoot), { version: 1, skills: next });
  return results;
}
