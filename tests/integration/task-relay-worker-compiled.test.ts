import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("standalone build embeds the relay worker and runs it away from the source cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-compiled-test-"));
  try {
    const entry = join(root, "probe.ts"), binary = join(root, "probe"), runDir = join(root, "run");
    mkdirSync(runDir);
    const client = resolve(import.meta.dir, "../../src/task-relay/worker-client.ts");
    const agent = resolve(import.meta.dir, "../../src/agent-kind.ts");
    writeFileSync(entry, `import { WorkerRelayGateway } from ${JSON.stringify(client)};
import { AGENT_KIND } from ${JSON.stringify(agent)};
const g = new WorkerRelayGateway({ root: process.argv[2], inspectSession: async selector => ({ok:true, session:selector, sessionId:selector, projectPath:process.argv[2], harness:AGENT_KIND.PI.id, alive:true}) });
try {
 const registration = await g.connect({callerSession:"probe",generation:"compiled",protocolVersions:[2]});
 if (!registration.ok) throw new Error(JSON.stringify(registration));
 const selected = await g.endpointsForSessions(["probe"]);
 if (selected.get("probe")?.id !== registration.endpoint.id) throw new Error("endpoint mismatch");
 console.log(JSON.stringify({ok:true,compiled:import.meta.url.includes("/$bunfs/")}));
} finally { await g.close(); }
`);
    const build = Bun.spawn([process.execPath, "build", "--compile", "--entry-naming", "[name].js", entry,
      resolve(import.meta.dir, "../../src/task-relay/worker-entry.ts"), "--outfile", binary], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
    expect(code, stdout + stderr).toBe(0);
    renameSync(entry, join(root, "source-hidden.txt"));
    const run = Bun.spawn([binary, join(root, "relay")], { cwd: runDir,
      env: { HOME: runDir, PATH: "/usr/bin:/bin", WOLFPACK_TEST: "1" }, stdout: "pipe", stderr: "pipe" });
    const [exit, result, diagnostic] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
    expect(exit, diagnostic).toBe(0);
    expect(JSON.parse(result)).toEqual({ ok: true, compiled: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
