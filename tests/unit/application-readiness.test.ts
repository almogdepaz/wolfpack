import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applicationReady, waitForApplicationReady } from "../../src/cli/readiness.js";

// A separate process keeps HTTP real while managed readiness blocks this thread.
test("real readiness rejects non-2xx, malformed, oversized, degraded and stalled endpoints; bypasses proxies", async () => {
  const root = mkdtempSync("/tmp/wp-health-");
  const evidence = mkdtempSync("/tmp/wp-health-evidence-");
  const state = join(root, "state.json");
  const address = join(root, "address.json");
  const entry = join(root, "server.ts");
  writeFileSync(state, JSON.stringify({ mode: "healthy" }));
  writeFileSync(entry, `import { writeFileSync, readFileSync } from 'node:fs';
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
 const {mode} = JSON.parse(readFileSync(${JSON.stringify(state)},'utf8'));
 const healthy = JSON.stringify({status:'ready',broker:{state:'ready'}});
 if(mode==='stall') return new Promise(()=>{});
 if(mode==='redirect') return new Response(healthy,{status:302});
 if(mode==='error') return new Response(healthy,{status:500});
 if(mode==='malformed') return new Response('not json');
 if(mode==='oversized') return new Response(' '.repeat(65536)+healthy);
 if(mode==='degraded') return Response.json({status:'ready',broker:{state:'unavailable'}});
 return new Response(healthy);
}}); writeFileSync(${JSON.stringify(address)},JSON.stringify({port:server.port}));`);
  const child = spawn(process.execPath, [entry], { cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" }, stdio: "ignore" });
  const observations: unknown[] = [];
  const proxyKeys = ["http_proxy", "HTTP_PROXY", "NO_PROXY", "no_proxy"] as const;
  const previous = proxyKeys.map(key => [key, process.env[key]] as const);
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(address) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(25);
    if (!existsSync(address)) throw new Error("HTTP fixture failed to bind");
    const { port } = JSON.parse(readFileSync(address, "utf8"));
    process.env.http_proxy = process.env.HTTP_PROXY = "http://127.0.0.1:1";
    process.env.NO_PROXY = process.env.no_proxy = "";
    for (const mode of ["redirect", "error", "malformed", "oversized", "degraded", "stall", "healthy"]) {
      writeFileSync(state, JSON.stringify({ mode }));
      const started = Date.now();
      const asyncReady = await applicationReady(port, 150);
      const syncReady = waitForApplicationReady(port, 200);
      observations.push({ mode, asyncReady, syncReady, durationMs: Date.now() - started });
      writeFileSync(join(evidence, "observations.json"), JSON.stringify(observations), { mode: 0o600 });
      expect(asyncReady).toBe(mode === "healthy");
      expect(syncReady).toBe(mode === "healthy");
      expect(Date.now() - started).toBeLessThan(1500);
    }
    child.kill("SIGTERM");
    const deadlineStop = Date.now() + 3000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadlineStop) await Bun.sleep(25);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(await applicationReady(port, 150)).toBe(false);
    expect(waitForApplicationReady(port, 200)).toBe(false);
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const stopDeadline = Date.now() + 3000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < stopDeadline) await Bun.sleep(25);
    const reaped = child.exitCode !== null || child.signalCode !== null;
    writeFileSync(join(evidence, "cleanup.json"), JSON.stringify({ pid: child.pid, reaped, exitCode: child.exitCode, signalCode: child.signalCode }), { mode: 0o600 });
    if (reaped) rmSync(root, { recursive: true, force: true });
    else throw new Error(`health fixture cleanup unconfirmed: ${root}`);
    console.info(`health receipts: ${evidence}`);
  }
}, 15000);
