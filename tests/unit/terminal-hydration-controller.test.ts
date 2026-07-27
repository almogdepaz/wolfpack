import { describe, expect, test } from "bun:test";
import { createInitialHydrationController } from "../../public/terminal-hydration.ts";

class FakeClassList {
  readonly values = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) this.values.add(token);
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) this.values.delete(token);
  }
}

describe("initial terminal hydration", () => {
  test("reveals, scrolls, and focuses only after hydration finishes", async () => {
    const classList = new FakeClassList();
    classList.add("hydrating");
    let scrolled = false;
    let focused = false;
    const controller = createInitialHydrationController({
      getElement: () => ({ classList }),
      getTerm: () => ({
        scrollToBottom: () => { scrolled = true; },
        focus: () => { focused = true; },
      }),
      shouldFocus: () => true,
      scheduleFrame: (callback) => {
        callback(0);
        return 0;
      },
    });

    controller.start();
    expect(controller.pending).toBe(true);
    controller.forceFinish();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.pending).toBe(false);
    expect(scrolled).toBe(true);
    expect(focused).toBe(true);
    expect(classList.values).toEqual(new Set(["hydrated"]));
  });
});
