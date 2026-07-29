import { describe, expect, test } from "bun:test";
import {
  buildSessionNotificationUrl,
  parseSessionNotificationRoute,
} from "../../src/session-notification-route.js";

describe("session notification routes", () => {
  test("encodes stable session identity and local machine context", () => {
    expect(buildSessionNotificationUrl({
      sessionId: "broker:id/with spaces",
      sessionName: "agent one",
      machineUrl: "",
    })).toBe("/?sessionId=broker%3Aid%2Fwith+spaces&session=agent+one&machine=local");
  });

  test("round-trips a known remote machine without treating the display name as identity", () => {
    const url = buildSessionNotificationUrl({
      sessionId: "broker-session-id",
      sessionName: "renamable label",
      machineUrl: "https://peer.tail.example",
    });

    expect(parseSessionNotificationRoute(new URL(url, "https://wolfpack.example").search)).toEqual({
      sessionId: "broker-session-id",
      sessionName: "renamable label",
      machineUrl: "https://peer.tail.example",
    });
  });

  test("rejects missing, empty, and oversized stable identities", () => {
    expect(parseSessionNotificationRoute("?session=agent&machine=local")).toBeNull();
    expect(parseSessionNotificationRoute("?sessionId=&session=agent&machine=local")).toBeNull();
    expect(parseSessionNotificationRoute(`?sessionId=${"x".repeat(257)}&session=agent&machine=local`)).toBeNull();
  });
});
