import { describe, expect, test } from "bun:test";
import { stripInitialPtyOverlap } from "../../src/server/pty-overlap.ts";

describe("PTY scrollback overlap stripping", () => {
  test("passes through attach output when no prefill was sent", () => {
    const result = stripInitialPtyOverlap(Buffer.alloc(0), Buffer.from("live output"));
    expect(result.awaitingMore).toBe(false);
    expect(result.data.toString()).toBe("live output");
  });

  test("waits for more data when attach bytes are fully duplicated so far", () => {
    const result = stripInitialPtyOverlap(
      Buffer.from("history\nvisible pane"),
      Buffer.from("visible pane"),
    );
    expect(result.awaitingMore).toBe(true);
    expect(result.data.length).toBe(0);
  });

  test("drops duplicated visible pane bytes once live output diverges", () => {
    const result = stripInitialPtyOverlap(
      Buffer.from("history\nvisible pane"),
      Buffer.from("visible pane\r\n$ "),
    );
    expect(result.awaitingMore).toBe(false);
    expect(result.data.toString()).toBe("\r\n$ ");
  });

  test("passes through attach output unchanged when there is no overlap", () => {
    const result = stripInitialPtyOverlap(
      Buffer.from("history\nvisible pane"),
      Buffer.from("fresh output"),
    );
    expect(result.awaitingMore).toBe(false);
    expect(result.data.toString()).toBe("fresh output");
  });
});
