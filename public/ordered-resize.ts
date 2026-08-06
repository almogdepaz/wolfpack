export interface OrderedResizeDimensions {
  readonly cols: number;
  readonly rows: number;
}

export interface OrderedResizeRequest extends OrderedResizeDimensions {
  readonly type: "resize";
  readonly resizeId: number;
}

export class OrderedResizeTracker {
  private nextId = 1;
  private latestId = 0;

  request(dimensions: OrderedResizeDimensions): OrderedResizeRequest {
    const resizeId = this.nextId++;
    this.latestId = resizeId;
    return { type: "resize", resizeId, ...dimensions };
  }

  acknowledge(message: Readonly<Record<string, unknown>>): OrderedResizeDimensions | null {
    if (typeof message.resizeId !== "number" || message.resizeId !== this.latestId) return null;
    if (typeof message.cols !== "number" || typeof message.rows !== "number") return null;
    if (!Number.isInteger(message.cols) || !Number.isInteger(message.rows) || message.cols < 1 || message.rows < 1) return null;
    return { cols: message.cols, rows: message.rows };
  }
}
