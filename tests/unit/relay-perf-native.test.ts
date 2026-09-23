import { expect, test } from "bun:test";
import { sampleProcesses } from "../../scripts/relay-perf/native-resources.ts";

const binary = process.env.RELAY_PERF_NATIVE;
test.skipIf(!binary)("native sampler reads explicit live pids, identities and cumulative counters", async () => {
  const child = Bun.spawn(["/bin/sleep", "10"], { stdout: "ignore", stderr: "ignore" });
  try {
    const owned = [{ pid: process.pid, role: "test" }, { pid: child.pid, role: "sleep" }];
    const first = await sampleProcesses(binary!, owned);
    expect(first.map(row => row.pid)).toEqual(owned.map(row => row.pid));
    expect(first[1]!.parentPid).toBe(process.pid);
    expect(first.every(row => row.rss > 0 && row.cpuMicros >= 0 && row.startSeconds > 0)).toBe(true);
    const cpuBefore = process.cpuUsage();
    const until = performance.now() + 100;
    while (performance.now() < until) Math.sqrt(performance.now());
    const runtimeCpu = process.cpuUsage(cpuBefore);
    const second = await sampleProcesses(binary!, owned);
    const ratio = (second[0]!.cpuMicros - first[0]!.cpuMicros) / (runtimeCpu.user + runtimeCpu.system);
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(2);
    expect(second[0]!.startSeconds).toBe(first[0]!.startSeconds);
    expect(second[0]!.startMicros).toBe(first[0]!.startMicros);
    expect(second[0]!.cpuMicros).toBeGreaterThan(first[0]!.cpuMicros);
    expect(second[1]!.cpuMicros).toBeGreaterThanOrEqual(first[1]!.cpuMicros);
    await expect(sampleProcesses(binary!, [{ pid: -1, role: "invalid" }])).rejects.toThrow("invalid owned pids");
  } finally { child.kill(); await child.exited; }
});
