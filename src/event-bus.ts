/**
 * In-process pub/sub for the live event stream. Synchronous fan-out, no
 * persistence: subscribers only see events published while subscribed.
 */
import { createLogger, errMsg } from "./log.js";
import {
  matchesEventFilter,
  type WolfpackEvent,
  type WolfpackEventBody,
  type WolfpackEventFilter,
} from "./events-contract.js";

const log = createLogger("server");

interface Subscriber {
  readonly filter: WolfpackEventFilter;
  readonly listener: (event: WolfpackEvent) => void;
}

export class EventBus {
  private readonly subscribers = new Set<Subscriber>();
  private nextEventId = 1;

  publishEvent(body: WolfpackEventBody): void {
    const event = { ...body, id: this.nextEventId++, at: new Date().toISOString() } as WolfpackEvent;
    for (const subscriber of Array.from(this.subscribers)) {
      if (!matchesEventFilter(event, subscriber.filter)) continue;
      try {
        subscriber.listener(event);
      } catch (error: unknown) {
        log.warn("event subscriber threw", { kind: event.kind, error: errMsg(error) });
      }
    }
  }

  subscribeEvents(filter: WolfpackEventFilter, listener: (event: WolfpackEvent) => void): () => void {
    const subscriber: Subscriber = { filter, listener };
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  eventSubscriberCount(): number {
    return this.subscribers.size;
  }


  reset(): void {
    this.subscribers.clear();
    this.nextEventId = 1;
  }
}

export let defaultEventBus = new EventBus();

/** Compatibility publishers follow the composition root's event bus. */
export function setDefaultEventBus(events: EventBus): void { defaultEventBus = events; }
export function publishEvent(body: WolfpackEventBody): void { defaultEventBus.publishEvent(body); }
export function subscribeEvents(filter: WolfpackEventFilter, listener: (event: WolfpackEvent) => void): () => void {
  return defaultEventBus.subscribeEvents(filter, listener);
}
export function eventSubscriberCount(): number { return defaultEventBus.eventSubscriberCount(); }
export function __resetEventBusForTests(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__resetEventBusForTests is test-only");
  defaultEventBus.reset();
}
