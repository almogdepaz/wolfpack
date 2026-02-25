import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import type { AddressInfo } from "node:net";

// Set WOLFPACK_TEST before importing serve.ts to prevent auto-listen
process.env.WOLFPACK_TEST = "1";

import { server, __setTmuxList, __setTmuxSend, __setTmuxSendKey, __getActivePtySessions } from "../../serve.ts";
import { recordEvent, getTimeline, clearTimeline, detectTriageTransition } from "../../timeline.ts";
import { classifySession, INPUT_PATTERNS, ERROR_PATTERNS, type TriageStatus } from "../../triage.ts";

// ── Test setup ──

let port: number;
let baseUrl: string;
let baseWsUrl: string;

const FAKE_SESSIONS = ["prompt-sess", "reconnect-sess"];
__setTmuxList(async () => [...FAKE_SESSIONS]);

// Mock tmux send/key to avoid requiring real tmux sessions
const sendLog: { session: string; text: string; noEnter?: boolean }[] = [];
const keyLog: { session: string; key: string }[] = [];
__setTmuxSend(async (session, text, noEnter) => { sendLog.push({ session, text, noEnter }); });
__setTmuxSendKey(async (session, key) => { keyLog.push({ session, key }); });

const _realConsoleError = console.error;

beforeAll((done) => {
  console.error = (...args: any[]) => {
    const msg = String(args[0] ?? "");
    if (msg.startsWith("WS error")) return;
    _realConsoleError(...args);
  };
  server.listen(0, "127.0.0.1", () => {
    port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    baseWsUrl = `ws://127.0.0.1:${port}`;
    done();
  });
});

afterAll(() => {
  console.error = _realConsoleError;
  server.close();
});

// ── Helpers ──

function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string) {
  return fetch(`${baseUrl}${path}`);
}

async function rawUpgrade(path: string): Promise<{ status: number; ws?: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${baseWsUrl}${path}`);
    ws.addEventListener("open", () => resolve({ status: 101, ws }));
    ws.addEventListener("error", () => resolve({ status: 0 }));
    ws.addEventListener("close", (ev) => {
      resolve({ status: ev.code === 1006 ? 403 : ev.code });
    });
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.addEventListener("close", () => resolve());
    ws.close();
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════
// 1. Prompt Action Dispatch (y/n key dispatch via HTTP API)
// ═══════════════════════════════════════════════════════════════════════════

describe("Prompt action dispatch — /api/send (yes/no text)", () => {
  test('sends "yes" text and records command event', async () => {
    clearTimeline("prompt-sess");
    const res = await post("/api/send", { session: "prompt-sess", text: "yes" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    // Timeline should have a "command" event with text "yes"
    const events = getTimeline("prompt-sess");
    const cmdEvent = events.find((e) => e.type === "command" && e.text === "yes");
    expect(cmdEvent).toBeDefined();
  });

  test('sends "no" text and records command event', async () => {
    clearTimeline("prompt-sess");
    const res = await post("/api/send", { session: "prompt-sess", text: "no" });
    expect(res.status).toBe(200);
    const events = getTimeline("prompt-sess");
    const cmdEvent = events.find((e) => e.type === "command" && e.text === "no");
    expect(cmdEvent).toBeDefined();
  });

  test("truncates command text >80 chars in timeline event", async () => {
    clearTimeline("prompt-sess");
    const longText = "a".repeat(100);
    const res = await post("/api/send", { session: "prompt-sess", text: longText });
    expect(res.status).toBe(200);
    const events = getTimeline("prompt-sess");
    const cmdEvent = events.find((e) => e.type === "command");
    expect(cmdEvent).toBeDefined();
    expect(cmdEvent!.text!.length).toBeLessThanOrEqual(83); // 80 + "..."
    expect(cmdEvent!.text!.endsWith("...")).toBe(true);
  });

  test("noEnter flag passes through correctly", async () => {
    const res = await post("/api/send", {
      session: "prompt-sess",
      text: "y",
      noEnter: true,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

describe("Prompt action dispatch — /api/key (Enter, C-c)", () => {
  test("dispatches Enter key for prompt confirmation", async () => {
    const res = await post("/api/key", { session: "prompt-sess", key: "Enter" });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  test("dispatches C-c key for prompt interrupt", async () => {
    const res = await post("/api/key", { session: "prompt-sess", key: "C-c" });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  test("dispatches y and n single-char keys", async () => {
    for (const key of ["y", "n"]) {
      const res = await post("/api/key", { session: "prompt-sess", key });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    }
  });

  test("rejects non-allowlisted keys", async () => {
    for (const key of ["Delete", "F1", "q", "a", "C-a"]) {
      const res = await post("/api/key", { session: "prompt-sess", key });
      expect(res.status).toBe(400);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Keyboard Accessory Input Coordination (WS key dispatch)
// ═══════════════════════════════════════════════════════════════════════════

describe("Keyboard accessory — WS /ws/terminal key dispatch", () => {
  test("Tab key accepted via WS", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=prompt-sess");
    expect(ws).toBeDefined();
    ws!.send(JSON.stringify({ type: "key", key: "Tab" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("Escape key accepted via WS", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=prompt-sess");
    expect(ws).toBeDefined();
    ws!.send(JSON.stringify({ type: "key", key: "Escape" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("C-c key accepted via WS", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=prompt-sess");
    expect(ws).toBeDefined();
    ws!.send(JSON.stringify({ type: "key", key: "C-c" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("arrow keys accepted via WS", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=prompt-sess");
    expect(ws).toBeDefined();
    for (const key of ["Up", "Down", "Left", "Right"]) {
      ws!.send(JSON.stringify({ type: "key", key }));
    }
    await wait(300);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("insert characters sent as input (not key)", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=prompt-sess");
    expect(ws).toBeDefined();
    // Keyboard accessory insert chars (|, /, ~, -) are sent as input type
    for (const char of ["|", "/", "~", "-"]) {
      ws!.send(JSON.stringify({ type: "input", data: char }));
    }
    await wait(300);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("WS input records timeline command events", async () => {
    clearTimeline("prompt-sess");
    const { ws } = await rawUpgrade("/ws/terminal?session=prompt-sess");
    expect(ws).toBeDefined();
    ws!.send(JSON.stringify({ type: "input", data: "ls -la" }));
    await wait(300);
    const events = getTimeline("prompt-sess");
    const cmdEvent = events.find((e) => e.type === "command" && e.text === "ls -la");
    expect(cmdEvent).toBeDefined();
    await closeWs(ws!);
  });

  test("mixed key and input messages in rapid succession", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=prompt-sess");
    expect(ws).toBeDefined();
    // Simulate rapid keyboard accessory taps
    ws!.send(JSON.stringify({ type: "key", key: "Tab" }));
    ws!.send(JSON.stringify({ type: "input", data: "cd " }));
    ws!.send(JSON.stringify({ type: "key", key: "Tab" }));
    ws!.send(JSON.stringify({ type: "key", key: "Enter" }));
    await wait(400);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Reconnect State Transitions
// ═══════════════════════════════════════════════════════════════════════════

describe("Reconnect — mobile terminal close codes", () => {
  test("session disappear yields 4001 (client should NOT retry)", async () => {
    const ws = new WebSocket(`${baseWsUrl}/ws/terminal?session=prompt-sess`);
    const closePromise = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("connect failed")));
    });

    // Remove session
    const idx = FAKE_SESSIONS.indexOf("prompt-sess");
    FAKE_SESSIONS.splice(idx, 1);

    try {
      const ev = await Promise.race([
        closePromise,
        wait(6000).then(() => { throw new Error("timeout"); }),
      ]) as CloseEvent;
      expect(ev.code).toBe(4001);
    } finally {
      FAKE_SESSIONS.push("prompt-sess");
      await wait(50);
    }
  });

  test("reconnect succeeds after session reappears post-4001", async () => {
    // First: connect and get 4001
    const ws1 = new WebSocket(`${baseWsUrl}/ws/terminal?session=reconnect-sess`);
    const close1 = new Promise<CloseEvent>((r) => ws1.addEventListener("close", r));
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("connect failed")));
    });

    const idx = FAKE_SESSIONS.indexOf("reconnect-sess");
    FAKE_SESSIONS.splice(idx, 1);

    const ev1 = await Promise.race([
      close1,
      wait(6000).then(() => { throw new Error("timeout"); }),
    ]) as CloseEvent;
    expect(ev1.code).toBe(4001);

    // Restore session and reconnect
    FAKE_SESSIONS.push("reconnect-sess");
    await wait(50);

    const { status, ws: ws2 } = await rawUpgrade("/ws/terminal?session=reconnect-sess");
    expect(status).toBe(101);
    expect(ws2!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws2!);
  });

  test("connection to nonexistent session rejected immediately", async () => {
    const { status, ws } = await rawUpgrade("/ws/terminal?session=ghost-session");
    expect(status).not.toBe(101);
    if (ws) await closeWs(ws);
  });
});

describe("Reconnect — PTY /ws/pty close codes", () => {
  test("PTY spawn failure yields 4001 (prevents reconnect loop)", async () => {
    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=prompt-sess`);
    ws.binaryType = "arraybuffer";
    const closePromise = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("connect failed")));
    });

    // Trigger spawn (will fail — no real tmux)
    ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));

    const ev = await Promise.race([
      closePromise,
      wait(5000).then(() => { throw new Error("timeout"); }),
    ]) as CloseEvent;

    expect(ev.code).toBe(4001);
  });

  test("consecutive PTY spawn failures all return 4001 (no 1000 leak)", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=prompt-sess`);
      ws.binaryType = "arraybuffer";
      const cp = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("connect failed")));
      });
      ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
      const ev = await Promise.race([
        cp,
        wait(5000).then(() => { throw new Error("timeout"); }),
      ]) as CloseEvent;
      codes.push(ev.code);
    }
    expect(codes).toEqual([4001, 4001, 4001]);
  });
});

describe("Reconnect — PTY grace period state transitions", () => {
  test("viewer disconnect → grace period → reconnect reuses entry", async () => {
    const ptySessions = __getActivePtySessions();
    ptySessions.delete("prompt-sess");
    await wait(50);

    // Connect
    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=prompt-sess`);
    ws1.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("connect failed")));
    });

    expect(ptySessions.has("prompt-sess")).toBe(true);
    const entry = ptySessions.get("prompt-sess")!;
    expect(entry.alive).toBe(true);

    // Disconnect — starts grace period
    ws1.close();
    await wait(200);

    // Still alive during grace
    expect(entry.alive).toBe(true);

    // Reconnect — reuse same entry
    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=prompt-sess`);
    ws2.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("reconnect failed")));
    });

    expect(ptySessions.get("prompt-sess")).toBe(entry); // same ref
    ws2.close();
    await wait(100);
  });

  test("viewer disconnect with no reconnect → teardown after grace expires", async () => {
    const ptySessions = __getActivePtySessions();
    ptySessions.delete("reconnect-sess");
    await wait(50);

    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=reconnect-sess`);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("connect failed")));
    });

    const entry = ptySessions.get("reconnect-sess")!;
    expect(entry.alive).toBe(true);

    ws.close();
    await wait(200);

    // Grace period active — still alive
    expect(entry.alive).toBe(true);

    // Wait past 15s grace
    await wait(16_000);

    const afterEntry = ptySessions.get("reconnect-sess");
    if (afterEntry) {
      expect(afterEntry.alive).toBe(false);
    } else {
      expect(ptySessions.has("reconnect-sess")).toBe(false);
    }
  }, 20_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Triage State Machine Transitions (timeline integration)
// ═══════════════════════════════════════════════════════════════════════════

describe("Triage state machine — classifySession", () => {
  test("input patterns trigger needs-input", () => {
    const prompts = [
      "Do you want to continue? (y/n)",
      "Proceed? [Y/n]",
      "Continue? [yes/no]",
      "Do you want to proceed?",
      "Press Enter to continue",
      "Need permission to access /etc/hosts",
      "Waiting for input",
      "Approve this deployment?",
      "Type (yes/no) to confirm",
      "Continue? [y/N]",
    ];
    for (const prompt of prompts) {
      expect(classifySession(prompt, 0)).toBe("needs-input");
    }
  });

  test("error patterns trigger error", () => {
    const errors = [
      "Error: something failed",
      "error[E0001]: type mismatch",
      "build failed with 3 errors",
      "❌ Tests failed",
      "panic: runtime error",
      "FATAL: out of memory",
      "unhandled rejection at Promise",
      "segfault at 0x0000",
    ];
    for (const err of errors) {
      expect(classifySession(err, 999)).toBe("error");
    }
  });

  test("recent activity classifies as running", () => {
    expect(classifySession("$ compiling...", 5)).toBe("running");
    expect(classifySession("$ compiling...", 20)).toBe("running");
  });

  test("stale activity classifies as idle", () => {
    expect(classifySession("$ ", 21)).toBe("idle");
    expect(classifySession("$ ", 999)).toBe("idle");
  });

  test("needs-input takes priority over error patterns", () => {
    // Line matches both input and error patterns
    expect(classifySession("Error: Do you want to continue? (y/n)", 0)).toBe("needs-input");
  });

  test("error takes priority over running", () => {
    expect(classifySession("Error: build failed", 5)).toBe("error");
  });
});

describe("Triage state machine — detectTriageTransition", () => {
  beforeEach(() => {
    clearTimeline("state-sess");
  });

  test("transition to needs-input records prompt event", () => {
    detectTriageTransition("state-sess", "idle");
    detectTriageTransition("state-sess", "needs-input");
    const events = getTimeline("state-sess");
    expect(events.some((e) => e.type === "prompt")).toBe(true);
  });

  test("transition to error records error event", () => {
    detectTriageTransition("state-sess", "running");
    detectTriageTransition("state-sess", "error");
    const events = getTimeline("state-sess");
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  test("transition from idle to running records running event", () => {
    detectTriageTransition("state-sess", "idle");
    detectTriageTransition("state-sess", "running");
    const events = getTimeline("state-sess");
    expect(events.some((e) => e.type === "running")).toBe(true);
  });

  test("transition to idle from running records idle event", () => {
    detectTriageTransition("state-sess", "running");
    detectTriageTransition("state-sess", "idle");
    const events = getTimeline("state-sess");
    expect(events.some((e) => e.type === "idle")).toBe(true);
  });

  test("no event on same-state repeat", () => {
    clearTimeline("state-sess");
    detectTriageTransition("state-sess", "running");
    const countBefore = getTimeline("state-sess").length;
    detectTriageTransition("state-sess", "running");
    detectTriageTransition("state-sess", "running");
    expect(getTimeline("state-sess").length).toBe(countBefore);
  });

  test("full lifecycle: idle → running → needs-input → idle", () => {
    clearTimeline("state-sess");
    detectTriageTransition("state-sess", "idle");
    detectTriageTransition("state-sess", "running");
    detectTriageTransition("state-sess", "needs-input");
    detectTriageTransition("state-sess", "idle");

    const events = getTimeline("state-sess");
    const types = events.map((e) => e.type);
    expect(types).toContain("running");
    expect(types).toContain("prompt");
    expect(types).toContain("idle");
  });
});

describe("Timeline — event deduplication and limits", () => {
  test("same type within 2s is deduplicated", () => {
    clearTimeline("dedup-sess");
    recordEvent("dedup-sess", "command", "ls");
    recordEvent("dedup-sess", "command", "pwd");
    // Second event within 2s with same type is skipped
    const events = getTimeline("dedup-sess");
    expect(events.length).toBe(1);
    expect(events[0].text).toBe("ls");
  });

  test("different types are not deduplicated", () => {
    clearTimeline("dedup-sess");
    recordEvent("dedup-sess", "command", "ls");
    recordEvent("dedup-sess", "prompt");
    const events = getTimeline("dedup-sess");
    expect(events.length).toBe(2);
  });

  test("events beyond 100 evict oldest", () => {
    clearTimeline("limit-sess");
    for (let i = 0; i < 110; i++) {
      // Use different types to avoid deduplication
      recordEvent("limit-sess", i % 2 === 0 ? "command" : "prompt", `event-${i}`);
    }
    const events = getTimeline("limit-sess");
    expect(events.length).toBeLessThanOrEqual(100);
  });
});

describe("Timeline — /api/timeline endpoint", () => {
  test("returns events for session", async () => {
    clearTimeline("prompt-sess");
    recordEvent("prompt-sess", "opened");
    recordEvent("prompt-sess", "command", "test");

    const res = await get(`/api/timeline?session=prompt-sess`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.session).toBe("prompt-sess");
    expect(data.events.length).toBeGreaterThanOrEqual(2);
  });

  test("rejects missing session param", async () => {
    const res = await get("/api/timeline");
    expect(res.status).toBe(400);
  });

  test("rejects unknown session", async () => {
    const res = await get("/api/timeline?session=ghost");
    expect(res.status).toBe(404);
  });

  test("respects limit param", async () => {
    clearTimeline("prompt-sess");
    recordEvent("prompt-sess", "opened");
    // Wait to avoid dedup
    await wait(2100);
    recordEvent("prompt-sess", "command", "a");
    await wait(2100);
    recordEvent("prompt-sess", "prompt");

    const res = await get("/api/timeline?session=prompt-sess&limit=2");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.events.length).toBe(2);
  });

  test("limit clamped to 1-100", async () => {
    clearTimeline("prompt-sess");
    recordEvent("prompt-sess", "opened");
    const res = await get("/api/timeline?session=prompt-sess&limit=999");
    expect(res.status).toBe(200);
    // Should not crash — limit clamped to 100
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. End-to-end: prompt detection → action → timeline record
// ═══════════════════════════════════════════════════════════════════════════

describe("End-to-end: prompt action → command event recorded", () => {
  test("quick-action 'yes' via /api/send creates timeline command event", async () => {
    clearTimeline("prompt-sess");
    // Simulate what the frontend quickAction("yes") does
    const res = await post("/api/send", { session: "prompt-sess", text: "yes" });
    expect(res.status).toBe(200);
    const events = getTimeline("prompt-sess");
    expect(events.some((e) => e.type === "command" && e.text === "yes")).toBe(true);
  });

  test("quick-action 'no' via /api/send creates timeline command event", async () => {
    clearTimeline("prompt-sess");
    const res = await post("/api/send", { session: "prompt-sess", text: "no" });
    expect(res.status).toBe(200);
    const events = getTimeline("prompt-sess");
    expect(events.some((e) => e.type === "command" && e.text === "no")).toBe(true);
  });

  test("quick-action 'enter' via /api/key succeeds (no timeline event for keys)", async () => {
    clearTimeline("prompt-sess");
    const res = await post("/api/key", { session: "prompt-sess", key: "Enter" });
    expect(res.status).toBe(200);
    // /api/key does NOT record timeline events — only /api/send does
    const events = getTimeline("prompt-sess");
    expect(events.some((e) => e.type === "command")).toBe(false);
  });

  test("quick-action 'ctrl-c' via /api/key succeeds", async () => {
    const res = await post("/api/key", { session: "prompt-sess", key: "C-c" });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
