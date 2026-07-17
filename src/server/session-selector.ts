import type { PublicSessionIdentity } from "./session-identity.js";

export type SessionSelectorResult =
  | {
    readonly ok: true;
    readonly name: string;
    readonly identity: PublicSessionIdentity;
  }
  | { readonly ok: false; readonly code: "NOT_FOUND" | "AMBIGUOUS" };

export function resolveSessionSelector(
  selector: string,
  activeNames: readonly string[],
  identities: Readonly<Record<string, PublicSessionIdentity>>,
): SessionSelectorResult {
  const active = new Set(activeNames);
  const nameIdentity = active.has(selector) ? identities[selector] : undefined;
  const idMatches = Object.values(identities).filter(
    identity => active.has(identity.wolfpackSessionName)
      && identity.wolfpackSessionId === selector,
  );

  if (
    nameIdentity
    && idMatches.some(identity => identity.wolfpackSessionName !== selector)
  ) {
    return { ok: false, code: "AMBIGUOUS" };
  }
  if (nameIdentity) return { ok: true, name: selector, identity: nameIdentity };
  if (idMatches.length > 1) return { ok: false, code: "AMBIGUOUS" };
  const identity = idMatches[0];
  if (!identity) return { ok: false, code: "NOT_FOUND" };
  return { ok: true, name: identity.wolfpackSessionName, identity };
}
