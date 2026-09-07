#!/usr/bin/env bun
/**
 * Synthetic temporary-store benchmark; never opens the live runtime-state file.
 * Run the SAME script against candidate and an exact-base module export:
 *   bun scripts/agent-runtime-state-perf.ts [absolute/path/to/base/src/server/agent-status.ts]
 * Setup/input allocation is outside measured operations. Times include real
 * serialization/fsync for changed writes, not production latency or RSS.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentRuntimeStateInput } from "../src/server/agent-status.ts";

const modulePath = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dir, "../src/server/agent-status.ts");
const { AgentRuntimeStateStore } = await import(pathToFileURL(modulePath).href) as typeof import("../src/server/agent-status.ts");
const times = ["2026-07-25T00:00:00.000Z", "2026-07-25T00:01:00.000Z", "2026-07-25T00:02:00.000Z"] as const;
function inputs(count: number, observedAt: string): AgentRuntimeStateInput[] {
  return Array.from({ length: count }, (_, i) => ({
    sessionKey: `session-${i}`,
    broker: { state: "alive", observedAt },
    sources: [],
    fallback: { rawOutputChanged: false, observedAt },
    currentRun: { runId: `session-${i}`, runOrder: 1 },
  }));
}
function elapsed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}
function median(values: number[]): number {
  return Number(values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!.toFixed(3));
}

console.log(JSON.stringify({ modulePath, scope: "5-trial local medians in ms; requested operation work, not RSS or production latency; current timestamps remain persisted" }));
const root = mkdtempSync(join(tmpdir(), "runtime-state-perf-"));
try {
  for (const count of [10, 100, 1_000]) {
    const initial = inputs(count, times[0]);
    const changed = inputs(count, times[1]);
    const keys = new Set(initial.map((input) => input.sessionKey));
    const results: Record<string, number[]> = {};
    let bytes = 0;
    for (let trial = 0; trial < 5; trial++) {
      const path = join(root, `state-${count}-${trial}.json`);
      const store = new AgentRuntimeStateStore(path);
      for (const input of initial) store.reduce(input, { persist: false });
      store.flush();
      const measure = (name: string, run: () => void) => (results[name] ??= []).push(elapsed(run));
      measure("changedReductionsMs", () => {
        for (const input of changed) store.reduce(input, { persist: false });
      });
      measure("pruneAndRealFlushMs", () => { store.prune(keys, { persist: false }); store.flush(); });
      measure("cleanFlushMs", () => store.flush());
      measure("equivalentBatchIncludingFlushMs", () => {
        for (const input of changed) store.reduce(input, { persist: false });
        store.prune(keys, { persist: false });
        store.flush();
      });
      measure("realAcknowledgementMs", () => {
        if (!store.acknowledge("session-0", store.get("session-0")!.transitionSequence, times[2])) {
          throw new Error("benchmark acknowledgement unexpectedly rejected");
        }
      });
      measure("restartLoadMs", () => {
        const restarted = new AgentRuntimeStateStore(path);
        if (restarted.get("session-0")?.acknowledgedAt !== times[2]) throw new Error("persistence mismatch");
      });
      bytes = statSync(path).size;
    }
    console.log(JSON.stringify({ count, bytes, ...Object.fromEntries(Object.entries(results).map(([name, values]) => [name, median(values)])) }));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
