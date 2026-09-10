import { canonicalTailnetOrigin, enumerateTailnetCandidates } from "../tailnet-machine-contract.ts";

export interface RelayPeerTopology {
  readonly origin: string;
  readonly nodeId: string;
  readonly peers: ReadonlyMap<string, string>;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const userId = (value: unknown): string | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value)
  : typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) ? value : undefined;
const untagged = (node: Record<string, unknown>) => node.Tags === undefined || (Array.isArray(node.Tags) && node.Tags.length === 0);

/** Authority comes ONLY from the local Tailscale control-plane status, never a peer's claims.
 * Default policy: online, untagged machines of the same nonzero Tailscale user.
 * Tagged/shared/foreign-user devices need a future separately reviewed policy. */
export function relayPeerTopology(status: unknown, configuredOrigin: string): RelayPeerTopology {
  if (!record(status) || status.BackendState !== "Running" || !record(status.Self) || !record(status.Peer)
    || status.Self.Online !== true || !untagged(status.Self) || !userId(status.Self.UserID)
    || canonicalTailnetOrigin(status.Self.DNSName) !== configuredOrigin) throw new Error("relay peer policy unavailable");
  const enumeration = enumerateTailnetCandidates(status);
  if (enumeration.kind !== "valid") throw new Error("relay peer policy unavailable");
  const nodes = Object.values(status.Peer).filter(record);
  const peers = new Map<string, string>();
  for (const candidate of enumeration.candidates) {
    const matches = nodes.filter(node => node.ID === candidate.tailnetNodeId || canonicalTailnetOrigin(node.DNSName) === candidate.origin);
    if (matches.length !== 1) continue; // No ambiguous name/node authority.
    const node = matches[0]!;
    if (!candidate.online || candidate.origin === configuredOrigin || !untagged(node) || userId(node.UserID) !== userId(status.Self.UserID)) continue;
    peers.set(candidate.origin, candidate.tailnetNodeId);
  }
  return { origin: configuredOrigin, nodeId: status.Self.ID as string, peers };
}
