/**
 * RingBuffer — fixed-capacity circular byte buffer for PTY output capture.
 *
 * Stores the most recent N bytes written. Older data is silently overwritten
 * when the buffer wraps. Designed for capturePane-style reads where only the
 * tail of terminal output matters.
 */
export class RingBuffer {
  private buf: Buffer;
  private head = 0; // next write position
  private len = 0; // bytes currently stored (≤ capacity)

  constructor(readonly capacity: number) {
    this.buf = Buffer.alloc(capacity);
  }

  /** Append data, silently dropping oldest bytes when full. */
  write(data: Uint8Array): void {
    const n = data.length;
    if (n === 0) return;

    if (n >= this.capacity) {
      // Data larger than buffer — keep only the tail
      Buffer.from(data.subarray(n - this.capacity)).copy(this.buf, 0);
      this.head = 0;
      this.len = this.capacity;
      return;
    }

    const firstChunk = Math.min(n, this.capacity - this.head);
    Buffer.from(data.subarray(0, firstChunk)).copy(this.buf, this.head);
    if (firstChunk < n) {
      Buffer.from(data.subarray(firstChunk)).copy(this.buf, 0);
    }
    this.head = (this.head + n) % this.capacity;
    this.len = Math.min(this.len + n, this.capacity);
  }

  /** Read stored contents as a UTF-8 string. */
  read(): string {
    if (this.len === 0) return "";

    if (this.len < this.capacity) {
      // Buffer hasn't wrapped — data is contiguous from 0..len
      return this.buf.toString("utf-8", 0, this.len);
    }

    // Wrapped: oldest data starts at head, wraps around
    const tail = this.buf.subarray(this.head, this.capacity);
    const front = this.buf.subarray(0, this.head);
    return Buffer.concat([tail, front]).toString("utf-8");
  }

  /** Read stored contents as a Buffer. */
  readBuffer(): Buffer {
    if (this.len === 0) return Buffer.alloc(0);
    if (this.len < this.capacity) return Buffer.from(this.buf.subarray(0, this.len));
    const tail = this.buf.subarray(this.head, this.capacity);
    const front = this.buf.subarray(0, this.head);
    return Buffer.concat([tail, front]);
  }

  /** Number of bytes currently stored. */
  get size(): number {
    return this.len;
  }

  /** Discard all stored data. */
  clear(): void {
    this.head = 0;
    this.len = 0;
  }
}
