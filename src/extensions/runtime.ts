import { createHash, randomUUID } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, renameSync, rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { WOLFPACK_DIR } from "../cli/config.ts";
import { writePrivateJsonFile } from "../server/persistence.ts";
import { compileStaticDocumentSchema, type ExtensionDocumentKey, type StaticSchemaValidator } from "./document-contract.ts";
import { parseExtensionPackageManifest, type ExtensionPackageManifest } from "./manifest.ts";
import { extractVerifiedNpmTarball, fetchExactNpmPackage } from "./package-security.ts";
import { assertPortablePackagePath } from "./portable-path.ts";
import { deployBundledPiSkills, removeBundledPiSkills, type BundledPiSkill, type PiSkillDeploymentResult } from "./pi-skill-deployment.ts";
import type { ExtensionCatalogEnvelope, ExtensionCatalogInstallation } from "./runtime-contract.ts";

const REGISTRY_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 4_000;

export interface InstalledExtension {
  readonly installationId: string;
  readonly extensionId: string;
  readonly package: { readonly name: string; readonly version: string; readonly digest: string };
  readonly snapshot: string;
  readonly enabled: boolean;
  /** Removed packages keep their private snapshot/installation UUID so explicit reinstall retains document data. */
  readonly removed?: boolean;
  readonly previous?: { readonly version: string; readonly snapshot: string; readonly digest: string };
}
interface ExtensionRegistry { readonly version: 1; readonly installations: readonly InstalledExtension[]; }
export class ExtensionRuntimeError extends Error {
  constructor(readonly code: "INVALID_SOURCE" | "NOT_INSTALLED" | "DISABLED" | "BUSY" | "REGISTRY_CORRUPT" | "INCOMPATIBLE_SCHEMA", message: string) { super(message); this.name = "ExtensionRuntimeError"; }
}
export interface InstallExtensionOptions { readonly source: string; readonly trustBrowserCode: boolean; readonly skillsRoot?: string; readonly registryUrl?: string; }
export interface ExtensionRuntimeOptions { readonly root?: string; readonly skillsRoot?: string; }

function sha(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function safeRead(path: string): Buffer { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new ExtensionRuntimeError("INVALID_SOURCE", "extension snapshot has an invalid file"); return readFileSync(path); }
function isRegistry(value: unknown): value is ExtensionRegistry {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (value as { version?: unknown }).version === REGISTRY_VERSION
    && Array.isArray((value as { installations?: unknown }).installations)
    && (value as { installations: unknown[] }).installations.every((entry) => !!entry && typeof entry === "object" && UUID.test((entry as InstalledExtension).installationId) && typeof (entry as InstalledExtension).extensionId === "string" && typeof (entry as InstalledExtension).snapshot === "string" && typeof (entry as InstalledExtension).enabled === "boolean");
}

/** Local owner-private package registry. Package files are copied before parsing; no package code is imported. */
export class ExtensionRuntime {
  readonly root: string;
  private readonly skillsRoot?: string;
  constructor(options: ExtensionRuntimeOptions = {}) { this.root = options.root ?? join(WOLFPACK_DIR, "extensions"); this.skillsRoot = options.skillsRoot; }
  private registryPath() { return join(this.root, "registry.json"); }
  private snapshots() { return join(this.root, "snapshots"); }
  private ensureRoot() { mkdirSync(this.root, { recursive: true, mode: 0o700 }); if (!lstatSync(this.root).isDirectory()) throw new ExtensionRuntimeError("REGISTRY_CORRUPT", "extension root is not a directory"); mkdirSync(this.snapshots(), { recursive: true, mode: 0o700 }); }
  private registry(): ExtensionRegistry { this.ensureRoot(); if (!existsSync(this.registryPath())) return { version: 1, installations: [] }; try { const registry: unknown = JSON.parse(readFileSync(this.registryPath(), "utf8")); if (!isRegistry(registry)) throw new Error(); return registry; } catch { throw new ExtensionRuntimeError("REGISTRY_CORRUPT", "extension registry is not coherent"); } }
  private save(registry: ExtensionRegistry) { writePrivateJsonFile(this.registryPath(), registry); }
  private withLock<T>(fn: () => T): T { this.ensureRoot(); const lock = join(this.root, ".registry-lock"); try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new ExtensionRuntimeError("BUSY", "extension registry has an active transaction; no automatic recovery"); } try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); } }
  private snapshotDirectory(source: string): { snapshot: string; digest: string } {
    if (!isAbsolute(source)) throw new ExtensionRuntimeError("INVALID_SOURCE", "local extension source must be an absolute directory");
    const sourceRoot = resolve(source); const stat = lstatSync(sourceRoot); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ExtensionRuntimeError("INVALID_SOURCE", "local extension source must be a non-symlink directory");
    const files: string[] = []; const walk = (directory: string) => { const dir = opendirSync(directory); try { for (let entry = dir.readSync(); entry; entry = dir.readSync()) { const full = join(directory, entry.name); const rel = relative(sourceRoot, full).replaceAll("\\", "/"); assertPortablePackagePath(rel); const entryStat = lstatSync(full); if (entryStat.isSymbolicLink() || (!entryStat.isDirectory() && !entryStat.isFile())) throw new ExtensionRuntimeError("INVALID_SOURCE", "local extension cannot contain links or special files"); if (entryStat.isDirectory()) walk(full); else { safeRead(full); files.push(rel); if (files.length > MAX_FILES) throw new ExtensionRuntimeError("INVALID_SOURCE", "local extension has too many files"); } } } finally { dir.closeSync(); } };
    walk(sourceRoot); if (!files.includes("package.json")) throw new ExtensionRuntimeError("INVALID_SOURCE", "local extension requires package.json");
    files.sort(); const digest = sha(files.map((file) => `${file}\0${sha(safeRead(join(sourceRoot, file)))}`).join("\n")); const stage = join(this.snapshots(), `.stage-${randomUUID()}`); const destination = join(this.snapshots(), digest); try { cpSync(sourceRoot, stage, { recursive: true, dereference: false, errorOnExist: true, force: false }); if (!existsSync(destination)) renameSync(stage, destination); else rmSync(stage, { recursive: true, force: true }); return { snapshot: destination, digest }; } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
  }
  private async snapshot(source: string, registryUrl?: string): Promise<{ snapshot: string; digest: string }> {
    if (!source.startsWith("npm:")) return this.snapshotDirectory(source);
    const stage = join(this.root, "acquisition"); mkdirSync(stage, { recursive: true, mode: 0o700 });
    const pack = await fetchExactNpmPackage(source, stage, { registryUrl });
    const extracted = await extractVerifiedNpmTarball(pack.tarball, this.snapshots(), { integrity: pack.integrity });
    return this.snapshotDirectory(extracted);
  }
  private manifest(snapshot: string): ExtensionPackageManifest { try { return parseExtensionPackageManifest(JSON.parse(safeRead(join(snapshot, "package.json")).toString("utf8"))); } catch (error) { if (error instanceof ExtensionRuntimeError) throw error; throw new ExtensionRuntimeError("INVALID_SOURCE", error instanceof Error ? error.message : "invalid package manifest"); } }
  private catalogEntry(installed: InstalledExtension): ExtensionCatalogInstallation {
    const manifest = this.manifest(installed.snapshot); const ui = manifest.wolfpack.ui;
    return { installationId: installed.installationId, extensionId: installed.extensionId, package: installed.package, enabled: installed.enabled, ...(ui ? { ui: { path: ui, digest: sha(safeRead(join(installed.snapshot, ui))), mime: "text/javascript" as const } } : {}), documents: manifest.wolfpack.documents.map(({ id, schemaVersion }) => ({ id, schemaVersion })) };
  }
  catalog(safeMode = false): ExtensionCatalogEnvelope { return { safeMode, installations: this.registry().installations.filter((entry) => !entry.removed).map((entry) => this.catalogEntry(entry)) }; }
  get(extensionId: string): InstalledExtension { const found = this.registry().installations.find((entry) => entry.extensionId === extensionId && !entry.removed); if (!found) throw new ExtensionRuntimeError("NOT_INSTALLED", "extension is not installed"); return found; }
  schema(key: ExtensionDocumentKey): StaticSchemaValidator {
    const installed = this.get(key.extensionId); if (!installed.enabled) throw new ExtensionRuntimeError("DISABLED", "extension is disabled"); if (installed.installationId !== key.installationId) throw new ExtensionRuntimeError("NOT_INSTALLED", "installation does not own this extension"); const declaration = this.manifest(installed.snapshot).wolfpack.documents.find((doc) => doc.id === key.documentId); if (!declaration) throw new ExtensionRuntimeError("NOT_INSTALLED", "document is not installed"); return compileStaticDocumentSchema(JSON.parse(safeRead(join(installed.snapshot, declaration.schema)).toString("utf8")));
  }
  asset(installationId: string, assetPath: string): { readonly bytes: Buffer; readonly digest: string } {
    const installed = this.registry().installations.find((entry) => entry.installationId === installationId); if (!installed || !installed.enabled) throw new ExtensionRuntimeError("NOT_INSTALLED", "extension asset is unavailable"); const ui = this.manifest(installed.snapshot).wolfpack.ui; if (!ui || ui !== assetPath || !ui.endsWith(".js")) throw new ExtensionRuntimeError("NOT_INSTALLED", "extension asset is not allowlisted"); const bytes = safeRead(join(installed.snapshot, ui)); return { bytes, digest: sha(bytes) };
  }
  async install(options: InstallExtensionOptions): Promise<{ readonly installation: InstalledExtension; readonly skills: readonly PiSkillDeploymentResult[] }> {
    if (!options.trustBrowserCode) throw new ExtensionRuntimeError("INVALID_SOURCE", "explicit browser-code trust is required"); this.ensureRoot(); const snap = await this.snapshot(options.source, options.registryUrl); const manifest = this.manifest(snap.snapshot); const skills = options.skillsRoot ?? this.skillsRoot ? this.skills(manifest, snap.snapshot, options.skillsRoot ?? this.skillsRoot!) : [];
    return this.withLock(() => { const registry = this.registry(); const old = registry.installations.find((entry) => entry.extensionId === manifest.wolfpack.id); if (old && this.schemaChanged(old, manifest)) throw new ExtensionRuntimeError("INCOMPATIBLE_SCHEMA", "schema-changing updates require explicit migration support"); const installation: InstalledExtension = { installationId: old?.installationId ?? randomUUID(), extensionId: manifest.wolfpack.id, package: { name: manifest.name, version: manifest.version, digest: snap.digest }, snapshot: snap.snapshot, enabled: old?.enabled ?? true, removed: false, ...(old ? { previous: { version: old.package.version, snapshot: old.snapshot, digest: old.package.digest } } : {}) }; this.save({ version: 1, installations: [...registry.installations.filter((entry) => entry.extensionId !== manifest.wolfpack.id), installation] }); return { installation, skills }; });
  }
  private schemaChanged(old: InstalledExtension, next: ExtensionPackageManifest): boolean { const before = this.manifest(old.snapshot).wolfpack.documents; return before.length !== next.wolfpack.documents.length || before.some((doc) => { const successor = next.wolfpack.documents.find((candidate) => candidate.id === doc.id); return !successor || successor.schemaVersion !== doc.schemaVersion; }); }
  private skills(manifest: ExtensionPackageManifest, snapshot: string, root: string): readonly PiSkillDeploymentResult[] { const skills: BundledPiSkill[] = manifest.wolfpack.skills.map((path) => { const directory = join(snapshot, path); const stat = lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ExtensionRuntimeError("INVALID_SOURCE", "manifest skill must be a regular directory"); const files: Array<{ path: string; content: string }> = []; const walk = (d: string) => { const dir = opendirSync(d); try { for (let entry = dir.readSync(); entry; entry = dir.readSync()) { const full = join(d, entry.name); if (entry.isDirectory()) walk(full); else if (entry.isFile()) files.push({ path: relative(directory, full).replaceAll("\\", "/"), content: safeRead(full).toString("utf8") }); else throw new ExtensionRuntimeError("INVALID_SOURCE", "skill contains unsupported entry"); } } finally { dir.closeSync(); } }; walk(directory); return { name: path.split("/").at(-1)!, files }; }); return deployBundledPiSkills({ skillsRoot: root, extensionId: manifest.wolfpack.id, skills }); }
  setEnabled(extensionId: string, enabled: boolean): InstalledExtension { return this.withLock(() => { const registry = this.registry(); const old = this.get(extensionId); const installation = { ...old, enabled }; this.save({ version: 1, installations: registry.installations.map((entry) => entry.extensionId === extensionId ? installation : entry) }); return installation; }); }
  remove(extensionId: string, skillsRoot?: string): readonly PiSkillDeploymentResult[] { return this.withLock(() => { const registry = this.registry(); const old = this.get(extensionId); const manifest = this.manifest(old.snapshot); const results = skillsRoot ?? this.skillsRoot ? removeBundledPiSkills({ skillsRoot: skillsRoot ?? this.skillsRoot!, extensionId, names: manifest.wolfpack.skills.map((skill) => skill.split("/").at(-1)!) }) : []; this.save({ version: 1, installations: registry.installations.map((entry) => entry.extensionId === extensionId ? { ...entry, enabled: false, removed: true } : entry) }); return results; }); }
  /** Explicit destructive data cleanup; ordinary remove deliberately does not call this. */
  purge(extensionId: string): void { this.withLock(() => { const registry = this.registry(); const entry = registry.installations.find((item) => item.extensionId === extensionId); if (!entry) throw new ExtensionRuntimeError("NOT_INSTALLED", "extension has no retained installation"); const docs = join(this.root, "documents"); if (existsSync(docs)) { const directory = opendirSync(docs); try { for (let file = directory.readSync(); file; file = directory.readSync()) { if (!file.isFile() || !file.name.endsWith(".json")) continue; const path = join(docs, file.name); try { const value = JSON.parse(safeRead(path).toString("utf8")) as { key?: { installationId?: string } }; if (value.key?.installationId === entry.installationId) rmSync(path, { force: true }); } catch { /* corrupted records remain visible to the document store; purge never masks corruption */ } } } finally { directory.closeSync(); } } rmSync(entry.snapshot, { recursive: true, force: true }); if (entry.previous) rmSync(entry.previous.snapshot, { recursive: true, force: true }); this.save({ version: 1, installations: registry.installations.filter((item) => item.extensionId !== extensionId) }); }); }
  rollback(extensionId: string): InstalledExtension { return this.withLock(() => { const registry = this.registry(); const old = this.get(extensionId); if (!old.previous) throw new ExtensionRuntimeError("INVALID_SOURCE", "extension has no retained previous version"); const next = { ...old, package: { ...old.package, version: old.previous.version, digest: old.previous.digest }, snapshot: old.previous.snapshot, previous: { version: old.package.version, digest: old.package.digest, snapshot: old.snapshot } }; this.save({ version: 1, installations: registry.installations.map((entry) => entry.extensionId === extensionId ? next : entry) }); return next; }); }
}

let runtime: ExtensionRuntime | undefined;
export function getExtensionRuntime(): ExtensionRuntime { return runtime ??= new ExtensionRuntime(); }
export function __setExtensionRuntimeForTests(value: ExtensionRuntime | undefined): void { if (!process.env.WOLFPACK_TEST) throw new Error("test-only extension runtime override"); runtime = value; }
