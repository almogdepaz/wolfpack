import { describe, expect, test } from "bun:test";
import {
  formatEventLine,
  matchesEventFilter,
  parseEventFilter,
  parseSseEvents,
  WOLFPACK_EVENT_KIND,
  type WolfpackEvent,
} from "../../src/events-contract";

const created: WolfpackEvent = {
  id: 1,
  at: "2026-10-11T00:00:00.000Z",
  kind: WOLFPACK_EVENT_KIND.SESSION_CREATED,
  sessionId: "11111111-1111-1111-1111-111111111111",
  session: "wolf-1",
  cwd: "/tmp/wolf-1",
};
const task: WolfpackEvent = {
  id: 2,
  at: "2026-10-11T00:00:01.000Z",
  kind: WOLFPACK_EVENT_KIND.TASK_UPDATED,
  taskId: "t-1",
  eventId: "e-1",
  eventType: "task.completed",
  sequence: "3",
};

test("parent notifications filter by parent name or id and render for humans", () => {
  const event: WolfpackEvent = { id: 8, at: "t", kind: WOLFPACK_EVENT_KIND.PARENT_NOTIFIED, session: "parent", sessionId: "parent-id", seq: 2, message: "ready", from: "child" };
  expect(parseEventFilter(new URLSearchParams("kinds=parent_notified")).ok).toBe(true);
  expect(matchesEventFilter(event, { session: "parent" })).toBe(true);
  expect(matchesEventFilter(event, { session: "parent-id" })).toBe(true);
  expect(matchesEventFilter(event, { session: "child" })).toBe(false);
  expect(formatEventLine(event)).toBe("t parent_notified parent seq=2 [child] ready");
  expect(formatEventLine({ ...event, from: "child\nagent", message: "ready\r\nfor review" })).toBe("t parent_notified parent seq=2 [child agent] ready  for review");
});

describe("parseEventFilter", () => {
  test("empty params match every kind and session", () => {
    const parsed = parseEventFilter(new URLSearchParams());
    expect(parsed).toEqual({ ok: true, filter: {} });
  });

  test("parses comma separated kinds and a session selector", () => {
    const parsed = parseEventFilter(new URLSearchParams("kinds=session.created,task.updated&session=wolf-1"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect([...(parsed.filter.kinds ?? [])]).toEqual(["session.created", "task.updated"]);
    expect(parsed.filter.session).toBe("wolf-1");
  });

  test("rejects unknown kinds and empty kind lists", () => {
    expect(parseEventFilter(new URLSearchParams("kinds=session.bogus"))).toEqual({ ok: false, error: "unknown event kind: session.bogus" });
    expect(parseEventFilter(new URLSearchParams("kinds="))).toEqual({ ok: false, error: "kinds must not be empty" });
  });

  test("rejects unknown query params and empty session", () => {
    expect(parseEventFilter(new URLSearchParams("since=4")).ok).toBe(false);
    expect(parseEventFilter(new URLSearchParams("session=")).ok).toBe(false);
  });
});

describe("matchesEventFilter", () => {
  test("filters by kind", () => {
    const filter = { kinds: new Set([WOLFPACK_EVENT_KIND.TASK_UPDATED]) };
    expect(matchesEventFilter(created, filter)).toBe(false);
    expect(matchesEventFilter(task, filter)).toBe(true);
  });

  test("session selector matches name or stable id and excludes task events", () => {
    expect(matchesEventFilter(created, { session: "wolf-1" })).toBe(true);
    expect(matchesEventFilter(created, { session: created.kind === "session.created" ? created.sessionId : "" })).toBe(true);
    expect(matchesEventFilter(created, { session: "wolf-2" })).toBe(false);
    expect(matchesEventFilter(task, { session: "wolf-1" })).toBe(false);
  });
});

describe("parseSseEvents", () => {
  test("returns complete events and keeps a partial tail", () => {
    const chunk = `: ping\n\nid: 1\ndata: ${JSON.stringify(created)}\n\nid: 2\ndata: {"id":2`;
    const parsed = parseSseEvents(chunk);
    expect(parsed.events).toEqual([created]);
    expect(parsed.rest).toBe(`id: 2\ndata: {"id":2`);
  });
});

describe("parseSseEvents line endings", () => {
  const body = JSON.stringify(created);

  test("dispatches CRLF-delimited messages", () => {
    const parsed = parseSseEvents(`id: 1\r\ndata: ${body}\r\n\r\n`);
    expect(parsed.events).toEqual([created]);
    expect(parsed.rest).toBe("");
  });

  test("keeps a CRLF delimiter split across chunks", () => {
    const first = parseSseEvents(`id: 1\r\ndata: ${body}\r\n\r`);
    expect(first.events).toEqual([]);
    const second = parseSseEvents(`${first.rest}\n`);
    expect(second.events).toEqual([created]);
  });

  test("joins multi-line data fields", () => {
    const [head, ...tail] = JSON.stringify(created, null, 1).split("\n");
    const wire = `data: ${head}\n${tail.map((line) => `data: ${line}`).join("\n")}\n\n`;
    expect(parseSseEvents(wire).events).toEqual([created]);
  });
});

describe("formatEventLine", () => {
  test("renders a compact human line per kind", () => {
    expect(formatEventLine(created)).toBe("2026-10-11T00:00:00.000Z session.created wolf-1 cwd=/tmp/wolf-1");
    expect(formatEventLine(task)).toBe("2026-10-11T00:00:01.000Z task.updated t-1 task.completed");
    expect(formatEventLine({
      id: 3, at: "t", kind: WOLFPACK_EVENT_KIND.SESSION_EXITED, sessionId: "abc", reason: "killed", signal: 1,
    })).toBe("t session.exited abc reason=killed signal=1");
    expect(formatEventLine({
      id: 4, at: "t", kind: WOLFPACK_EVENT_KIND.SESSION_STATE, session: "wolf-1", state: "needs-input", label: "Needs input", transitionSequence: 2,
    })).toBe("t session.state wolf-1 needs-input (Needs input)");
  });
});
