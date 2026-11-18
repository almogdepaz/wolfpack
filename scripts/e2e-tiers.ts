import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import config from "../playwright.config";

const root = resolve(import.meta.dir, "..");
export const tierNames = ["pr", "full", "quarantine"] as const;
export type Tier = typeof tierNames[number];
type Entry = { projects: string[]; reason?: string; failing?: string[] };
type Manifest = Record<Tier, Record<string, Entry>>;
const projects = config.projects!;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applies(file: string, project: typeof projects[number]): boolean {
  const match = project.testMatch ?? config.testMatch ?? "*.e2e.ts";
  return (Array.isArray(match) ? match : [match]).some(pattern =>
    typeof pattern === "string" ? new Bun.Glob(pattern).match(file) : pattern.test(file));
}

export function readTierManifest(): unknown {
  return JSON.parse(readFileSync(resolve(root, "tests/e2e/tiers.json"), "utf8"));
}

// Grep is deliberately not applied here: it filters test titles, not files.
// machine-groups/mobile-webkit is a known zero-test selection in the config.
export function checkTiers(
  manifest: unknown = readTierManifest(),
  files = readdirSync(resolve(root, "tests/e2e")).filter(file => file.endsWith(".e2e.ts")).sort(),
): string[] {
  if (!isRecord(manifest)) return ["tiers: expected an object"];
  const problems: string[] = [];
  const assigned = new Map<string, Tier>();
  for (const name of Object.keys(manifest)) {
    if (!tierNames.includes(name as Tier)) problems.push(`unknown tier: ${name}`);
  }
  for (const tier of tierNames) {
    const entries = manifest[tier];
    if (!isRecord(entries)) {
      problems.push(`${tier}: expected a spec map`);
      continue;
    }
    for (const [file, entry] of Object.entries(entries)) {
      if (!files.includes(file)) problems.push(`${file}: listed in ${tier} but missing on disk`);
      if (!isRecord(entry) || !Array.isArray(entry.projects) || entry.projects.length === 0) {
        problems.push(`${file}: ${tier} needs a nonempty projects array`);
        continue;
      }
      if (tier === "quarantine") {
        if (typeof entry.reason !== "string" || !entry.reason.trim() || /[\r\n]/.test(entry.reason)) {
          problems.push(`${file}: quarantine needs a one-line reason`);
        }
        if (!Array.isArray(entry.failing) || entry.failing.length === 0
          || entry.failing.some(title => typeof title !== "string" || !title.trim())) {
          problems.push(`${file}: quarantine needs failing test titles`);
        }
      }
      for (const name of entry.projects) {
        const project = projects.find(project => project.name === name);
        if (!project || typeof name !== "string") {
          problems.push(`${file}: unknown project ${String(name)}`);
          continue;
        }
        if (!applies(file, project)) problems.push(`${file}: not matched by project ${name}`);
        const key = `${file} [${name}]`;
        const previous = assigned.get(key);
        if (previous) problems.push(`${key}: assigned to ${previous} and ${tier}`);
        assigned.set(key, tier);
      }
    }
  }
  for (const file of files) for (const project of projects) {
    const key = `${file} [${project.name}]`;
    if (applies(file, project) && !assigned.has(key)) problems.push(`${key}: in no tier`);
  }
  return problems;
}

export function tierFiles(tier: Tier, project?: string, input = readTierManifest()): string[] {
  const problems = checkTiers(input);
  if (project !== undefined && !projects.some(candidate => candidate.name === project)) {
    problems.push(`unknown project: ${project}`);
  }
  if (problems.length) throw new Error(problems.join("\n"));
  // checkTiers validates the JSON boundary before entries are used.
  const manifest = input as Manifest;
  return Object.entries(manifest[tier])
    .filter(([, entry]) => project === undefined || entry.projects.includes(project))
    .map(([file]) => `tests/e2e/${file}`).sort();
}

if (import.meta.main) {
  const [tier, flag, project, ...extra] = process.argv.slice(2);
  try {
    if (tier === "--check" && flag === undefined) {
      const problems = checkTiers();
      if (problems.length) throw new Error(problems.join("\n"));
    } else if (tierNames.includes(tier as Tier) && extra.length === 0
      && (flag === undefined || (flag === "--project" && project !== undefined))) {
      for (const file of tierFiles(tier as Tier, project)) console.log(file);
    } else {
      throw new Error("usage: e2e-tiers.ts --check | <pr|full|quarantine> [--project <name>]");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
