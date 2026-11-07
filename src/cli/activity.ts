import { ACTIVITY_KIND, ACTIVITY_PAGE_DEFAULT, ACTIVITY_PAGE_MAX, ACTIVITY_PATH, type ActivityPage, type ActivityRow } from "../activity-journal.js";
import { call } from "./api.js";
import type { VerifiedMachineTarget } from "./machine-target.js";
import { print, printError, printJson } from "./formatting.js";

export const ACTIVITY_USAGE = `Usage: wolfpack [--machine <name>] activity [--since <seq>] [--limit <n>] [--json]
       wolfpack activity ack <inbox-file> [--json]
  Reads this (or the selected) machine's activity journal after a cursor.
  ack: the focus assistant confirms it processed an inbox file; the home server advances its cursors.`;

export type ActivityCommand =
  | { action: "read"; since: number; limit: number; json: boolean }
  | { action: "ack"; file: string; json: boolean };

export function parseActivityCommand(args: readonly string[]): ActivityCommand {
  const json = args.includes("--json");
  const argv = args.filter(a => a !== "--json");
  if (argv[0] === "ack") {
    if (argv.length !== 2 || !argv[1] || argv[1].startsWith("--")) throw new Error(ACTIVITY_USAGE);
    return { action: "ack", file: argv[1], json };
  }
  const options = { since: 0, limit: ACTIVITY_PAGE_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    const key = ({ "--since": "since", "--limit": "limit" } as const)[argv[i] as "--since" | "--limit"];
    const raw = argv[++i];
    const value = raw !== undefined && /^\d{1,16}$/.test(raw) ? Number(raw) : NaN;
    if (!key || !Number.isSafeInteger(value) || (key === "limit" && value > ACTIVITY_PAGE_MAX)) throw new Error(ACTIVITY_USAGE);
    options[key] = value;
  }
  return { action: "read", ...options, json };
}

const flat = (text: string) => text.replace(/[\r\n\u2028\u2029\t]+/g, " ");
/** Row text comes from other programs: printed flattened, never interpreted. */
export function formatActivityRow(row: ActivityRow): string {
  const head = `#${row.seq} ${row.at} ${row.kind}`;
  switch (row.kind) {
    case ACTIVITY_KIND.SESSION_CREATED: case ACTIVITY_KIND.SESSION_LIVE:
      return flat(`${head} ${row.session} ${row.cwd}${row.harness ? ` ${row.harness}` : ""}${row.branch ? ` ${row.branch}` : ""}${row.head ? `@${row.head.slice(0, 12)}` : ""}`);
    case ACTIVITY_KIND.SESSION_STATE:
      return flat(`${head} ${row.session} ${row.state} ${row.label}${row.message ? ` — ${row.message}` : ""}`);
    case ACTIVITY_KIND.SESSION_EXITED:
      return flat(`${head} ${row.session ?? row.sessionId} ${row.reason}${row.exitCode !== undefined ? ` code=${row.exitCode}` : ""}`);
    case ACTIVITY_KIND.TASK_UPDATED:
      return flat(`${head} ${row.taskId} ${row.eventType}`);
    case ACTIVITY_KIND.INPUT:
      return flat(`${head} ${row.session} ${row.source}`);
  }
}

async function body<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { error?: unknown };
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `activity HTTP ${response.status}`);
  return value;
}

/** Acks go to the focus home: the only server that owns routine cursors. */
async function ackOnFocusHome(file: string, target?: VerifiedMachineTarget): Promise<unknown> {
  const { focusHomeTarget } = await import("./focus.js");
  const home = await focusHomeTarget(target);
  return body(await call("/api/activity/ack", { method: "POST", body: JSON.stringify({ file }) }, home));
}

export async function activityCommand(args: readonly string[], target?: VerifiedMachineTarget, ack: (file: string) => Promise<unknown> = file => ackOnFocusHome(file, target)): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) { print(ACTIVITY_USAGE); return 0; }
  const json = args.includes("--json");
  try {
    const command = parseActivityCommand(args);
    if (command.action === "ack") {
      const result = await ack(command.file);
      if (json) printJson(result); else print(`acked ${command.file}`);
      return 0;
    }
    const page = await body<ActivityPage & { machine?: string }>(await call(`${ACTIVITY_PATH}?since=${command.since}&limit=${command.limit}`, {}, target));
    if (json) printJson(page);
    else {
      for (const row of page.rows) print(formatActivityRow(row));
      print(`${page.machine ?? "machine"}: next ${page.next} · head ${page.headSeq}${page.truncated ? ` · rows before ${page.oldestSeq} expired` : ""}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) printJson({ error: message }); else printError(message);
    return 1;
  }
}
