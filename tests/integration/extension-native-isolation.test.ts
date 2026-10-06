import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixture = readFileSync(join(import.meta.dirname, "fixtures", "extension-native-acceptance.ts"), "utf8");

test("native acceptance initializes owned persistent paths before importing its broker backend", () => {
  expect(fixture).not.toContain('import { BrokerBackend }');
  expect(fixture).not.toContain('import { BrokerClient }');
  expect(fixture.indexOf("configureOuterEnvironment();")).toBeGreaterThan(-1);
  expect(fixture.indexOf("configureOuterEnvironment();")).toBeLessThan(fixture.indexOf('await import("../../../src/server/broker-backend.ts")'));
  expect(fixture).toContain("assertOwnedPersistentPaths()");
});
