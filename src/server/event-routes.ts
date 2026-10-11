/**
 * `GET /api/events` — live server-sent event stream. Auth is the shared
 * `/api/*` JWT gate in index.ts.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { EVENTS_PATH, formatSseEvent, parseEventFilter } from "../events-contract.js";
import { subscribeEvents } from "./event-bus.js";
import { json } from "./http.js";

export const EVENTS_MAX_STREAMS = 32;
const EVENTS_PING_INTERVAL_MS = 15_000;

let openStreams = 0;

function handleEventStream(req: IncomingMessage, res: ServerResponse): void {
  const parsed = parseEventFilter(new URL(req.url ?? "/", "http://localhost").searchParams);
  if (!parsed.ok) return json(res, { error: parsed.error }, 400);
  if (openStreams >= EVENTS_MAX_STREAMS) return json(res, { error: "too many event streams" }, 429);

  openStreams++;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    // Keep reverse proxies from buffering the stream.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const unsubscribe = subscribeEvents(parsed.filter, (event) => {
    res.write(formatSseEvent(event));
  });
  const ping = setInterval(() => res.write(": ping\n\n"), EVENTS_PING_INTERVAL_MS);
  let closed = false;
  res.on("close", () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    unsubscribe();
    openStreams--;
  });
}

export const eventRoutes: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {
  [`GET ${EVENTS_PATH}`]: handleEventStream,
};
