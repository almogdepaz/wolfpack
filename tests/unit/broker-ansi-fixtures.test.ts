/**
 * Drift guard for the broker ANSI byte-identity fixtures: the checked-in
 * `<name>.ansi` files must still equal the TypeScript renderer's output, so
 * the Rust gate (`broker/tests/ansi_render_fixtures.rs`) keeps comparing
 * against the live reference renderer.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANSI_FIXTURE_DIR,
  expectedAnsiForCase,
  readAnsiFixtureCases,
} from "../../scripts/gen-broker-ansi-fixtures";

describe("broker ANSI fixtures", () => {
  const cases = readAnsiFixtureCases();
  const trims = JSON.parse(readFileSync(join(ANSI_FIXTURE_DIR, "expected.json"), "utf8")) as Record<string, { trimmed_lines: number }>;

  test("cover at least the plan's scenario set", () => {
    expect(cases.length).toBeGreaterThanOrEqual(6);
    expect(cases.some(fixture => fixture.max_bytes !== undefined)).toBe(true);
  });

  for (const fixture of cases) {
    test(`${fixture.name}.ansi matches renderSnapshotToAnsi`, () => {
      const expected = expectedAnsiForCase(fixture);
      const checkedIn = readFileSync(join(ANSI_FIXTURE_DIR, `${fixture.name}.ansi`));
      expect(Buffer.compare(checkedIn, expected.bytes)).toBe(0);
      if (fixture.max_bytes !== undefined) {
        expect(trims[fixture.name]?.trimmed_lines).toBe(expected.trimmedLines);
      }
    });
  }
});
