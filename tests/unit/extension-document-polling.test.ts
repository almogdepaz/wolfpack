import { describe, expect, test } from "bun:test";
import { SharedDocumentPoller } from "../../public/extension-document-polling.ts";

const wait = () => new Promise(resolve => setTimeout(resolve, 0));

describe("SharedDocumentPoller", () => {
  test("coalesces subscribers, emits initial state, and never overlaps reads", async () => {
    let reads = 0;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const poller = new SharedDocumentPoller({
      intervalMs: 250,
      read: async () => { reads++; await pending; return { document: { safe: "text" }, revision: 1 }; },
    });
    const first: unknown[] = []; const second: unknown[] = [];
    const unsubscribeFirst = poller.subscribe((value, revision) => first.push([value, revision]));
    const unsubscribeSecond = poller.subscribe((value, revision) => second.push([value, revision]));
    const directRead = poller.readOnce();
    await wait();
    expect(reads).toBe(1);
    expect(first[0]).toEqual([null, 0]);
    expect(second[0]).toEqual([null, 0]);
    release();
    await wait();
    expect(first.at(-1)).toEqual([{ safe: "text" }, 1]);
    expect(second.at(-1)).toEqual([{ safe: "text" }, 1]);
    expect(await directRead).toEqual({ document: { safe: "text" }, revision: 1 });
    unsubscribeFirst(); unsubscribeSecond(); poller.dispose();
  });

  test("treats repeated subscriptions of the same listener as independent consumers", async () => {
    let reads = 0;
    const values: number[] = [];
    const listener = (_document: unknown, revision: number) => values.push(revision);
    const poller = new SharedDocumentPoller({ intervalMs: 250, read: async () => ({ document: {}, revision: ++reads }) });
    const releaseFirst = poller.subscribe(listener);
    const releaseSecond = poller.subscribe(listener);
    await wait(); await wait();
    expect(values).toEqual([0, 0, 1, 1]);
    releaseFirst();
    await new Promise(resolve => setTimeout(resolve, 280));
    expect(reads).toBe(2);
    expect(values.at(-1)).toBe(2);
    releaseSecond(); poller.dispose();
  });

  test("resumes a pending one-shot reader after a hidden key becomes visible", async () => {
    let reads = 0;
    const poller = new SharedDocumentPoller({
      intervalMs: 250,
      read: async () => ({ document: { reads: ++reads }, revision: reads }),
    });
    poller.setPaused(true);
    const pending = poller.readOnce();
    await wait();
    expect(reads).toBe(0);
    poller.setPaused(false);
    try {
      await wait();
      expect(reads).toBe(1);
      expect(await pending).toEqual({ document: { reads: 1 }, revision: 1 });
    } finally {
      poller.dispose();
      await pending.catch(() => {});
    }
  });

  test("aborting one reader leaves another reader and the shared fetch alive", async () => {
    let reads = 0;
    let resolveRead!: (value: { document: unknown; revision: number }) => void;
    const response = new Promise<{ document: unknown; revision: number }>(resolve => { resolveRead = resolve; });
    const poller = new SharedDocumentPoller({ intervalMs: 250, read: async () => { reads++; return response; } });
    const firstController = new AbortController();
    const first = poller.readOnce(firstController.signal);
    const second = poller.readOnce();
    await wait();
    expect(reads).toBe(1);
    firstController.abort();
    resolveRead({ document: { current: true }, revision: 2 });
    expect(await first.then(() => "resolved", error => (error as Error).message)).toBe("stale extension scope");
    expect(await second).toEqual({ document: { current: true }, revision: 2 });
    poller.dispose();
  });

  test("aborts an in-flight read when visibility pauses the exact document key", async () => {
    let aborts = 0;
    const poller = new SharedDocumentPoller({
      intervalMs: 250,
      read: signal => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborts++; reject(new Error("aborted")); }, { once: true })),
    });
    const unsubscribe = poller.subscribe(() => {});
    await wait();
    poller.setPaused(true);
    await wait();
    expect(aborts).toBe(1);
    unsubscribe();
    poller.dispose();
  });

  test("does not let a lower revision replace the last good document", async () => {
    let reads = 0;
    const values: unknown[] = [];
    const poller = new SharedDocumentPoller({
      intervalMs: 250,
      read: async () => ++reads === 1
        ? { document: { revision: 2 }, revision: 2 }
        : { document: { revision: 1 }, revision: 1 },
    });
    const unsubscribe = poller.subscribe((document, revision) => values.push([document, revision]));
    await new Promise(resolve => setTimeout(resolve, 280));
    expect(reads).toBe(2);
    expect(values.at(-1)).toEqual([{ revision: 2 }, 2]);
    unsubscribe(); poller.dispose();
  });

  test("pauses hidden work and keeps the last good revision stale after an error", async () => {
    const states: string[] = [];
    let fail = false;
    const poller = new SharedDocumentPoller({
      intervalMs: 250,
      onState: state => states.push(state),
      read: async () => { if (fail) throw new Error("offline"); return { document: { revision: 1 }, revision: 1 }; },
    });
    const unsubscribe = poller.subscribe(() => {});
    await wait(); await wait();
    poller.setPaused(true);
    expect(states).toContain("paused");
    fail = true;
    poller.setPaused(false);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(states).toContain("stale");
    unsubscribe(); poller.dispose();
  });
});
