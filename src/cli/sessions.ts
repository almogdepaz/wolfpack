/**
 * `wolfpack ls` and `wolfpack kill <name>` — talk to the local server's
 * HTTP API. JWT auth is honored when WOLFPACK_JWT_SECRET is set.
 */
import { print, bold, dim, red, green, yellow } from "./formatting.js";
import { baseUrl, call } from "./api.js";

interface SessionRow {
  name: string;
  lastLine?: string;
  triage?: string;
  identity?: {
    wolfpackSessionId: string;
  };
}

export async function lsSessions(argv: readonly string[] = []): Promise<number> {
  if (argv.length === 1 && ["--help", "-h", "help"].includes(argv[0])) {
    print("Usage: wolfpack list [--json]");
    return 0;
  }
  const jsonOutput = argv.length === 1 && argv[0] === "--json";
  if (argv.length > 0 && !jsonOutput) {
    print(red("  Usage: wolfpack list [--json]"));
    return 2;
  }
  let resp: Response;
  const apiPath = jsonOutput ? "/api/session-control/list" : "/api/sessions";
  try {
    resp = await call(apiPath);
  } catch (e: unknown) {
    print(red(`  Could not reach the wolfpack server at ${baseUrl()}.`));
    print(dim(`  Is it running? Try: wolfpack service status`));
    print(dim(`  Error: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  }
  if (resp.status === 401) {
    print(red("  Auth required. Set WOLFPACK_JWT_SECRET to the server's secret and re-run."));
    return 1;
  }
  if (!resp.ok) {
    print(red(`  ${apiPath} returned ${resp.status}: ${await resp.text()}`));
    return 1;
  }
  const data = (await resp.json()) as { sessions?: SessionRow[] };
  const sessions = data.sessions ?? [];
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify({ sessions })}\n`);
    return 0;
  }
  if (sessions.length === 0) {
    print(dim("  No active sessions."));
    return 0;
  }
  print(bold(`  ${sessions.length} session${sessions.length === 1 ? "" : "s"}:`));
  print("");
  for (const s of sessions) {
    const triage = s.triage ?? "idle";
    const colored = triage === "running" ? green(triage) : triage === "idle" ? yellow(triage) : dim(triage);
    print(`    ${bold(s.name)}  ${colored}`);
    if (s.lastLine) print(`      ${dim(s.lastLine)}`);
  }
  print("");
  return 0;
}

export async function killSession(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  const jsonOutput = args.includes("--json");
  if (jsonOutput) args.splice(args.indexOf("--json"), 1);
  if (args.length === 1 && ["--help", "-h", "help"].includes(args[0])) {
    print("Usage: wolfpack kill <session-or-id> [--json]");
    return 0;
  }
  const name = args[0];
  if (!name || args.length !== 1) {
    print(red("  Usage: wolfpack kill <session-or-id> [--json]"));
    return 2;
  }
  let resp: Response;
  try {
    resp = await call("/api/kill", { method: "POST", body: JSON.stringify({ session: name }) });
  } catch (e: unknown) {
    print(red(`  Could not reach the wolfpack server at ${baseUrl()}.`));
    print(dim(`  Error: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  }
  if (resp.status === 401) {
    print(red("  Auth required. Set WOLFPACK_JWT_SECRET and re-run."));
    return 1;
  }
  if (resp.status === 404) {
    print(yellow(`  Session "${name}" not found.`));
    return 1;
  }
  if (!resp.ok) {
    print(red(`  Kill failed: HTTP ${resp.status} — ${await resp.text()}`));
    return 1;
  }
  const data = await resp.json() as { ok: true; session: string; sessionId: string };
  if (jsonOutput) process.stdout.write(`${JSON.stringify(data)}\n`);
  else print(green(`  Killed session "${data.session}".`));
  return 0;
}
