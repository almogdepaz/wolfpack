import { relayOpenFailure } from "./owner-failure.ts";
import { MemoryRelayStore } from "./memory-store.ts";
import { RelayRecoveryJournal } from "./recovery-journal.ts";
import type { RelayInvestigationSink } from "./investigation.ts";

/** The existing bounded engine remains the only state machine. Every synchronous
 * operation commits its primary changes before exposing its result to the gateway.
 * SQLite writes only changed rows; derived indexes are never recovery authority. */
export function createRecoveryStore(options: { readonly root: string; readonly peerOrigin?: string; readonly limits?: NonNullable<ConstructorParameters<typeof MemoryRelayStore>[0]>["limits"]; readonly investigation?: RelayInvestigationSink }): { store: MemoryRelayStore; close(): void } {
  let journal: RelayRecoveryJournal;
  try { journal = new RelayRecoveryJournal(options.root, options.peerOrigin); }
  catch (error) { throw relayOpenFailure(error); }
  try {
    const engine = new MemoryRelayStore({ limits: options.limits, investigation: options.investigation, recoverable: true, rows: journal.load() });
    journal.commit(engine.recoveryRows());
    const store = new Proxy(engine, { get(target, property) {
      journal.assertHealthy();
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        journal.assertHealthy();
        try { return value.apply(target, args); }
        finally { journal.commit(target.recoveryRows()); }
      };
    } });
    return { store, close: () => journal.close() };
  } catch (error) { journal.close(); throw relayOpenFailure(error); }
}
