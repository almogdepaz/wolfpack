import { describe, expect, test } from "bun:test";
import { createTerminalLiveGate } from "../../public/terminal-bootstrap";

describe("terminal live gate", () => {
  test("marks desktop live once per hydration cycle", () => {
    const transitions: string[] = [];
    const gate = createTerminalLiveGate({
      waitForPostMount: false,
      onLive: () => transitions.push("live"),
    });

    gate.onHydrated();
    gate.onHydrated();
    expect(transitions).toEqual(["live"]);

    gate.onHydrationStart();
    gate.onHydrated();
    expect(transitions).toEqual(["live", "live"]);
  });

  test("waits for both mobile hydration and post-mount readiness", () => {
    const hydrationFirstTransitions: string[] = [];
    const hydrationFirst = createTerminalLiveGate({
      waitForPostMount: true,
      onLive: () => hydrationFirstTransitions.push("live"),
    });
    hydrationFirst.onHydrated();
    expect(hydrationFirstTransitions).toEqual([]);
    hydrationFirst.onPostMountReady();
    expect(hydrationFirstTransitions).toEqual(["live"]);

    const postMountFirstTransitions: string[] = [];
    const postMountFirst = createTerminalLiveGate({
      waitForPostMount: true,
      onLive: () => postMountFirstTransitions.push("live"),
    });
    postMountFirst.onPostMountReady();
    expect(postMountFirstTransitions).toEqual([]);
    postMountFirst.onHydrated();
    expect(postMountFirstTransitions).toEqual(["live"]);
  });
});
