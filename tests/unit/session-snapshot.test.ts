import { describe, expect, test } from "bun:test";
import {
  SESSION_SNAPSHOT_MAX_ACTIVE,
  SESSION_SNAPSHOT_MAX_CACHED,
  SESSION_SNAPSHOT_MAX_TEXT_BYTES,
  SESSION_SNAPSHOT_REFRESH_MS,
  SessionSnapshotBusyError,
  SessionSnapshotService,
} from "../../src/server/session-snapshot.ts";

function capture(sessionId: string, text = "screen"): {
  readonly session: string;
  readonly sessionId: string;
  readonly text: string;
  readonly capturedAtMs: number;
  readonly cols: number;
  readonly rows: number;
} {
  return {
    session: "session",
    sessionId,
    text,
    capturedAtMs: 1_000,
    cols: 80,
    rows: 24,
  };
}

describe("SessionSnapshotService", () => {
  test("shares concurrent exact-ID work and labels a fresh cache reply", async () => {
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const service = new SessionSnapshotService(async (sessionId) => {
      calls++;
      await held;
      return capture(sessionId);
    }, () => 1_000);

    const first = service.read("00000000-0000-4000-8000-000000000001");
    const second = service.read("00000000-0000-4000-8000-000000000001");
    release();
    expect(await first).toMatchObject({ freshness: "fresh" });
    expect(await second).toMatchObject({ freshness: "fresh" });
    expect(calls).toBe(1);
    expect(await service.read("00000000-0000-4000-8000-000000000001")).toMatchObject({ freshness: "cached" });
  });

  test("rejects a distinct capture at the global permit limit until real work settles", async () => {
    const releases: Array<() => void> = [];
    const service = new SessionSnapshotService((sessionId) => new Promise((resolve) => {
      releases.push(() => resolve(capture(sessionId)));
    }));
    const active = Array.from({ length: SESSION_SNAPSHOT_MAX_ACTIVE }, (_, index) =>
      service.read(`00000000-0000-4000-8000-00000000000${index + 1}`),
    );
    await expect(service.read("00000000-0000-4000-8000-000000000009")).rejects.toBeInstanceOf(SessionSnapshotBusyError);
    for (const release of releases) release();
    await Promise.all(active);
  });

  test("expires stale entries and evicts the least-recently-used entry at the cache bound", async () => {
    let now = 1_000;
    let calls = 0;
    const service = new SessionSnapshotService(async (sessionId) => {
      calls++;
      return capture(sessionId);
    }, () => now);
    const firstId = "00000000-0000-4000-8000-000000000001";
    await service.read(firstId);
    now += SESSION_SNAPSHOT_REFRESH_MS;
    expect(await service.read(firstId)).toMatchObject({ freshness: "fresh" });
    expect(calls).toBe(2);

    for (let index = 0; index <= SESSION_SNAPSHOT_MAX_CACHED; index++) {
      await service.read(`00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`);
    }
    const beforeReload = calls;
    expect(await service.read(firstId)).toMatchObject({ freshness: "fresh" });
    expect(calls).toBe(beforeReload + 1);
  });

  test("releases an active permit when capture fails so another exact ID can retry", async () => {
    const service = new SessionSnapshotService(async (sessionId) => {
      if (sessionId.endsWith("001")) throw new Error("capture failed");
      return capture(sessionId);
    });
    await expect(service.read("00000000-0000-4000-8000-000000000001")).rejects.toThrow("capture failed");
    await expect(service.read("00000000-0000-4000-0000-000000000002")).resolves.toMatchObject({
      sessionId: "00000000-0000-4000-0000-000000000002",
    });
  });

  test("truncates UTF-8 only at a character boundary and labels the result", async () => {
    const text = "a".repeat(SESSION_SNAPSHOT_MAX_TEXT_BYTES - 1) + "🙂";
    const service = new SessionSnapshotService(async (sessionId) => capture(sessionId, text));
    const snapshot = await service.read("00000000-0000-4000-8000-000000000001");
    expect(snapshot.truncated).toBe(true);
    expect(Buffer.byteLength(snapshot.text, "utf8")).toBeLessThanOrEqual(SESSION_SNAPSHOT_MAX_TEXT_BYTES);
    expect(snapshot.text).not.toContain("�");
  });
});
