import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { CMD_REGEX } from "./validation.js";

export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1;
export const DEFAULT_USER_PLUGIN_DIR = join(homedir(), ".wolfpack", "plugins");
export const PROJECT_PLUGIN_RELATIVE_DIR = ".wolfpack/plugins";

export type PluginTrustLabel = "bundled" | "user-installed" | "project";
export type PluginSourceKind = "bundled" | "config" | "project";
export type PluginCapabilityKind = "command" | "link" | "statusProvider" | "ralphPreset" | "uiAction";

export interface PluginCommand {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly description?: string;
}

export interface PluginLink {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly description?: string;
}

export interface PluginStatusProvider {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly description?: string;
}

export interface PluginRalphPreset {
  readonly id: string;
  readonly label: string;
  readonly planFile?: string;
  readonly agent?: string;
  readonly description?: string;
}

export interface PluginUiAction {
  readonly id: string;
  readonly label: string;
  readonly kind: "open-link" | "copy-command";
  readonly target: string;
  readonly description?: string;
}

export interface PluginManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly homepage?: string;
  readonly capabilities: {
    readonly commands: PluginCommand[];
    readonly links: PluginLink[];
    readonly statusProviders: PluginStatusProvider[];
    readonly ralphPresets: PluginRalphPreset[];
    readonly uiActions: PluginUiAction[];
  };
}

export interface DiscoveredPlugin extends PluginManifest {
  readonly source: {
    readonly kind: PluginSourceKind;
    readonly trust: PluginTrustLabel;
    readonly path: string;
    readonly project?: string;
  };
}

export interface PluginManifestError {
  readonly path: string;
  readonly code: "invalid_path" | "read_error" | "parse_error" | "validation_error" | "duplicate";
  readonly message: string;
  readonly trust?: PluginTrustLabel;
  readonly project?: string;
}

export interface PluginDiscoveryOptions {
  readonly devDir: string;
  readonly configPluginDirs?: readonly string[];
  readonly bundledPluginDir?: string;
}

export interface PluginDiscoveryResult {
  readonly plugins: DiscoveredPlugin[];
  readonly errors: PluginManifestError[];
  readonly boundaries: {
    readonly schemaVersion: 1;
    readonly allowedRoots: Array<{ kind: PluginSourceKind; path: string; trust: PluginTrustLabel; project?: string }>;
    readonly forbidden: string[];
    readonly precedence: PluginSourceKind[];
  };
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const ID_REGEX = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const LABEL_MAX = 80;
const DESCRIPTION_MAX = 240;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MANIFEST_FILE_REGEX = /^[a-zA-Z0-9._-]+\.json$/;

const MANIFEST_KEYS = new Set(["schemaVersion", "id", "displayName", "description", "homepage", "capabilities"]);
const CAPABILITY_KEYS = new Set(["commands", "links", "statusProviders", "ralphPresets", "uiActions"]);
const COMMON_CAPABILITY_KEYS = new Set(["id", "label", "description"]);
const COMMAND_KEYS = new Set([...COMMON_CAPABILITY_KEYS, "command"]);
const LINK_KEYS = new Set([...COMMON_CAPABILITY_KEYS, "url"]);
const RALPH_PRESET_KEYS = new Set([...COMMON_CAPABILITY_KEYS, "planFile", "agent"]);
const UI_ACTION_KEYS = new Set([...COMMON_CAPABILITY_KEYS, "kind", "target"]);
const UI_ACTION_KINDS = new Set(["open-link", "copy-command"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(obj: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(obj).filter(key => !allowed.has(key));
}

function requiredString(obj: Record<string, unknown>, key: string, errors: string[], max = LABEL_MAX): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${key} must be a non-empty string`);
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.length > max) errors.push(`${key} must be ${max} chars or fewer`);
  return trimmed.slice(0, max);
}

function optionalString(obj: Record<string, unknown>, key: string, errors: string[], max = DESCRIPTION_MAX): string | undefined {
  if (!(key in obj)) return undefined;
  const value = obj[key];
  if (typeof value !== "string") {
    errors.push(`${key} must be a string`);
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) errors.push(`${key} must be ${max} chars or fewer`);
  return trimmed.slice(0, max);
}

function validateId(value: string, label: string, errors: string[]): void {
  if (!ID_REGEX.test(value)) errors.push(`${label} must match ${ID_REGEX.source}`);
}

function validateHttpUrl(value: string, label: string, errors: string[]): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") errors.push(`${label} must be http(s)`);
  } catch {
    errors.push(`${label} must be a valid url`);
  }
}

function validateCommandValue(value: string, label: string, errors: string[]): void {
  if (!CMD_REGEX.test(value)) errors.push(`${label} has invalid characters`);
}

function validateCapabilityArray<T>(
  obj: Record<string, unknown>,
  key: string,
  errors: string[],
  validateItem: (item: Record<string, unknown>, index: number) => T | null,
): T[] {
  const raw = obj[key];
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    errors.push(`capabilities.${key} must be an array`);
    return [];
  }
  const out: T[] = [];
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!isRecord(item)) {
      errors.push(`capabilities.${key}[${index}] must be an object`);
      continue;
    }
    const parsed = validateItem(item, index);
    if (parsed) out.push(parsed);
  }
  return out;
}

function validateCommandLike(
  item: Record<string, unknown>,
  index: number,
  prefix: string,
  allowed: Set<string>,
): PluginCommand | PluginStatusProvider | null {
  const errors: string[] = [];
  const extra = unknownKeys(item, allowed);
  if (extra.length) errors.push(`${prefix}[${index}] unknown fields: ${extra.join(", ")}`);
  const id = requiredString(item, "id", errors);
  validateId(id, `${prefix}[${index}].id`, errors);
  const label = requiredString(item, "label", errors);
  const command = requiredString(item, "command", errors, 200);
  validateCommandValue(command, `${prefix}[${index}].command`, errors);
  const description = optionalString(item, "description", errors);
  if (errors.length) throw errors;
  return { id, label, command, ...(description ? { description } : {}) };
}

export function validatePluginManifest(raw: unknown): ValidationResult<PluginManifest> {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["manifest must be an object"] };

  const extra = unknownKeys(raw, MANIFEST_KEYS);
  if (extra.length) errors.push(`unknown fields: ${extra.join(", ")}`);
  if (raw.schemaVersion !== PLUGIN_MANIFEST_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${PLUGIN_MANIFEST_SCHEMA_VERSION}`);
  }
  const id = requiredString(raw, "id", errors);
  validateId(id, "id", errors);
  const displayName = requiredString(raw, "displayName", errors);
  const description = optionalString(raw, "description", errors);
  const homepage = optionalString(raw, "homepage", errors, 200);
  if (homepage) validateHttpUrl(homepage, "homepage", errors);

  const capRaw = raw.capabilities;
  const capObj = capRaw == null ? {} : capRaw;
  if (!isRecord(capObj)) {
    errors.push("capabilities must be an object");
  } else {
    const capExtra = unknownKeys(capObj, CAPABILITY_KEYS);
    if (capExtra.length) errors.push(`capabilities unknown fields: ${capExtra.join(", ")}`);
  }
  const capabilitiesObject = isRecord(capObj) ? capObj : {};

  const collect = <T>(fn: () => T[]): T[] => {
    try { return fn(); } catch (e) {
      if (Array.isArray(e)) errors.push(...e);
      else errors.push(String(e));
      return [];
    }
  };

  const commands = collect(() => validateCapabilityArray(capabilitiesObject, "commands", errors, (item, index) =>
    validateCommandLike(item, index, "capabilities.commands", COMMAND_KEYS) as PluginCommand,
  ));
  const statusProviders = collect(() => validateCapabilityArray(capabilitiesObject, "statusProviders", errors, (item, index) =>
    validateCommandLike(item, index, "capabilities.statusProviders", COMMAND_KEYS) as PluginStatusProvider,
  ));
  const links = validateCapabilityArray(capabilitiesObject, "links", errors, (item, index): PluginLink | null => {
    const localErrors: string[] = [];
    const extraKeys = unknownKeys(item, LINK_KEYS);
    if (extraKeys.length) localErrors.push(`capabilities.links[${index}] unknown fields: ${extraKeys.join(", ")}`);
    const itemId = requiredString(item, "id", localErrors);
    validateId(itemId, `capabilities.links[${index}].id`, localErrors);
    const label = requiredString(item, "label", localErrors);
    const url = requiredString(item, "url", localErrors, 500);
    validateHttpUrl(url, `capabilities.links[${index}].url`, localErrors);
    const itemDescription = optionalString(item, "description", localErrors);
    if (localErrors.length) {
      errors.push(...localErrors);
      return null;
    }
    return { id: itemId, label, url, ...(itemDescription ? { description: itemDescription } : {}) };
  });
  const ralphPresets = validateCapabilityArray(capabilitiesObject, "ralphPresets", errors, (item, index): PluginRalphPreset | null => {
    const localErrors: string[] = [];
    const extraKeys = unknownKeys(item, RALPH_PRESET_KEYS);
    if (extraKeys.length) localErrors.push(`capabilities.ralphPresets[${index}] unknown fields: ${extraKeys.join(", ")}`);
    const itemId = requiredString(item, "id", localErrors);
    validateId(itemId, `capabilities.ralphPresets[${index}].id`, localErrors);
    const label = requiredString(item, "label", localErrors);
    const planFile = optionalString(item, "planFile", localErrors, 120);
    if (planFile && (planFile.includes("..") || planFile.startsWith("/") || planFile.includes("\\"))) {
      localErrors.push(`capabilities.ralphPresets[${index}].planFile must be project-relative`);
    }
    const agent = optionalString(item, "agent", localErrors, 120);
    if (agent) validateCommandValue(agent, `capabilities.ralphPresets[${index}].agent`, localErrors);
    const itemDescription = optionalString(item, "description", localErrors);
    if (localErrors.length) {
      errors.push(...localErrors);
      return null;
    }
    return { id: itemId, label, ...(planFile ? { planFile } : {}), ...(agent ? { agent } : {}), ...(itemDescription ? { description: itemDescription } : {}) };
  });
  const uiActions = validateCapabilityArray(capabilitiesObject, "uiActions", errors, (item, index): PluginUiAction | null => {
    const localErrors: string[] = [];
    const extraKeys = unknownKeys(item, UI_ACTION_KEYS);
    if (extraKeys.length) localErrors.push(`capabilities.uiActions[${index}] unknown fields: ${extraKeys.join(", ")}`);
    const itemId = requiredString(item, "id", localErrors);
    validateId(itemId, `capabilities.uiActions[${index}].id`, localErrors);
    const label = requiredString(item, "label", localErrors);
    const kind = requiredString(item, "kind", localErrors, 40);
    if (!UI_ACTION_KINDS.has(kind)) localErrors.push(`capabilities.uiActions[${index}].kind is unsupported`);
    const target = requiredString(item, "target", localErrors, 500);
    if (kind === "open-link") validateHttpUrl(target, `capabilities.uiActions[${index}].target`, localErrors);
    if (kind === "copy-command") validateCommandValue(target, `capabilities.uiActions[${index}].target`, localErrors);
    const itemDescription = optionalString(item, "description", localErrors);
    if (localErrors.length) {
      errors.push(...localErrors);
      return null;
    }
    return { id: itemId, label, kind: kind as PluginUiAction["kind"], target, ...(itemDescription ? { description: itemDescription } : {}) };
  });

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
      id,
      displayName,
      ...(description ? { description } : {}),
      ...(homepage ? { homepage } : {}),
      capabilities: { commands, links, statusProviders, ralphPresets, uiActions },
    },
  };
}

function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const base = normalizePath(root);
  const child = normalizePath(candidate);
  return child === base || child.startsWith(base + sep);
}

function trustForKind(kind: PluginSourceKind): PluginTrustLabel {
  if (kind === "bundled") return "bundled";
  if (kind === "project") return "project";
  return "user-installed";
}

function safeListManifestFiles(root: string, kind: PluginSourceKind, project?: string): { files: string[]; errors: PluginManifestError[]; root?: string } {
  const trust = trustForKind(kind);
  try {
    if (!existsSync(root)) return { files: [], errors: [] };
    if (lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory()) {
      return { files: [], errors: [{ path: root, code: "invalid_path", message: "plugin root is not a directory", trust, project }] };
    }
    const realRoot = realpathSync(root);
    const files: string[] = [];
    const errors: PluginManifestError[] = [];
    for (const name of readdirSync(realRoot)) {
      if (!MANIFEST_FILE_REGEX.test(name)) continue;
      const candidate = join(realRoot, name);
      try {
        if (!isWithinRoot(realRoot, candidate)) {
          errors.push({ path: candidate, code: "invalid_path", message: "manifest path escapes plugin root", trust, project });
          continue;
        }
        if (lstatSync(candidate).isSymbolicLink()) {
          errors.push({ path: candidate, code: "invalid_path", message: "manifest symlinks are not allowed", trust, project });
          continue;
        }
        if (!statSync(candidate).isFile()) continue;
        const realFile = realpathSync(candidate);
        if (!isWithinRoot(realRoot, realFile)) {
          errors.push({ path: candidate, code: "invalid_path", message: "manifest resolves outside plugin root", trust, project });
          continue;
        }
        files.push(realFile);
      } catch (e) {
        errors.push({ path: candidate, code: "invalid_path", message: `cannot inspect manifest: ${String(e)}`, trust, project });
      }
    }
    return { files, errors, root: realRoot };
  } catch (e) {
    return { files: [], errors: [{ path: root, code: "invalid_path", message: `cannot inspect plugin root: ${String(e)}`, trust, project }] };
  }
}

function readManifest(path: string, trust: PluginTrustLabel, project?: string): { manifest?: PluginManifest; error?: PluginManifestError } {
  let text = "";
  try {
    const size = statSync(path).size;
    if (size > MAX_MANIFEST_BYTES) {
      return { error: { path, code: "read_error", message: "manifest is too large", trust, project } };
    }
    text = readFileSync(path, "utf-8");
  } catch (e) {
    return { error: { path, code: "read_error", message: `cannot read manifest: ${String(e)}`, trust, project } };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { error: { path, code: "parse_error", message: `invalid JSON: ${String(e)}`, trust, project } };
  }
  const validation = validatePluginManifest(raw);
  if (!validation.ok) {
    return { error: { path, code: "validation_error", message: validation.errors.join("; "), trust, project } };
  }
  return { manifest: validation.value };
}

function expandPluginDirs(dirs: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [DEFAULT_USER_PLUGIN_DIR, ...(dirs ?? [])]) {
    const expanded = dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
    const abs = resolve(expanded);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

function projectPluginRoots(devDir: string): Array<{ root: string; project: string }> {
  const roots: Array<{ root: string; project: string }> = [];
  try {
    if (!existsSync(devDir) || !statSync(devDir).isDirectory()) return roots;
    const realDevDir = realpathSync(devDir);
    for (const name of readdirSync(realDevDir)) {
      if (name === "." || name === ".." || name.includes(sep)) continue;
      const projectDir = join(realDevDir, name);
      try {
        if (lstatSync(projectDir).isSymbolicLink() || !statSync(projectDir).isDirectory()) continue;
        roots.push({ root: join(projectDir, PROJECT_PLUGIN_RELATIVE_DIR), project: name });
      } catch { /* project disappeared during scan */ }
    }
  } catch { /* dev dir unavailable */ }
  return roots;
}

export function discoverPluginManifests(options: PluginDiscoveryOptions): PluginDiscoveryResult {
  const roots: Array<{ kind: PluginSourceKind; root: string; trust: PluginTrustLabel; project?: string }> = [];
  if (options.bundledPluginDir) roots.push({ kind: "bundled", root: resolve(options.bundledPluginDir), trust: "bundled" });
  for (const root of expandPluginDirs(options.configPluginDirs)) {
    roots.push({ kind: "config", root, trust: "user-installed" });
  }
  for (const projectRoot of projectPluginRoots(options.devDir)) {
    roots.push({ kind: "project", root: projectRoot.root, trust: "project", project: projectRoot.project });
  }

  const errors: PluginManifestError[] = [];
  const candidates: DiscoveredPlugin[] = [];
  const allowedRoots: PluginDiscoveryResult["boundaries"]["allowedRoots"] = [];
  for (const root of roots) {
    const listing = safeListManifestFiles(root.root, root.kind, root.project);
    errors.push(...listing.errors);
    if (listing.root) allowedRoots.push({ kind: root.kind, path: listing.root, trust: root.trust, ...(root.project ? { project: root.project } : {}) });
    for (const file of listing.files) {
      const parsed = readManifest(file, root.trust, root.project);
      if (parsed.error) {
        errors.push(parsed.error);
        continue;
      }
      candidates.push({
        ...parsed.manifest!,
        source: { kind: root.kind, trust: root.trust, path: file, ...(root.project ? { project: root.project } : {}) },
      });
    }
  }

  const rank: Record<PluginSourceKind, number> = { bundled: 0, config: 1, project: 2 };
  candidates.sort((a, b) => {
    const byRank = rank[b.source.kind] - rank[a.source.kind];
    if (byRank) return byRank;
    return basename(a.source.path).localeCompare(basename(b.source.path));
  });
  const byId = new Map<string, DiscoveredPlugin>();
  for (const plugin of candidates) {
    if (byId.has(plugin.id)) {
      errors.push({
        path: plugin.source.path,
        code: "duplicate",
        message: `plugin id ${plugin.id} ignored because higher-precedence manifest already exists`,
        trust: plugin.source.trust,
        project: plugin.source.project,
      });
      continue;
    }
    byId.set(plugin.id, plugin);
  }

  return {
    plugins: [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    errors,
    boundaries: {
      schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
      allowedRoots,
      forbidden: [
        "arbitrary browser script execution",
        "implicit plugin execution during discovery",
        "manifest symlinks or paths resolving outside approved roots",
        "unknown manifest fields",
      ],
      precedence: ["project", "config", "bundled"],
    },
  };
}
