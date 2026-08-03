export interface StoredMachine {
  readonly url: string;
  readonly name: string;
  readonly peerId: string | undefined;
}

export interface ReadyTailnetPeer {
  readonly url: string;
  readonly name: string;
  readonly peerId: string;
}

function isStoredPeerId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}:[0-9a-f-]{36}$/i.test(value);
}

export function parseStoredMachines(value: unknown): StoredMachine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const machine = entry as Record<string, unknown>;
    if (typeof machine.url !== "string" || typeof machine.name !== "string") return [];
    return [{
      url: machine.url,
      name: machine.name,
      peerId: isStoredPeerId(machine.peerId) ? machine.peerId : undefined,
    }];
  });
}

/** Reconciles Tailnet-owned entries by stable identity while retaining manual machines. */
export function mergeDiscoveredTailnetMachines(
  stored: readonly StoredMachine[],
  peers: readonly ReadyTailnetPeer[],
): StoredMachine[] {
  const pending = new Map(peers.map((peer) => [peer.peerId, peer]));
  const byUrl = new Map(peers.map((peer) => [peer.url, peer]));
  const merged: StoredMachine[] = [];

  for (const machine of stored) {
    const peer = machine.peerId ? pending.get(machine.peerId) : byUrl.get(machine.url);
    if (machine.peerId && !peer) continue;
    if (!peer) {
      merged.push(machine);
      continue;
    }
    pending.delete(peer.peerId);
    merged.push({ url: peer.url, name: peer.name, peerId: peer.peerId });
  }

  for (const peer of pending.values()) {
    merged.push({ url: peer.url, name: peer.name, peerId: peer.peerId });
  }
  return merged;
}
