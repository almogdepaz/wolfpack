import { getRouter } from "./backend.js";

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
  const broker = brokerHealth.observe(getRouter().isBrokerAvailable());
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
