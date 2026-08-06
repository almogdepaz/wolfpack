import { describe, expect, test } from "bun:test";
import {
  buildSessionNotificationUrl,
  parseSessionNotificationRoute,
} from "../../src/session-notification-route.js";

describe("session notification routes", () => {
  test("encodes stable session identity and local machine context without a URL", () => {
    expect(buildSessionNotificationUrl({
      sessionId: "broker:id/with spaces",
      sessionName: "agent one",
      machineIdentity: "local",
    })).toBe("/?sessionId=broker%3Aid%2Fwith+spaces&session=agent+one&machine=local");
  });

  test("round-trips a bounded remote machine identity without treating a URL as identity", () => {
    const machineIdentity = "node:2af8af29-c4fe-44f9-9a99-9a0e35952d74";
    const url = buildSessionNotificationUrl({
      sessionId: "broker-session-id",
      sessionName: "renamable label",
      machineIdentity,
    });

    expect(parseSessionNotificationRoute(new URL(url, "https://wolfpack.example").search)).toEqual({
      sessionId: "broker-session-id",
      sessionName: "renamable label",
      machineIdentity,
    });
  });

  test("rejects missing, empty, oversized, and URL machine identities", () => {
    expect(parseSessionNotificationRoute("?session=agent&machine=local")).toBeNull();
    expect(parseSessionNotificationRoute("?sessionId=&session=agent&machine=local")).toBeNull();
    expect(parseSessionNotificationRoute(`?sessionId=${"x".repeat(257)}&session=agent&machine=local`)).toBeNull();
    expect(parseSessionNotificationRoute("?sessionId=stable&session=agent&machine=https%3A%2F%2Fevil.example")).toBeNull();
  });
});
