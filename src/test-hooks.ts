/**
 * Test hooks — re-exports test-only helpers from internal modules.
 *
 * Import from here in tests instead of from production barrel exports.
 * These functions all throw unless WOLFPACK_TEST=1.
 */

export { MockBackend } from "./server/mock-backend.js";
