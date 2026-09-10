import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assertSupportedBunRuntime, MINIMUM_BUN_VERSION } from "../../src/runtime-version.ts";

test("rejects unvalidated older/prerelease runtimes before relay worker startup", () => {
  for (const version of ["1.3.9", "1.4.1", "1.4.2-canary", "", "not-a-version", "0.9.0"]) expect(() => assertSupportedBunRuntime(version)).toThrow("requires stable Bun 1.4.2");
  for (const version of ["1.4.2", "1.5.0", "2.0.0"]) expect(() => assertSupportedBunRuntime(version)).not.toThrow();
});

test("CI/release pins and build/server/worker startup enforce the tested runtime floor", () => {
  for (const path of [".github/workflows/test.yml", ".github/workflows/release.yml"]) {
    const pins = [...readFileSync(path, "utf8").matchAll(/bun-version:\s*(\S+)/g)].map(match => match[1]);
    expect(pins.length).toBeGreaterThan(0); expect(pins.every(pin => pin === MINIMUM_BUN_VERSION)).toBe(true);
  }
  for (const path of ["src/server/index.ts", "src/task-relay/worker-client.ts", "scripts/build.ts"]) expect(readFileSync(path, "utf8")).toContain("assertSupportedBunRuntime();");
});
