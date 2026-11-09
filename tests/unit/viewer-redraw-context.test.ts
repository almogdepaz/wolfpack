process.env.WOLFPACK_TEST = "1";
import { expect, test } from "bun:test";
import { BrokerSupervisor } from "../../src/server/broker-supervisor";
import { MockBackend } from "../../src/server/mock-backend";
import { createServerContext } from "../../src/server/context";

// The proxy object survives broker replacement; attribution must not.
test("context retires attribution, pending reads and input history on backend replacement", async () => {
  const supervisor = new BrokerSupervisor({ start: false });
  const old = new MockBackend({ sessions: ["work"] });
  supervisor.__setBrokerForTest(old);
  const ctx = createServerContext({ supervisor, config: null });
  const proxy = ctx.backend;
  const tracker = ctx.viewerRedraw;
  const fact = (await ctx.backend.listSessionFacts())[0]!;
  tracker.prune([fact]);
  tracker.begin("work");
  expect(tracker.includes(fact)).toBe(true);
  supervisor.__setBrokerForTest(new MockBackend({ sessions: ["work"] }));
  expect(ctx.backend).toBe(proxy);
  expect(ctx.viewerRedraw).not.toBe(tracker);
  expect(tracker.includes(fact)).toBe(false);
  expect(ctx.viewerRedraw.includes(fact)).toBe(false);
  ctx.viewerRedraw.clear();
});
