import { afterEach, describe, expect, test } from "bun:test";
import { consumeEventStream, eventsCommand, eventsQuery, parseEventsOptions } from "../../src/cli/events";
import { SESSION_EXIT } from "../../src/cli/session-control";
import { formatSseEvent, type WolfpackEvent } from "../../src/events-contract";

describe("parseEventsOptions", () => {
  test("parses flags", () => {
    expect(parseEventsOptions([])).toEqual({ json: false });
    expect(parseEventsOptions(["--kinds", "session.exited,task.updated", "--session", "wolf-1", "--json"]))
      .toEqual({ kinds: "session.exited,task.updated", session: "wolf-1", json: true });
  });

  test("rejects unknown flags and missing values", () => {
    expect(parseEventsOptions(["--follow"])).toBeNull();
    expect(parseEventsOptions(["--kinds"])).toBeNull();
    expect(parseEventsOptions(["--session", "--json"])).toBeNull();
  });
});

describe("eventsQuery", () => {
  test("encodes filters as query params", () => {
    expect(eventsQuery({ json: false })).toBe("/api/events");
    expect(eventsQuery({ kinds: "session.exited", session: "wolf 1", json: false }))
      .toBe("/api/events?kinds=session.exited&session=wolf+1");
  });
});

describe("consumeEventStream", () => {
  test("emits events split across arbitrary chunk boundaries and skips pings", async () => {
    const events: WolfpackEvent[] = [
      { id: 1, at: "t", kind: "session.created", sessionId: "a", session: "wolf-1", cwd: "/tmp" },
      { id: 2, at: "t", kind: "task.updated", taskId: "t1", eventId: "e1", eventType: "task.completed", sequence: "2" },
    ];
    const wire = `: ping\n\n${events.map(formatSseEvent).join("")}`;
    const bytes = new TextEncoder().encode(wire);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
        controller.close();
      },
    });
    const seen: WolfpackEvent[] = [];
    await consumeEventStream(body, (event) => seen.push(event));
    expect(seen).toEqual(events);
  });
});

describe("eventsCommand exit codes", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function stubFetch(handler: () => Promise<Response>): { calls: number } {
    const counter = { calls: 0 };
    globalThis.fetch = (async () => { counter.calls++; return handler(); }) as unknown as typeof fetch;
    return counter;
  }

  test("an invalid kind is a usage error rejected before any request", async () => {
    const counter = stubFetch(async () => new Response("{}"));
    expect(await eventsCommand(["--kinds", "session.bogus"])).toBe(SESSION_EXIT.USAGE);
    expect(counter.calls).toBe(0);
  });

  test("401 maps to the auth exit code", async () => {
    stubFetch(async () => Response.json({ error: "unauthorized" }, { status: 401 }));
    expect(await eventsCommand([])).toBe(SESSION_EXIT.AUTH);
  });

  test("an unreachable server is a general failure, not a thrown fatal", async () => {
    stubFetch(async () => { throw new TypeError("Unable to connect"); });
    expect(await eventsCommand([])).toBe(SESSION_EXIT.GENERAL);
  });

  function captureStderr(): { text: () => string; restore: () => void } {
    const realWrite = process.stderr.write;
    const realError = console.error;
    const lines: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    return {
      text: () => lines.join("\n"),
      restore: () => { process.stderr.write = realWrite; console.error = realError; },
    };
  }

  test("an unreachable server names the URL, the cause and the sandbox", async () => {
    stubFetch(async () => { throw Object.assign(new TypeError("Was there a typo in the url or port?"), { code: "FailedToOpenSocket" }); });
    const stderr = captureStderr();
    try {
      expect(await eventsCommand([])).toBe(SESSION_EXIT.GENERAL);
    } finally {
      stderr.restore();
    }
    expect(stderr.text()).toMatch(/cannot reach the Wolfpack server at http:\/\/127\.0\.0\.1:\d+\/api\/events \(FailedToOpenSocket\)/);
    expect(stderr.text()).toContain("sandbox");
  });

  test("a sandbox proxy's plain-text 403 is reported as a proxy denial", async () => {
    stubFetch(async () => new Response("Connection blocked by network allowlist", { status: 403 }));
    const stderr = captureStderr();
    try {
      expect(await eventsCommand([])).toBe(SESSION_EXIT.GENERAL);
    } finally {
      stderr.restore();
    }
    expect(stderr.text()).toContain("(proxy denial (HTTP 403))");
  });

  test("an established stream that ends exits with the general failure code", async () => {
    stubFetch(async () => new Response(new ReadableStream({ start: (controller) => controller.close() }), { headers: { "Content-Type": "text/event-stream" } }));
    expect(await eventsCommand([])).toBe(SESSION_EXIT.GENERAL);
  });
});
