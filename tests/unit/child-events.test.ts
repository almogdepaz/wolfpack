import { afterEach, beforeEach, describe, expect, test } from "bun:test";

process.env.WOLFPACK_TEST = "1";

import {
  AGENT_STATUS_AUTHORITY,
  AGENT_STATUS_FRESHNESS,
  AGENT_STATUS_SOURCE,
  AGENT_STATUS_STATE,
  type AgentStatusAuthority,
  type AgentStatusState,
} from "../../src/agent-status-contract.ts";
import { CHILD_EVENT_PAYLOAD_KIND } from "../../src/child-event-contract.ts";
import { WOLFPACK_EVENT_KIND, type WolfpackEventBody } from "../../src/events-contract.ts";
import { PROGRAM_STATUS_KIND } from "../../src/program-status-contract.ts";
import type { AgentRuntimeState } from "../../src/server/agent-status.ts";
import { createChildEvents, CHILD_EXIT_MEMORY } from "../../src/server/child-events.ts";
let service = createChildEvents();
import { clearParentInbox, listParentNotifications, PARENT_INBOX_BOOT_ID } from "../../src/server/parent-inbox.ts";

const PARENT = { wolfpackSessionId: "parent-id", wolfpackSessionName: "lead" };
const CHILD = "child-id";

function runtime(
  state: AgentStatusState,
  authority: AgentStatusAuthority = AGENT_STATUS_AUTHORITY.PROGRAM,
  extra: Partial<AgentRuntimeState> = {},
): AgentRuntimeState {
  return {
    state,
    authority,
    freshness: AGENT_STATUS_FRESHNESS.FRESH,
    source: AGENT_STATUS_SOURCE.PROGRAM_STATUS,
    label: state,
    stale: false,
    observedAt: "2026-11-09T00:00:00.000Z",
    changedAt: "2026-11-09T00:00:00.000Z",
    transitionSequence: 1,
    unseen: false,
    ...extra,
  };
}

let published: WolfpackEventBody[] = [];
const publish = (body: WolfpackEventBody) => { published.push(body); };

function observe(state: AgentStatusState, authority?: AgentStatusAuthority, extra: Partial<AgentRuntimeState> = {}, options: { alive?: boolean; rendered?: string; parent?: typeof PARENT | undefined; id?: string; name?: string } = {}) {
  service.observeChildSession({
    sessionId: options.id ?? CHILD,
    name: options.name ?? "worker",
    parentSession: "parent" in options ? options.parent : PARENT,
    alive: options.alive ?? true,
    runtimeState: runtime(state, authority, extra),
    ...(options.rendered !== undefined && { rendered: options.rendered }),
  }, publish);
}

function events() {
  return published.flatMap(body => body.kind === WOLFPACK_EVENT_KIND.CHILD_EVENT ? [body.childEvent] : []);
}

beforeEach(() => {
  service = createChildEvents();
  clearParentInbox(PARENT.wolfpackSessionId);
  published = [];
});

afterEach(() => {
  service = createChildEvents();
});

describe("child events", () => {
  test("program working to done emits one done event to the inbox and the event stream", () => {
    observe(AGENT_STATUS_STATE.WORKING);
    expect(published).toEqual([]);
    observe(AGENT_STATUS_STATE.DONE, AGENT_STATUS_AUTHORITY.PROGRAM, { message: "tests pass" });

    expect(published).toHaveLength(1);
    const body = published[0]!;
    expect(body).toMatchObject({ kind: WOLFPACK_EVENT_KIND.CHILD_EVENT, session: "lead", sessionId: "parent-id" });
    const [event] = events();
    const inbox = listParentNotifications(PARENT.wolfpackSessionId);
    expect(inbox).toHaveLength(1);
    expect(event).toEqual({
      kind: CHILD_EVENT_PAYLOAD_KIND,
      eventId: `${CHILD}:${PARENT_INBOX_BOOT_ID}:${inbox[0]!.seq}`,
      bootId: PARENT_INBOX_BOOT_ID,
      seq: inbox[0]!.seq,
      childSessionId: CHILD,
      childName: "worker",
      parentSessionId: "parent-id",
      event: "done",
      state: AGENT_STATUS_STATE.DONE,
      message: "tests pass",
      observedAt: inbox[0]!.at,
      authority: AGENT_STATUS_AUTHORITY.PROGRAM,
    });
    expect(inbox[0]).toEqual({ seq: event!.seq, at: event!.observedAt, message: "done: tests pass", from: "worker", childEvent: event });
  });

  test("a child created in this boot reports its first event state exactly once", () => {
    service.noteChildCreated("blocked-id", "blocked", PARENT);
    service.noteChildCreated("failed-id", "failed", PARENT);
    service.noteChildCreated("done-id", "done", PARENT);
    for (let pass = 0; pass < 2; pass++) {
      observe(AGENT_STATUS_STATE.NEEDS_INPUT, AGENT_STATUS_AUTHORITY.PROGRAM, { inputKind: PROGRAM_STATUS_KIND.PERMISSION }, { id: "blocked-id", name: "blocked" });
      observe(AGENT_STATUS_STATE.FAILED, AGENT_STATUS_AUTHORITY.MANIFEST, {}, { id: "failed-id", name: "failed" });
      observe(AGENT_STATUS_STATE.DONE, AGENT_STATUS_AUTHORITY.PROGRAM, {}, { id: "done-id", name: "done" });
    }
    expect(events().map(event => [event.childName, event.event])).toEqual([["blocked", "blocked"], ["failed", "error"], ["done", "done"]]);
    expect(listParentNotifications(PARENT.wolfpackSessionId)).toHaveLength(3);
  });

  test("a child first seen through restart recovery is a baseline, even in an event state", () => {
    observe(AGENT_STATUS_STATE.DONE);
    observe(AGENT_STATUS_STATE.NEEDS_INPUT, AGENT_STATUS_AUTHORITY.PROGRAM, {}, { id: "other", name: "other" });
    observe(AGENT_STATUS_STATE.FAILED, AGENT_STATUS_AUTHORITY.MANIFEST, {}, { id: "third", name: "third" });
    expect(published).toEqual([]);
    expect(listParentNotifications(PARENT.wolfpackSessionId)).toEqual([]);
  });

  test("a created child that starts idle or working emits nothing until an event state", () => {
    service.noteChildCreated(CHILD, "worker", PARENT);
    observe(AGENT_STATUS_STATE.IDLE);
    observe(AGENT_STATUS_STATE.WORKING);
    expect(published).toEqual([]);
    observe(AGENT_STATUS_STATE.DONE);
    expect(events().map(event => event.event)).toEqual(["done"]);
  });

  test("repeated reports in the same state coalesce into one event", () => {
    observe(AGENT_STATUS_STATE.WORKING);
    observe(AGENT_STATUS_STATE.DONE);
    observe(AGENT_STATUS_STATE.DONE, AGENT_STATUS_AUTHORITY.PROGRAM, { transitionSequence: 2 });
    observe(AGENT_STATUS_STATE.NEEDS_INPUT, AGENT_STATUS_AUTHORITY.PROGRAM, { inputKind: PROGRAM_STATUS_KIND.PERMISSION, message: "run rm?" });
    observe(AGENT_STATUS_STATE.NEEDS_INPUT, AGENT_STATUS_AUTHORITY.PROGRAM, { inputKind: PROGRAM_STATUS_KIND.QUESTION, message: "which branch?", transitionSequence: 3 });
    expect(events().map(event => event.event)).toEqual(["done", "blocked"]);
    expect(events()[1]).toMatchObject({ inputKind: "permission", message: "run rm?", state: AGENT_STATUS_STATE.NEEDS_INPUT });
    expect(listParentNotifications(PARENT.wolfpackSessionId).map(entry => entry.message)).toEqual(["done", "blocked (permission): run rm?"]);
  });

  test("leaving and re-entering an event state emits again", () => {
    observe(AGENT_STATUS_STATE.WORKING);
    observe(AGENT_STATUS_STATE.NEEDS_INPUT);
    observe(AGENT_STATUS_STATE.WORKING);
    observe(AGENT_STATUS_STATE.NEEDS_INPUT);
    expect(events().map(event => event.event)).toEqual(["blocked", "blocked"]);
    const [first, second] = events();
    expect(second!.seq).toBe(first!.seq + 1);
  });

  test("heuristic states never produce blocked or error, and manifest failure is an error", () => {
    observe(AGENT_STATUS_STATE.WORKING, AGENT_STATUS_AUTHORITY.FALLBACK);
    observe(AGENT_STATUS_STATE.NEEDS_INPUT, AGENT_STATUS_AUTHORITY.FALLBACK);
    observe(AGENT_STATUS_STATE.FAILED, AGENT_STATUS_AUTHORITY.FALLBACK);
    observe(AGENT_STATUS_STATE.DONE, AGENT_STATUS_AUTHORITY.MANIFEST);
    expect(published).toEqual([]);
    observe(AGENT_STATUS_STATE.FAILED, AGENT_STATUS_AUTHORITY.MANIFEST, { message: "manifest text" });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ event: "error", authority: AGENT_STATUS_AUTHORITY.MANIFEST });
    // Only the program's own report carries reader-facing text.
    expect(events()[0]!.message).toBeUndefined();
  });

  test("busy to idle is done only after a delivered send arms the child", () => {
    observe(AGENT_STATUS_STATE.WORKING, AGENT_STATUS_AUTHORITY.FALLBACK);
    observe(AGENT_STATUS_STATE.IDLE, AGENT_STATUS_AUTHORITY.FALLBACK);
    expect(published).toEqual([]);
    service.noteChildInputDelivered(CHILD, "worker", PARENT);
    observe(AGENT_STATUS_STATE.WORKING, AGENT_STATUS_AUTHORITY.FALLBACK);
    observe(AGENT_STATUS_STATE.IDLE, AGENT_STATUS_AUTHORITY.FALLBACK);
    observe(AGENT_STATUS_STATE.WORKING, AGENT_STATUS_AUTHORITY.FALLBACK);
    observe(AGENT_STATUS_STATE.IDLE, AGENT_STATUS_AUTHORITY.FALLBACK);
    expect(events().map(event => [event.event, event.state])).toEqual([["done", AGENT_STATUS_STATE.IDLE]]);
  });

  test("dead, stale and parentless observations produce no state event and keep the baseline", () => {
    observe(AGENT_STATUS_STATE.WORKING);
    observe(AGENT_STATUS_STATE.DONE, AGENT_STATUS_AUTHORITY.PROGRAM, {}, { alive: false });
    observe(AGENT_STATUS_STATE.DONE, AGENT_STATUS_AUTHORITY.PROGRAM, { stale: true });
    observe(AGENT_STATUS_STATE.WORKING, AGENT_STATUS_AUTHORITY.PROGRAM, {}, { parent: undefined, id: "orphan" });
    observe(AGENT_STATUS_STATE.DONE, AGENT_STATUS_AUTHORITY.PROGRAM, {}, { parent: undefined, id: "orphan" });
    expect(published).toEqual([]);
    observe(AGENT_STATUS_STATE.DONE);
    expect(events().map(event => event.event)).toEqual(["done"]);
  });

  test("exit emits once with the last screen lines, then the child is forgotten", () => {
    observe(AGENT_STATUS_STATE.WORKING, AGENT_STATUS_AUTHORITY.PROGRAM, {}, { rendered: "one\n\ntwo\x1b\nthree\nfour\nfive\nsix\n" });
    const exited = service.childSessionExited(CHILD, { reason: "exit", exitCode: 2 }, publish);
    expect(exited).toMatchObject({ event: "exited", state: AGENT_STATUS_STATE.WORKING, reason: "exit", exitCode: 2, lastLines: ["two", "three", "four", "five", "six"] });
    expect(listParentNotifications(PARENT.wolfpackSessionId).at(-1)?.message).toBe("exited (exit code 2)");
    expect(service.childSessionExited(CHILD, { reason: "exit", exitCode: 2 }, publish)).toBeUndefined();
    expect(service.childSessionExited("unknown", { reason: "killed" }, publish)).toBeUndefined();
    expect(events()).toHaveLength(1);
  });

  test("a notify message from a known child name becomes a message event", () => {
    observe(AGENT_STATUS_STATE.WORKING);
    expect(service.childMessageEvent(PARENT.wolfpackSessionId, "stranger", "hi", publish)).toBeUndefined();
    expect(service.childMessageEvent("other-parent", "worker", "hi", publish)).toBeUndefined();
    expect(service.childMessageEvent(PARENT.wolfpackSessionId, undefined, "hi", publish)).toBeUndefined();
    const event = service.childMessageEvent(PARENT.wolfpackSessionId, "worker", "phase 1 done", publish);
    expect(event).toMatchObject({ event: "message", message: "phase 1 done", state: AGENT_STATUS_STATE.WORKING, childSessionId: CHILD });
    expect(listParentNotifications(PARENT.wolfpackSessionId)).toEqual([expect.objectContaining({ message: "phase 1 done", from: "worker", childEvent: event })]);
  });

  test("listeners see every event, and reconcile forgets absent children", () => {
    const seen: string[] = [];
    const stop = service.onChildEvent(({ parentSessionName, childEvent }) => seen.push(`${parentSessionName}:${childEvent.event}`));
    observe(AGENT_STATUS_STATE.WORKING);
    observe(AGENT_STATUS_STATE.FAILED);
    stop();
    observe(AGENT_STATUS_STATE.WORKING);
    observe(AGENT_STATUS_STATE.FAILED);
    expect(seen).toEqual(["lead:error"]);
    service.reconcileChildEvents(new Set(), { trackedBefore: service.childTrackingMark(), exitReason: () => "exit", publish });
    expect(events().map(event => event.event)).toEqual(["error", "error", "exited"]);
    // An exited child is not tracked again.
    observe(AGENT_STATUS_STATE.DONE);
    expect(events()).toHaveLength(3);
  });

  test("a table read reports a known child that is dead or gone as exited, once", () => {
    observe(AGENT_STATUS_STATE.WORKING, AGENT_STATUS_AUTHORITY.PROGRAM, {}, { rendered: "compiling\nfailed" });
    observe(AGENT_STATUS_STATE.WORKING, AGENT_STATUS_AUTHORITY.PROGRAM, {}, { id: "live", name: "live" });
    observe(AGENT_STATUS_STATE.WORKING, AGENT_STATUS_AUTHORITY.PROGRAM, {}, { id: "killing", name: "killing" });
    // A dead first sight is not tracked: there is no live child to report.
    observe(AGENT_STATUS_STATE.DONE, AGENT_STATUS_AUTHORITY.PROGRAM, {}, { alive: false, id: "ghost", name: "ghost" });
    const mark = service.childTrackingMark();
    // Created while that table read was in flight: absent from it, but not gone.
    service.noteChildCreated("new-id", "new", PARENT);
    const exitReason = (id: string) => (id === "killing" ? undefined : "exit" as const);
    service.reconcileChildEvents(new Set(["live"]), { trackedBefore: mark, exitReason, publish });
    expect(events().map(event => [event.childName, event.event, event.reason])).toEqual([["worker", "exited", "exit"]]);
    expect(events()[0]).toMatchObject({ state: AGENT_STATUS_STATE.WORKING, lastLines: ["compiling", "failed"] });
    // The lifecycle callback that arrives later finds nothing to report.
    expect(service.childSessionExited(CHILD, { reason: "exit", exitCode: 1 }, publish)).toBeUndefined();

    // The kill reply came back: the deferred child is reported with its reason.
    service.reconcileChildEvents(new Set(["live", "new-id"]), { trackedBefore: service.childTrackingMark(), exitReason: () => "killed", publish });
    expect(events().map(event => [event.childName, event.event, event.reason])).toEqual([["worker", "exited", "exit"], ["killing", "exited", "killed"]]);
    service.reconcileChildEvents(new Set(["live", "new-id"]), { trackedBefore: service.childTrackingMark(), exitReason: () => "exit", publish });
    expect(events()).toHaveLength(2);
  });

  test("an exited child is not tracked again by a late live observation, send or create (review A3-1)", () => {
    observe(AGENT_STATUS_STATE.WORKING);
    service.childSessionExited(CHILD, { reason: "exit", exitCode: 3 }, publish);
    // An observation that read the child as live before the exit arrives late.
    observe(AGENT_STATUS_STATE.WORKING);
    observe(AGENT_STATUS_STATE.NEEDS_INPUT);
    service.noteChildInputDelivered(CHILD, "worker", PARENT);
    service.noteChildCreated(CHILD, "worker", PARENT);
    service.reconcileChildEvents(new Set(), { trackedBefore: service.childTrackingMark(), exitReason: () => "exit", publish });
    expect(service.childSessionExited(CHILD, { reason: "exit" }, publish)).toBeUndefined();
    expect(events().map(event => event.event)).toEqual(["exited"]);
  });

  test("the exited-child memory is bounded and forgets the oldest exit first", () => {
    for (let n = 0; n <= CHILD_EXIT_MEMORY; n += 1) {
      service.noteChildCreated(`gone-${n}`, `gone-${n}`, PARENT);
      service.childSessionExited(`gone-${n}`, { reason: "exit" }, publish);
    }
    observe(AGENT_STATUS_STATE.WORKING, AGENT_STATUS_AUTHORITY.PROGRAM, {}, { id: "gone-0", name: "gone-0" });
    observe(AGENT_STATUS_STATE.FAILED, AGENT_STATUS_AUTHORITY.PROGRAM, {}, { id: "gone-0", name: "gone-0" });
    observe(AGENT_STATUS_STATE.WORKING, AGENT_STATUS_AUTHORITY.PROGRAM, {}, { id: "gone-1", name: "gone-1" });
    observe(AGENT_STATUS_STATE.FAILED, AGENT_STATUS_AUTHORITY.PROGRAM, {}, { id: "gone-1", name: "gone-1" });
    expect(events().filter(event => event.event === "error").map(event => event.childName)).toEqual(["gone-0"]);
  });

  test("event text is bounded and has no control characters", () => {
    observe(AGENT_STATUS_STATE.WORKING);
    observe(AGENT_STATUS_STATE.NEEDS_INPUT, AGENT_STATUS_AUTHORITY.PROGRAM, { message: `line\none\x07${"x".repeat(600)}` });
    const [event] = events();
    expect([...event!.message!]).toHaveLength(500);
    expect(event!.message!.startsWith("line one ")).toBe(true);
    expect([...listParentNotifications(PARENT.wolfpackSessionId)[0]!.message].length).toBeLessThanOrEqual(500);
  });
});
