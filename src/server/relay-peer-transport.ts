import { isIP } from "node:net";
import { loadConfig, remoteUrl } from "../cli/config.ts";
import { issueJwt } from "../cli/api.ts";
import { RelayPeerTransport } from "../task-relay/peer-transport.ts";
import type { RelayGateway } from "../task-relay/worker-protocol.ts";
import { readRelayPeerTopology } from "./http.ts";
import { isLoopbackAddress } from "./operability.ts";

const owners = new WeakMap<RelayGateway, RelayPeerTransport>();
export function getRelayPeerTransport(gateway: RelayGateway, origin?: string): RelayPeerTransport {
  let transport = owners.get(gateway);
  if (!transport) {
    const config = loadConfig(), configuredOrigin = origin ?? (config ? remoteUrl(config) ?? undefined : undefined);
    transport = new RelayPeerTransport({ topology: () => readRelayPeerTopology(configuredOrigin), epoch: () => gateway.volatileEpoch(), jwt: issueJwt });
    owners.set(gateway, transport);
  }
  return transport;
}
function tailnetAddress(address: string): boolean {
  const value = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(value) === 4) { const parts = value.split(".").map(Number); return parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127; }
  return isIP(value) === 6 && value.toLowerCase().startsWith("fd7a:115c:a1e0:");
}
/** Loopback is owner-controlled; forwarded addresses are considered only there.
 * A single Tailnet address supports local Tailscale Serve. Public/Funnel and
 * ambiguous proxy chains fail closed. Do not deploy behind an untrusted proxy. */
export function trustedRelayClient(remote: string | undefined, forwarded: string | string[] | undefined): boolean {
  if (!remote) return false;
  if (!isLoopbackAddress(remote)) return tailnetAddress(remote);
  if (forwarded === undefined) return true;
  return typeof forwarded === "string" && tailnetAddress(forwarded.trim());
}
