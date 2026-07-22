/**
 * Wolfpack broker wire codec — TS mirror of `broker/src/codec.rs`.
 *
 * Wire layout (every frame):
 *   1 byte   kind
 *   4 bytes  payload length (big-endian u32)
 *   N bytes  payload (kind-dependent)
 *
 * Pure transport plumbing — no broker session semantics live here.
 */

export const FRAME_KIND_CONTROL_REQUEST = 0x01;
export const FRAME_KIND_CONTROL_RESPONSE = 0x02;
export const FRAME_KIND_OUTPUT_BINARY = 0x03;
export const FRAME_KIND_INPUT_BINARY = 0x04;
export const FRAME_KIND_EVENT = 0x05;

export const FRAME_HEADER_BYTES = 5;
export const MAX_FRAME_PAYLOAD = 64 * 1024 * 1024;

export type FrameKind =
  | typeof FRAME_KIND_CONTROL_REQUEST
  | typeof FRAME_KIND_CONTROL_RESPONSE
  | typeof FRAME_KIND_OUTPUT_BINARY
  | typeof FRAME_KIND_INPUT_BINARY
  | typeof FRAME_KIND_EVENT;

export interface ControlRequest {
  id: number;
  method: string;
  params: unknown;
}

export interface ProtocolErrorBody {
  code: string;
  message: string;
}

export interface ResponsePayloadBody {
  kind: string;
  [k: string]: unknown;
}

export interface ControlResponse {
  id: number;
  status: "ok" | "error";
  payload?: ResponsePayloadBody;
  error?: ProtocolErrorBody;
}

export interface EventBody {
  event: string;
  [k: string]: unknown;
}

export interface OutputBinaryFrame {
  /** Canonical lowercase UUID string (8-4-4-4-12). */
  sessionId: string;
  /** Final per-session PTY-chunk seq covered by this possibly coalesced frame. */
  seq: bigint;
  /** Raw PTY bytes; receiver-owned (caller may retain). */
  data: Uint8Array;
}

export interface InputBinaryFrame {
  sessionId: string;
  data: Uint8Array;
}

export type Frame =
  | { kind: typeof FRAME_KIND_CONTROL_REQUEST; value: ControlRequest }
  | { kind: typeof FRAME_KIND_CONTROL_RESPONSE; value: ControlResponse }
  | { kind: typeof FRAME_KIND_OUTPUT_BINARY; value: OutputBinaryFrame }
  | { kind: typeof FRAME_KIND_INPUT_BINARY; value: InputBinaryFrame }
  | { kind: typeof FRAME_KIND_EVENT; value: EventBody };

export type CodecErrorCode =
  | "frame_too_large"
  | "unknown_kind"
  | "short_binary"
  | "json"
  | "invalid_uuid";

export class CodecError extends Error {
  constructor(
    readonly code: CodecErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CodecError";
  }
}

// ---------------------------------------------------------------------------
// UUID helpers (16 raw bytes ↔ canonical lowercase string)
// ---------------------------------------------------------------------------

const UUID_HEX_CHARS = 32;

export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== UUID_HEX_CHARS || !/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new CodecError("invalid_uuid", `invalid uuid: ${uuid}`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function uuidFromBytes(buf: Uint8Array, off = 0): string {
  if (buf.length - off < 16) {
    throw new CodecError("short_binary", "not enough bytes for uuid");
  }
  const hex = new Array<string>(16);
  for (let i = 0; i < 16; i++) {
    hex[i] = buf[off + i].toString(16).padStart(2, "0");
  }
  return (
    hex[0] + hex[1] + hex[2] + hex[3] +
    "-" +
    hex[4] + hex[5] +
    "-" +
    hex[6] + hex[7] +
    "-" +
    hex[8] + hex[9] +
    "-" +
    hex[10] + hex[11] + hex[12] + hex[13] + hex[14] + hex[15]
  );
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();
// fatal:true — reject malformed UTF-8 in JSON control
// frames instead of replacing bytes with U+FFFD. Silent replacement
// could parse-as-clean a corrupted field (mojibake in session names
// etc.), misrouting events. The TypeError is caught by `decodeJson`
// below and rethrown as a CodecError so the caller drops the frame and
// the broker reconnect path takes over.
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

export function encodeFrame(frame: Frame): Uint8Array {
  switch (frame.kind) {
    case FRAME_KIND_CONTROL_REQUEST:
      return encodeJsonFrame(FRAME_KIND_CONTROL_REQUEST, frame.value);
    case FRAME_KIND_CONTROL_RESPONSE:
      return encodeJsonFrame(FRAME_KIND_CONTROL_RESPONSE, frame.value);
    case FRAME_KIND_EVENT:
      return encodeJsonFrame(FRAME_KIND_EVENT, frame.value);
    case FRAME_KIND_OUTPUT_BINARY: {
      const { sessionId, seq, data } = frame.value;
      const body = new Uint8Array(24 + data.length);
      body.set(uuidToBytes(sessionId), 0);
      const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
      dv.setBigUint64(16, seq, false);
      body.set(data, 24);
      return wrapFrame(FRAME_KIND_OUTPUT_BINARY, body);
    }
    case FRAME_KIND_INPUT_BINARY: {
      const { sessionId, data } = frame.value;
      const body = new Uint8Array(16 + data.length);
      body.set(uuidToBytes(sessionId), 0);
      body.set(data, 16);
      return wrapFrame(FRAME_KIND_INPUT_BINARY, body);
    }
  }
}

function encodeJsonFrame(kind: FrameKind, value: unknown): Uint8Array {
  const body = TEXT_ENCODER.encode(JSON.stringify(value));
  return wrapFrame(kind, body);
}

function wrapFrame(kind: FrameKind, body: Uint8Array): Uint8Array {
  if (body.length > MAX_FRAME_PAYLOAD) {
    throw new CodecError(
      "frame_too_large",
      `frame too large: ${body.length} bytes (max ${MAX_FRAME_PAYLOAD})`,
    );
  }
  const out = new Uint8Array(FRAME_HEADER_BYTES + body.length);
  out[0] = kind;
  const dv = new DataView(out.buffer, out.byteOffset, FRAME_HEADER_BYTES);
  dv.setUint32(1, body.length, false);
  out.set(body, FRAME_HEADER_BYTES);
  return out;
}

// ---------------------------------------------------------------------------
// Decoding (pure, single-frame)
// ---------------------------------------------------------------------------

export function decodeFrame(kind: number, payload: Uint8Array): Frame {
  switch (kind) {
    case FRAME_KIND_CONTROL_REQUEST:
      return {
        kind: FRAME_KIND_CONTROL_REQUEST,
        value: decodeJson<ControlRequest>(payload),
      };
    case FRAME_KIND_CONTROL_RESPONSE:
      return {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: decodeJson<ControlResponse>(payload),
      };
    case FRAME_KIND_EVENT:
      return {
        kind: FRAME_KIND_EVENT,
        value: decodeJson<EventBody>(payload),
      };
    case FRAME_KIND_OUTPUT_BINARY: {
      if (payload.length < 24) {
        throw new CodecError("short_binary", "output_binary frame too short");
      }
      const sessionId = uuidFromBytes(payload, 0);
      const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const seq = dv.getBigUint64(16, false);
      // Detach the data slice so callers may retain it independently
      // of the streaming parser's chunk recycling.
      const owned = new Uint8Array(payload.length - 24);
      owned.set(payload.subarray(24));
      return {
        kind: FRAME_KIND_OUTPUT_BINARY,
        value: { sessionId, seq, data: owned },
      };
    }
    case FRAME_KIND_INPUT_BINARY: {
      if (payload.length < 16) {
        throw new CodecError("short_binary", "input_binary frame too short");
      }
      const sessionId = uuidFromBytes(payload, 0);
      const owned = new Uint8Array(payload.length - 16);
      owned.set(payload.subarray(16));
      return {
        kind: FRAME_KIND_INPUT_BINARY,
        value: { sessionId, data: owned },
      };
    }
    default:
      throw new CodecError(
        "unknown_kind",
        `unknown frame kind: 0x${kind.toString(16).padStart(2, "0")}`,
      );
  }
}

function decodeJson<T>(body: Uint8Array): T {
  try {
    return JSON.parse(TEXT_DECODER.decode(body)) as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new CodecError("json", `invalid json payload: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Streaming parser — accepts arbitrary-sized chunks, emits whole frames.
// ---------------------------------------------------------------------------

export class FrameParser {
  private chunks: Uint8Array[] = [];
  private buffered = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
  }

  /** Drain every complete frame currently buffered. Throws CodecError on protocol violation. */
  drain(): Frame[] {
    const out: Frame[] = [];
    while (true) {
      const frame = this.tryReadOne();
      if (!frame) break;
      out.push(frame);
    }
    return out;
  }

  /** True iff the parser has buffered bytes that don't yet form a full frame. */
  hasPartial(): boolean {
    return this.buffered > 0;
  }

  private tryReadOne(): Frame | null {
    if (this.buffered < FRAME_HEADER_BYTES) return null;
    this.coalesce(FRAME_HEADER_BYTES);
    const head = this.chunks[0];
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const kind = head[0];
    const len = dv.getUint32(1, false);
    if (len > MAX_FRAME_PAYLOAD) {
      throw new CodecError(
        "frame_too_large",
        `frame too large: ${len} bytes (max ${MAX_FRAME_PAYLOAD})`,
      );
    }
    const total = FRAME_HEADER_BYTES + len;
    if (this.buffered < total) return null;
    this.coalesce(total);
    const body = this.chunks[0].subarray(FRAME_HEADER_BYTES, total);
    const frame = decodeFrame(kind, body);
    this.advance(total);
    return frame;
  }

  /**
   * Ensure chunks[0] holds at least `n` bytes (or the remainder of the buffer if smaller).
   *
   * Allocation tradeoff: when data spans multiple chunks, coalesce()
   * allocates a new Uint8Array and copies bytes. Under high-throughput +
   * fragmented input this increases GC pressure, but keeps parser logic
   * simple/obvious for current scale.
   */
  private coalesce(n: number): void {
    if (this.chunks.length === 0) return;
    if (this.chunks[0].length >= n) return;
    let acc = 0;
    let take = 0;
    while (take < this.chunks.length && acc < n) {
      acc += this.chunks[take].length;
      take++;
    }
    const merged = new Uint8Array(acc);
    let off = 0;
    for (let i = 0; i < take; i++) {
      merged.set(this.chunks[i], off);
      off += this.chunks[i].length;
    }
    this.chunks.splice(0, take, merged);
  }

  private advance(n: number): void {
    const head = this.chunks[0];
    if (head.length === n) {
      this.chunks.shift();
    } else {
      this.chunks[0] = head.subarray(n);
    }
    this.buffered -= n;
  }
}
