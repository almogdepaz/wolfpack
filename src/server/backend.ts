/** @deprecated Use ServerContext and BrokerSupervisor; retained for old import paths and test hooks. */
import { BrokerSupervisor } from "./broker-supervisor.js";
import { createServerContext, getDefaultServerContext, setDefaultServerContext, resetDefaultServerContext, type ServerBackend } from "./context.js";
import type { SessionBackend } from "./backend-contract.js";
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

/** @deprecated Use an explicitly constructed ServerContext. */
export function initBackend(): SessionBackend {
  const context = createServerContext();
  setDefaultServerContext(context);
  return context.backend;
}
export function getBackend(): SessionBackend { return getDefaultServerContext().backend; }
export function getRouter(): BrokerSupervisor {
  const context = getDefaultServerContext();
  if (!context.supervisor) throw new Error("broker supervisor unavailable");
  return context.supervisor;
}
export function __resetBackend(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__resetBackend() is only available in test mode");
  resetDefaultServerContext();
}
export function __setTestBackend(backend: SessionBackend): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__setTestBackend() is only available in test mode");
  const supervisor = new BrokerSupervisor({ start: false });
  supervisor.__setBrokerForTest(backend);
  // Legacy hooks accepted partial test backends before the explicit context contract.
  setDefaultServerContext(createServerContext({ backend: backend as ServerBackend, supervisor }));
}
