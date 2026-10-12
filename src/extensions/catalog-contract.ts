import { isExtensionIdentifier } from "./contribution-metadata.ts";
import type { ExtensionCatalogEnvelope, ExtensionCatalogInstallation } from "./runtime-contract.ts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string"; }
function positiveSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function safeRelativeAssetPath(value: unknown): value is string { return text(value) && value.length <= 256 && /^[A-Za-z0-9._@+/-]+$/.test(value) && !value.split("/").some(part => !part || part === "." || part === ".."); }
function catalogFailure(): never { throw new Error("invalid extension catalog envelope"); }

/** Shared browser/proxy boundary: JSON identities must be validated before storage or loading. */
export function parseExtensionCatalog(value: unknown): ExtensionCatalogEnvelope {
  if (!record(value) || typeof value.safeMode !== "boolean" || !Array.isArray(value.installations)) return catalogFailure();
  let installationId: string | undefined;
  const extensionIds = new Set<string>();
  const installations: ExtensionCatalogInstallation[] = value.installations.map((candidate) => {
    if (!record(candidate) || !text(candidate.installationId) || !UUID.test(candidate.installationId) || !text(candidate.extensionId) || !isExtensionIdentifier(candidate.extensionId) || typeof candidate.enabled !== "boolean" || !record(candidate.package) || !text(candidate.package.name) || !text(candidate.package.version) || !text(candidate.package.digest) || !SHA256.test(candidate.package.digest) || !Array.isArray(candidate.documents)) return catalogFailure();
    if (installationId !== undefined && installationId !== candidate.installationId) return catalogFailure();
    installationId = candidate.installationId;
    if (extensionIds.has(candidate.extensionId)) return catalogFailure();
    extensionIds.add(candidate.extensionId);
    const documents = candidate.documents.map((document) => {
      if (!record(document) || !text(document.id) || !isExtensionIdentifier(document.id) || !positiveSafeInteger(document.schemaVersion)) return catalogFailure();
      return Object.freeze({ id: document.id, schemaVersion: document.schemaVersion });
    });
    if (documents.length > 32) return catalogFailure();
    let ui: ExtensionCatalogInstallation["ui"];
    if (candidate.ui !== undefined) {
      if (!record(candidate.ui) || !safeRelativeAssetPath(candidate.ui.path) || !text(candidate.ui.url) || candidate.ui.url !== `/api/extensions/assets/${candidate.extensionId}/${candidate.package.digest}/${candidate.ui.path}` || !text(candidate.ui.digest) || !SHA256.test(candidate.ui.digest) || candidate.ui.mime !== "text/javascript") return catalogFailure();
      ui = Object.freeze({ path: candidate.ui.path, url: candidate.ui.url, digest: candidate.ui.digest, mime: "text/javascript" });
    }
    return Object.freeze({ installationId: candidate.installationId, extensionId: candidate.extensionId, package: Object.freeze({ name: candidate.package.name, version: candidate.package.version, digest: candidate.package.digest }), enabled: candidate.enabled, ...(ui ? { ui } : {}), documents: Object.freeze(documents) });
  });
  return Object.freeze({ safeMode: value.safeMode, installations: Object.freeze(installations) });
}
