export interface PolledExtensionDocument {
  readonly document: unknown | null;
  readonly revision: number;
}

export interface DocumentPollingOptions {
  readonly read: (signal: AbortSignal) => Promise<PolledExtensionDocument>;
  readonly intervalMs?: number;
  readonly maxBackoffMs?: number;
  readonly onState?: (state: "fresh" | "stale" | "paused" | "error") => void;
}

/** One in-flight read and one cadence per exact document key, shared by all views. */
export class SharedDocumentPoller {
  private readonly subscribers = new Set<(document: unknown | null, revision: number) => void>();
  private readonly intervalMs: number;
  private readonly maxBackoffMs: number;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private disposed = false;
  private inFlight = false;
  private failures = 0;
  private current: PolledExtensionDocument = { document: null, revision: 0 };

  constructor(private readonly options: DocumentPollingOptions) {
    this.intervalMs = Math.max(250, options.intervalMs ?? 2_000);
    this.maxBackoffMs = Math.max(this.intervalMs, options.maxBackoffMs ?? 16_000);
  }

  subscribe(listener: (document: unknown | null, revision: number) => void): () => void {
    if (this.disposed) return () => {};
    this.subscribers.add(listener);
    listener(this.current.document, this.current.revision);
    this.schedule(0);
    return () => {
      this.subscribers.delete(listener);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  setPaused(paused: boolean): void {
    if (this.disposed || this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.clearTimer();
      this.options.onState?.("paused");
    } else if (this.subscribers.size > 0) {
      this.schedule(0);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscribers.clear();
    this.stop();
  }

  private stop(): void {
    this.clearTimer();
    this.controller?.abort();
    this.controller = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    if (this.disposed || this.paused || this.inFlight || this.subscribers.size === 0 || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delay);
  }

  private async poll(): Promise<void> {
    if (this.disposed || this.paused || this.inFlight || this.subscribers.size === 0) return;
    this.inFlight = true;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const next = await this.options.read(controller.signal);
      if (this.disposed || this.paused || this.controller !== controller) return;
      this.failures = 0;
      if (next.revision >= this.current.revision) this.current = next;
      this.options.onState?.("fresh");
      for (const listener of this.subscribers) listener(this.current.document, this.current.revision);
    } catch {
      if (!this.disposed && !controller.signal.aborted) {
        this.failures = Math.min(this.failures + 1, 8);
        this.options.onState?.(this.current.revision > 0 ? "stale" : "error");
      }
    } finally {
      if (this.controller === controller) this.controller = null;
      this.inFlight = false;
      const delay = Math.min(this.maxBackoffMs, this.intervalMs * 2 ** this.failures);
      this.schedule(delay);
    }
  }
}
