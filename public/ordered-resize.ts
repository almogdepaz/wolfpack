export interface TerminalDimensions {
  readonly cols: number;
  readonly rows: number;
}

interface ResizeAck {
  readonly type: "resize_ack";
  readonly resizeId: number;
  readonly cols: number;
  readonly rows: number;
}

export interface OrderedResizeRequest extends TerminalDimensions {
  readonly type: "resize";
  readonly resizeId: number;
}

export type OrderedResizeSettlement = "acknowledged" | "cancelled";

/** Ordered proposals always require a broker round trip, even when their
 * geometry matches the last sent request: an earlier pending proposal may
 * have changed the broker's eventual dimensions. */
export function shouldSendResizeRequest(
  request: OrderedResizeRequest | TerminalDimensions,
  lastSentResize: string,
  force: boolean,
): boolean {
  return force || "resizeId" in request || `${request.cols}x${request.rows}` !== lastSentResize;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Commits only the latest resize after its broker acknowledgement. */
export class OrderedResizeTracker {
  private nextResizeId = 0;
  private pending: OrderedResizeRequest | null = null;
  private waiters: Array<(settlement: OrderedResizeSettlement) => void> = [];

  request(dimensions: TerminalDimensions): OrderedResizeRequest {
    this.nextResizeId++;
    const request = { type: "resize" as const, resizeId: this.nextResizeId, ...dimensions };
    this.pending = request;
    return request;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  hasPendingDimensions(dimensions: TerminalDimensions): boolean {
    return this.pending?.cols === dimensions.cols && this.pending.rows === dimensions.rows;
  }

  waitForSettlement(): Promise<OrderedResizeSettlement> {
    if (!this.pending) return Promise.resolve("acknowledged");
    return new Promise((resolve) => { this.waiters.push(resolve); });
  }

  acknowledge(message: unknown): TerminalDimensions | null {
    if (!this.isValidAck(message) || !this.pending || message.resizeId !== this.pending.resizeId) return null;
    this.pending = null;
    this.settleWaiters("acknowledged");
    return { cols: message.cols, rows: message.rows };
  }

  clear(): void {
    this.pending = null;
    this.settleWaiters("cancelled");
  }

  private settleWaiters(settlement: OrderedResizeSettlement): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve(settlement);
  }

  private isValidAck(message: unknown): message is ResizeAck {
    return typeof message === "object"
      && message !== null
      && (message as Record<string, unknown>).type === "resize_ack"
      && isPositiveSafeInteger((message as Record<string, unknown>).resizeId)
      && isPositiveSafeInteger((message as Record<string, unknown>).cols)
      && isPositiveSafeInteger((message as Record<string, unknown>).rows);
  }
}
