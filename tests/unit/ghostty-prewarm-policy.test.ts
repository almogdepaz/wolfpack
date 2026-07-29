import { expect, test } from "bun:test";
import { DEFAULT_GHOSTTY_PREWARM_POOL_SIZE } from "../../src/ghostty-prewarm-policy.js";

test("production keeps one warm terminal after measured solo and grid validation", () => {
  expect(DEFAULT_GHOSTTY_PREWARM_POOL_SIZE).toBe(1);
});
