export interface FocusHomeIdentity { home: string; installationId: string; local: boolean }

export function isFocusHome(value: unknown): value is string | null {
  return value === null || typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
/** Store-independent local identity, including on failed focus-document reads. */
export function isFocusHomeIdentity(value: unknown): value is FocusHomeIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.home === "string" && isFocusHome(candidate.home)
    && typeof candidate.installationId === "string" && isFocusHome(candidate.installationId)
    && candidate.local === (candidate.home === candidate.installationId);
}
