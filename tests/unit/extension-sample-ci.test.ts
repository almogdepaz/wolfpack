import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..", "..");
const workflow = Bun.YAML.parse(readFileSync(join(repo, ".github", "workflows", "test.yml"), "utf8")) as {
  jobs: Record<string, { steps?: Array<{ run?: string }> }>;
};
const gate = readFileSync(join(repo, "scripts", "ci-gate.sh"), "utf8");

function requireCompatibleBash(): string {
  // Server imports can reorder shared-process PATH. Probe stable executable
  // paths instead of letting the gate's env shebang select an older Bash.
  const candidates = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"];
  const diagnostics: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) { diagnostics.push(`${candidate}: missing`); continue; }
    try {
      const probe = Bun.spawnSync([candidate, "--noprofile", "--norc", "-c",
        'printf "%s.%s" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"'], { timeout: 5000 });
      const version = /^(\d+)\.(\d+)$/.exec(probe.stdout.toString());
      if (probe.exitCode === 0 && version &&
          (Number(version[1]) > 4 || (Number(version[1]) === 4 && Number(version[2]) >= 4))) return candidate;
      diagnostics.push(`${candidate}: exit ${probe.exitCode}, version ${probe.stdout.toString()}, ${probe.stderr.toString()}`);
    } catch (error) {
      diagnostics.push(`${candidate}: ${String(error)}`);
    }
  }
  throw new Error(`CI gate test requires Bash >= 4.4; no compatible executable found. ${diagnostics.join("; ")}`);
}

test("CI runs the complete integration shard, then auth alone, in the integration job", () => {
  const runs = Object.entries(workflow.jobs).flatMap(([job, { steps = [] }]) =>
    steps.flatMap(step => step.run === "scripts/ci-gate.sh integration" ? [job] : []));
  expect(runs).toEqual(["integration"]);
  expect(gate).toContain("find tests/integration -name '*.test.ts' ! -name 'auth-middleware.test.ts'");

  const root = mkdtempSync(join(tmpdir(), "wolfpack-ci-shard-"));
  try {
    const bin = join(root, "bin");
    const callsPath = join(root, "calls.jsonl");
    mkdirSync(bin);
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "tests", "integration", "nested"), { recursive: true });
    writeFileSync(join(root, "scripts", "ci-gate.sh"), gate, { mode: 0o700 });
    const shard = ["tests/integration/alpha.test.ts", "tests/integration/nested/space name.test.ts", "tests/integration/zeta.test.ts"];
    const auth = "tests/integration/auth-middleware.test.ts";
    for (const file of [...shard, auth, "tests/integration/not-a-test.ts"]) writeFileSync(join(root, file), "");
    // Run the real gate; replace only its external Bun test processes with a recorder.
    const recorder = join(bin, "bun");
    writeFileSync(recorder, `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + "\\n");
`, { mode: 0o700 });
    const result = Bun.spawnSync([requireCompatibleBash(), "--noprofile", "--norc", join(root, "scripts", "ci-gate.sh"), "integration"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WOLFPACK_BROKER_BIN: recorder },
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    const calls = readFileSync(callsPath, "utf8").trim().split("\n").map(line => JSON.parse(line) as { pid: number; args: string[] });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual(["test", ...shard]);
    expect(calls[1]!.args).toEqual(["test", auth]);
    expect(calls[1]!.pid).not.toBe(calls[0]!.pid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
