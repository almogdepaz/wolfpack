import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { distribution, number, record, text } from "./measurement.ts";

function objects(value: unknown): Record<string, unknown>[] {
  if (value && typeof value === "object" && "traceFile" in value) return jsonLines(text(value.traceFile));
  if (!Array.isArray(value)) throw new TypeError("expected array");
  return value.map(record);
}
function load(path: string): Record<string, unknown> { return record(JSON.parse(readFileSync(path, "utf8"))); }
function jsonLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => record(JSON.parse(line)));
}
export function summarize(root: string): Record<string, unknown> {
  const run = load(join(root, "run.json")), metrics = record(run.metrics), config = record(run.config);
  const start = number(metrics.measuredStart), end = number(metrics.end), seconds = (end - start) / 1000;
  const adapter = load(join(root, "adapter/adapter-metrics.json"));
  const window = (row: Record<string, unknown>, key: string): boolean => number(row[key]) >= start && number(row[key]) < end;
  const sends = objects(adapter.sends).filter(row => window(row, "scheduled"));
  const deliveries = objects(adapter.deliveries);
  const byTask = new Map<unknown, Record<string, unknown>>(), byAck = new Map<unknown, Record<string, unknown>>();
  for (const row of deliveries) {
    if (!byTask.has(row.taskId)) byTask.set(row.taskId, row);
    if (typeof row.acknowledged === "number" && !byAck.has(row.taskId)) byAck.set(row.taskId, row);
  }
  const echoes = objects(metrics.echoes).filter(row => window(row, "scheduled"));
  const archiveWrites = adapter.archive === undefined ? [] : objects(adapter.archive).flatMap(archive => objects(archive.writes));
  const inserted = new Map<unknown, number>();
  for (const row of archiveWrites) {
    const details = record(row.details);
    if (row.type === "pi-tasks-event" && details.event && record(details.event).type === "task.created" && !inserted.has(details.taskId)) inserted.set(details.taskId, number(row.at));
  }
  const counts: Record<string, number> = {};
  for (const row of sends) { const code = text(row.outcome); counts[code] = (counts[code] ?? 0) + 1; }
  const accepted = sends.filter(row => row.outcome === "accepted");
  const delivered = sends.filter(row => byTask.has(row.taskId)), acknowledged = sends.filter(row => byAck.has(row.taskId));
  const incorporationCoverageComplete = adapter.capturesUnacknowledgedIncorporation === true || objects(adapter.failures).length === 0;
  const hosts = Array.from({ length: number(config.relays) }, (_, index) => load(join(root, String(index), "host-metrics.json")));
  const resources = (actor: Record<string, unknown>): Record<string, unknown> => {
    if (actor.sampleFile) {
      const rows = jsonLines(text(actor.sampleFile));
      actor = { resources: rows.filter(row => row.kind === "resource"), delays: rows.filter(row => row.kind === "delay") };
    }
    const samples = objects(actor.resources).filter(row => window(row, "at"));
    const first = samples[0], last = samples.at(-1);
    return { samples: samples.length, rssBytes: distribution(samples.map(row => number(row.rss))),
      cpuPercent: first && last && number(last.at) > number(first.at) ? (number(last.cpuMicros) - number(first.cpuMicros)) / ((number(last.at) - number(first.at)) * 10) : null,
      eventLoopDelayMs: distribution(objects(actor.delays).filter(row => window(row, "at")).map(row => number(row.ms))),
      secondMinuteRssMedian: distribution(samples.filter(row => number(row.at) >= start + 60_000 && number(row.at) < start + 120_000).map(row => number(row.rss))).p50,
      finalMinuteRssMedian: distribution(samples.filter(row => number(row.at) >= end - 60_000).map(row => number(row.rss))).p50,
    };
  };
  const nativeRows = existsSync(join(root, "native-samples.jsonl")) ? jsonLines(join(root, "native-samples.jsonl")) : [];
  const native = [...new Set(nativeRows.map(row => row.pid))].map(pid => {
    const rows = nativeRows.filter(row => row.pid === pid);
    return { pid, role: rows[0]!.role, ...resources({ resources: rows, delays: [] }) };
  });
  const treeByTime = new Map<number, { at: number; rss: number; cpuMicros: number }>();
  for (const row of nativeRows.filter(row => row.role !== "controller")) {
    const at = number(row.at), total = treeByTime.get(at) ?? { at, rss: 0, cpuMicros: 0 };
    total.rss += number(row.rss); total.cpuMicros += number(row.cpuMicros); treeByTime.set(at, total);
  }
  return {
    root, config, sourceRevision: run.sourceRevision, adapterRevision: run.adapterRevision, brokerHash: run.brokerHash,
    seconds, offered: sends.length, outcomes: counts, acceptedPerSecond: accepted.length / seconds,
    acceptedNotIncorporated: incorporationCoverageComplete ? accepted.filter(row => !byTask.has(row.taskId)).length : null,
    acceptedNotAcknowledged: accepted.filter(row => !byAck.has(row.taskId)).length,
    incorporationCoverageComplete,
    failedSendLaterDelivered: delivered.filter(row => row.outcome !== "accepted").length,
    duplicateDeliveries: deliveries.filter(row => row.duplicate === true).length,
    acceptanceMs: distribution(accepted.map(row => number(row.completed) - number(row.dispatched))),
    archiveInsertionMs: distribution(sends.filter(row => inserted.has(row.taskId)).map(row => inserted.get(row.taskId)! - number(row.dispatched))),
    acceptedNotInserted: adapter.archive === undefined ? null : accepted.filter(row => !inserted.has(row.taskId)).length,
    incorporationMs: distribution(delivered.map(row => number(byTask.get(row.taskId)!.incorporated) - number(row.dispatched))),
    acknowledgementMs: distribution(acknowledged.map(row => number(byAck.get(row.taskId)!.acknowledged) - number(row.dispatched))),
    acknowledgementFromScheduledMs: distribution(acknowledged.map(row => number(byAck.get(row.taskId)!.acknowledged) - number(row.scheduled))),
    dispatchLatenessMs: distribution(sends.map(row => number(row.lateness))),
    echoes: { offered: Math.floor((end - start) / 50) * 2, dispatched: echoes.length,
      undispatched: Math.floor((end - start) / 50) * 2 - echoes.length, missing: echoes.filter(row => row.latency === null).length,
      latencyMs: distribution(echoes.filter(row => row.latency !== null).map(row => number(row.latency))),
      latenessMs: distribution(echoes.map(row => number(row.lateness))) },
    host: hosts.map(resources), adapter: resources(adapter), controller: resources(record(metrics.controller)),
    native, processTree: resources({ resources: [...treeByTime.values()], delays: [] }),
    archive: adapter.archive, initialState: adapter.initialState, finalState: adapter.finalState, healthSamples: adapter.healthSamples === undefined ? [] : objects(adapter.healthSamples),
    failures: objects(adapter.failures), initialHealth: adapter.initialHealth, finalHealth: adapter.finalHealth,
    socketEvents: metrics.socketEvents, faultEvents: hosts.map(host => host.faultEvents), teardown: run.teardown, ptyCleanup: run.ptyCleanup,
  };
}
if (import.meta.main) {
  const root = text(process.argv[2]);
  const summary = summarize(root);
  writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ root, offered: summary.offered, outcomes: summary.outcomes, acceptedNotAcknowledged: summary.acceptedNotAcknowledged, echo: summary.echoes, acceptance: summary.acceptanceMs, ack: summary.acknowledgementMs, failures: summary.failures }));
}
