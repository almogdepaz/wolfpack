/**
 * `wolfpack events` — follow the server's live event stream.
 */
import { call } from "./api.js";
import type { VerifiedMachineTarget } from "./machine-target.js";
import { print, printError, red } from "./formatting.js";
import { SESSION_EXIT } from "./session-control.js";
import { EVENTS_PATH, formatEventLine, parseEventFilter, parseSseEvents, type WolfpackEvent } from "../events-contract.js";

export const EVENTS_USAGE = "Usage: wolfpack events [--kinds <kind,...>] [--session <name-or-id>] [--json]";

export interface ParsedEventsOptions {
  readonly kinds?: string;
  readonly session?: string;
  readonly json: boolean;
}

export function parseEventsOptions(argv: readonly string[]): ParsedEventsOptions | null {
  let kinds: string | undefined;
  let session: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if ((arg === "--kinds" || arg === "--session") && argv[index + 1] && !argv[index + 1]!.startsWith("--")) {
      if (arg === "--kinds") kinds = argv[++index];
      else session = argv[++index];
    } else return null;
  }
  return { ...(kinds !== undefined && { kinds }), ...(session !== undefined && { session }), json };
}

export function eventsQuery(options: ParsedEventsOptions): string {
  const params = new URLSearchParams();
  if (options.kinds !== undefined) params.set("kinds", options.kinds);
  if (options.session !== undefined) params.set("session", options.session);
  const query = params.toString();
  return query ? `${EVENTS_PATH}?${query}` : EVENTS_PATH;
}

/** Feed every SSE event in `body` to `onEvent`; resolves when the stream ends. */
export async function consumeEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: WolfpackEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    const parsed = parseSseEvents(pending + decoder.decode(value, { stream: true }));
    pending = parsed.rest;
    for (const event of parsed.events) onEvent(event);
  }
}

export async function eventsCommand(argv: readonly string[], target?: VerifiedMachineTarget): Promise<number> {
  const options = parseEventsOptions(argv);
  if (!options) {
    printError(red(EVENTS_USAGE));
    return SESSION_EXIT.USAGE;
  }
  const path = eventsQuery(options);
  // Validate with the shared contract so a bad filter is a usage error, not an HTTP failure.
  const filter = parseEventFilter(new URL(path, "http://localhost").searchParams);
  if (!filter.ok) {
    printError(red(`  events: ${filter.error}`));
    return SESSION_EXIT.USAGE;
  }
  let response: Response;
  try {
    response = await call(path, {}, target);
  } catch (error: unknown) {
    printError(red(`  events: could not reach the wolfpack server (${error instanceof Error ? error.message : String(error)})`));
    return SESSION_EXIT.GENERAL;
  }
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    printError(red(`  events: ${typeof body.error === "string" ? body.error : `HTTP ${response.status}`}`));
    return response.status === 401 ? SESSION_EXIT.AUTH : SESSION_EXIT.GENERAL;
  }
  // The stream is open-ended: a clean end or a dropped socket both mean the
  // server went away, and scripts own the retry.
  let detail = "";
  try {
    await consumeEventStream(response.body, (event) => {
      print(options.json ? JSON.stringify(event) : formatEventLine(event));
    });
  } catch (error: unknown) {
    detail = ` (${error instanceof Error ? error.message : String(error)})`;
  }
  printError(red(`  events: stream closed by server${detail}`));
  return SESSION_EXIT.GENERAL;
}
