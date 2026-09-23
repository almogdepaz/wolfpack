import { number, record } from "./measurement.ts";

export interface OwnedProcess { readonly pid: number; readonly role: string }
export interface NativeSample extends OwnedProcess {
  readonly at: number; readonly parentPid: number; readonly startSeconds: number; readonly startMicros: number;
  readonly rss: number; readonly cpuMicros: number;
}
/** Read only explicit controller-owned pids; no process-name discovery or machine-wide sampling. */
export async function sampleProcesses(binary: string, processes: readonly OwnedProcess[]): Promise<NativeSample[]> {
  if (!processes.length || processes.some(child => !Number.isSafeInteger(child.pid) || child.pid <= 0)) throw new Error("invalid owned pids");
  const started = Date.now();
  const child = Bun.spawn([binary, ...processes.map(child => String(child.pid))], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(`native sampler exit ${exit}: ${stderr}`);
  const rows = stdout.trim().split("\n").map(line => record(JSON.parse(line)));
  if (rows.length !== processes.length) throw new Error("native sampler count mismatch");
  return rows.map((row, index) => {
    const owned = processes[index]!;
    if (row.pid !== owned.pid) throw new Error("native sampler pid mismatch");
    return { ...owned, at: started, parentPid: number(row.parentPid), startSeconds: number(row.startSeconds),
      startMicros: number(row.startMicros), rss: number(row.rss), cpuMicros: number(row.cpuNanos) / 1000 };
  });
}
