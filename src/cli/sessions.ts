/**
 * `wolfpack ls` and `wolfpack kill <name>` — talk to the local server's
 * HTTP API. JWT auth is honored when WOLFPACK_JWT_SECRET is set.
 */
import type { VerifiedMachineTarget } from "./machine-target.js";
import { print, printError, printApiJson, printJson, bold, dim, red, green, yellow } from "./formatting.js";
import { baseUrl, call } from "./api.js";

interface SessionRow {
  readonly name: string;
  readonly lastLine?: string;
  readonly triage?: string;
  readonly identity?: {
    readonly wolfpackSessionId: string;
  };
}

interface CliFailure {
  readonly code: string;
  readonly message: string;
  readonly human: readonly string[];
  readonly exitCode: number;
}

function emitFailure(jsonOutput: boolean, failure: CliFailure): number {
  if (jsonOutput) {
    printJson({ ok: false, error: { code: failure.code, message: failure.message } });
  } else {
    for (const line of failure.human) printError(line);
  }
  return failure.exitCode;
}

export async function lsSessions(
  argv: readonly string[] = [],
  target?: VerifiedMachineTarget,
): Promise<number> {
  if (argv.length === 1 && ["--help", "-h", "help"].includes(argv[0])) {
    print("Usage: wolfpack list [--json]\nGlobal selector: wolfpack --machine <short-name-or-fqdn> list [--json]");
    return 0;
  }
  const jsonOutput = argv.includes("--json");
  if (argv.length > 0 && !(argv.length === 1 && jsonOutput)) {
    return emitFailure(jsonOutput, {
      code: "INVALID_ARGUMENTS",
      message: "invalid list arguments",
      human: [red("  Usage: wolfpack list [--json]")],
      exitCode: 2,
    });
  }

  let resp: Response;
  const apiPath = jsonOutput ? "/api/session-control/list" : "/api/sessions";
  try {
    resp = await call(apiPath, {}, target);
  } catch (error: unknown) {
    return emitFailure(jsonOutput, {
      code: "SERVER_UNREACHABLE",
      message: "could not reach the wolfpack server",
      human: [
        red(`  Could not reach the wolfpack server at ${baseUrl(target)}.`),
        dim("  Is it running? Try: wolfpack service status"),
        dim(`  Error: ${error instanceof Error ? error.message : String(error)}`),
      ],
      exitCode: 1,
    });
  }
  if (resp.status === 401) {
    return emitFailure(jsonOutput, {
      code: "AUTH_REQUIRED",
      message: "auth required",
      human: [red("  Auth required. Set WOLFPACK_JWT_SECRET to the server's secret and re-run.")],
      exitCode: 1,
    });
  }
  if (!resp.ok) {
    const responseBody = await resp.text();
    return emitFailure(jsonOutput, {
      code: "SERVER_ERROR",
      message: "wolfpack server request failed",
      human: [red(`  ${apiPath} returned ${resp.status}: ${responseBody}`)],
      exitCode: 1,
    });
  }

  let data: { readonly sessions?: readonly SessionRow[] };
  try {
    data = await resp.json() as { readonly sessions?: readonly SessionRow[] };
  } catch {
    return emitFailure(jsonOutput, {
      code: "INVALID_RESPONSE",
      message: "wolfpack server returned invalid JSON",
      human: [red("  Wolfpack server returned invalid JSON.")],
      exitCode: 1,
    });
  }
  const sessions = data.sessions ?? [];
  if (jsonOutput) {
    printApiJson({ sessions }, target);
    return 0;
  }
  if (sessions.length === 0) {
    print(dim("  No active sessions."));
    return 0;
  }
  print(bold(`  ${sessions.length} session${sessions.length === 1 ? "" : "s"}:`));
  print("");
  for (const session of sessions) {
    const triage = session.triage ?? "idle";
    const activity = triage === "running" ? "output" : triage === "idle" ? "quiet" : triage;
    const colored = triage === "running" ? green(activity) : triage === "idle" ? yellow(activity) : dim(activity);
    print(`    ${bold(session.name)}  ${colored}`);
    if (session.lastLine) print(`      ${dim(session.lastLine)}`);
  }
  print("");
  return 0;
}

export async function killSession(
  argv: readonly string[],
  target?: VerifiedMachineTarget,
): Promise<number> {
  const args = [...argv];
  const jsonOutput = args.includes("--json");
  if (jsonOutput) args.splice(args.indexOf("--json"), 1);
  if (args.length === 1 && ["--help", "-h", "help"].includes(args[0])) {
    print("Usage: wolfpack kill <session-or-id> [--json]\nGlobal selector: wolfpack --machine <short-name-or-fqdn> kill <session-or-id> [--json]");
    return 0;
  }
  const name = args[0];
  if (!name || args.length !== 1) {
    return emitFailure(jsonOutput, {
      code: "INVALID_ARGUMENTS",
      message: "invalid kill arguments",
      human: [red("  Usage: wolfpack kill <session-or-id> [--json]")],
      exitCode: 2,
    });
  }

  let resp: Response;
  try {
    resp = await call("/api/kill", { method: "POST", body: JSON.stringify({ session: name }) }, target);
  } catch (error: unknown) {
    return emitFailure(jsonOutput, {
      code: "SERVER_UNREACHABLE",
      message: "could not reach the wolfpack server",
      human: [
        red(`  Could not reach the wolfpack server at ${baseUrl(target)}.`),
        dim(`  Error: ${error instanceof Error ? error.message : String(error)}`),
      ],
      exitCode: 1,
    });
  }
  if (resp.status === 401) {
    return emitFailure(jsonOutput, {
      code: "AUTH_REQUIRED",
      message: "auth required",
      human: [red("  Auth required. Set WOLFPACK_JWT_SECRET and re-run.")],
      exitCode: 1,
    });
  }
  if (resp.status === 404) {
    return emitFailure(jsonOutput, {
      code: "SESSION_NOT_FOUND",
      message: "session not found",
      human: [yellow(`  Session "${name}" not found.`)],
      exitCode: 1,
    });
  }
  if (!resp.ok) {
    const responseBody = await resp.text();
    return emitFailure(jsonOutput, {
      code: "KILL_FAILED",
      message: "session kill failed",
      human: [red(`  Kill failed: HTTP ${resp.status} — ${responseBody}`)],
      exitCode: 1,
    });
  }

  let data: { readonly ok: true; readonly session: string; readonly sessionId: string };
  try {
    data = await resp.json() as { readonly ok: true; readonly session: string; readonly sessionId: string };
  } catch {
    return emitFailure(jsonOutput, {
      code: "INVALID_RESPONSE",
      message: "wolfpack server returned invalid JSON",
      human: [red("  Wolfpack server returned invalid JSON.")],
      exitCode: 1,
    });
  }
  if (jsonOutput) printApiJson(data, target);
  else print(green(`  Killed session "${data.session}".`));
  return 0;
}
