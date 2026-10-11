process.env.WOLFPACK_TEST = "1";

import { beforeEach, describe, expect, test } from "bun:test";
import {
  __resetEventBusForTests,
  eventSubscriberCount,
  publishEvent,
  subscribeEvents,
} from "../../src/server/event-bus";
import { WOLFPACK_EVENT_KIND, type WolfpackEvent } from "../../src/events-contract";

beforeEach(() => __resetEventBusForTests());

const created = {
  kind: WOLFPACK_EVENT_KIND.SESSION_CREATED,
  sessionId: "11111111-1111-1111-1111-111111111111",
  session: "wolf-1",
  cwd: "/tmp",
} as const;

describe("event bus", () => {
  test("delivers published events with a monotonic id and timestamp", () => {
    const seen: WolfpackEvent[] = [];
    subscribeEvents({}, (event) => seen.push(event));
    publishEvent(created);
    publishEvent({ ...created, session: "wolf-2" });
    expect(seen.map((event) => event.id)).toEqual([1, 2]);
    expect(seen[0]).toMatchObject(created);
    expect(Number.isNaN(Date.parse(seen[0]!.at))).toBe(false);
  });

  test("applies the subscriber filter", () => {
    const seen: WolfpackEvent[] = [];
    subscribeEvents({ session: "wolf-2" }, (event) => seen.push(event));
    publishEvent(created);
    publishEvent({ ...created, session: "wolf-2" });
    expect(seen.map((event) => event.kind === "session.created" && event.session)).toEqual(["wolf-2"]);
  });

  test("unsubscribe is idempotent and updates the subscriber count", () => {
    const unsubscribe = subscribeEvents({}, () => undefined);
    expect(eventSubscriberCount()).toBe(1);
    unsubscribe();
    unsubscribe();
    expect(eventSubscriberCount()).toBe(0);
  });

  test("a throwing subscriber does not stop fan-out", () => {
    const seen: number[] = [];
    subscribeEvents({}, () => { throw new Error("boom"); });
    subscribeEvents({}, (event) => seen.push(event.id));
    expect(() => publishEvent(created)).not.toThrow();
    expect(seen).toEqual([1]);
  });

  test("publishing with no subscribers is a no-op that still advances ids", () => {
    publishEvent(created);
    const seen: number[] = [];
    subscribeEvents({}, (event) => seen.push(event.id));
    publishEvent(created);
    expect(seen).toEqual([2]);
  });
});
