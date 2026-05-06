import { describe, expect, test } from "bun:test";

import {
  CodecError,
  decodeFrame,
  encodeFrame,
  FRAME_HEADER_BYTES,
  FRAME_KIND_CONTROL_REQUEST,
  FRAME_KIND_CONTROL_RESPONSE,
  FRAME_KIND_EVENT,
  FRAME_KIND_INPUT_BINARY,
  FRAME_KIND_OUTPUT_BINARY,
  FrameParser,
  MAX_FRAME_PAYLOAD,
  uuidFromBytes,
  uuidToBytes,
  type Frame,
} from "../../src/broker/codec";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const SAMPLE_UUID = "550e8400-e29b-41d4-a716-446655440000";

function concat(...arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe("uuid bytes", () => {
  test("roundtrip", () => {
    const bytes = uuidToBytes(SAMPLE_UUID);
    expect(bytes.length).toBe(16);
    expect(uuidFromBytes(bytes)).toBe(SAMPLE_UUID);
  });

  test("nil uuid", () => {
    const bytes = uuidToBytes(NIL_UUID);
    expect(bytes.every((b) => b === 0)).toBe(true);
    expect(uuidFromBytes(bytes)).toBe(NIL_UUID);
  });

  test("rejects malformed string", () => {
    expect(() => uuidToBytes("not-a-uuid")).toThrow(CodecError);
    expect(() => uuidToBytes("550e8400e29b41d4a716446655440000XX")).toThrow();
  });

  test("decodes uppercase as canonical lowercase", () => {
    const upper = "550E8400-E29B-41D4-A716-446655440000";
    const bytes = uuidToBytes(upper);
    expect(uuidFromBytes(bytes)).toBe(SAMPLE_UUID);
  });
});

describe("frame roundtrips", () => {
  test("control_request", () => {
    const frame: Frame = {
      kind: FRAME_KIND_CONTROL_REQUEST,
      value: { id: 7, method: "list_sessions", params: {} },
    };
    const bytes = encodeFrame(frame);
    expect(bytes[0]).toBe(FRAME_KIND_CONTROL_REQUEST);
    const parser = new FrameParser();
    parser.push(bytes);
    const out = parser.drain();
    expect(out.length).toBe(1);
    expect(out[0]).toEqual(frame);
  });

  test("control_response ok", () => {
    const frame: Frame = {
      kind: FRAME_KIND_CONTROL_RESPONSE,
      value: {
        id: 12,
        status: "ok",
        payload: { kind: "subscribe", ok: true, current_seq: 99 },
      },
    };
    const parser = new FrameParser();
    parser.push(encodeFrame(frame));
    expect(parser.drain()[0]).toEqual(frame);
  });

  test("control_response error", () => {
    const frame: Frame = {
      kind: FRAME_KIND_CONTROL_RESPONSE,
      value: {
        id: 9,
        status: "error",
        error: { code: "unknown_session", message: "no such id" },
      },
    };
    const parser = new FrameParser();
    parser.push(encodeFrame(frame));
    expect(parser.drain()[0]).toEqual(frame);
  });

  test("event", () => {
    const frame: Frame = {
      kind: FRAME_KIND_EVENT,
      value: { event: "session_resized", session_id: NIL_UUID, cols: 100, rows: 40 },
    };
    const parser = new FrameParser();
    parser.push(encodeFrame(frame));
    expect(parser.drain()[0]).toEqual(frame);
  });

  test("output_binary preserves uuid + seq + raw bytes", () => {
    const data = new Uint8Array([
      0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x1b, 0x5b, 0x48, 0x77, 0x6f, 0x72, 0x6c, 0x64,
    ]);
    const frame: Frame = {
      kind: FRAME_KIND_OUTPUT_BINARY,
      value: { sessionId: SAMPLE_UUID, seq: 0xCAFEBABEn, data },
    };
    const bytes = encodeFrame(frame);
    expect(bytes[0]).toBe(FRAME_KIND_OUTPUT_BINARY);
    const parser = new FrameParser();
    parser.push(bytes);
    const [out] = parser.drain();
    expect(out.kind).toBe(FRAME_KIND_OUTPUT_BINARY);
    if (out.kind !== FRAME_KIND_OUTPUT_BINARY) throw new Error("unreachable");
    expect(out.value.sessionId).toBe(SAMPLE_UUID);
    expect(out.value.seq).toBe(0xCAFEBABEn);
    expect(arraysEqual(out.value.data, data)).toBe(true);
  });

  test("output_binary handles large bigint seq above 2^32", () => {
    const seq = 0x0123_4567_89AB_CDEFn;
    const frame: Frame = {
      kind: FRAME_KIND_OUTPUT_BINARY,
      value: { sessionId: SAMPLE_UUID, seq, data: new Uint8Array([1, 2, 3]) },
    };
    const parser = new FrameParser();
    parser.push(encodeFrame(frame));
    const [out] = parser.drain();
    if (out.kind !== FRAME_KIND_OUTPUT_BINARY) throw new Error("kind mismatch");
    expect(out.value.seq).toBe(seq);
  });

  test("input_binary", () => {
    const data = new Uint8Array([0x03]); // ^C
    const frame: Frame = {
      kind: FRAME_KIND_INPUT_BINARY,
      value: { sessionId: NIL_UUID, data },
    };
    const parser = new FrameParser();
    parser.push(encodeFrame(frame));
    const [out] = parser.drain();
    if (out.kind !== FRAME_KIND_INPUT_BINARY) throw new Error("kind mismatch");
    expect(out.value.sessionId).toBe(NIL_UUID);
    expect(arraysEqual(out.value.data, data)).toBe(true);
  });
});

describe("wire-byte fixtures (catches endianness/layout drift vs Rust)", () => {
  test("control_request bytes layout", () => {
    const value = { id: 1, method: "list_sessions", params: {} };
    const bytes = encodeFrame({ kind: FRAME_KIND_CONTROL_REQUEST, value });
    const json = new TextEncoder().encode(JSON.stringify(value));
    const len = json.length;
    expect(bytes[0]).toBe(0x01);
    // big-endian u32 length
    expect(bytes[1]).toBe((len >>> 24) & 0xff);
    expect(bytes[2]).toBe((len >>> 16) & 0xff);
    expect(bytes[3]).toBe((len >>> 8) & 0xff);
    expect(bytes[4]).toBe(len & 0xff);
    expect(bytes.length).toBe(5 + len);
    // payload bytes match JSON.stringify exactly
    expect(arraysEqual(bytes.subarray(5), json)).toBe(true);
  });

  test("output_binary header layout: 16-byte uuid + 8-byte BE seq + bytes", () => {
    const data = new Uint8Array([0xAA, 0xBB, 0xCC]);
    const seq = 0x0011_2233_4455_6677n;
    const bytes = encodeFrame({
      kind: FRAME_KIND_OUTPUT_BINARY,
      value: { sessionId: SAMPLE_UUID, seq, data },
    });
    const payloadLen = 16 + 8 + data.length;
    expect(bytes[0]).toBe(0x03);
    expect(bytes[1]).toBe(0);
    expect(bytes[2]).toBe(0);
    expect(bytes[3]).toBe(0);
    expect(bytes[4]).toBe(payloadLen);
    // uuid bytes — 0x550e8400e29b41d4a716446655440000
    const expectedUuid = new Uint8Array([
      0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4,
      0xa7, 0x16, 0x44, 0x66, 0x55, 0x44, 0x00, 0x00,
    ]);
    expect(arraysEqual(bytes.subarray(5, 5 + 16), expectedUuid)).toBe(true);
    // seq big-endian
    const expectedSeq = new Uint8Array([
      0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
    ]);
    expect(arraysEqual(bytes.subarray(5 + 16, 5 + 24), expectedSeq)).toBe(true);
    // raw data
    expect(arraysEqual(bytes.subarray(5 + 24), data)).toBe(true);
  });

  test("input_binary header layout: 16-byte uuid + bytes (no seq)", () => {
    const data = new Uint8Array([0x0d]); // CR
    const bytes = encodeFrame({
      kind: FRAME_KIND_INPUT_BINARY,
      value: { sessionId: NIL_UUID, data },
    });
    expect(bytes[0]).toBe(0x04);
    expect(bytes[4]).toBe(16 + data.length);
    // 16 zero bytes for nil uuid
    for (let i = 0; i < 16; i++) expect(bytes[5 + i]).toBe(0);
    expect(bytes[5 + 16]).toBe(0x0d);
  });

  test("event bytes are JSON kind 0x05", () => {
    const value = { event: "snapshot_invalidated", session_id: NIL_UUID };
    const bytes = encodeFrame({ kind: FRAME_KIND_EVENT, value });
    const json = new TextEncoder().encode(JSON.stringify(value));
    expect(bytes[0]).toBe(0x05);
    expect(bytes.length).toBe(5 + json.length);
    expect(arraysEqual(bytes.subarray(5), json)).toBe(true);
  });
});

describe("rejection paths", () => {
  test("rejects unknown kind via decodeFrame", () => {
    expect(() => decodeFrame(0xff, new Uint8Array(0))).toThrow(CodecError);
  });

  test("rejects unknown kind via streaming parser", () => {
    const buf = new Uint8Array([0xff, 0, 0, 0, 0]);
    const parser = new FrameParser();
    parser.push(buf);
    expect(() => parser.drain()).toThrow(CodecError);
  });

  test("rejects short output_binary payload", () => {
    // Declare a 10-byte payload but the binary header demands ≥24
    const buf = new Uint8Array([
      FRAME_KIND_OUTPUT_BINARY,
      0,
      0,
      0,
      10,
      // 10 zero payload bytes
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const parser = new FrameParser();
    parser.push(buf);
    let err: unknown;
    try {
      parser.drain();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodecError);
    expect((err as CodecError).code).toBe("short_binary");
  });

  test("rejects short input_binary payload", () => {
    const buf = new Uint8Array([FRAME_KIND_INPUT_BINARY, 0, 0, 0, 5, 0, 0, 0, 0, 0]);
    const parser = new FrameParser();
    parser.push(buf);
    expect(() => parser.drain()).toThrow(CodecError);
  });

  test("rejects oversized declared length", () => {
    // 128 MiB declared, exceeds 64 MiB cap
    const buf = new Uint8Array([FRAME_KIND_INPUT_BINARY, 0x08, 0x00, 0x00, 0x00]);
    const parser = new FrameParser();
    parser.push(buf);
    let err: unknown;
    try {
      parser.drain();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodecError);
    expect((err as CodecError).code).toBe("frame_too_large");
  });

  test("rejects oversized encode body", () => {
    const huge = new Uint8Array(MAX_FRAME_PAYLOAD + 1);
    expect(() =>
      encodeFrame({
        kind: FRAME_KIND_INPUT_BINARY,
        value: { sessionId: NIL_UUID, data: huge },
      }),
    ).toThrow(CodecError);
  });

  test("rejects malformed json payload", () => {
    // Hand-crafted control_request frame with non-JSON body
    const body = new TextEncoder().encode("{not json");
    const head = new Uint8Array([
      FRAME_KIND_CONTROL_REQUEST,
      0,
      0,
      0,
      body.length,
    ]);
    const parser = new FrameParser();
    parser.push(concat(head, body));
    let err: unknown;
    try {
      parser.drain();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodecError);
    expect((err as CodecError).code).toBe("json");
  });
});

describe("streaming parser — chunk-boundary robustness", () => {
  function makeBatch(): { stream: Uint8Array; expected: Frame[] } {
    const expected: Frame[] = [
      {
        kind: FRAME_KIND_CONTROL_REQUEST,
        value: { id: 1, method: "subscribe", params: { session_id: SAMPLE_UUID } },
      },
      {
        kind: FRAME_KIND_CONTROL_RESPONSE,
        value: {
          id: 1,
          status: "ok",
          payload: { kind: "subscribe", ok: true, current_seq: 0 },
        },
      },
      {
        kind: FRAME_KIND_OUTPUT_BINARY,
        value: {
          sessionId: SAMPLE_UUID,
          seq: 1n,
          data: new Uint8Array([0x61, 0x62, 0x63]),
        },
      },
      {
        kind: FRAME_KIND_INPUT_BINARY,
        value: { sessionId: SAMPLE_UUID, data: new Uint8Array([0x0d]) },
      },
      {
        kind: FRAME_KIND_EVENT,
        value: { event: "snapshot_invalidated", session_id: SAMPLE_UUID },
      },
    ];
    const parts = expected.map(encodeFrame);
    return { stream: concat(...parts), expected };
  }

  test("multiple frames in one chunk", () => {
    const { stream, expected } = makeBatch();
    const parser = new FrameParser();
    parser.push(stream);
    const out = parser.drain();
    expect(out.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(out[i]).toEqual(expected[i]);
    }
  });

  test("one byte at a time emits identical frames", () => {
    const { stream, expected } = makeBatch();
    const parser = new FrameParser();
    const collected: Frame[] = [];
    for (let i = 0; i < stream.length; i++) {
      parser.push(stream.subarray(i, i + 1));
      const drained = parser.drain();
      for (const f of drained) collected.push(f);
    }
    expect(collected.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(collected[i]).toEqual(expected[i]);
    }
    expect(parser.hasPartial()).toBe(false);
  });

  test("pathological splits: mid-header, mid-payload", () => {
    const { stream, expected } = makeBatch();
    // pre-compute frame boundaries
    const splits = [1, 3, 4, 5, 10, 17, 25, 50, 80, 120].filter((s) => s < stream.length);
    for (const s of splits) {
      const parser = new FrameParser();
      const collected: Frame[] = [];
      parser.push(stream.subarray(0, s));
      for (const f of parser.drain()) collected.push(f);
      parser.push(stream.subarray(s));
      for (const f of parser.drain()) collected.push(f);
      expect(collected.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(collected[i]).toEqual(expected[i]);
      }
    }
  });

  test("retained data slices outlive subsequent chunk pushes", () => {
    // Issue: if the parser's internal buffer is reused, decoded frames'
    // .data subarray would point to bytes overwritten by the next push.
    // Our decoder copies into an owned Uint8Array, so retention is safe.
    const data = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const frame: Frame = {
      kind: FRAME_KIND_OUTPUT_BINARY,
      value: { sessionId: SAMPLE_UUID, seq: 5n, data },
    };
    const parser = new FrameParser();
    parser.push(encodeFrame(frame));
    const [decoded] = parser.drain();
    if (decoded.kind !== FRAME_KIND_OUTPUT_BINARY) throw new Error("kind mismatch");
    const retained = decoded.value.data;
    // Push a different output frame with overlapping data
    const noise: Frame = {
      kind: FRAME_KIND_OUTPUT_BINARY,
      value: {
        sessionId: SAMPLE_UUID,
        seq: 6n,
        data: new Uint8Array([0x00, 0x00, 0x00, 0x00]),
      },
    };
    parser.push(encodeFrame(noise));
    parser.drain();
    expect(arraysEqual(retained, data)).toBe(true);
  });
});

describe("header parser primitives", () => {
  test("FRAME_HEADER_BYTES is 5", () => {
    expect(FRAME_HEADER_BYTES).toBe(5);
  });

  test("hasPartial reflects buffered residue", () => {
    const parser = new FrameParser();
    expect(parser.hasPartial()).toBe(false);
    parser.push(new Uint8Array([FRAME_KIND_INPUT_BINARY, 0, 0, 0, 16]));
    expect(parser.hasPartial()).toBe(true);
    expect(parser.drain().length).toBe(0);
    expect(parser.hasPartial()).toBe(true);
  });
});
