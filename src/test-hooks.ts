/**
 * Test hooks — re-exports test-only helpers from internal modules.
 *
 * Import from here in tests instead of from production barrel exports.
 * These functions all throw unless WOLFPACK_TEST=1.
 */

export { __setDevDir } from "./server/dev-dir.js";
export { __getTestState } from "./server/websocket.js";
export { __resetJwtAuthConfig } from "./auth.js";
export { __setTestBackend, __resetBackend } from "./server/backend.js";
export { MockBackend } from "./server/mock-backend.js";
export { __registerTestRalphProcess } from "./shared/process-cleanup.js";
