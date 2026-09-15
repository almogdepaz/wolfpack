import { MAX_EXTENSION_CONTRIBUTIONS, qualifiedContributionId } from "./manifest.ts";

export type ExtensionContributionKind = "context-view" | "terminal-layout";
export interface RegisteredContribution {
  readonly kind: ExtensionContributionKind;
  readonly localId: string;
  readonly qualifiedId: string;
}

/**
 * Phase-2 loader creates one gate per verified package before calling its default
 * registration function. IDs are local to that verified extension; the gate,
 * not executable code, establishes global qualified ownership and rejects
 * duplicate post-load registrations.
 */
export class ExtensionContributionGate {
  private readonly contributions = new Map<string, RegisteredContribution>();
  constructor(private readonly extensionId: string) {}
  register(kind: ExtensionContributionKind, localId: string): RegisteredContribution {
    if (kind !== "context-view" && kind !== "terminal-layout") throw new Error("unsupported extension contribution kind");
    const qualifiedId = qualifiedContributionId(this.extensionId, localId);
    if (this.contributions.has(qualifiedId)) throw new Error(`duplicate ${kind} registration: ${qualifiedId}`);
    if (this.contributions.size >= MAX_EXTENSION_CONTRIBUTIONS) throw new Error(`extension contribution limit exceeded (${MAX_EXTENSION_CONTRIBUTIONS})`);
    const contribution = Object.freeze({ kind, localId, qualifiedId });
    this.contributions.set(qualifiedId, contribution);
    return contribution;
  }
  entries(): readonly RegisteredContribution[] { return [...this.contributions.values()]; }
}
