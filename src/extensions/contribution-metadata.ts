export const MAX_EXTENSION_CONTRIBUTIONS = 32;
export const MAX_EXTENSION_DOCUMENTS = 32;
export const EXTENSION_IDENTIFIER_SOURCE = "^[a-z][a-z0-9-]{0,63}$";

export class ExtensionManifestError extends Error {
  constructor(readonly code: "INVALID_MANIFEST" | "DUPLICATE_DOCUMENT_ID", message: string) {
    super(message);
    this.name = "ExtensionManifestError";
  }
}

export function isExtensionIdentifier(value: string): boolean {
  return new RegExp(EXTENSION_IDENTIFIER_SOURCE).test(value);
}

/** Browser-safe identity gate shared by manifest parsing and post-load contribution registration. */
export function qualifiedContributionId(extensionId: string, contributionId: string): string {
  if (!isExtensionIdentifier(extensionId) || !isExtensionIdentifier(contributionId)) {
    throw new ExtensionManifestError("INVALID_MANIFEST", "extension and contribution IDs must be stable lowercase identifiers");
  }
  return `${extensionId}/${contributionId}`;
}
