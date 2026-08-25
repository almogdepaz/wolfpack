import { describe, expect, test } from "bun:test";
import { buildPtyWebSocketUrl } from "../../public/pty-socket-client.ts";

describe("PTY WebSocket URL construction", () => {
  test("converts HTTPS origins to WSS and encodes sessions", () => {
    const url = new URL(buildPtyWebSocketUrl({
      origin: "https://phone.example.ts.net/app",
      session: "alpha/beta session",
    }));

    expect(url.href).toBe("wss://phone.example.ts.net/ws/pty?session=alpha%2Fbeta+session");
    expect(url.searchParams.get("session")).toBe("alpha/beta session");
  });

  test("converts HTTP origins to WS and includes ticket/reset without token fallback", () => {
    const url = new URL(buildPtyWebSocketUrl({
      origin: "http://127.0.0.1:18790",
      session: "shell",
      ticket: "ticket-123",
      reset: true,
    }));

    expect(url.href).toBe("ws://127.0.0.1:18790/ws/pty?session=shell&ticket=ticket-123&reset=1");
    expect(url.searchParams.get("ticket")).toBe("ticket-123");
    expect(url.searchParams.get("reset")).toBe("1");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.searchParams.has("jwt")).toBe(false);
  });
});
