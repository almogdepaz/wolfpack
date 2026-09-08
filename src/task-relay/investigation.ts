import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson } from "../canonical-json.ts";
import type { RelayEnvelope } from "./domain.ts";
import { RELAY_LIMITS, isOpaqueRelayId } from "./domain.ts";
import { captureRelayWire } from "./worker-protocol.ts";

const KINDS = ["registered", "disconnected", "accepted", "acknowledged", "forward_queued", "forward_attempt", "forward_confirmed", "forward_retry", "forward_unconfirmed", "rejected"] as const;
export interface RelayInvestigationEvent {
  readonly epoch: string;
  readonly at: number;
  readonly kind: typeof KINDS[number];
  readonly envelopeId?: string;
  readonly envelope?: RelayEnvelope;
  readonly reason?: "capacity" | "conflict" | "expired";
}
export interface RelayInvestigationSink { offer(event: RelayInvestigationEvent): boolean }
export interface RelayInvestigationWriter { append(line: string): Promise<void>; cleanup?(): Promise<void> }
export const INVESTIGATION_LIMITS = Object.freeze({
  queueItems: 1024, queueBytes: 4 * 1024 * 1024, recordBytes: RELAY_LIMITS.HTTP_BODY_BYTES + 2048,
  segments: 16, segmentBytes: 16 * 1024 * 1024, retentionMs: 24 * 60 * 60 * 1000,
});
const increment = (value: number, by = 1): number => Math.min(Number.MAX_SAFE_INTEGER, value + by);

/** Best effort only. Counts include the in-flight write, not just waiting rows. */
export class BoundedRelayInvestigation implements RelayInvestigationSink {
  readonly #queue: { line: string | undefined; bytes: number }[] = [];
  readonly #writer: RelayInvestigationWriter;
  readonly #maxItems: number;
  readonly #maxBytes: number;
  #queuedBytes = 0;
  #running: Promise<void> | undefined;
  #closed = false;
  #written = 0;
  #dropped = 0;
  #droppedBytes = 0;
  #invalid = 0;
  #writeFailures = 0;
  #maintenanceFailures = 0;
  #maintenanceQueued = false;
  #lastFailure: "invalid_event" | "capacity" | "write_failed" | "maintenance_failed" | "closed" | undefined;

  constructor(writer: RelayInvestigationWriter, limits: { readonly items?: number; readonly bytes?: number } = {}) {
    this.#writer = writer;
    this.#maxItems = limits.items ?? INVESTIGATION_LIMITS.queueItems;
    this.#maxBytes = limits.bytes ?? INVESTIGATION_LIMITS.queueBytes;
    if (!Number.isSafeInteger(this.#maxItems) || this.#maxItems < 1 || this.#maxItems > INVESTIGATION_LIMITS.queueItems
      || !Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1 || this.#maxBytes > INVESTIGATION_LIMITS.queueBytes) throw new TypeError("invalid investigation queue limits");
  }

  offer(input: RelayInvestigationEvent): boolean {
    let line: string;
    try {
      const event = captureRelayWire(input, INVESTIGATION_LIMITS.recordBytes - 1).value;
      if (!event || !isOpaqueRelayId(event.epoch) || !Number.isSafeInteger(event.at) || event.at < 0 || !KINDS.includes(event.kind)
        || (event.reason !== undefined && !["capacity", "conflict", "expired"].includes(event.reason))
        || Object.keys(event).some(key => !["epoch", "at", "kind", "envelopeId", "envelope", "reason"].includes(key))) throw new TypeError("invalid event");
      line = canonicalJson(event) + "\n";
    } catch {
      this.#invalid = increment(this.#invalid); this.#dropped = increment(this.#dropped);
      this.#lastFailure = "invalid_event";
      return false;
    }
    const size = Buffer.byteLength(line);
    if (this.#closed || this.#queue.length >= this.#maxItems || size > this.#maxBytes - this.#queuedBytes) {
      this.#drop(size, this.#closed ? "closed" : "capacity");
      return false;
    }
    this.#queue.push({ line, bytes: size }); this.#queuedBytes += size;
    this.#start();
    return true;
  }

  /** Gateway timer requests an idle retention sweep through the SAME bounded
   * writer queue; concurrent sweeps coalesce and never race an append. */
  requestCleanup(): boolean {
    if (!this.#writer.cleanup || this.#closed || this.#maintenanceQueued || this.#queue.length >= this.#maxItems) return false;
    this.#maintenanceQueued = true;
    this.#queue.push({ line: undefined, bytes: 0 });
    this.#start();
    return true;
  }

  health() {
    return { queuedItems: this.#queue.length, queuedBytes: this.#queuedBytes, written: this.#written,
      droppedRecords: this.#dropped, droppedBytes: this.#droppedBytes, invalidRecords: this.#invalid,
      writeFailures: this.#writeFailures, maintenanceFailures: this.#maintenanceFailures,
      degraded: this.#dropped > 0 || this.#maintenanceFailures > 0, lastFailure: this.#lastFailure, closed: this.#closed };
  }

  /** Explicit graceful/test drain only; ordinary acceptance never awaits this. */
  async drain(): Promise<void> { while (this.#running) await this.#running; }
  async close(): Promise<void> { this.#closed = true; await this.drain(); }

  #start(): void {
    // Install the owner before writer code runs; also cover offers between the
    // pump's final check and its completion microtask (otherwise they strand).
    this.#running ??= Promise.resolve().then(() => this.#pump()).finally(() => {
      this.#running = undefined;
      if (this.#queue.length) this.#start();
    });
  }

  async #pump(): Promise<void> {
    while (this.#queue.length) {
      const item = this.#queue[0]!;
      try {
        if (item.line === undefined) await this.#writer.cleanup!();
        else { await this.#writer.append(item.line); this.#written = increment(this.#written); }
      } catch {
        if (item.line === undefined) { this.#maintenanceFailures = increment(this.#maintenanceFailures); this.#lastFailure = "maintenance_failed"; }
        else { this.#writeFailures = increment(this.#writeFailures); this.#drop(item.bytes, "write_failed"); }
      } finally {
        this.#queue.shift(); this.#queuedBytes -= item.bytes;
        if (item.line === undefined) this.#maintenanceQueued = false;
      }
    }
  }

  #drop(size: number, reason: "capacity" | "write_failed" | "closed"): void {
    this.#dropped = increment(this.#dropped); this.#droppedBytes = increment(this.#droppedBytes, size); this.#lastFailure = reason;
  }
}

interface Segment { readonly slot: number; size: number; at: number }
/**
 * Fixed private slots, no directory-wide history read or unbounded file listing.
 * Total disk bound = slots * segmentBytes, with no rotation overshoot. Only this
 * dedicated directory's named slots are managed; legacy relay-state is untouched.
 * Not a local-user security sandbox, durable audit, or recovery authority.
 */
export class RotatingRelayInvestigationWriter implements RelayInvestigationWriter {
  readonly #directory: string;
  readonly #slots: number;
  readonly #segmentBytes: number;
  readonly #retentionMs: number;
  readonly #clock: () => number;
  readonly #segments = new Map<number, Segment>();
  #initialized = false;
  #active: number | undefined;
  #busy = false;

  constructor(directory: string, options: { readonly slots?: number; readonly segmentBytes?: number; readonly retentionMs?: number; readonly clock?: () => number } = {}) {
    this.#directory = resolve(directory);
    this.#slots = options.slots ?? INVESTIGATION_LIMITS.segments;
    this.#segmentBytes = options.segmentBytes ?? INVESTIGATION_LIMITS.segmentBytes;
    this.#retentionMs = options.retentionMs ?? INVESTIGATION_LIMITS.retentionMs;
    this.#clock = options.clock ?? Date.now;
    if (!Number.isInteger(this.#slots) || this.#slots < 1 || this.#slots > INVESTIGATION_LIMITS.segments
      || !Number.isSafeInteger(this.#segmentBytes) || this.#segmentBytes < 1 || this.#segmentBytes > INVESTIGATION_LIMITS.segmentBytes
      || !Number.isSafeInteger(this.#retentionMs) || this.#retentionMs < 1 || this.#retentionMs > INVESTIGATION_LIMITS.retentionMs) throw new TypeError("invalid investigation rotation limits");
  }

  async append(line: string): Promise<void> {
    if (this.#busy) throw new Error("investigation writer requires serialized admission");
    if (typeof line !== "string" || line.length > this.#segmentBytes || Buffer.byteLength(line) > this.#segmentBytes) throw new Error("investigation record exceeds segment");
    this.#busy = true;
    try {
      const now = this.#clock();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid investigation clock");
      await this.#initialize();
      await this.#prune(now);
      const size = Buffer.byteLength(line);
      let segment = this.#active === undefined ? undefined : this.#segments.get(this.#active);
      if (segment && segment.size + size > this.#segmentBytes) { this.#active = undefined; segment = undefined; }
      if (!segment) {
        let slot = 0;
        while (slot < this.#slots && this.#segments.has(slot)) slot++;
        if (slot === this.#slots) {
          const oldest = [...this.#segments.values()].reduce((a, b) => a.at <= b.at ? a : b);
          slot = oldest.slot;
          await this.#remove(slot); // Before creating/writing, never a temporary extra segment.
        }
        const file = await open(this.#path(slot), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await file.close();
        segment = { slot, size: 0, at: now }; this.#segments.set(slot, segment); this.#active = slot;
      }
      const file = await open(this.#path(segment.slot), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        this.#privateRegular(stat);
        if (stat.size !== segment.size || stat.size + size > this.#segmentBytes) throw new Error("investigation segment changed externally");
        await file.writeFile(line, "utf8");
        segment.size += size; // Retention is from segment creation, never refreshed by writes.
      } finally { await file.close(); }
    } catch (error) {
      // A partial write may exist. Re-stat only fixed slots and start a NEW
      // segment next time; never concatenate new JSON onto a partial old record.
      this.#initialized = false; this.#active = undefined;
      throw error;
    } finally { this.#busy = false; }
  }

  async cleanup(): Promise<void> {
    if (this.#busy) throw new Error("investigation writer requires serialized admission");
    this.#busy = true;
    try {
      const now = this.#clock();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid investigation clock");
      await this.#initialize();
      await this.#prune(now);
    } catch (error) {
      this.#initialized = false; this.#active = undefined;
      throw error;
    } finally { this.#busy = false; }
  }

  async #prune(now: number): Promise<void> {
    for (const segment of this.#segments.values()) {
      if (now - segment.at >= this.#retentionMs) await this.#remove(segment.slot);
    }
  }

  async #initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.#directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0
      || (process.getuid && directory.uid !== process.getuid())) throw new Error("investigation directory must be private and owned");
    if (this.#initialized) return;
    this.#segments.clear();
    for (let slot = 0; slot < this.#slots; slot++) {
      try {
        const stat = await lstat(this.#path(slot));
        this.#privateRegular(stat);
        if (stat.size > this.#segmentBytes) throw new Error("existing investigation segment exceeds budget");
        // Unknown creation time expires conservatively instead of extending
        // retention on every append/restart. File contents are not replayed.
        this.#segments.set(slot, { slot, size: stat.size, at: stat.birthtimeMs > 0 ? Math.min(stat.birthtimeMs, stat.mtimeMs) : 0 });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.#initialized = true;
  }

  async #remove(slot: number): Promise<void> {
    this.#privateRegular(await lstat(this.#path(slot)));
    await unlink(this.#path(slot));
    this.#segments.delete(slot);
    if (this.#active === slot) this.#active = undefined;
  }

  #path(slot: number): string { return join(this.#directory, `relay-investigation-${String(slot).padStart(2, "0")}.jsonl`); }
  #privateRegular(stat: { isFile(): boolean; mode: number; uid: number }): void {
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("investigation segment must be a private owned regular file");
  }
}
