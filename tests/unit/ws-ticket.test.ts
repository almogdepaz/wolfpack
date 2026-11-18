import { beforeEach, describe, expect, test } from "bun:test";
import { createWebSocketTickets } from "../../src/server/ws-ticket";
let service = createWebSocketTickets();

beforeEach(() => service = createWebSocketTickets());

describe("one-time WebSocket tickets", () => {
  test("are bound to client and expire", () => {
    const { ticket, expiresInMs } = service.issueWebSocketTicket("127.0.0.1", 1_000);
    expect(expiresInMs).toBe(30_000);
    expect(service.consumeWebSocketTicket(ticket, "127.0.0.2", 1_001)).toBe(false);
    expect(service.consumeWebSocketTicket(ticket, "127.0.0.1", 1_002)).toBe(false);
    const second = service.issueWebSocketTicket("127.0.0.1", 2_000).ticket;
    expect(service.consumeWebSocketTicket(second, "127.0.0.1", 32_000)).toBe(false);
  });

  test("can be consumed exactly once", () => {
    const { ticket } = service.issueWebSocketTicket("local", 5_000);
    expect(service.consumeWebSocketTicket(ticket, "local", 5_001)).toBe(true);
    expect(service.consumeWebSocketTicket(ticket, "local", 5_002)).toBe(false);
  });
});
