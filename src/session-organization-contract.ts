/** Host-owned classification only; independent of terminal identity and runtime state. */
export interface SessionOrganization {
  readonly group: string | null;
  readonly tags: readonly string[];
  readonly revision: number;
}
export type SessionOrganizationProjection = SessionOrganization | { readonly status: "unavailable" };
export const SESSION_ORGANIZATION_MAX_REQUEST_BYTES = 8192;
export const SESSION_ORGANIZATION_MAX_TAGS = 16;
export const SESSION_ORGANIZATION_LABEL_CODE_POINTS = 64;
export const SESSION_ORGANIZATION_LABEL_BYTES = 256;
export const SESSION_ORGANIZATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class SessionOrganizationError extends Error {
  constructor(readonly code: "INVALID_ORGANIZATION" | "ORGANIZATION_CONFLICT", message: string) { super(message); }
}

function invalid(message: string): never { throw new SessionOrganizationError("INVALID_ORGANIZATION", message); }
function label(value: unknown): string {
  if (typeof value !== "string" || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) return invalid("labels must be text without controls");
  const normalized = value.normalize("NFC").trim();
  if (!normalized || [...normalized].length > SESSION_ORGANIZATION_LABEL_CODE_POINTS || new TextEncoder().encode(normalized).length > SESSION_ORGANIZATION_LABEL_BYTES) return invalid("labels must contain 1–64 characters (at most 256 UTF-8 bytes)");
  return normalized;
}

/** Locale-independent lowercase deduplication; keep first display spelling and order. */
export function normalizeOrganizationUpdate(value: unknown): SessionOrganizationUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("organization update must be an object");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["expectedRevision", "group", "tags"].includes(key)) || (!Object.hasOwn(v, "group") && !Object.hasOwn(v, "tags"))) return invalid("provide group or tags; unknown fields are not allowed");
  if (!Number.isSafeInteger(v.expectedRevision) || (v.expectedRevision as number) < 0) return invalid("expectedRevision must be a nonnegative safe integer");
  const result: { expectedRevision: number; group?: string | null; tags?: string[] } = { expectedRevision: v.expectedRevision as number };
  if (Object.hasOwn(v, "group")) result.group = v.group === null ? null : label(v.group);
  if (Object.hasOwn(v, "tags")) {
    if (!Array.isArray(v.tags) || v.tags.length > SESSION_ORGANIZATION_MAX_TAGS) return invalid("at most 16 tags are allowed");
    const seen = new Set<string>();
    result.tags = v.tags.map(label).filter(tag => { const key = tag.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  return result;
}

export function isSessionOrganization(value: unknown): value is SessionOrganization {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as SessionOrganization;
  try {
    if (Object.keys(v).sort().join(",") !== "group,revision,tags") return false;
    const canonical = normalizeOrganizationUpdate({ expectedRevision: v.revision, group: v.group, tags: v.tags });
    return canonical.group === v.group && JSON.stringify(canonical.tags) === JSON.stringify(v.tags);
  } catch { return false; }
}

export interface SessionOrganizationUpdate {
  readonly expectedRevision: number;
  readonly group?: string | null;
  readonly tags?: readonly string[];
}
