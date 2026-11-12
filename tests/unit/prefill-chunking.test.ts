import { describe, expect, test } from "bun:test";


const { sendPrefillChunked, PREFILL_CHUNK_SIZE } = await import("../../src/server/websocket.ts");

/** Minimal mock WebSocket that records sent frames. */
function mockWs() {
  const frames: (Buffer | string)[] = [];
  return {
    frames,
    readyState: 1,
    send(data: Buffer | string) { frames.push(data); },
  };
}

describe("PTY prefill chunked delivery", () => {
  test("small prefill (< 32KB) is sent as a single chunk + prefill_done", async () => {
    const ws = mockWs();
    const entry = { viewer: ws as any, alive: true };
    const prefill = Buffer.alloc(1024, 0x41); // 1KB of 'A'

    await sendPrefillChunked(entry, prefill, "test-session");

    // 1 binary frame + 1 JSON prefill_done
    expect(ws.frames.length).toBe(2);
    expect(Buffer.isBuffer(ws.frames[0])).toBe(true);
    expect((ws.frames[0] as Buffer).length).toBe(1024);
    const done = JSON.parse(ws.frames[1] as string);
    expect(done.type).toBe("prefill_done");
  });

  test("large prefill is split into 32KB chunks + prefill_done", async () => {
    const ws = mockWs();
    const entry = { viewer: ws as any, alive: true };
    const size = PREFILL_CHUNK_SIZE * 3 + 100; // 3 full chunks + 100 byte remainder
    const prefill = Buffer.alloc(size, 0x42);

    await sendPrefillChunked(entry, prefill, "test-session");

    // 4 binary frames + 1 prefill_done
    expect(ws.frames.length).toBe(5);

    // Verify chunk sizes
    expect((ws.frames[0] as Buffer).length).toBe(PREFILL_CHUNK_SIZE);
    expect((ws.frames[1] as Buffer).length).toBe(PREFILL_CHUNK_SIZE);
    expect((ws.frames[2] as Buffer).length).toBe(PREFILL_CHUNK_SIZE);
    expect((ws.frames[3] as Buffer).length).toBe(100);

    // Verify concatenated chunks equal original prefill
    const reassembled = Buffer.concat(
      ws.frames.slice(0, 4).map(f => f as Buffer),
    );
    expect(reassembled.equals(prefill)).toBe(true);

    // Last frame is prefill_done
    const done = JSON.parse(ws.frames[4] as string);
    expect(done.type).toBe("prefill_done");
  });

  test("stops sending if entry becomes dead mid-delivery", async () => {
    const ws = mockWs();
    const entry = { viewer: ws as any, alive: true };
    const size = PREFILL_CHUNK_SIZE * 5;
    const prefill = Buffer.alloc(size, 0x43);

    // Kill entry after first send
    const origSend = ws.send.bind(ws);
    let sendCount = 0;
    ws.send = (data: Buffer | string) => {
      origSend(data);
      sendCount++;
      if (sendCount >= 2) entry.alive = false;
    };

    await sendPrefillChunked(entry, prefill, "test-session");

    // Should have stopped after 2 binary frames (no prefill_done)
    expect(ws.frames.length).toBe(2);
    expect(ws.frames.every(f => Buffer.isBuffer(f))).toBe(true);
  });

  test("empty prefill sends only prefill_done", async () => {
    const ws = mockWs();
    const entry = { viewer: ws as any, alive: true };

    await sendPrefillChunked(entry, Buffer.alloc(0), "test-session");

    expect(ws.frames.length).toBe(1);
    const done = JSON.parse(ws.frames[0] as string);
    expect(done.type).toBe("prefill_done");
  });

  test("returns false when entry dies mid-delivery (dedup must use viewport prefill)", async () => {
    const ws = mockWs();
    const entry = { viewer: ws as any, alive: true };
    const size = PREFILL_CHUNK_SIZE * 5;
    const prefill = Buffer.alloc(size, 0x43);

    const origSend = ws.send.bind(ws);
    let sendCount = 0;
    ws.send = (data: Buffer | string) => {
      origSend(data);
      sendCount++;
      if (sendCount >= 2) entry.alive = false;
    };

    // sendPrefillChunked must return false so the caller knows the full
    // scrollback was NOT delivered — dedup reference must stay as viewport
    // prefill, not full scrollback. See PR #89 review fix #5.
    const completed = await sendPrefillChunked(entry, prefill, "test-session");
    expect(completed).toBe(false);
  });

  test("returns true on successful full delivery", async () => {
    const ws = mockWs();
    const entry = { viewer: ws as any, alive: true };
    const prefill = Buffer.alloc(1024, 0x41);
    const completed = await sendPrefillChunked(entry, prefill, "test-session");
    expect(completed).toBe(true);
  });

  test("exactly 32KB prefill is sent as single chunk + prefill_done", async () => {
    const ws = mockWs();
    const entry = { viewer: ws as any, alive: true };
    const prefill = Buffer.alloc(PREFILL_CHUNK_SIZE, 0x44);

    await sendPrefillChunked(entry, prefill, "test-session");

    expect(ws.frames.length).toBe(2);
    expect((ws.frames[0] as Buffer).length).toBe(PREFILL_CHUNK_SIZE);
    const done = JSON.parse(ws.frames[1] as string);
    expect(done.type).toBe("prefill_done");
  });
});
