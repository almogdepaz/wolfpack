import { describe, expect, test } from "bun:test";
import { sendMessageDraftAttempt } from "../../src/terminal-input.ts";

describe("message draft send attempt", () => {
  test("normalizes the wire payload and preserves the trimmed draft on failure", () => {
    const payloads: string[] = [];
    const result = sendMessageDraftAttempt("  run\nthis  ", (wireText) => {
      payloads.push(wireText);
      return false;
    });

    expect(payloads).toEqual(["run this\r"]);
    expect(result).toEqual({ sent: false, savedDraft: "run\nthis" });
  });

  test("reports success with the same saved draft for callers to clear", () => {
    const payloads: string[] = [];
    const result = sendMessageDraftAttempt("  echo ok  ", (wireText) => {
      payloads.push(wireText);
      return true;
    });

    expect(payloads).toEqual(["echo ok\r"]);
    expect(result).toEqual({ sent: true, savedDraft: "echo ok" });
  });
});
