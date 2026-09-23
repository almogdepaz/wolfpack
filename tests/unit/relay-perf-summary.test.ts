import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { summarize } from "../../scripts/relay-perf/summarize.ts";

test("summary keeps failed sends, lost accepted work, uncertainty and omitted probes out of success claims", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-perf-summary-"));
  const write = (path: string, value: unknown): void => writeFileSync(join(root, path), JSON.stringify(value));
  try {
    mkdirSync(join(root, "0")); mkdirSync(join(root, "adapter"));
    const actor = { resources: [], delays: [] };
    write("run.json", { config: { relays: 1 }, metrics: { measuredStart: 1000, end: 2000, echoes: [], socketEvents: [], controller: actor }, teardown: [] });
    write("0/host-metrics.json", actor);
    write("adapter/adapter-metrics.json", { ...actor, failures: [], sends: [
      { scheduled: 0, dispatched: 0, completed: 3, outcome: "accepted", taskId: "warmup", lateness: 0 },
      { scheduled: 1000, dispatched: 1010, completed: 1015, outcome: "accepted", taskId: "lost", lateness: 10 },
      { scheduled: 1100, dispatched: 1100, completed: 1105, outcome: "PEER_UNREACHABLE", taskId: "uncertain", lateness: 0 },
    ], deliveries: [{ taskId: "uncertain", incorporated: 1500, acknowledged: 1510, duplicate: false }] });
    const summary = summarize(root);
    expect(summary.offered).toBe(2);
    expect(summary.outcomes).toEqual({ accepted: 1, PEER_UNREACHABLE: 1 });
    expect(summary.acceptedNotIncorporated).toBe(1);
    expect(summary.acceptedNotAcknowledged).toBe(1);
    expect(summary.failedSendLaterDelivered).toBe(1);
    expect(summary.acceptanceMs).toMatchObject({ count: 1, p95: 5 });
    expect(summary.echoes).toMatchObject({ offered: 40, dispatched: 0, undispatched: 40 });
    const adapter = JSON.parse(readFileSync(join(root, "adapter/adapter-metrics.json"), "utf8"));
    adapter.capturesUnacknowledgedIncorporation = true;
    adapter.deliveries.push({ taskId: "lost", incorporated: 1200, acknowledged: null, duplicate: false });
    write("adapter/adapter-metrics.json", adapter);
    const partial = summarize(root);
    expect(partial.acceptedNotIncorporated).toBe(0);
    expect(partial.acceptedNotAcknowledged).toBe(1);
    expect(partial.acknowledgementMs).toMatchObject({ count: 1 });
    const traceFile = join(root, "failures.jsonl");
    writeFileSync(traceFile, JSON.stringify({ code: "RELAY_CAPACITY" }) + "\n");
    adapter.failures = { traceFile };
    adapter.archive = [{ writes: [{ at: 1210, type: "pi-tasks-event", details: { taskId: "lost", event: { type: "task.created" } } }] }];
    write("adapter/adapter-metrics.json", adapter);
    const rows = [
      { pid: 1, role: "host", at: 1000, rss: 100, cpuMicros: 0 },
      { pid: 2, role: "broker", at: 1000, rss: 50, cpuMicros: 0 },
      { pid: 3, role: "controller", at: 1000, rss: 900, cpuMicros: 0 },
      { pid: 1, role: "host", at: 1500, rss: 110, cpuMicros: 100000 },
      { pid: 2, role: "broker", at: 1500, rss: 60, cpuMicros: 50000 },
      { pid: 3, role: "controller", at: 1500, rss: 999, cpuMicros: 500000 },
    ];
    writeFileSync(join(root, "native-samples.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const qualified = summarize(root);
    expect(qualified.failures).toEqual([{ code: "RELAY_CAPACITY" }]);
    expect(qualified.acceptedNotInserted).toBe(0);
    expect(qualified.archiveInsertionMs).toMatchObject({ count: 1, p95: 200 });
    expect(qualified.processTree).toMatchObject({ samples: 2, cpuPercent: 30, rssBytes: { max: 170 } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
