export interface GhosttyPrewarmPoolOptions<TInstance> {
  readonly maxSize: number;
  readonly create: () => Promise<TInstance>;
  readonly onReady?: (instance: TInstance) => void;
  readonly onError?: (error: unknown) => void;
}

export interface GhosttyPrewarmTakeResult<TInstance> {
  readonly instance: TInstance | null;
  readonly prewarmed: boolean;
}

export interface GhosttyPrewarmRefillScheduleOptions {
  readonly prewarm: () => Promise<void> | null;
  readonly schedule: (task: () => void) => void;
  readonly waitUntilReady?: () => Promise<unknown> | undefined;
  readonly onError?: (error: unknown) => void;
}

export function scheduleGhosttyPrewarmRefill(options: GhosttyPrewarmRefillScheduleOptions): void {
  const onError = options.onError ?? (() => {});
  const prewarm = (): void => {
    try {
      void options.prewarm()?.catch(onError);
    } catch (error) {
      onError(error);
    }
  };
  options.schedule(() => {
    const ready = options.waitUntilReady?.();
    if (!ready) {
      prewarm();
      return;
    }
    void ready.then(prewarm).catch(onError);
  });
}

export class GhosttyPrewarmPool<TInstance> {
  private readonly maxSize: number;
  private readonly create: () => Promise<TInstance>;
  private readonly onReady: (instance: TInstance) => void;
  private readonly onError: (error: unknown) => void;
  private readonly idle: TInstance[] = [];
  private readonly pending = new Set<Promise<void>>();

  constructor(options: GhosttyPrewarmPoolOptions<TInstance>) {
    this.maxSize = Math.max(0, options.maxSize);
    this.create = options.create;
    this.onReady = options.onReady ?? (() => {});
    this.onError = options.onError ?? (() => {});
  }

  take(): GhosttyPrewarmTakeResult<TInstance> {
    const instance = this.idle.shift();
    if (!instance) return { instance: null, prewarmed: false };
    return { instance, prewarmed: true };
  }

  prewarm(): Promise<void> | null {
    if (this.idle.length + this.pending.size >= this.maxSize) return null;

    const task = this.create()
      .then((instance) => {
        if (this.idle.length < this.maxSize) {
          this.idle.push(instance);
          this.onReady(instance);
        }
      })
      .catch((error) => this.onError(error))
      .finally(() => {
        this.pending.delete(task);
      });

    this.pending.add(task);
    return task;
  }
}
