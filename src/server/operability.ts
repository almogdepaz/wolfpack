import { getRouter } from "./backend.js";

export interface RequestClientInput {
  readonly remoteAddress: string | undefined;
  readonly tailscaleUserLogin: string | readonly string[] | undefined;
}

export type RequestClient =
  | {
      readonly kind: "direct";
      readonly clientKey: string;
      readonly isDirectLoopback: boolean;
    }
  | {
      readonly kind: "tailscale_serve";
      readonly clientKey: string;
      readonly isDirectLoopback: false;
    }
  | {
      readonly kind: "unverified";
      readonly clientKey: "unverified-loopback";
      readonly isDirectLoopback: false;
    };

export type BrokerHealthState = "starting" | "ready" | "unavailable";

export class BrokerHealthMonitor {
  private state: BrokerHealthState = "starting";
  private changedAt = Date.now();

  observe(available: boolean, now = Date.now()): BrokerHealthState {
    const next: BrokerHealthState = available ? "ready" : "unavailable";
    if (next !== this.state) {
      this.state = next;
      this.changedAt = now;
    }
    return this.state;
  }

  snapshot(now = Date.now()): { state: BrokerHealthState; changedAt: string; stateAgeMs: number } {
    return { state: this.state, changedAt: new Date(this.changedAt).toISOString(), stateAgeMs: Math.max(0, now - this.changedAt) };
  }
}

const brokerHealth = new BrokerHealthMonitor();

export function operationalHealth(): Record<string, unknown> {
  const broker = brokerHealth.observe(getRouter().isBrokerReady());
  return {
    status: broker === "ready" ? "ready" : "degraded",
    broker: brokerHealth.snapshot(),
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

export function boundedMetrics(): Readonly<Record<string, number>> {
  const memory = process.memoryUsage();
  const health = operationalHealth();
  return Object.freeze({
    wolfpack_up: 1,
    wolfpack_broker_ready: (health.broker as { state: string }).state === "ready" ? 1 : 0,
    wolfpack_process_uptime_seconds: Math.floor(process.uptime()),
    wolfpack_process_resident_memory_bytes: memory.rss,
    wolfpack_process_heap_used_bytes: memory.heapUsed,
  });
}

export function prometheusMetrics(): string {
  return Object.entries(boundedMetrics()).map(([name, value]) => `# TYPE ${name} gauge\n${name} ${value}`).join("\n") + "\n";
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * Tailscale Serve is the only trusted loopback proxy. Its injected scalar
 * login replaces transport identity for quotas and tickets. Any supplied but
 * malformed loopback header is ambiguous proxy input, not direct-local trust.
 */
export function classifyRequestClient(input: RequestClientInput): RequestClient {
  const directAddress = input.remoteAddress ?? "unknown";
  const loopback = isLoopbackAddress(input.remoteAddress);
  const login = input.tailscaleUserLogin;
  if (!loopback || login === undefined) {
    return {
      kind: "direct",
      clientKey: `direct:${directAddress}`,
      isDirectLoopback: loopback,
    };
  }
  if (typeof login === "string") {
    const normalizedLogin = login.trim().toLowerCase();
    if (normalizedLogin.length > 0 && !normalizedLogin.includes(",")) {
      return {
        kind: "tailscale_serve",
        clientKey: `tailscale-serve:${normalizedLogin}`,
        isDirectLoopback: false,
      };
    }
  }
  return {
    kind: "unverified",
    clientKey: "unverified-loopback",
    isDirectLoopback: false,
  };
}
