process.env.WOLFPACK_TEST = "1";
import { expect, test, spyOn } from "bun:test";
import { BrokerSupervisor } from "../../src/server/broker-supervisor";
import { MockBackend } from "../../src/server/mock-backend";
import { createServerContext } from "../../src/server/context";

// The proxy object survives broker replacement; attribution must not.
test("context retires attribution, pending reads and input history on backend replacement", async () => {
  const supervisor = new BrokerSupervisor({ start: false });
  const old = new MockBackend({ sessions: ["work"] });
  const broker = spyOn(supervisor, "backend").mockReturnValue(old as unknown as ReturnType<BrokerSupervisor["backend"]>);
  const ctx = createServerContext({ supervisor, config: null });
  const proxy = ctx.backend;
  const tracker = ctx.viewerRedraw;
  const fact = (await ctx.backend.listSessionFacts())[0]!;
  tracker.prune([fact]);
  tracker.begin("work");
  expect(tracker.includes(fact)).toBe(true);
  broker.mockReturnValue(new MockBackend({ sessions: ["work"] }) as unknown as ReturnType<BrokerSupervisor["backend"]>);
  expect(ctx.backend).toBe(proxy);
  expect(ctx.viewerRedraw).not.toBe(tracker);
  expect(tracker.includes(fact)).toBe(false);
  expect(ctx.viewerRedraw.includes(fact)).toBe(false);
  await ctx.close();
  broker.mockRestore();
});
