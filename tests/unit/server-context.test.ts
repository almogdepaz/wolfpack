
import { describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { EventBus } from "../../src/event-bus.ts";
import { WOLFPACK_EVENT_KIND } from "../../src/events-contract.ts";
import { createServerContext } from "../../src/server/context.ts";
import { MockBackend } from "../../src/server/mock-backend.ts";
// Set test mode before loading the auto-starting server entrypoint.
const { createServerInstance } = await import("../../src/server/index.ts");

const created = { kind: WOLFPACK_EVENT_KIND.SESSION_CREATED, sessionId: "test-id", session: "session", cwd: "/tmp" } as const;

describe("explicit server context", () => {
  test("explicitly stopped construction does not start a broker supervisor", () => {
    const ctx = createServerContext({ startSupervisor: false });
    expect(ctx.supervisor).toBeDefined();
    expect(ctx.supervisor!.backend()).toBeNull();
    expect(ctx.supervisor!.isBrokerAvailable()).toBe(false);
  });
  test("event buses own their subscriptions and event sequences", () => {
    const first = new EventBus(), second = new EventBus();
    const seen: number[] = [];
    first.subscribeEvents({}, event => seen.push(event.id));
    second.publishEvent(created);
    first.publishEvent(created);
    expect(seen).toEqual([1]);
    expect(first.eventSubscriberCount()).toBe(1);
    expect(second.eventSubscriberCount()).toBe(0);
  });

  test("HTTP factories keep independently owned backends isolated", async () => {
    const legacy = new MockBackend({ sessions: ["legacy"] });
    const legacyContext = createServerContext({ backend: legacy });
    const servers = ["first", "second"].map(name => createServerInstance(createServerContext({
      backend: new MockBackend({ sessions: [name], capturePane: async () => name }),
      events: new EventBus(), config: null,
    })).server);
    try {
      for (const [index, server] of servers.entries()) {
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const name = index === 0 ? "first" : "second";
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const response = await fetch(`${base}/api/session-control/read?session=${name}`);
        expect(response.status).toBe(200);
        expect((await response.json()).output).toBe(name);
        expect((await fetch(`${base}/api/poll?session=legacy`)).status).toBe(404);
      }
      expect(legacyContext.backend).toBe(legacy);
      expect(await legacyContext.backend.list()).toEqual(["legacy"]);
    } finally {
      await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      })));
    }
  });
});
