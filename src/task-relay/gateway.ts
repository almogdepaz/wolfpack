import type { SessionInspectionResult } from "../session-status-contract.ts";
import type { RelayGateway } from "./worker-protocol.ts";
import { WorkerRelayGateway, hasRelayWorkerOwners } from "./worker-client.ts";
import { getRelayPeerTransport } from "../server/relay-peer-transport.ts";

export interface GatewayOptions {
  readonly root?: string;
  readonly peerOrigin?: string;
  readonly peerFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly inspectSession?: (selector: string) => Promise<SessionInspectionResult>;
}

/** One memory-only protocol. Retired profiles are errors, not compatibility modes. */
export function getTaskRelayProfile(): "volatile-v1" {
  if (hasRelayWorkerOwners()) return "volatile-v1";
  const selected = process.env.WOLFPACK_TASK_RELAY_PROFILE;
  if (selected !== undefined && selected !== "volatile-v1") throw new TypeError("only memory-owned volatile-v1 is supported");
  return "volatile-v1";
}
export function createTaskRelayGateway(options: GatewayOptions): RelayGateway {
  getTaskRelayProfile();
  const worker: WorkerRelayGateway = new WorkerRelayGateway({ ...options,
    peerFetch: options.peerFetch ?? ((input, init) => getRelayPeerTransport(worker, options.peerOrigin).forward(input, init)) });
  return worker;
}
