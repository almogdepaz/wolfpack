import type { SessionInspectionResult } from "../session-status-contract.ts";
import type { RelayGateway } from "./worker-protocol.ts";
import { RecoveryRelayGateway } from "./recovery-gateway.ts";
import { WorkerRelayGateway, captureOptions } from "./worker-client.ts";
import { getRelayPeerTransport } from "../server/relay-peer-transport.ts";

export interface GatewayOptions {
  readonly root?: string;
  readonly requestTimeoutMs?: number;
  readonly profile?: "volatile-v1" | "restart-safe-v1";
  readonly peerOrigin?: string;
  readonly peerFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly inspectSession?: (selector: string) => Promise<SessionInspectionResult>;
}

/** Explicit profiles have different guarantees. There is no fallback or legacy durable API. */
export function getTaskRelayProfile(): "volatile-v1" | "restart-safe-v1" {
  const selected = process.env.WOLFPACK_TASK_RELAY_PROFILE ?? "restart-safe-v1";
  if (selected !== "volatile-v1" && selected !== "restart-safe-v1") throw new TypeError("unsupported task relay profile");
  return selected;
}
export function createTaskRelayGateway(suppliedOptions: GatewayOptions): RelayGateway {
  const options = captureOptions(suppliedOptions);
  const profile = options.profile ?? getTaskRelayProfile();
  const peerFetch: NonNullable<GatewayOptions["peerFetch"]> = options.peerFetch ?? ((input, init) => getRelayPeerTransport(gateway, options.peerOrigin).forward(input, init));
  const gateway: RelayGateway = profile === "restart-safe-v1"
    ? new RecoveryRelayGateway({ ...options, profile, peerFetch })
    : new WorkerRelayGateway({ ...options, profile, peerFetch });
  return gateway;
}
