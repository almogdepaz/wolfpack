import { appendFileSync } from "node:fs";

export const POLL_MS = 5_000;
export const ECHO_INTERVAL_MS = 50;
export const SEND_INTERVAL_MS = 100;
export const MAX_SENDS_IN_FLIGHT = 4;
export const ROUTE = "/api/task-relay/volatile-v1";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("expected object");
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new TypeError("expected nonempty string");
  return value;
}
export function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("expected finite number");
  return value;
}
export function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "UNKNOWN_ERROR";
}
export function distribution(samples: readonly number[]): Record<string, number | null> {
  if (samples.some(value => !Number.isFinite(value) || value < 0)) throw new TypeError("invalid latency sample");
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number): number | null => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? null };
}
export interface DispatchSlot { readonly scheduled: number; readonly dispatched: number; readonly lateness: number }
/** Fixed offered schedule: delayed dispatch never changes the next due timestamp. */
export function dueSlots(start: number, now: number, interval: number, next: number, total: number): DispatchSlot[] {
  if (!(interval > 0) || !Number.isInteger(next) || next < 0 || !Number.isInteger(total) || total < next) throw new TypeError("invalid schedule");
  const slots: DispatchSlot[] = [];
  while (next < total && start + next * interval <= now) {
    const scheduled = start + next++ * interval;
    slots.push({ scheduled, dispatched: now, lateness: now - scheduled });
  }
  return slots;
}
export interface ResourceSample {
  readonly at: number; readonly rss: number; readonly cpuMicros: number;
}
export function startSampling(sampleFile?: string): { stop(): { resources: ResourceSample[]; delays: { at: number; ms: number }[]; sampleFile?: string } } {
  const resources: ResourceSample[] = [], delays: { at: number; ms: number }[] = [];
  const resource = (row: ResourceSample): void => { if (sampleFile) writeJsonLine(sampleFile, { kind: "resource", ...row }); else resources.push(row); };
  const delay = (row: { at: number; ms: number }): void => { if (sampleFile) writeJsonLine(sampleFile, { kind: "delay", ...row }); else delays.push(row); };
  const sample = (): void => {
    const cpu = process.cpuUsage();
    resource({ at: Date.now(), rss: process.memoryUsage().rss, cpuMicros: cpu.user + cpu.system });
  };
  sample();
  let previous = performance.now();
  const loop = setInterval(() => {
    const now = performance.now();
    delay({ at: Date.now(), ms: Math.max(0, now - previous - 10) });
    previous = now;
  }, 10);
  const timer = setInterval(sample, 1_000);
  return { stop() { clearInterval(loop); clearInterval(timer); sample(); return { resources, delays, ...(sampleFile && { sampleFile }) }; } };
}
export function writeJsonLine(path: string, value: unknown): void {
  appendFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 });
}
/** Append-only evidence without retaining the trace in the measured process heap. */
export function trace(path: string): { push(value: unknown): void; toJSON(): { traceFile: string } } {
  appendFileSync(path, "", { mode: 0o600 });
  return { push(value) { writeJsonLine(path, value); }, toJSON() { return { traceFile: path }; } };
}
export async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`deadline: ${label}`);
    await Bun.sleep(10);
  }
}
