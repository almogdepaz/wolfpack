import Ajv from "ajv";
import { isCanonicalPackageVersion } from "./package-version.ts";
import {
  EXTENSION_IDENTIFIER_SOURCE,
  ExtensionManifestError,
  MAX_EXTENSION_CONTRIBUTIONS,
  MAX_EXTENSION_DOCUMENTS,
  qualifiedContributionId,
} from "./contribution-metadata.ts";

export { ExtensionManifestError, MAX_EXTENSION_CONTRIBUTIONS, MAX_EXTENSION_DOCUMENTS, qualifiedContributionId } from "./contribution-metadata.ts";

export const EXTENSION_MANIFEST_VERSION = 1;
export const EXTENSION_API_VERSION = 1;

const IDENTIFIER = EXTENSION_IDENTIFIER_SOURCE;
const SAFE_RELATIVE_PATH = "^(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*\\\\)[A-Za-z0-9._@/+-]+$";

export interface ExtensionDocumentDeclaration {
  readonly id: string;
  readonly schemaVersion: number;
  readonly schema: string;
}

export interface ExtensionManifest {
  readonly manifestVersion: typeof EXTENSION_MANIFEST_VERSION;
  readonly apiVersion: typeof EXTENSION_API_VERSION;
  readonly id: string;
  readonly ui?: string;
  readonly skills: readonly string[];
  readonly documents: readonly ExtensionDocumentDeclaration[];
}

export interface ExtensionPackageManifest {
  readonly name: string;
  readonly version: string;
  readonly wolfpack: ExtensionManifest;
}

const packageSchema = {
  type: "object",
  additionalProperties: true,
  required: ["name", "version", "wolfpack"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 214 },
    version: { type: "string", minLength: 1, maxLength: 256 },
    wolfpack: {
      type: "object",
      additionalProperties: false,
      required: ["manifestVersion", "apiVersion", "id", "skills", "documents"],
      properties: {
        manifestVersion: { const: EXTENSION_MANIFEST_VERSION },
        apiVersion: { const: EXTENSION_API_VERSION },
        id: { type: "string", pattern: IDENTIFIER },
        ui: { type: "string", pattern: SAFE_RELATIVE_PATH, maxLength: 256 },
        skills: {
          type: "array", maxItems: MAX_EXTENSION_CONTRIBUTIONS, uniqueItems: true,
          items: { type: "string", pattern: SAFE_RELATIVE_PATH, maxLength: 256 },
        },
        documents: {
          type: "array", maxItems: MAX_EXTENSION_DOCUMENTS,
          items: {
            type: "object", additionalProperties: false,
            required: ["id", "schemaVersion", "schema"],
            properties: {
              id: { type: "string", pattern: IDENTIFIER },
              schemaVersion: { type: "integer", minimum: 1, maximum: 1_000_000 },
              schema: { type: "string", pattern: SAFE_RELATIVE_PATH, maxLength: 256 },
            },
          },
        },
      },
    },
  },
} as const;

const validatePackage = new Ajv({ allErrors: true, strict: true }).compile(packageSchema);

/** Validates metadata only. It never imports or executes package browser code. */
export function parseExtensionPackageManifest(value: unknown): ExtensionPackageManifest {
  if (!validatePackage(value)) {
    const detail = validatePackage.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ") ?? "unknown validation error";
    throw new ExtensionManifestError("INVALID_MANIFEST", `invalid Wolfpack extension manifest: ${detail}`);
  }
  const manifest = value as ExtensionPackageManifest;
  if (!isCanonicalPackageVersion(manifest.version)) {
    throw new ExtensionManifestError("INVALID_MANIFEST", "package version must be canonical exact SemVer");
  }
  const paths = [manifest.wolfpack.ui, ...manifest.wolfpack.skills, ...manifest.wolfpack.documents.map((document) => document.schema)].filter((path): path is string => Boolean(path));
  if (paths.some((path) => path !== path.replace(/\/+/g, "/").replace(/^\.\//, "")) || new Set(paths).size !== paths.length) throw new ExtensionManifestError("INVALID_MANIFEST", "manifest paths must be canonical unique POSIX relative paths");
  const ids = new Set<string>();
  for (const document of manifest.wolfpack.documents) {
    if (ids.has(document.id)) {
      throw new ExtensionManifestError("DUPLICATE_DOCUMENT_ID", `duplicate extension document id: ${document.id}`);
    }
    ids.add(document.id);
  }
  return manifest;
}

