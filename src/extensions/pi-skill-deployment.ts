import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { canonicalJson } from "../canonical-json.ts";
import { readValidatedJsonFile, writePrivateJsonFile } from "../server/persistence.ts";
const SKILL_NAME = /^[a-z][a-z0-9-]{0,63}$/; const FILE_NAME = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@/+-]{1,256}$/; const OWNERSHIP_FILE = ".wolfpack-extension-skill-ownership.json";
export interface BundledPiSkill { readonly name: string; readonly files: readonly { readonly path: string; readonly content: string }[]; }
interface SkillOwnership { readonly extensionId: string; readonly sourceDigest: string; readonly files: Readonly<Record<string, string>>; }
interface OwnershipRegistry { readonly version: 1; readonly skills: Readonly<Record<string, SkillOwnership>>; }
export type PiSkillDeploymentResult = { readonly name: string; readonly status: "installed" | "unchanged" } | { readonly name: string; readonly status: "collision" | "modified" | "write_failed"; readonly message: string };
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function inventory(skill: BundledPiSkill): { digest: string; files: Record<string, string> } {
  if (!SKILL_NAME.test(skill.name) || !skill.files.length) throw new Error("invalid skill name or empty inventory"); const files: Record<string, string> = {};
  for (const file of skill.files) { if (!FILE_NAME.test(file.path) || files[file.path]) throw new Error("invalid or duplicate skill file path"); files[file.path] = hash(file.content); }
  const main = skill.files.find((file) => file.path === "SKILL.md")?.content;
  if (!main || !/^---\nname:\s*[^\n]+\ndescription:\s*[^\n]+\n---\n/s.test(main)) throw new Error("SKILL.md requires Agent Skills name and description frontmatter");
  return { files, digest: hash(canonicalJson(files)) };
}
function path(root: string, name: string): string { const result = resolve(root, name); if (relative(resolve(root), result).startsWith("..")) throw new Error("skill path escaped skills root"); return result; }
function registryPath(root: string) { return join(root, OWNERSHIP_FILE); }
function hasUntracked(directory: string, tracked: Readonly<Record<string, string>>, prefix = ""): boolean { for (const entry of readdirSync(directory)) { const relativePath = prefix ? `${prefix}/${entry}` : entry; const full = join(directory, entry); if (statSync(full).isDirectory()) { if (hasUntracked(full, tracked, relativePath)) return true; } else if (!(relativePath in tracked)) return true; } return false; }
function isRegistry(value: unknown): value is OwnershipRegistry { return typeof value === "object" && value !== null && (value as { version?: unknown }).version === 1 && typeof (value as { skills?: unknown }).skills === "object" && (value as { skills: unknown }).skills !== null; }
export function deployBundledPiSkills(options: { readonly skillsRoot: string; readonly extensionId: string; readonly skills: readonly BundledPiSkill[] }): readonly PiSkillDeploymentResult[] {
  if (!SKILL_NAME.test(options.extensionId)) throw new Error("extension ID must be stable"); mkdirSync(options.skillsRoot, { recursive: true, mode: 0o700 });
  const registry = readValidatedJsonFile(registryPath(options.skillsRoot), "Pi extension skill ownership", isRegistry) ?? { version: 1 as const, skills: {} }; const next: Record<string, SkillOwnership> = { ...registry.skills }; const results: PiSkillDeploymentResult[] = [];
  for (const skill of options.skills) try {
    const current = inventory(skill); const owner = registry.skills[skill.name]; const destination = path(options.skillsRoot, skill.name);
    if (!owner && existsSync(destination)) { results.push({ name: skill.name, status: "collision", message: "skill name already exists and is not installer-owned" }); continue; }
    if (owner?.extensionId !== undefined && owner.extensionId !== options.extensionId) { results.push({ name: skill.name, status: "collision", message: "skill is owned by another extension" }); continue; }
    const modified = owner && (hasUntracked(destination, owner.files) || Object.entries(owner.files).some(([file, oldDigest]) => !existsSync(join(destination, file)) || hash(readFileSync(join(destination, file), "utf8")) !== oldDigest));
    if (modified) { results.push({ name: skill.name, status: "modified", message: "owned skill was modified; refusing overwrite" }); continue; }
    if (owner?.sourceDigest === current.digest) { results.push({ name: skill.name, status: "unchanged" }); continue; }
    const stage = path(options.skillsRoot, `.${skill.name}-stage-${process.pid}`); const backup = path(options.skillsRoot, `.${skill.name}-backup-${process.pid}`); rmSync(stage, { recursive: true, force: true }); rmSync(backup, { recursive: true, force: true }); mkdirSync(stage, { recursive: true, mode: 0o700 });
    for (const file of skill.files) { const target = join(stage, file.path); mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 }); writeFileSync(target, file.content, { mode: 0o600 }); }
    if (existsSync(destination)) renameSync(destination, backup); renameSync(stage, destination); rmSync(backup, { recursive: true, force: true }); next[skill.name] = { extensionId: options.extensionId, sourceDigest: current.digest, files: current.files }; results.push({ name: skill.name, status: "installed" });
  } catch (error) { results.push({ name: skill.name, status: "write_failed", message: (error as Error).message }); }
  writePrivateJsonFile(registryPath(options.skillsRoot), { version: 1, skills: next }); return results;
}
