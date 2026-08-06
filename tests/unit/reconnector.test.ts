import { describe, expect, test } from "bun:test";
import {
  createReconnector,
  RECONNECT_BASE_DELAY_MS,
  type ReconnectorRuntime,
} from "../../public/reconnector";

class FakeRuntime implements ReconnectorRuntime {
  nowMs = 1_000;
  callback: (() => void) | null = null;
  delays: number[] = [];
  now = (): number => this.nowMs;
  random = (): number => 0;
  setTimer = (callback: () => void, delayMs: number): object => {
    this.callback = callback;
    this.delays.push(delayMs);
    return {};
  };
  clearTimer = (): void => { this.callback = null; };
  fire(): void {
    const callback = this.callback;
    this.callback = null;
    callback?.();
  }
}

describe("terminal reconnect backoff", () => {
  test("keeps exponential backoff until protocol readiness is declared", () => {
    const runtime = new FakeRuntime();
    const reconnector = createReconnector({}, runtime);

    reconnector.schedule(() => {});
    runtime.fire();
    reconnector.schedule(() => {});
    runtime.fire();

    expect(runtime.delays).toEqual([RECONNECT_BASE_DELAY_MS, 900]);
    expect(reconnector.connected()).toBe(true);

    reconnector.schedule(() => {});
    expect(runtime.delays.at(-1)).toBe(RECONNECT_BASE_DELAY_MS);
  });

  test("cancel and block prevent stale reconnect attempts", () => {
    const runtime = new FakeRuntime();
    const reconnector = createReconnector({}, runtime);
    let attempts = 0;

    reconnector.schedule(() => { attempts++; });
    reconnector.cancel();
    runtime.fire();
    reconnector.block();
    reconnector.schedule(() => { attempts++; });

    expect(attempts).toBe(0);
    expect(reconnector.pending).toBe(false);
    expect(reconnector.isBlocked).toBe(true);
  });
});
