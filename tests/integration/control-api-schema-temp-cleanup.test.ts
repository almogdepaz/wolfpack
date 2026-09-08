import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const TARGET_TEST = join(ROOT, "tests", "integration", "control-api-schema-contract.test.ts");
const PRELOAD = join(ROOT, "tests", "integration", "fixtures", "control-api-schema-temp-cleanup-preload.ts");
const CHILD_TIMEOUT_MS = 3_000;

test("schema contract cleanup does not delete a planted temp-root target", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "wolfpack-schema-cleanup-regression-"));
  const victim = join(sandbox, "victim");
  const sentinel = join(victim, "sentinel");
  const bin = join(sandbox, "bin");
  const shell = join(bin, "fixture-shell");
  const providerMarker = join(sandbox, "provider-version-called");
  let child: Bun.Subprocess<"pipe", "ignore", "inherit"> | undefined;
  let exited: Promise<number> | undefined;

  try {
    mkdirSync(victim);
    writeFileSync(sentinel, "keep me");
    mkdirSync(bin, { mode: 0o700 });
    // Server import reads a login-shell PATH, and /api/providers executes --version.
    // Neither the operator's shell startup nor installed agent CLIs belong in
    // this cleanup regression's deadline. Keep real HTTP/probing, but use owned
    // fixtures (including the shell's executable probe) with no external commands.
    writeFileSync(join(bin, "test"), '#!/bin/sh\n[ "$1" = "-x" ] && [ -x "$2" ]\n', { mode: 0o700 });
    writeFileSync(shell, '#!/bin/sh\n[ "$1" = "-lic" ] && [ "$2" = \'echo $PATH\' ] || exit 64\nprintf \'%s\\n\' "$PATH"\n', { mode: 0o700 });
    writeFileSync(join(bin, "pi"), '#!/bin/sh\n[ "$#" = "1" ] && [ "$1" = "--version" ] || exit 64\nprintf \'%s\\n\' "$1" >> "$WOLFPACK_SCHEMA_PROVIDER_MARKER"\nprintf \'fixture-pi 0.0.0\\n\'\n', { mode: 0o700 });
    child = Bun.spawn([process.execPath, "test", "--preload", PRELOAD, TARGET_TEST], {
      cwd: ROOT,
      env: { ...process.env, TMPDIR: sandbox, PATH: bin, SHELL: shell, WOLFPACK_SCHEMA_PROVIDER_MARKER: providerMarker },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "inherit",
      timeout: CHILD_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    exited = child.exited;

    symlinkSync(victim, join(sandbox, `wolfpack-schema-contract-${child.pid}`));
    await child.stdin.end();

    expect(await exited).toBe(0);
    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("keep me");
    expect(readFileSync(providerMarker, "utf8")).toBe("--version\n");
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    if (exited) await exited;
    rmSync(sandbox, { recursive: true, force: true });
  }
}, { timeout: 4_500 });
