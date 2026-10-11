/**
 * In-process pub/sub for the live event stream. Synchronous fan-out, no
 * persistence: subscribers only see events published while subscribed.
 */
import { createLogger, errMsg } from "../log.js";
import {
  matchesEventFilter,
  type WolfpackEvent,
  type WolfpackEventBody,
  type WolfpackEventFilter,
} from "../events-contract.js";

const log = createLogger("server");

interface Subscriber {
  readonly filter: WolfpackEventFilter;
  readonly listener: (event: WolfpackEvent) => void;
}

const subscribers = new Set<Subscriber>();
let nextEventId = 1;

export function publishEvent(body: WolfpackEventBody): void {
  const event = { ...body, id: nextEventId++, at: new Date().toISOString() } as WolfpackEvent;
  for (const subscriber of Array.from(subscribers)) {
    if (!matchesEventFilter(event, subscriber.filter)) continue;
    try {
      subscriber.listener(event);
    } catch (error: unknown) {
      log.warn("event subscriber threw", { kind: event.kind, error: errMsg(error) });
    }
  }
}

export function subscribeEvents(filter: WolfpackEventFilter, listener: (event: WolfpackEvent) => void): () => void {
  const subscriber: Subscriber = { filter, listener };
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function eventSubscriberCount(): number {
  return subscribers.size;
}

export function __resetEventBusForTests(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__resetEventBusForTests is test-only");
  subscribers.clear();
  nextEventId = 1;
}
