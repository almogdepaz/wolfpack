/**
 * Barrel export for all client-side pure logic modules.
 * Bundled into public/wolfpack-lib.js for browser use.
 * Tests import from the individual modules directly.
 */
export {
  captureScrollState,
  scrollTargetAfterResize,
  serializeBufferTail,
} from "./terminal-buffer";

export {
  shouldInterceptCopy,
  encodeTerminalBinary,
} from "./terminal-input";

export {
  shouldRehydrate,
} from "./reconnect-hydration";

export {
  addToGridState,
  removeFromGridState,
  suspendGridState,
  resumeGridState,
  type GridSession,
} from "./grid-logic";

export {
  recordFailure as peerHealthRecordFailure,
  recordSuccess as peerHealthRecordSuccess,
  fetchTimeoutMs as peerHealthTimeoutMs,
  FAILING_TIMEOUT_MS as PEER_FAILING_TIMEOUT_MS,
  HEALTHY_TIMEOUT_MS as PEER_HEALTHY_TIMEOUT_MS,
} from "./peer-health";

export {
  CLOSE_CODE_DISPLACED,
  CLOSE_CODE_SESSION_UNAVAILABLE,
  CLOSE_CODE_NORMAL,
  classifyDisconnect,
  handleViewerConflict,
  handleControlGranted,
  handleDisplaced,
  prepareAutoTakeControl,
  handleTakeControlClick,
} from "./take-control-logic";
