import { describe, expect, test } from "bun:test";
import { createReconnectBanner } from "../../public/reconnect-banner";
import { RECONNECT_CAUSE, type ReconnectStatus } from "../../src/connection-status";

class FakeNode {
  textContent = "";
  readonly attributes: Record<string, string> = {};
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
}

class FakeBanner {
  readonly dataset: Record<string, string | undefined> = { connState: "reconnecting" };
  children: Array<FakeNode | string> = [];
  replacements = 0;
  replaceChildren(...nodes: Array<FakeNode | string>): void {
    this.children = nodes;
    this.replacements++;
  }
  visibleText(): string {
    return this.children.map((child) => typeof child === "string" ? child : child.textContent).join("");
  }
  accessibleText(): string {
    return this.children
      .filter((child) => typeof child === "string" || child.attributes["aria-hidden"] !== "true")
      .map((child) => typeof child === "string" ? child : child.textContent)
      .join("");
  }
}

function harness() {
  let now = 8_000;
  let tick: (() => void) | null = null;
  const element = new FakeBanner();
  let current: string | null = "a";
  const banner = createReconnectBanner<string>({
    getElement: () => element as never,
    isCurrentOwner: (owner) => owner === current,
    createIcon: () => new FakeNode("img") as never,
    createCountdown: () => new FakeNode("span") as never,
    runtime: {
      now: () => now,
      setInterval: (callback) => { tick = callback; return 1; },
      clearInterval: () => { tick = null; },
    },
  });
  return {
    banner,
    element,
    advance(ms: number) { now += ms; tick?.(); },
    get ticking() { return tick !== null; },
    switchTo(owner: string | null) { current = owner; },
  };
}

const status = (overrides: Partial<ReconnectStatus> = {}): ReconnectStatus => ({
  cause: RECONNECT_CAUSE.UNREACHABLE,
  attempt: 3,
  retryAt: 10_000,
  ...overrides,
});

describe("reconnect banner", () => {
  test("shows the full label but exposes only cause and attempt to assistive tech", () => {
    const h = harness();
    h.banner.show("a", status(), "sgt");
    expect(h.element.visibleText()).toBe("sgt unreachable (attempt 3, retry in 2s)");
    expect(h.element.accessibleText()).toBe("sgt unreachable (attempt 3)");
    expect(h.element.dataset.reconnectCause).toBe(RECONNECT_CAUSE.UNREACHABLE);
  });

  test("countdown ticks update only the hidden countdown node", () => {
    const h = harness();
    h.banner.show("a", status(), "sgt");
    h.advance(1_000);
    h.advance(1_000);
    h.advance(1_000);
    expect(h.element.visibleText()).toBe("sgt unreachable (attempt 3, connecting…)");
    expect(h.element.replacements).toBe(1);
  });

  test("a new cause or attempt rebuilds the announced text", () => {
    const h = harness();
    h.banner.show("a", status(), "sgt");
    h.banner.show("a", status({ attempt: 4, retryAt: 12_000 }), "sgt");
    expect(h.element.accessibleText()).toBe("sgt unreachable (attempt 4)");
    expect(h.element.replacements).toBe(2);
  });

  test("stops without rendering once its terminal is no longer current", () => {
    const h = harness();
    h.banner.show("a", status(), "sgt");
    h.switchTo("b");
    h.element.replaceChildren("reconnecting…");
    h.advance(1_000);
    expect(h.element.visibleText()).toBe("reconnecting…");
    expect(h.ticking).toBe(false);
  });

  test("stops once the banner leaves the reconnecting state", () => {
    const h = harness();
    h.banner.show("a", status(), "sgt");
    h.element.dataset.connState = "live";
    h.advance(1_000);
    expect(h.ticking).toBe(false);
  });

  test("stop clears its markers so the next outage starts fresh", () => {
    const h = harness();
    h.banner.show("a", status(), "sgt");
    h.banner.stop();
    expect(h.ticking).toBe(false);
    expect(h.element.dataset.reconnectLead).toBeUndefined();
    expect(h.element.dataset.reconnectCause).toBeUndefined();
    h.banner.show("a", status(), "sgt");
    expect(h.element.replacements).toBe(2);
  });
});
