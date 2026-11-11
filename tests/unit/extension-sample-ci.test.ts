import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..", "..");
const workflow = Bun.YAML.parse(readFileSync(join(repo, ".github", "workflows", "test.yml"), "utf8")) as {
  jobs: { test: { steps: Array<{ run?: string }> } };
};
const gate = readFileSync(join(repo, "scripts", "ci-gate.sh"), "utf8");

test("CI provisions its required Playwright browsers before the complete integration shard", () => {
  const steps = workflow.jobs.test.steps;
  const provisionCommand = "bunx playwright install --with-deps chromium webkit";
  const provision = steps.findIndex(step => step.run === provisionCommand);
  const integration = steps.findIndex(step => step.run === "scripts/ci-gate.sh integration");
  expect(provision).toBeGreaterThanOrEqual(0);
  expect(integration).toBeGreaterThanOrEqual(0);
  expect(provision).toBeLessThan(integration);
  expect(steps.filter(step => step.run === provisionCommand)).toHaveLength(1);
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
    const result = Bun.spawnSync([join(root, "scripts", "ci-gate.sh"), "integration"], {
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
