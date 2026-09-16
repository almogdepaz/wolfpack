import type { ExtensionDocumentReceipt } from "./document-contract.ts";

export const EXTENSION_API_ERROR = {
  NOT_INSTALLED: "NOT_INSTALLED",
  DISABLED: "DISABLED",
  ASSET_NOT_FOUND: "ASSET_NOT_FOUND",
  INVALID_REQUEST: "INVALID_REQUEST",
  SCOPE_NOT_WRITABLE: "SCOPE_NOT_WRITABLE",
  CONFLICT: "CONFLICT",
  SCHEMA_INVALID: "SCHEMA_INVALID",
  STORE_CORRUPT: "STORE_CORRUPT",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  STORE_UNAVAILABLE: "STORE_UNAVAILABLE",
} as const;
export type ExtensionApiErrorCode = (typeof EXTENSION_API_ERROR)[keyof typeof EXTENSION_API_ERROR];

export interface ExtensionCatalogDocument { readonly id: string; readonly schemaVersion: number; }
export interface ExtensionCatalogInstallation {
  readonly installationId: string;
  readonly extensionId: string;
  readonly package: { readonly name: string; readonly version: string; readonly digest: string };
  readonly enabled: boolean;
  readonly ui?: { readonly path: string; readonly digest: string; readonly mime: "text/javascript" };
  readonly documents: readonly ExtensionCatalogDocument[];
}
export interface ExtensionCatalogEnvelope { readonly safeMode: boolean; readonly installations: readonly ExtensionCatalogInstallation[]; }
export interface ExtensionDocumentReadEnvelope {
  readonly installationId: string;
  readonly scopeSessionId: string;
  readonly extensionId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly document: unknown | null;
}
export interface ExtensionDocumentPublishEnvelope { readonly receipt: ExtensionDocumentReceipt; }
export interface ExtensionApiErrorEnvelope { readonly error: { readonly code: ExtensionApiErrorCode; readonly message: string; readonly currentRevision?: number }; }
