/**
 * Regression: ralph worker must handle BOTH SIGTERM and SIGINT, otherwise
 * Ctrl+C from a terminal leaves `.ralph.lock` and in-progress worktrees
 * behind, and the next `POST /api/ralph/start` rejects with 409.
 *
 * Why a source-level test instead of a subprocess test:
 *   ralph-macchio.ts has top-level side effects (parses argv, calls main()
 *   on import). Driving real cleanup requires a project fixture, a written
 *   lock, a spawned bun subprocess, and an OS signal — far heavier than the
 *   bug warrants. The actual cleanup logic is shared between SIGTERM and
 *   SIGINT via `shutdownHandler`, so the test we need is "both signals are
 *   wired to the same handler". A grep is enough.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(import.meta.dir, "..", "..", "src", "ralph-macchio.ts"),
  "utf-8",
);

describe("ralph-macchio shutdown signal registration", () => {
  // Quote class is `["']` to tolerate either single or double quotes —
  // a formatter switch should not produce a false negative.
  test("registers a SIGTERM handler", () => {
    expect(SOURCE).toMatch(/process\.on\(\s*["']SIGTERM["']/);
  });

  test("registers a SIGINT handler", () => {
    expect(SOURCE).toMatch(/process\.on\(\s*["']SIGINT["']/);
  });

  test("both signals route through the same shutdownHandler", () => {
    // Loose match — we don't care about the arrow-fn shape, only that both
    // signals reach a function named shutdownHandler. The body of that
    // handler is the single source of truth for cleanup.
    const sigterm = /process\.on\(\s*["']SIGTERM["']\s*,[\s\S]*?shutdownHandler/.test(SOURCE);
    const sigint = /process\.on\(\s*["']SIGINT["']\s*,[\s\S]*?shutdownHandler/.test(SOURCE);
    expect(sigterm).toBe(true);
    expect(sigint).toBe(true);
  });

  test("shutdownHandler removes the lock and cleans srt settings", () => {
    // The handler itself must call removeLock() and cleanupSrtSettings()
    // — these are what unblock the next `POST /api/ralph/start`.
    const start = SOURCE.indexOf("function shutdownHandler(");
    expect(start).toBeGreaterThan(-1);
    // Find the function body terminator. Prefer the canonical `\n}\n`
    // (closing brace on its own line followed by a blank line). If a
    // formatter ever emits `}` without a trailing blank line, fall back
    // to the next `\n}` so we don't over-capture the rest of the file
    // and silently mask a removeLock() removal.
    let end = SOURCE.indexOf("\n}\n", start);
    if (end === -1) end = SOURCE.indexOf("\n}", start);
    expect(end).toBeGreaterThan(start);
    const body = SOURCE.slice(start, end);
    // Sanity cap: shutdownHandler is intentionally small. If the slice is
    // huge, we've over-captured (formatter changed the closing brace
    // pattern) and the toContain assertions below would silently pass
    // against unrelated code.
    expect(body.length).toBeLessThan(2000);
    expect(body).toContain("removeLock()");
    expect(body).toContain("cleanupSrtSettings()");
  });
});
