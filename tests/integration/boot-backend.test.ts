/**
 * Verify bootTestServer works with the broker backend (the only supported
 * backend post-S6). Ensures MockBackend integration end-to-end.
 */
import { describe, test, expect } from "bun:test";
import {
  bootTestServer,
  connectPty,
  waitForMessage,
  closeWs,
  wait,
} from "./pty-test-helpers";

describe("bootTestServer backendType=broker", () => {
    test("boots server, connects WS, receives attach_ack", async () => {
      const ctx = await bootTestServer({
        sessions: ["test-session"],
        capturePane: async () => "$ mock-prompt\n",
        backendType: "broker",
      });

      try {
        expect(ctx.port).toBeGreaterThan(0);
        expect(ctx.baseWsUrl).toContain("ws://");

        const ws = await connectPty(ctx.baseWsUrl, "test-session");
        const ackPromise = waitForMessage(ws, "attach_ack", 3000);
        ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
        const msg = await ackPromise;
        expect(msg.type).toBe("attach_ack");
        await closeWs(ws);
        await wait(50);
      } finally {
        ctx.cleanup();
      }
    });
});
