export interface ArchiveInspectionProgress { readonly expandedBytes: number; readonly entries: number; }
export class ExtensionPackageError extends Error {
  readonly inspection?: ArchiveInspectionProgress;
  readonly cleanupDirectory?: string;
  constructor(
    readonly code: "INVALID_NPM_SPECIFIER" | "NPM_UNAVAILABLE" | "NPM_FETCH_FAILED" | "INTEGRITY_MISMATCH" | "UNSAFE_ARCHIVE",
    message: string,
    details?: { readonly inspection?: ArchiveInspectionProgress; readonly cleanupDirectory?: string },
  ) {
    super(message); this.name = "ExtensionPackageError";
    if (details?.inspection) this.inspection = Object.freeze({ ...details.inspection });
    if (details?.cleanupDirectory) this.cleanupDirectory = details.cleanupDirectory;
  }
}
