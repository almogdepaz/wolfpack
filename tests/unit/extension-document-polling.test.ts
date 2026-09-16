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
    await wait();
    expect(reads).toBe(1);
    expect(first[0]).toEqual([null, 0]);
    expect(second[0]).toEqual([null, 0]);
    release();
    await wait();
    expect(first.at(-1)).toEqual([{ safe: "text" }, 1]);
    expect(second.at(-1)).toEqual([{ safe: "text" }, 1]);
    unsubscribeFirst(); unsubscribeSecond(); poller.dispose();
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
