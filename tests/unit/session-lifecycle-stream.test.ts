import { describe, expect, test } from "bun:test";
import { startSessionLifecycleStream } from "../../public/session-lifecycle-stream.ts";

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(status = 200) {
  const timers: { callback: () => void; ms: number; active: boolean }[] = [];
  const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  const signals: AbortSignal[] = [];
  const urls: string[] = [];
  const errors: unknown[] = [];
  let snapshots = 0;
  const stop = startSessionLifecycleStream({
    origin: "https://peer.example.ts.net",
    fetch: async (url, init) => {
      urls.push(String(url));
      signals.push(init!.signal!);
      expect(init).toMatchObject({ cache: "no-store", redirect: "error", credentials: "omit" });
      return new Response(new ReadableStream({ start(controller) { bodies.push(controller); } }), {
        status, headers: { "Content-Type": status === 200 ? "text/event-stream" : "application/json" },
      });
    },
    reconcile: () => { snapshots++; },
    onError: error => { errors.push(error); },
    setTimeout: (callback, ms) => { const timer = { callback, ms, active: true }; timers.push(timer); return timer; },
    clearTimeout: timer => { (timer as typeof timers[number]).active = false; },
  });
  return {
    stop, bodies, signals, urls, errors,
    get snapshots() { return snapshots; },
    activeTimers: () => timers.filter(timer => timer.active),
    fire(ms: number) {
      const timer = timers.find(timer => timer.active && timer.ms === ms);
      expect(timer).toBeDefined();
      timer!.active = false;
      timer!.callback();
    },
    send(text: string) { bodies.at(-1)!.enqueue(new TextEncoder().encode(text)); },
  };
}

describe("browser lifecycle stream repair", () => {
  test("subscribes before snapshot and parses fragmented lifecycle frames without treating other events as truth", async () => {
    const f = fixture();
    try {
      expect(f.snapshots).toBe(0);
      await settle();
      expect(f.snapshots).toBe(1);
      expect(new URL(f.urls[0]!).searchParams.get("kinds")).toBe("session.created,session.exited");
      f.send(': ping\r\n\r\ndata: {"kind":"session.cre');
      await settle();
      expect(f.snapshots).toBe(1);
      f.send('ated","sessionId":"first"}\r\n\r\n');
      await settle();
      expect(f.snapshots).toBe(2);
      f.send('data: {"kind":"task.updated"}\n\ndata: {"kind":"session.exited","sessionId":"first"}\n\n');
      await settle();
      expect(f.snapshots).toBe(3);
      expect(f.activeTimers().map(timer => timer.ms)).toEqual([45_000]);
    } finally { f.stop(); }
  });

  test("disconnect/reconnect snapshots repair the live-only gap, and stop cancels all ownership", async () => {
    const f = fixture();
    await settle();
    f.bodies[0]!.close();
    await settle();
    expect(f.activeTimers().map(timer => timer.ms)).toEqual([2_000]);
    f.fire(2_000);
    await settle();
    expect(f.snapshots).toBe(2);
    f.stop();
    await settle();
    expect(f.signals.every(signal => signal.aborted)).toBe(true);
    expect(f.activeTimers()).toEqual([]);
  });

  test("401 is noninteractive with capped reconnect delays, never an unbounded retry loop", async () => {
    const f = fixture(401);
    try {
      await settle();
      for (const delay of [2_000, 5_000, 10_000, 30_000, 30_000]) {
        expect(f.activeTimers().map(timer => timer.ms)).toEqual([delay]);
        f.fire(delay);
        await settle();
      }
      expect(f.snapshots).toBe(0);
      expect(f.errors).toHaveLength(6);
    } finally { f.stop(); }
  });

  for (const payload of ['data: not-json\n\n', "x".repeat(64 * 1024 + 1)]) {
    test(`bounds malformed/oversized stream data (${payload.length} characters)`, async () => {
      const f = fixture();
      try {
        await settle();
        f.send(payload);
        await settle();
        expect(f.errors).toHaveLength(1);
        expect(f.snapshots).toBe(1);
        expect(f.signals[0]!.aborted).toBe(true);
        expect(f.activeTimers().map(timer => timer.ms)).toEqual([2_000]);
      } finally { f.stop(); }
    });
  }

  test("missing heartbeats close zombie streams for snapshot repair", async () => {
    const f = fixture();
    try {
      await settle();
      f.fire(45_000);
      await settle();
      expect(f.errors).toHaveLength(1);
      expect(f.errors[0]).toMatchObject({ name: "TimeoutError" });
      expect(f.signals[0]!.aborted).toBe(true);
      expect(f.activeTimers().map(timer => timer.ms)).toEqual([2_000]);
      f.fire(2_000);
      await settle();
      expect(f.snapshots).toBe(2);
    } finally { f.stop(); }
  });
});
