import { SESSION_SNAPSHOT_FRESHNESS } from "../session-snapshot-contract.js";
import type { SessionSnapshotFreshness } from "../session-snapshot-contract.js";
import type { SessionSnapshotCapture } from "./backend-contract.js";

export const SESSION_SNAPSHOT_REFRESH_MS = 2_000;
export const SESSION_SNAPSHOT_MAX_ACTIVE = 2;
export const SESSION_SNAPSHOT_MAX_CACHED = 32;
export const SESSION_SNAPSHOT_MAX_TEXT_BYTES = 64 * 1024;
export const SESSION_SNAPSHOT_MAX_RESPONSE_BYTES = 256 * 1024;

export interface SessionSnapshotResponse {
  readonly session: string;
  readonly sessionId: string;
  readonly text: string;
  readonly capturedAt: string;
  readonly cols: number;
  readonly rows: number;
  readonly truncated: boolean;
  readonly freshness: SessionSnapshotFreshness;
}

export class SessionSnapshotBusyError extends Error {
  constructor() {
    super("snapshot capacity is busy");
    this.name = "SessionSnapshotBusyError";
  }
}

interface CachedSnapshot {
  readonly response: SessionSnapshotResponse;
  readonly cachedAtMs: number;
}

export class SessionSnapshotService {
  private readonly cache = new Map<string, CachedSnapshot>();
  private readonly inFlight = new Map<string, Promise<SessionSnapshotResponse>>();
  private active = 0;

  constructor(
    private readonly capture: (sessionId: string) => Promise<SessionSnapshotCapture>,
    private readonly now: () => number = Date.now,
  ) {}

  async read(sessionId: string): Promise<SessionSnapshotResponse> {
    const cached = this.cache.get(sessionId);
    if (cached && this.now() - cached.cachedAtMs < SESSION_SNAPSHOT_REFRESH_MS) {
      this.cache.delete(sessionId);
      this.cache.set(sessionId, cached);
      return { ...cached.response, freshness: SESSION_SNAPSHOT_FRESHNESS.CACHED };
    }
    if (cached) this.cache.delete(sessionId);

    const shared = this.inFlight.get(sessionId);
    if (shared) return shared;
    if (this.active >= SESSION_SNAPSHOT_MAX_ACTIVE) throw new SessionSnapshotBusyError();

    this.active++;
    const operation = this.capture(sessionId)
      .then((capture) => toResponse(capture))
      .then((response) => {
        this.cache.set(sessionId, { response, cachedAtMs: this.now() });
        while (this.cache.size > SESSION_SNAPSHOT_MAX_CACHED) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.cache.delete(oldest);
        }
        return response;
      })
      .finally(() => {
        this.active--;
        this.inFlight.delete(sessionId);
      });
    this.inFlight.set(sessionId, operation);
    return operation;
  }
}

function toResponse(capture: SessionSnapshotCapture): SessionSnapshotResponse {
  const { text, truncated } = truncateUtf8(capture.text, SESSION_SNAPSHOT_MAX_TEXT_BYTES);
  return {
    session: capture.session,
    sessionId: capture.sessionId,
    text,
    capturedAt: new Date(capture.capturedAtMs).toISOString(),
    cols: capture.cols,
    rows: capture.rows,
    truncated,
    freshness: SESSION_SNAPSHOT_FRESHNESS.FRESH,
  };
}

function truncateUtf8(text: string, maximumBytes: number): { readonly text: string; readonly truncated: boolean } {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maximumBytes) return { text, truncated: false };
  let end = maximumBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return { text: encoded.subarray(0, end).toString("utf8"), truncated: true };
}
