import { EVENTS_PATH, WOLFPACK_EVENT_KIND, parseSseEvents } from "../src/events-contract";
import type { FetchLike } from "./fetch-timeout";

const RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 30_000];
const MAX_PENDING_CHARACTERS = 64 * 1024;
const HEADER_TIMEOUT_MS = 8_000;
// The existing server sends a comment every 15s, even without lifecycle events.
const IDLE_TIMEOUT_MS = 45_000;

/** Only controlled diagnostics, never response text or malformed event payloads. */
export class SessionLifecycleStreamError extends Error {}

/** Live-only invalidation, never session truth. The owner supplies identity fences. */
export function startSessionLifecycleStream(options: {
  readonly origin: string;
  readonly fetch: FetchLike;
  readonly reconcile: () => void;
  readonly onError?: (error: unknown) => void;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (timer: unknown) => void;
}): () => void {
  const schedule = options.setTimeout ?? setTimeout;
  const clear = options.clearTimeout ?? ((timer: unknown) => globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>));
  let stopped = false;
  let attempt = 0;
  let retry: unknown;
  let deadline: unknown;
  let controller: AbortController | undefined;
  const connect = async (): Promise<void> => {
    if (stopped) return;
    const owner = new AbortController();
    controller = owner;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const armDeadline = (ms: number): void => {
      if (deadline !== undefined) clear(deadline);
      deadline = schedule(() => owner.abort(new DOMException("event stream timed out", "TimeoutError")), ms);
    };
    const cancelRead = (): void => { void reader?.cancel().catch(() => undefined); };
    owner.signal.addEventListener("abort", cancelRead, { once: true });
    try {
      armDeadline(HEADER_TIMEOUT_MS);
      const url = new URL(EVENTS_PATH, options.origin);
      url.searchParams.set("kinds", `${WOLFPACK_EVENT_KIND.SESSION_CREATED},${WOLFPACK_EVENT_KIND.SESSION_EXITED}`);
      const response = await options.fetch(url, {
        signal: owner.signal, headers: { Accept: "text/event-stream" },
        cache: "no-store", redirect: "error", credentials: "omit",
      });
      if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
        void response.body?.cancel().catch(() => undefined);
        const detail = !response.ok ? `HTTP ${response.status}` : !response.body ? "missing body" : "unexpected content type";
        throw new SessionLifecycleStreamError(`lifecycle stream unavailable (${detail})`);
      }
      if (stopped || owner.signal.aborted) {
        void response.body.cancel().catch(() => undefined);
        if (!stopped) owner.signal.throwIfAborted();
        return;
      }
      reader = response.body.getReader();
      // Subscribe first, then repair the gap (including the initial connection).
      options.reconcile();
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        armDeadline(IDLE_TIMEOUT_MS);
        const { done, value } = await reader.read();
        if (stopped) return;
        owner.signal.throwIfAborted();
        if (done) throw new SessionLifecycleStreamError("lifecycle stream closed");
        // Healthy traffic, including heartbeats, restores the short retry budget.
        attempt = 0;
        const chunk = decoder.decode(value, { stream: true });
        if (pending.length + chunk.length > MAX_PENDING_CHARACTERS) throw new SessionLifecycleStreamError("lifecycle stream frame exceeds limit");
        const parsed = parseSseEvents(pending + chunk);
        pending = parsed.rest;
        if (parsed.events.some(event => event.kind === WOLFPACK_EVENT_KIND.SESSION_CREATED || event.kind === WOLFPACK_EVENT_KIND.SESSION_EXITED)) options.reconcile();
      }
    } catch (error) {
      if (!stopped) options.onError?.(error);
    } finally {
      if (deadline !== undefined) clear(deadline);
      deadline = undefined;
      owner.abort();
      owner.signal.removeEventListener("abort", cancelRead);
      reader?.releaseLock();
      if (!stopped) {
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt++, RECONNECT_DELAYS_MS.length - 1)]!;
        retry = schedule(() => { retry = undefined; void connect(); }, delay);
      }
    }
  };
  void connect();
  return () => {
    stopped = true;
    controller?.abort();
    if (retry !== undefined) clear(retry);
    if (deadline !== undefined) clear(deadline);
  };
}
