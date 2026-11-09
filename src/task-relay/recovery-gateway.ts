import type { GatewayOptions } from "./gateway.ts";
import type { RelayGateway } from "./worker-protocol.ts";
import { WorkerRelayGateway, captureOptions } from "./worker-client.ts";

/** Server-owned recovery, not mutation replay. A timed-out request returns unknown;
 * the next caller reopens storage only after confirmed prior worker termination. */
export class RecoveryRelayGateway implements RelayGateway {
  readonly root: string;
  readonly profile = "restart-safe-v1" as const;
  #worker: WorkerRelayGateway;
  #replacing: Promise<WorkerRelayGateway> | undefined;
  #closed = false;
  readonly #options: GatewayOptions;
  constructor(options: GatewayOptions) {
    this.#options = captureOptions(options);
    this.#worker = new WorkerRelayGateway({ ...this.#options, profile: this.profile });
    this.root = this.#worker.root;
  }
  async #owner(): Promise<WorkerRelayGateway> {
    if (this.#closed) throw new Error("relay gateway is closed");
    if (!this.#worker.isClosed) return this.#worker;
    if (!this.#replacing) {
      const prior = this.#worker;
      this.#replacing = (async () => {
        await prior.close(); // A failed termination retains the root reservation and prevents replacement.
        if (this.#closed) throw new Error("relay gateway closed during recovery");
        this.#worker = new WorkerRelayGateway({ ...this.#options, root: this.root, profile: this.profile });
        await this.#worker.initialize();
        return this.#worker;
      })().finally(() => { this.#replacing = undefined; });
    }
    return this.#replacing;
  }
  async initialize() { await (await this.#owner()).initialize(); }
  async volatileEpoch() { return (await this.#owner()).volatileEpoch(); }
  async registrationsForSessions(ids: readonly string[]) { return (await this.#owner()).registrationsForSessions(ids); }
  async endpointForSession(id: string) { return (await this.#owner()).endpointForSession(id); }
  async endpointsForSessions(ids: readonly string[]) { return (await this.#owner()).endpointsForSessions(ids); }
  async volatile(input: unknown) { return (await this.#owner()).volatile(input); }
  async volatilePeer(input: unknown) { return (await this.#owner()).volatilePeer(input); }
  async volatileTopology(input: unknown) { return (await this.#owner()).volatileTopology(input); }
  async close() {
    this.#closed = true;
    await this.#replacing?.catch(() => undefined);
    await this.#worker.close();
  }
}
