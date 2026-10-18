/**
 * Wire contract for the live event stream (`GET /api/events`, `wolfpack events`).
 * Shared by the server and the CLI. Events are live-only: there is no replay.
 */
import type { AgentStatusState } from "./agent-status-contract.js";
import type { ProgramStatusKind } from "./program-status-contract.js";

export const EVENTS_PATH = "/api/events";

export const WOLFPACK_EVENT_KIND = {
  SESSION_CREATED: "session.created",
  SESSION_EXITED: "session.exited",
  SESSION_STATE: "session.state",
  TASK_UPDATED: "task.updated",
  PARENT_NOTIFIED: "parent_notified",
} as const;

export type WolfpackEventKind = typeof WOLFPACK_EVENT_KIND[keyof typeof WOLFPACK_EVENT_KIND];

const WOLFPACK_EVENT_KIND_SET: ReadonlySet<string> = new Set(Object.values(WOLFPACK_EVENT_KIND));

export const SESSION_EXIT_REASON = {
  EXIT: "exit",
  KILLED: "killed",
} as const;

export type SessionExitReason = typeof SESSION_EXIT_REASON[keyof typeof SESSION_EXIT_REASON];

export type WolfpackEventBody =
  | {
    readonly kind: typeof WOLFPACK_EVENT_KIND.PARENT_NOTIFIED;
    readonly session: string;
    readonly sessionId: string;
    readonly seq: number;
    readonly message: string;
    /** Informational only, not an authenticated sender identity. */
    readonly from?: string;
  }
  | {
    readonly kind: typeof WOLFPACK_EVENT_KIND.SESSION_CREATED;
    readonly sessionId: string;
    readonly session: string;
    readonly cwd: string;
  }
  | {
    readonly kind: typeof WOLFPACK_EVENT_KIND.SESSION_EXITED;
    readonly sessionId: string;
    /** Absent when the exiting session was never known to this server. */
    readonly session?: string;
    readonly reason: SessionExitReason;
    readonly exitCode?: number;
    readonly signal?: number;
  }
  | {
    readonly kind: typeof WOLFPACK_EVENT_KIND.SESSION_STATE;
    readonly session: string;
    readonly sessionId?: string;
    readonly state: AgentStatusState;
    readonly label: string;
    readonly transitionSequence: number;
    /** What a `needs-input` program reported waiting for (OSC 7501 program status). */
    readonly inputKind?: ProgramStatusKind;
    /** The program's OSC 7501 status message; absent for other authorities. */
    readonly message?: string;
  }
  | {
    readonly kind: typeof WOLFPACK_EVENT_KIND.TASK_UPDATED;
    readonly taskId: string;
    readonly eventId: string;
    /** Canonical task event type, e.g. `task.completed`. */
    readonly eventType: string;
    readonly sequence: string;
  };

/** Envelope: `id` is monotonic per server process, `at` is an ISO timestamp. */
export type WolfpackEvent = WolfpackEventBody & { readonly id: number; readonly at: string };

export interface WolfpackEventFilter {
  readonly kinds?: ReadonlySet<WolfpackEventKind>;
  /** Matches a session name or stable session id. Task events never match. */
  readonly session?: string;
}

export type ParsedEventFilter =
  | { readonly ok: true; readonly filter: WolfpackEventFilter }
  | { readonly ok: false; readonly error: string };

const FILTER_PARAMS = new Set(["kinds", "session"]);

export function isWolfpackEventKind(value: string): value is WolfpackEventKind {
  return WOLFPACK_EVENT_KIND_SET.has(value);
}

export function parseEventFilter(params: URLSearchParams): ParsedEventFilter {
  for (const key of params.keys()) {
    if (!FILTER_PARAMS.has(key)) return { ok: false, error: `unknown parameter: ${key}` };
  }
  const filter: { kinds?: Set<WolfpackEventKind>; session?: string } = {};
  const kinds = params.get("kinds");
  if (kinds !== null) {
    const values = kinds.split(",").map((value) => value.trim()).filter(Boolean);
    if (values.length === 0) return { ok: false, error: "kinds must not be empty" };
    const unknown = values.find((value) => !isWolfpackEventKind(value));
    if (unknown !== undefined) return { ok: false, error: `unknown event kind: ${unknown}` };
    filter.kinds = new Set(values as WolfpackEventKind[]);
  }
  const session = params.get("session");
  if (session !== null) {
    if (!session) return { ok: false, error: "session must not be empty" };
    filter.session = session;
  }
  return { ok: true, filter };
}

export function matchesEventFilter(event: WolfpackEventBody, filter: WolfpackEventFilter): boolean {
  if (filter.kinds && !filter.kinds.has(event.kind)) return false;
  if (filter.session === undefined) return true;
  if (event.kind === WOLFPACK_EVENT_KIND.TASK_UPDATED) return false;
  return event.session === filter.session || event.sessionId === filter.session;
}

export function formatEventLine(event: WolfpackEvent): string {
  switch (event.kind) {
    case WOLFPACK_EVENT_KIND.SESSION_CREATED:
      return `${event.at} ${event.kind} ${event.session} cwd=${event.cwd}`;
    case WOLFPACK_EVENT_KIND.SESSION_EXITED: {
      const parts = [event.at, event.kind, event.session ?? event.sessionId, `reason=${event.reason}`];
      if (event.exitCode !== undefined) parts.push(`code=${event.exitCode}`);
      if (event.signal !== undefined) parts.push(`signal=${event.signal}`);
      return parts.join(" ");
    }
    case WOLFPACK_EVENT_KIND.SESSION_STATE:
      return `${event.at} ${event.kind} ${event.session} ${event.state} (${event.label})`;
    case WOLFPACK_EVENT_KIND.PARENT_NOTIFIED:
      return `${event.at} ${event.kind} ${event.session} seq=${event.seq}${event.from !== undefined ? ` [${event.from}]` : ""} ${event.message}`;
    case WOLFPACK_EVENT_KIND.TASK_UPDATED:
      return `${event.at} ${event.kind} ${event.taskId} ${event.eventType}`;
  }
}

/** Serialize one event as an SSE message. */
export function formatSseEvent(event: WolfpackEvent): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Parse complete SSE messages out of a buffer. Comments (`: ping`) are
 * skipped; an incomplete trailing message is returned as `rest`. Line endings
 * may be LF or CRLF (lone-CR endings are not supported); a trailing CR is held
 * back in case its LF is in the next chunk.
 */
export function parseSseEvents(buffer: string): { readonly events: WolfpackEvent[]; readonly rest: string } {
  const heldCr = buffer.endsWith("\r");
  const normalized = (heldCr ? buffer.slice(0, -1) : buffer).replace(/\r\n/g, "\n");
  const messages = normalized.split("\n\n");
  const rest = (messages.pop() ?? "") + (heldCr ? "\r" : "");
  const events: WolfpackEvent[] = [];
  for (const message of messages) {
    const data = message.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (data) events.push(JSON.parse(data) as WolfpackEvent);
  }
  return { events, rest };
}
