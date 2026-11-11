/** Session backend contracts and compatibility re-exports. */
export { BrokerSupervisor as BackendRouter, checkBrokerSocketExists } from "./broker-supervisor.js";
export { DuplicateSessionError, UnsupportedTerminalKeyError } from "./backend-contract.js";
export type {
  CapturePaneOptions,
  PtyBackendMethods,
  SessionAttachLease,
  SessionSnapshotCapture,
  SessionBackend,
  SessionDataUnsubscribe,
  SessionLaunchOptions,
  SessionLifecycleEvent,
  SessionListFact,
  SessionPrefill,
  SessionPrefillOptions,
  SessionPromptBackendMethods,
} from "./backend-contract.js";
