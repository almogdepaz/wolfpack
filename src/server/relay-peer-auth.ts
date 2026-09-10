import { loadConfig, remoteUrl } from "../cli/config.ts";
import { issueJwt } from "../cli/api.ts";
import { RelayPeerAuth } from "../task-relay/peer-auth.ts";
import type { WorkerRelayGateway } from "../task-relay/worker-client.ts";
import { readRelayPeerTopology } from "./http.ts";

const owners = new WeakMap<WorkerRelayGateway, RelayPeerAuth>();

/** One epoch-key controller per worker owner, never a persisted recovery key. */
export function getRelayPeerAuth(gateway: WorkerRelayGateway, origin?: string): RelayPeerAuth {
  let auth = owners.get(gateway);
  if (!auth) {
    const config = loadConfig();
    const configuredOrigin = origin ?? (config ? remoteUrl(config) ?? undefined : undefined);
    auth = new RelayPeerAuth({
      topology: () => readRelayPeerTopology(configuredOrigin),
      epoch: () => gateway.volatileEpoch(),
      jwt: issueJwt,
    });
    owners.set(gateway, auth);
  }
  return auth;
}
