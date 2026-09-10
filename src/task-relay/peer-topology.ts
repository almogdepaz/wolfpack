import { canonicalTailnetOrigin, enumerateTailnetCandidates } from "../tailnet-machine-contract.ts";

export interface RelayPeerTopology {
  readonly origin: string;
  readonly nodeId: string;
  readonly peers: ReadonlyMap<string, string>;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
/** Trusted-Tailnet deployment: all locally visible online peers are trusted.
 * Keep canonical/unique routing and local Running state; no per-user/tag policy. */
export function relayPeerTopology(status: unknown, configuredOrigin: string): RelayPeerTopology {
  if (!record(status) || status.BackendState !== "Running" || !record(status.Self) || !record(status.Peer)
    || status.Self.Online !== true
    || canonicalTailnetOrigin(status.Self.DNSName) !== configuredOrigin) throw new Error("relay peer policy unavailable");
  const enumeration = enumerateTailnetCandidates(status);
  if (enumeration.kind !== "valid") throw new Error("relay peer policy unavailable");
  const nodes = Object.values(status.Peer).filter(record);
  const peers = new Map<string, string>();
  for (const candidate of enumeration.candidates) {
    const matches = nodes.filter(node => node.ID === candidate.tailnetNodeId || canonicalTailnetOrigin(node.DNSName) === candidate.origin);
    if (matches.length !== 1) continue; // No ambiguous name/node authority.
    if (!candidate.online || candidate.origin === configuredOrigin) continue;
    peers.set(candidate.origin, candidate.tailnetNodeId);
  }
  return { origin: configuredOrigin, nodeId: status.Self.ID as string, peers };
}
