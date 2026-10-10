#!/usr/bin/env bun
/**
 * Writes the expected ANSI bytes for the broker renderer's byte-identity
 * fixtures (`broker/tests/fixtures/ansi/`). The TypeScript renderer is the
 * reference: `<name>.ansi` is `renderSnapshotToAnsi(<name>.snapshot.json)`.
 *
 * Budgeted cases use a brute-force oracle for the broker's scrollback budget:
 * the smallest oldest-first trim whose standalone render fits `max_bytes`
 * (all scrollback when even the visible screen alone does not fit).
 *
 * Run after `cargo test ... --test ansi_render_fixtures -- --ignored
 * regenerate_snapshot_fixtures` regenerates the snapshots.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderSnapshotToAnsi, type SnapshotForRender } from "../src/broker/snapshot-render";

export const ANSI_FIXTURE_DIR = join(import.meta.dir, "..", "broker", "tests", "fixtures", "ansi");

export interface AnsiFixtureCase {
  readonly name: string;
  readonly max_bytes?: number;
}

export interface ExpectedAnsi {
  readonly bytes: Buffer;
  readonly trimmedLines: number;
}

export function readAnsiFixtureCases(): AnsiFixtureCase[] {
  return JSON.parse(readFileSync(join(ANSI_FIXTURE_DIR, "cases.json"), "utf8")) as AnsiFixtureCase[];
}

export function readAnsiFixtureSnapshot(name: string): SnapshotForRender {
  return JSON.parse(readFileSync(join(ANSI_FIXTURE_DIR, `${name}.snapshot.json`), "utf8")) as SnapshotForRender;
}

export function expectedAnsiForCase(fixture: AnsiFixtureCase): ExpectedAnsi {
  const snapshot = readAnsiFixtureSnapshot(fixture.name);
  if (fixture.max_bytes === undefined) {
    return { bytes: renderSnapshotToAnsi(snapshot), trimmedLines: 0 };
  }
  const scrollback = snapshot.scrollback ?? [];
  for (let trimmed = 0; trimmed <= scrollback.length; trimmed++) {
    const bytes = renderSnapshotToAnsi({ ...snapshot, scrollback: scrollback.slice(trimmed) });
    if (bytes.length <= fixture.max_bytes || trimmed === scrollback.length) {
      return { bytes, trimmedLines: trimmed };
    }
  }
  throw new Error("unreachable: the final iteration always returns");
}

if (import.meta.main) {
  const expected: Record<string, { trimmed_lines: number }> = {};
  for (const fixture of readAnsiFixtureCases()) {
    const result = expectedAnsiForCase(fixture);
    writeFileSync(join(ANSI_FIXTURE_DIR, `${fixture.name}.ansi`), result.bytes);
    if (fixture.max_bytes !== undefined) expected[fixture.name] = { trimmed_lines: result.trimmedLines };
    console.log(`${fixture.name}: ${result.bytes.length} bytes, trimmed_lines=${result.trimmedLines}`);
  }
  writeFileSync(join(ANSI_FIXTURE_DIR, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
}
