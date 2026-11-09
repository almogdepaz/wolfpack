import type { SessionInspectionResult } from "../session-status-contract.ts";
import type { RelayGateway } from "./worker-protocol.ts";
import { RecoveryRelayGateway } from "./recovery-gateway.ts";
import { WorkerRelayGateway, captureOptions } from "./worker-client.ts";
import { getRelayPeerTransport } from "../server/relay-peer-transport.ts";

export interface GatewayOptions {
  readonly root?: string;
  readonly requestTimeoutMs?: number;
  readonly storage?: "memory" | "sqlite";
  readonly profile?: "volatile-v1";
  readonly peerOrigin?: string;
  readonly peerFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly inspectSession?: (selector: string) => Promise<SessionInspectionResult>;
}

/** Storage does not negotiate endpoint durability. Existing RAM clients speak the same wire protocol. */
export function getTaskRelayProfile(): "volatile-v1" {
  const selected = process.env.WOLFPACK_TASK_RELAY_PROFILE;
  if (selected !== undefined && selected !== "volatile-v1") throw new TypeError("unsupported task relay profile");
  return "volatile-v1";
}
export function createTaskRelayGateway(suppliedOptions: GatewayOptions): RelayGateway {
  getTaskRelayProfile();
  const options = captureOptions(suppliedOptions);
  const storage = options.storage ?? process.env.WOLFPACK_TASK_RELAY_STORAGE ?? "sqlite";
  if (storage !== "memory" && storage !== "sqlite") throw new TypeError("unsupported task relay storage");
  const peerFetch: NonNullable<GatewayOptions["peerFetch"]> = options.peerFetch ?? ((input, init) => getRelayPeerTransport(gateway, options.peerOrigin).forward(input, init));
  const gateway: RelayGateway = storage === "sqlite"
    ? new RecoveryRelayGateway({ ...options, storage, peerFetch })
    : new WorkerRelayGateway({ ...options, storage, peerFetch });
  return gateway;
}
