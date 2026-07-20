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
