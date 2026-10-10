import type { DisconnectAction } from "../src/take-control-logic";
import type { TerminalLoadVisualState } from "./terminal-loading-ui";

/** Single-view terminals kept mounted on desktop so switching back to a
 * recent session is show/hide instead of attach + prefill + hydration. Each
 * entry holds a Ghostty WASM instance, a canvas and a PTY socket. */
export const TERMINAL_POOL_SIZE = 3;
/** Mobile keeps today's teardown-on-switch behavior for memory. */
export const MOBILE_TERMINAL_POOL_SIZE = 1;
/** The server allows one viewer per session, so a parked viewer blocks every
 * other device ("active on another device") while showing nothing here. The
 * lock is bounded by "recently and actively used": a parked entry is evicted
 * after this long, which keeps instant switch-back for active hopping. */
export const PARKED_TERMINAL_TTL_MS = 150_000;
/** While the page is hidden nobody is switching; release parked control soon
 * instead of holding it until the user returns. */
export const HIDDEN_PARKED_EVICT_MS = 30_000;

export interface TerminalPoolKey {
  readonly session: string;
  readonly machine: string;
}

export interface TerminalPoolOptions<T> {
  readonly capacity: () => number;
  /** Put the entry's host into the visible terminal container. */
  readonly attach: (entry: T) => void;
  /** Remove the entry's host from the document; it stays mounted and subscribed. */
  readonly detach: (entry: T) => void;
  /** Close the socket and dispose the terminal. */
  readonly dispose: (entry: T) => void;
}

export interface TerminalPoolOpenResult<T> {
  readonly entry: T;
  readonly hit: boolean;
}

export interface TerminalPool<T> {
  /** Show the pooled entry for `key`, or park the visible entry, make room and
   * create one. Never more than one entry is visible. */
  open(key: TerminalPoolKey, create: () => T): TerminalPoolOpenResult<T>;
  /** Hit-only open: show the pooled entry for `key`, or return null. */
  show(key: TerminalPoolKey): T | null;
  /** Hide the visible entry without disposing it. */
  park(): T | null;
  has(key: TerminalPoolKey): boolean;
  get(key: TerminalPoolKey): T | null;
  isVisible(entry: T): boolean;
  evict(key: TerminalPoolKey): boolean;
  /** Evict `entry` only if it is still the pooled entry for its key. */
  evictEntry(entry: T): boolean;
  /** Evict hidden entries of `machine`; the visible entry belongs to the single-view UI. */
  evictMachine(machine: string): number;
  evictHidden(): number;
  clear(): void;
  /** Most recently shown first. */
  keys(): TerminalPoolKey[];
  readonly visible: T | null;
  readonly size: number;
}

interface PoolSlot<T> {
  readonly key: TerminalPoolKey;
  readonly entry: T;
}

function sameKey(a: TerminalPoolKey, b: TerminalPoolKey): boolean {
  return a.session === b.session && a.machine === b.machine;
}

export function createTerminalPool<T>(options: TerminalPoolOptions<T>): TerminalPool<T> {
  // Most recently shown first.
  let slots: PoolSlot<T>[] = [];
  let visible: T | null = null;

  const indexOf = (key: TerminalPoolKey): number => slots.findIndex((slot) => sameKey(slot.key, key));

  function remove(index: number): void {
    const [slot] = slots.splice(index, 1);
    if (visible === slot.entry) visible = null;
    options.dispose(slot.entry);
  }

  function evictHiddenWhile(predicate: () => boolean): void {
    for (let index = slots.length - 1; index >= 0 && predicate(); index--) {
      if (slots[index].entry !== visible) remove(index);
    }
  }

  function park(): T | null {
    const parked = visible;
    if (parked === null) return null;
    visible = null;
    options.detach(parked);
    return parked;
  }

  function evictWhere(predicate: (slot: PoolSlot<T>) => boolean): number {
    const doomed = slots.filter(predicate);
    for (const slot of doomed) remove(slots.indexOf(slot));
    return doomed.length;
  }

  function show(key: TerminalPoolKey): T | null {
    const index = indexOf(key);
    if (index === -1) return null;
    const [slot] = slots.splice(index, 1);
    slots.unshift(slot);
    if (visible !== slot.entry) {
      park();
      visible = slot.entry;
      options.attach(slot.entry);
    }
    evictHiddenWhile(() => slots.length > Math.max(1, options.capacity()));
    return slot.entry;
  }

  return {
    open(key, create) {
      const shown = show(key);
      if (shown !== null) return { entry: shown, hit: true };
      park();
      // Make room before creating so a size-1 pool tears the old socket down
      // before the new one opens, exactly like the pre-pool switch.
      evictHiddenWhile(() => slots.length >= Math.max(1, options.capacity()));
      const entry = create();
      slots.unshift({ key, entry });
      visible = entry;
      options.attach(entry);
      return { entry, hit: false };
    },
    show,
    park,
    has: (key) => indexOf(key) !== -1,
    get(key) {
      const index = indexOf(key);
      return index === -1 ? null : slots[index].entry;
    },
    isVisible: (entry) => visible !== null && visible === entry,
    evict(key) {
      const index = indexOf(key);
      if (index === -1) return false;
      remove(index);
      return true;
    },
    evictEntry(entry) {
      const index = slots.findIndex((slot) => slot.entry === entry);
      if (index === -1) return false;
      remove(index);
      return true;
    },
    evictMachine: (machine) => evictWhere((slot) => slot.key.machine === machine && slot.entry !== visible),
    evictHidden: () => evictWhere((slot) => slot.entry !== visible),
    clear() {
      evictWhere(() => true);
    },
    keys: () => slots.map((slot) => slot.key),
    get visible() { return visible; },
    get size() { return slots.length; },
  };
}

export interface ParkedTerminalExpiryOptions<T> {
  readonly ttlMs: () => number;
  readonly hiddenEvictMs: number;
  /** Evict one entry if it is still parked. */
  readonly evictParked: (entry: T) => void;
  /** Evict every parked entry, never the visible one. */
  readonly evictAllParked: () => void;
}

/** Timers that bound how long parked entries hold their sessions. Driven by
 * the pool's attach/detach/dispose hooks and page visibility. */
export interface ParkedTerminalExpiry<T> {
  parked(entry: T): void;
  shown(entry: T): void;
  disposed(entry: T): void;
  pageHidden(): void;
  pageVisible(): void;
}

export function createParkedTerminalExpiry<T>(options: ParkedTerminalExpiryOptions<T>): ParkedTerminalExpiry<T> {
  const ttlTimers = new Map<T, ReturnType<typeof setTimeout>>();
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTtl(entry: T): void {
    const timer = ttlTimers.get(entry);
    if (timer === undefined) return;
    clearTimeout(timer);
    ttlTimers.delete(entry);
  }

  function clearHidden(): void {
    if (hiddenTimer === null) return;
    clearTimeout(hiddenTimer);
    hiddenTimer = null;
  }

  return {
    parked(entry) {
      clearTtl(entry);
      ttlTimers.set(entry, setTimeout(() => {
        ttlTimers.delete(entry);
        options.evictParked(entry);
      }, options.ttlMs()));
    },
    shown: clearTtl,
    disposed: clearTtl,
    pageHidden() {
      clearHidden();
      hiddenTimer = setTimeout(() => {
        hiddenTimer = null;
        options.evictAllParked();
      }, options.hiddenEvictMs);
    },
    pageVisible: clearHidden,
  };
}

/** DOM adapter: the visible entry's own element occupies the terminal shell
 * slot and carries its id, so CSS, accessibility and `getElementById` callers
 * see exactly one terminal. A parked element is swapped for an empty shell and
 * leaves the document with its canvas and Ghostty state intact. */
export interface TerminalShellSlot {
  show(element: HTMLElement): void;
  park(element: HTMLElement): void;
}

export function createTerminalShellSlot(doc: Document, id: string): TerminalShellSlot {
  return {
    show(element) {
      const current = doc.getElementById(id);
      if (current === element) return;
      element.id = id;
      current?.replaceWith(element);
    },
    park(element) {
      if (doc.getElementById(id) === element) {
        const blank = doc.createElement(element.tagName);
        blank.id = id;
        element.replaceWith(blank);
      }
      element.removeAttribute("id");
    },
  };
}

/** Callers look for a hit only when no terminal is current, so an entry the
 * pool still marks visible is stale (grid paths wipe the shell directly).
 * Evict it first so it can never be returned as a canvas-less hit. */
export function showAfterReleasingStaleVisible<T>(pool: TerminalPool<T>, key: TerminalPoolKey): T | null {
  const stale = pool.visible;
  if (stale !== null) pool.evictEntry(stale);
  return pool.show(key);
}

/** Events a parked (hidden) entry can receive from its socket. */
export type ParkedTerminalEvent =
  | DisconnectAction
  | "viewer-conflict"
  | "reconnect-exhausted"
  | "route-unavailable";

/** A parked entry has no UI to show conflict, ended or failed states, so any
 * terminal outcome evicts it; the next open is a miss with the normal UI. A
 * transient disconnect keeps it: it reconnects when shown. */
export function shouldEvictParkedTerminal(event: ParkedTerminalEvent): boolean {
  return event !== "reconnect";
}

export interface ParkCandidate {
  readonly hasTerminal: boolean;
  readonly displaced: boolean;
  readonly loadState: TerminalLoadVisualState;
}

const PARKABLE_LOAD_STATES: ReadonlySet<TerminalLoadVisualState> = new Set([
  "prefill-loading",
  "hydrating",
  "reconnecting",
  "live",
]);

/** Only a healthy terminal is kept when switching away from it. */
export function canParkTerminal(candidate: ParkCandidate): boolean {
  return candidate.hasTerminal && !candidate.displaced && PARKABLE_LOAD_STATES.has(candidate.loadState);
}
