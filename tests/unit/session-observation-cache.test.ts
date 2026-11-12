import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const ttl of [undefined, 0]) {
  test(`observation cache ${ttl === undefined ? "defaults to 500ms" : "accepts explicit zero TTL"}`, () => {
    const root = mkdtempSync(join(tmpdir(), "wolfpack-observation-cache-"));
    const moduleUrl = (name: string) => new URL(`../../src/server/${name}.ts`, import.meta.url).href;
    const env: NodeJS.ProcessEnv = { ...process.env, WOLFPACK_DIR: root, WOLFPACK_AGENT_RUNTIME_STATE_PATH: join(root, "runtime.json") };
    delete env.WOLFPACK_TEST;
    try {
      const child = Bun.spawnSync([process.execPath, "--eval", `
        const { createServerContext } = await import(${JSON.stringify(moduleUrl("context"))});
        const { MockBackend } = await import(${JSON.stringify(moduleUrl("mock-backend"))});
        const backend = new MockBackend({ sessions: ["first"] });
        const ctx = createServerContext({ backend, config: null, observationCacheTtlMs: ${ttl} });
        let now = 1_800_000_000_000;
        Date.now = () => now;
        const names = async () => (await ctx.sessionObservation.observeDashboardSessions()).map(s => s.name);
        const first = await names();
        backend.setSessions(["second"]);
        now += 499;
        const before = await names();
        now++;
        const at = await names();
        await ctx.close();
        console.log(JSON.stringify([first, before, at]));
      `], { env, stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toEqual([
        ["first"], [ttl === undefined ? "first" : "second"], ["second"],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
