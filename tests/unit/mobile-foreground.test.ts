import { expect, test } from "bun:test";
import { mobileForegroundAction, MOBILE_STALE_THRESHOLD_MS, MOBILE_FOREGROUND_PROBE_MS } from "../../src/mobile-foreground";

test("short mobile foreground probes an open socket, not a closed socket", () => {
  expect(mobileForegroundAction(true, 1_000)).toBe("probe");
  expect(mobileForegroundAction(false, 1_000)).toBe("reconnect");
  expect(MOBILE_FOREGROUND_PROBE_MS).toBe(400);
});

test("long suspension reconnects even an open socket at the threshold", () => {
  expect(mobileForegroundAction(true, MOBILE_STALE_THRESHOLD_MS - 1)).toBe("probe");
  expect(mobileForegroundAction(true, MOBILE_STALE_THRESHOLD_MS)).toBe("reconnect");
  expect(mobileForegroundAction(false, MOBILE_STALE_THRESHOLD_MS)).toBe("reconnect");
});
