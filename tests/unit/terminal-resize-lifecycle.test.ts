import { describe, expect, test } from "bun:test";
import {
  createTerminalResizeLifecycle,
  type TerminalResizeLifecycleScheduler,
} from "../../public/terminal-resize-lifecycle.ts";
import { TERMINAL_PREFILL_MODE } from "../../src/terminal-prefill.ts";

class FakeScheduler implements TerminalResizeLifecycleScheduler {
  private nextId = 0;
  private readonly frames = new Map<number, () => void>();
  private readonly timers = new Map<number, () => void>();

  requestFrame(callback: () => void): number {
    const id = this.nextId++;
    this.frames.set(id, callback);
    return id;
  }

  cancelFrame(id: number): void {
    this.frames.delete(id);
  }

  setTimeout(callback: () => void, _delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, callback);
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  runFrames(): void {
    const pending = [...this.frames.values()];
    this.frames.clear();
    for (const callback of pending) callback();
  }

  runTimers(): void {
    const pending = [...this.timers.values()];
    this.timers.clear();
    for (const callback of pending) callback();
  }
}

describe("terminal resize lifecycle", () => {
  test("ignores transient observer events and schedules one settled layout sync", () => {
    const scheduler = new FakeScheduler();
    let observerCallback: ((entries: readonly unknown[]) => void) | undefined;
    let observerDisconnected = false;
    const container = { clientWidth: 0, clientHeight: 24 };
    const syncCalls: unknown[] = [];
    const lifecycle = createTerminalResizeLifecycle({
      prefillMode: TERMINAL_PREFILL_MODE.FULL,
      getContainer: () => container,
      getTerm: () => ({ viewportY: 0, getScrollbackLength: () => 0 }),
      getPtyClient: () => null,
      shouldSuppressContainerResize: () => false,
      userRequestedScrollback: () => false,
      syncLayout: (options) => { syncCalls.push(options); },
      scheduler,
      createResizeObserver: (callback) => {
        observerCallback = callback;
        return { observe: () => {}, disconnect: () => { observerDisconnected = true; } };
      },
    });

    lifecycle.observe(container);
    observerCallback?.([{}]);
    scheduler.runFrames();
    expect(syncCalls).toEqual([]);

    container.clientWidth = 80;
    observerCallback?.([{}]);
    scheduler.runFrames();
    expect(syncCalls).toEqual([{ forceSend: true, repaint: true, reason: "container-resize" }]);

    lifecycle.dispose();
    expect(observerDisconnected).toBe(true);
  });

  test("rehydrates viewport scrollback through the debounced resize lifecycle", () => {
    const scheduler = new FakeScheduler();
    let observerCallback: ((entries: readonly unknown[]) => void) | undefined;
    let reconnects = 0;
    let lifecycle: ReturnType<typeof createTerminalResizeLifecycle>;
    const container = { clientWidth: 80, clientHeight: 24 };
    lifecycle = createTerminalResizeLifecycle({
      prefillMode: TERMINAL_PREFILL_MODE.VIEWPORT,
      getContainer: () => container,
      getTerm: () => ({ viewportY: 7, getScrollbackLength: () => 200 }),
      getPtyClient: () => ({ isOpen: true, reconnect: () => { reconnects++; } }),
      shouldSuppressContainerResize: () => false,
      userRequestedScrollback: () => true,
      syncLayout: () => lifecycle.scheduleResizeRehydrate(),
      scheduler,
      createResizeObserver: (callback) => {
        observerCallback = callback;
        return { observe: () => {}, disconnect: () => {} };
      },
    });

    lifecycle.observe(container);
    observerCallback?.([{}]);
    scheduler.runFrames();
    observerCallback?.([{}]);
    scheduler.runFrames();
    scheduler.runTimers();

    expect(reconnects).toBe(1);
    expect(lifecycle.takePendingScrollRestore()).toEqual({
      oldScrollbackLength: 200,
      oldViewportY: 7,
    });
  });

  test("debounces a full-prefill resize into one scrollback-preserving reconnect", () => {
    const scheduler = new FakeScheduler();
    let reconnects = 0;
    const lifecycle = createTerminalResizeLifecycle({
      prefillMode: TERMINAL_PREFILL_MODE.FULL,
      getContainer: () => ({ clientWidth: 80, clientHeight: 24 }),
      getTerm: () => ({ viewportY: 7, getScrollbackLength: () => 100 }),
      getPtyClient: () => ({ isOpen: true, reconnect: () => { reconnects++; } }),
      shouldSuppressContainerResize: () => false,
      userRequestedScrollback: () => true,
      syncLayout: () => {},
      scheduler,
      createResizeObserver: () => ({ observe: () => {}, disconnect: () => {} }),
    });

    lifecycle.scheduleResizeRehydrate();
    lifecycle.scheduleResizeRehydrate();
    scheduler.runTimers();

    expect(reconnects).toBe(1);
    expect(lifecycle.takePendingScrollRestore()).toEqual({
      oldScrollbackLength: 100,
      oldViewportY: 7,
    });
  });
});
