import { beforeEach, describe, expect, test } from "bun:test";
import { __clearWebSocketTickets, consumeWebSocketTicket, issueWebSocketTicket } from "../../src/server/ws-ticket";

beforeEach(() => __clearWebSocketTickets());

describe("one-time WebSocket tickets", () => {
  test("are bound to client and expire", () => {
    const { ticket, expiresInMs } = issueWebSocketTicket("127.0.0.1", 1_000);
    expect(expiresInMs).toBe(30_000);
    expect(consumeWebSocketTicket(ticket, "127.0.0.2", 1_001)).toBe(false);
    expect(consumeWebSocketTicket(ticket, "127.0.0.1", 1_002)).toBe(false);
    const second = issueWebSocketTicket("127.0.0.1", 2_000).ticket;
    expect(consumeWebSocketTicket(second, "127.0.0.1", 32_000)).toBe(false);
  });

  test("can be consumed exactly once", () => {
    const { ticket } = issueWebSocketTicket("local", 5_000);
    expect(consumeWebSocketTicket(ticket, "local", 5_001)).toBe(true);
    expect(consumeWebSocketTicket(ticket, "local", 5_002)).toBe(false);
  });
});
