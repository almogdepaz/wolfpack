/**
 * BrokerBackend unit tests.
 *
 * Drives BrokerBackend against a fake broker client that records RPC calls
 * and produces canned ControlResponse values. No real socket, no real broker.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { BrokerBackend, type BrokerClientApi } from "../../src/server/broker-backend";
import type { ControlResponse, OutputBinaryFrame, EventBody } from "../../src/broker/codec";
import type { OutputSubscriber } from "../../src/broker/client";
import type { SessionLifecycleEvent } from "../../src/server/backend";
import { sessionIdentityStorePath } from "../../src/server/session-identity";

const SESSION_UUID_1 = "550e8400-e29b-41d4-a716-446655440000";
const SESSION_UUID_2 = "11111111-1111-1111-1111-111111111111";

interface RecordedRequest {
  method: string;
  params: unknown;
}

interface RecordedInput {
  sessionId: string;
  data: Uint8Array;
}

class FakeBrokerClient implements BrokerClientApi {
  requests: RecordedRequest[] = [];
  inputs: RecordedInput[] = [];
  /** Sessions currently in the active subscribe set on this fake. */
  activeSubscriptions = new Set<string>();
  /** Number of distinct subscribe RPCs observed (independent of the active set). */
  subscribeCallCount = 0;
  /** Last sinceSeq passed to subscribe, per sessionId. */
  subscribeSeqs = new Map<string, bigint | undefined>();
  /** Number of distinct unsubscribe RPCs observed. */
  unsubscribeCallCount = 0;
  /** When set, the next subscribe() call rejects with this error then resets to null. */
  nextSubscribeError: Error | null = null;
  /** Per-session output subscribers registered via subscribeOutput. */
  outputSubs = new Map<string, Set<OutputSubscriber>>();
  /** Keyed by method name; return null/undefined to fall through to default. */
  handlers = new Map<string, (params: unknown) => ControlResponse | Promise<ControlResponse>>();
  /** When set, every request rejects with this error. */
  requestError: Error | null = null;
  /** When set, writeInput throws this error. */
  inputError: Error | null = null;

  setHandler(method: string, h: (params: unknown) => ControlResponse | Promise<ControlResponse>): void {
    this.handlers.set(method, h);
  }

  async request(method: string, params: unknown = {}): Promise<ControlResponse> {
    this.requests.push({ method, params });
    if (this.requestError) throw this.requestError;
    const h = this.handlers.get(method);
    if (h) return await h(params);
    return okResp({ kind: method });
  }

  writeInput(sessionId: string, data: Uint8Array): void {
    if (this.inputError) throw this.inputError;
    // Detach so callers can compare without aliasing concerns.
    const copy = new Uint8Array(data.length);
    copy.set(data);
    this.inputs.push({ sessionId, data: copy });
  }

  subscribeOutput(sessionId: string, cb: OutputSubscriber): () => void {
    let set = this.outputSubs.get(sessionId);
    if (!set) {
      set = new Set();
      this.outputSubs.set(sessionId, set);
    }
    set.add(cb);
    return () => {
      const s = this.outputSubs.get(sessionId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.outputSubs.delete(sessionId);
    };
  }

  async subscribe(sessionId: string, opts?: { sinceSeq?: bigint }): Promise<ControlResponse> {
    this.subscribeCallCount++;
    this.subscribeSeqs.set(sessionId, opts?.sinceSeq);
    if (this.nextSubscribeError) {
      const err = this.nextSubscribeError;
      this.nextSubscribeError = null;
      throw err;
    }
    this.activeSubscriptions.add(sessionId);
    return okResp({ kind: "subscribe", ok: true });
  }

  async unsubscribe(sessionId: string): Promise<void> {
    this.unsubscribeCallCount++;
    this.activeSubscriptions.delete(sessionId);
  }

  /** Push an output_binary frame to every subscriber for `sessionId`. */
  emit(sessionId: string, data: Uint8Array, seq = 1n): void {
    const set = this.outputSubs.get(sessionId);
    if (!set) return;
    const frame: OutputBinaryFrame = { sessionId, seq, data };
    for (const cb of set) cb(frame);
  }
}

function okResp(payload: Record<string, unknown>): ControlResponse {
  return { id: 0, status: "ok", payload: { kind: "ok", ...payload } };
}

function errResp(code: string, message = "boom"): ControlResponse {
  return { id: 0, status: "error", error: { code, message } };
}

function sessionInfo(overrides: Partial<{ id: string; name: string; cwd: string; alive: boolean }> = {}) {
  return {
    id: overrides.id ?? SESSION_UUID_1,
    name: overrides.name ?? "ralph",
    cwd: overrides.cwd ?? "/tmp/work",
    alive: overrides.alive ?? true,
    cols: 120,
    rows: 40,
    pid: 1234,
    started_at_ms: 1700000000000,
    exit_code: null,
    command: ["bash", "-l"],
    env: [],
  };
}

function styledSnapshot(lines: string[], scrollback: string[] = []) {
  return {
    snapshot: {
      session_id: SESSION_UUID_1,
      seq: 0,
      cols: 120,
      rows: 40,
      visible_screen: lines.map((l) => ({
        cells: l.split("").map((ch) => ({ ch, attrs: {} })),
      })),
      scrollback: scrollback.map((l) => ({
        cells: l.split("").map((ch) => ({ ch, attrs: {} })),
      })),
      cursor: { row: 0, col: 0, visible: true, shape: "block" },
      modes: {},
      scroll_region: { top: 0, bottom: 39 },
      title: null,
      captured_at_ms: 1700000000000,
    },
  };
}

const loadSettings = () => ({ agentCmd: "shell" });

let client: FakeBrokerClient;
let backend: BrokerBackend;

beforeEach(() => {
  process.env.WOLFPACK_TEST = "1";
  process.env.WOLFPACK_SESSION_IDENTITY_PATH = `${process.cwd()}/.wolfpack/broker-backend-identity-${process.pid}.json`;
  rmSync(sessionIdentityStorePath(), { force: true });
  client = new FakeBrokerClient();
  backend = new BrokerBackend(client);
});

describe("BrokerBackend.list", () => {
  test("returns names from list_sessions and populates name→id index", async () => {
    client.setHandler("list_sessions", () => okResp({
      sessions: [sessionInfo({ name: "alpha", id: SESSION_UUID_1 }),
                 sessionInfo({ name: "beta", id: SESSION_UUID_2 })],
    }));
    const names = await backend.list();
    expect(names).toEqual(["alpha", "beta"]);
    // Cached for sync sessionDir lookup
    expect(backend.sessionDir("alpha")).toBe("/tmp/work");
    expect(backend.sessionDir("beta")).toBe("/tmp/work");
    expect(backend.sessionDir("ghost")).toBeUndefined();
  });

  test("prunes stale entries when broker drops a session", async () => {
    client.setHandler("list_sessions", () => okResp({
      sessions: [sessionInfo({ name: "alpha", id: SESSION_UUID_1 })],
    }));
    await backend.list();
    expect(backend.sessionDir("alpha")).toBe("/tmp/work");

    client.setHandler("list_sessions", () => okResp({ sessions: [] }));
    const names = await backend.list();
    expect(names).toEqual([]);
    expect(backend.sessionDir("alpha")).toBeUndefined();
    expect(backend.isSessionAlive("alpha")).toBe(false);
  });

  test("propagates broker errors", async () => {
    client.setHandler("list_sessions", () => errResp("internal_error", "broker exploded"));
    await expect(backend.list()).rejects.toThrow(/internal_error/);
  });
});

describe("BrokerBackend.createSession", () => {
  test("issues create_session with shell command for 'shell' agent and caches id", async () => {
    client.setHandler("create_session", () => okResp({
      session: sessionInfo({ name: "newone", id: SESSION_UUID_1 }),
    }));
    await backend.createSession("newone", "/tmp/proj", "shell", loadSettings);
    const create = client.requests.find((r) => r.method === "create_session");
    expect(create).toBeDefined();
    const params = create!.params as { name: string; cwd: string; command: string[]; env: Array<[string, string]>; cols: number; rows: number };
    expect(params.name).toBe("newone");
    expect(params.cwd).toBe("/tmp/proj");
    expect(params.command[0]).toMatch(/sh|bash|zsh/);
    expect(params.command[1]).toBe("-lic");
    expect(params.cols).toBeGreaterThan(0);
    expect(params.rows).toBeGreaterThan(0);
    const envKeys = params.env.map(([k]) => k);
    expect(envKeys).toContain("TERM");
    expect(params.env).toContainEqual(["WOLFPACK_PROJECT_DIR", "/tmp/proj"]);
    expect(params.env).toContainEqual(["WOLFPACK_SESSION_NAME", "newone"]);
    expect(envKeys).toContain("WOLFPACK_AGENT_KIND");
    // sessionDir is now resolvable without another list call
    expect(backend.sessionDir("newone")).toBe("/tmp/work");
  });

  test("captures launch identity without terminal prose scraping", async () => {
    client.setHandler("create_session", () => okResp({
      session: sessionInfo({ name: "codex-one", id: SESSION_UUID_1 }),
    }));
    await backend.createSession("codex-one", "/tmp/proj", "codex", loadSettings);

    const identities = await backend.listIdentities();
    expect(identities["codex-one"]).toMatchObject({
      wolfpackSessionId: SESSION_UUID_1,
      wolfpackSessionName: "codex-one",
      projectPath: "/tmp/proj",
      agentKind: "codex",
    });
    expect(identities["codex-one"]).not.toHaveProperty("alive");
    expect(identities["codex-one"]).not.toHaveProperty("lastLine");
  });

  test("translates duplicate_session_name into legacy DUPLICATE_SESSION error", async () => {
    client.setHandler("create_session", () => errResp("duplicate_session_name", "in use"));
    let caught: { code?: string } | null = null;
    try {
      await backend.createSession("dup", "/tmp", "shell", loadSettings);
    } catch (e: unknown) {
      caught = e as { code?: string };
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("DUPLICATE_SESSION");
  });

  test("rejects invalid commands before reaching broker", async () => {
    let calledBroker = false;
    client.setHandler("create_session", () => { calledBroker = true; return okResp({ session: sessionInfo() }); });
    await expect(
      backend.createSession("bad", "/tmp", "rm -rf /; echo pwned", loadSettings),
    ).rejects.toThrow(/invalid command/);
    expect(calledBroker).toBe(false);
  });
});

describe("BrokerBackend.killSession", () => {
  test("resolves name→id then calls kill_session and drops cache", async () => {
    client.setHandler("list_sessions", () => okResp({
      sessions: [sessionInfo({ name: "doomed", id: SESSION_UUID_1 })],
    }));
    await backend.list();
    expect((await backend.listIdentities()).doomed).toBeDefined();
    let killParams: { session_id: string } | undefined;
    client.setHandler("kill_session", (p) => { killParams = p as { session_id: string }; return okResp({ killed: true }); });
    await backend.killSession("doomed");
    expect(killParams?.session_id).toBe(SESSION_UUID_1);
    expect(backend.sessionDir("doomed")).toBeUndefined();
    expect(backend.isSessionAlive("doomed")).toBe(false);
    expect((await backend.listIdentities()).doomed).toBeUndefined();
  });

  test("no-op when session unknown to broker", async () => {
    client.setHandler("list_sessions", () => okResp({ sessions: [] }));
    await backend.killSession("ghost");
    const calledKill = client.requests.some((r) => r.method === "kill_session");
    expect(calledKill).toBe(false);
  });

  test("swallows unknown_session from broker (concurrent kill is fine)", async () => {
    client.setHandler("list_sessions", () => okResp({
      sessions: [sessionInfo({ name: "racy", id: SESSION_UUID_1 })],
    }));
    await backend.list();
    client.setHandler("kill_session", () => errResp("unknown_session", "gone"));
    await backend.killSession("racy"); // no throw
    expect(backend.sessionDir("racy")).toBeUndefined();
  });

  test("swallows session_not_alive from broker (already-dead is fine)", async () => {
    client.setHandler("list_sessions", () => okResp({
      sessions: [sessionInfo({ name: "stiff", id: SESSION_UUID_1 })],
    }));
    await backend.list();
    client.setHandler("kill_session", () => errResp("session_not_alive", "exited"));
    await backend.killSession("stiff"); // no throw
    expect(backend.sessionDir("stiff")).toBeUndefined();
    expect(backend.isSessionAlive("stiff")).toBe(false);
  });
});

describe("BrokerBackend.hasSession", () => {
  test("true for live cached session, false for dead one", async () => {
    client.setHandler("list_sessions", () => okResp({
      sessions: [
        sessionInfo({ name: "alive-one", id: SESSION_UUID_1, alive: true }),
        sessionInfo({ name: "dead-one", id: SESSION_UUID_2, alive: false }),
      ],
    }));
    await backend.list();
    expect(await backend.hasSession("alive-one")).toBe(true);
    expect(await backend.hasSession("dead-one")).toBe(false);
    expect(await backend.hasSession("ghost")).toBe(false);
  });
});

describe("BrokerBackend.capturePane", () => {
  test("renders snapshot styled cells into plain text (scrollback first, then visible)", async () => {
    client.setHandler("list_sessions", () => okResp({
      sessions: [sessionInfo({ name: "tui", id: SESSION_UUID_1 })],
    }));
    await backend.list();
    client.setHandler("snapshot", () => okResp(styledSnapshot(["hello", "world"], ["older"])));
    const text = await backend.capturePane("tui");
    expect(text).toBe("older\nhello\nworld");
  });

  test("returns empty string when broker fails", async () => {
    client.setHandler("list_sessions", () => okResp({
      sessions: [sessionInfo({ name: "tui", id: SESSION_UUID_1 })],
    }));
    await backend.list();
    client.setHandler("snapshot", () => errResp("internal_error"));
    expect(await backend.capturePane("tui")).toBe("");
  });

  test("returns empty when session unknown", async () => {
    client.setHandler("list_sessions", () => okResp({ sessions: [] }));
    expect(await backend.capturePane("ghost")).toBe("");
  });

  test("triage cache hits within TTL avoid a second snapshot RPC", async () => {
    client.setHandler("list_sessions", () => okResp({
      sessions: [sessionInfo({ name: "tui", id: SESSION_UUID_1 })],
    }));
    await backend.list();
    let snapshotCalls = 0;
    client.setHandler("snapshot", () => {
      snapshotCalls++;
      return okResp(styledSnapshot(["x"]));
    });
    await backend.capturePaneForTriage("tui");
    await backend.capturePaneForTriage("tui");
    expect(snapshotCalls).toBe(1);
  });
});

describe("BrokerBackend.resize", () => {
  test("forwards to broker resize RPC", async () => {
    client.setHandler("list_sessions", () => okResp({
      sessions: [sessionInfo({ name: "tui", id: SESSION_UUID_1 })],
    }));
    await backend.list();
    let resizeParams: { session_id: string; cols: number; rows: number } | undefined;
    client.setHandler("resize", (p) => {
      resizeParams = p as { session_id: string; cols: number; rows: number };
      return okResp({ ok: true });
    });
    await backend.resize("tui", 100, 30);
    expect(resizeParams).toEqual({ session_id: SESSION_UUID_1, cols: 100, rows: 30 });
  });

  test("no-op for unknown session", async () => {
    client.setHandler("list_sessions", () => okResp({ sessions: [] }));
    await backend.resize("ghost", 80, 24);
    const called = client.requests.some((r) => r.method === "resize");
    expect(called).toBe(false);
  });

  test("propagates broker resize errors", async () => {
    client.setHandler("list_sessions", () => okResp({
      sessions: [sessionInfo({ name: "tui", id: SESSION_UUID_1 })],
    }));
    await backend.list();
    client.setHandler("resize", () => errResp("unsupported", "resize not implemented"));
    await expect(backend.resize("tui", 100, 30)).rejects.toThrow("resize not implemented");
    const resizeCalled = client.requests.some((r) => r.method === "resize");
    expect(resizeCalled).toBe(true);
  });
});

describe("BrokerBackend send/sendKey/writeToTerminal route through input_binary", () => {
  beforeEach(async () => {
    client.setHandler("list_sessions", () => okResp({
      sessions: [sessionInfo({ name: "live", id: SESSION_UUID_1 })],
    }));
    await backend.list();
  });

  test("send appends \\r by default", async () => {
    await backend.send("live", "ls");
    expect(client.inputs.length).toBe(1);
    expect(client.inputs[0].sessionId).toBe(SESSION_UUID_1);
    expect(new TextDecoder().decode(client.inputs[0].data)).toBe("ls\r");
  });

  test("send with noEnter omits the trailing CR", async () => {
    await backend.send("live", "partial", true);
    expect(new TextDecoder().decode(client.inputs[0].data)).toBe("partial");
  });

  test("sendKey maps named key to control sequence", async () => {
    await backend.sendKey("live", "C-c");
    expect(client.inputs[0].data[0]).toBe(0x03);
    expect(client.inputs[0].data.length).toBe(1);
  });

  test("sendKey passes single-char key through verbatim", async () => {
    await backend.sendKey("live", "q");
    expect(new TextDecoder().decode(client.inputs[0].data)).toBe("q");
  });

  test("sendKey ignores unknown key without throwing", async () => {
    await backend.sendKey("live", "F99");
    expect(client.inputs.length).toBe(0);
  });

  test("writeToTerminal forwards raw bytes for cached session", () => {
    expect(backend.writeToTerminal("live", Buffer.from([0x01, 0x02, 0x03]))).toBe(true);
    expect(client.inputs[0].sessionId).toBe(SESSION_UUID_1);
    expect(Array.from(client.inputs[0].data)).toEqual([0x01, 0x02, 0x03]);
  });

  test("writeToTerminal reports false for unknown sessions", () => {
    expect(backend.writeToTerminal("ghost", "hi")).toBe(false);
    expect(client.inputs.length).toBe(0);
  });

  test("writeToTerminal reports false when broker input write throws", () => {
    client.inputError = new Error("input plane down");
    expect(backend.writeToTerminal("live", "hi")).toBe(false);
    expect(client.inputs.length).toBe(0);
  });

  test("send is a no-op for unknown sessions (no broker chatter beyond list refresh)", async () => {
    const before = client.inputs.length;
    client.setHandler("list_sessions", () => okResp({ sessions: [] }));
    await backend.send("ghost", "hi");
    expect(client.inputs.length).toBe(before);
  });
});

describe("BrokerBackend.cleanupOrphans", () => {
  test("refreshes the local index from broker truth", async () => {
    let listCalls = 0;
    client.setHandler("list_sessions", () => { listCalls++; return okResp({ sessions: [] }); });
    await backend.cleanupOrphans();
    expect(listCalls).toBe(1);
  });

  test("swallows broker errors", async () => {
    client.setHandler("list_sessions", () => errResp("internal_error"));
    await backend.cleanupOrphans(); // no throw
  });
});

describe("BrokerBackend.isSessionAlive", () => {
  test("reflects cached liveness", async () => {
    client.setHandler("list_sessions", () => okResp({
      sessions: [sessionInfo({ name: "live", id: SESSION_UUID_1, alive: true })],
    }));
    await backend.list();
    expect(backend.isSessionAlive("live")).toBe(true);
    expect(backend.isSessionAlive("ghost")).toBe(false);
  });
});

describe("BrokerBackend.onSessionData (refcounted broker subscribe)", () => {
  // Tests below that don't care about subscribe-error semantics still need
  // to satisfy the now-required onSubscribeError contract. This noop is
  // fine because these tests exercise the success path or assert on the
  // FakeBrokerClient state directly, not the callback.
  const noopErr = { onSubscribeError: () => {} };

  beforeEach(async () => {
    client.setHandler("list_sessions", () => okResp({
      sessions: [sessionInfo({ name: "live", id: SESSION_UUID_1 })],
    }));
    await backend.list();
  });

  test("returns null for unknown session", () => {
    expect(backend.onSessionData("ghost", () => {}, noopErr)).toBeNull();
  });

  test("first onSessionData call issues exactly one subscribe RPC", async () => {
    backend.onSessionData("live", () => {}, noopErr);
    await Promise.resolve(); // let the fire-and-forget subscribe settle
    expect(client.subscribeCallCount).toBe(1);
    expect(client.activeSubscriptions.has(SESSION_UUID_1)).toBe(true);
  });

  test("a second subscriber for the same session reuses the broker subscribe", async () => {
    backend.onSessionData("live", () => {}, noopErr);
    backend.onSessionData("live", () => {}, noopErr);
    await Promise.resolve();
    expect(client.subscribeCallCount).toBe(1);
    expect(client.unsubscribeCallCount).toBe(0);
  });

  test("releases the broker subscribe only when the last subscriber detaches", async () => {
    const unsubA = backend.onSessionData("live", () => {}, noopErr)!;
    const unsubB = backend.onSessionData("live", () => {}, noopErr)!;
    await Promise.resolve();
    expect(client.subscribeCallCount).toBe(1);

    unsubA();
    await Promise.resolve();
    expect(client.unsubscribeCallCount).toBe(0);
    expect(client.activeSubscriptions.has(SESSION_UUID_1)).toBe(true);

    unsubB();
    await Promise.resolve();
    expect(client.unsubscribeCallCount).toBe(1);
    expect(client.activeSubscriptions.has(SESSION_UUID_1)).toBe(false);
  });

  test("subscribers see broker output frames as raw Uint8Array data", async () => {
    const seenA: number[] = [];
    const seenB: number[] = [];
    backend.onSessionData("live", (d) => seenA.push(d[0]), noopErr);
    backend.onSessionData("live", (d) => seenB.push(d[0]), noopErr);
    await Promise.resolve();
    client.emit(SESSION_UUID_1, new Uint8Array([0x41]));
    client.emit(SESSION_UUID_1, new Uint8Array([0x42]));
    expect(seenA).toEqual([0x41, 0x42]);
    expect(seenB).toEqual([0x41, 0x42]);
  });

  test("calling the returned unsubscribe twice is a no-op (idempotent)", async () => {
    const unsub = backend.onSessionData("live", () => {}, noopErr)!;
    await Promise.resolve();
    unsub();
    unsub();
    await Promise.resolve();
    expect(client.unsubscribeCallCount).toBe(1);
  });

  test("unsubscribe stops further frames reaching the callback", async () => {
    const seen: number[] = [];
    const unsub = backend.onSessionData("live", (d) => seen.push(d[0]), noopErr)!;
    await Promise.resolve();
    client.emit(SESSION_UUID_1, new Uint8Array([1]));
    unsub();
    client.emit(SESSION_UUID_1, new Uint8Array([2]));
    expect(seen).toEqual([1]);
  });

  test("sinceSeq is forwarded to the broker subscribe RPC", async () => {
    backend.onSessionData("live", () => {}, { sinceSeq: 42n, onSubscribeError: () => {} });
    await Promise.resolve();
    expect(client.subscribeSeqs.get(SESSION_UUID_1)).toBe(42n);
  });

  test("no sinceSeq option passes undefined to broker subscribe", async () => {
    backend.onSessionData("live", () => {}, noopErr);
    await Promise.resolve();
    expect(client.subscribeSeqs.get(SESSION_UUID_1)).toBeUndefined();
  });

  test("subscribe RPC failure unwinds local subscriber and refcount (no leak)", async () => {
    client.nextSubscribeError = new Error("transport error");
    backend.onSessionData("live", () => {}, noopErr);
    // Allow the fire-and-forget promise to settle through the rejection
    await new Promise((r) => setTimeout(r, 0));
    // Output subscriber must have been removed
    expect(client.outputSubs.has(SESSION_UUID_1)).toBe(false);
    // The session must no longer be in the active broker subscription set
    expect(client.activeSubscriptions.has(SESSION_UUID_1)).toBe(false);
    // A second onSessionData call must re-issue the subscribe RPC (refcount was cleaned up)
    backend.onSessionData("live", () => {}, noopErr);
    await new Promise((r) => setTimeout(r, 0));
    expect(client.subscribeCallCount).toBe(2);
  });

  // Regression: subscribe-RPC failure must not leave the WS open with no
  // data stream. broker-backend invokes opts.onSubscribeError so the WS
  // layer can tear down the viewer instead of leaving it idle.
  test("subscribe RPC failure invokes opts.onSubscribeError exactly once", async () => {
    const errors: unknown[] = [];
    client.nextSubscribeError = new Error("broker exploded");
    backend.onSessionData("live", () => {}, {
      onSubscribeError: (e) => errors.push(e),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("broker exploded");
  });

  test("onSubscribeError is NOT invoked on successful subscribe", async () => {
    const errors: unknown[] = [];
    backend.onSessionData("live", () => {}, {
      onSubscribeError: (e) => errors.push(e),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual([]);
  });

  test("onSubscribeError is only invoked for the first subscriber (the one that issued the RPC)", async () => {
    // The subscribe RPC is issued only by the first subscriber. If a second
    // subscriber attaches while the RPC is still in flight and the RPC fails,
    // only the first subscriber's onSubscribeError should fire — a second
    // subscriber is reusing an existing (in-flight, eventually failed) RPC,
    // not issuing its own. The current implementation invokes the callback
    // attached to the first subscriber; second subscriber gets nothing.
    client.nextSubscribeError = new Error("broker exploded");
    const firstErrors: unknown[] = [];
    const secondErrors: unknown[] = [];
    backend.onSessionData("live", () => {}, {
      onSubscribeError: (e) => firstErrors.push(e),
    });
    backend.onSessionData("live", () => {}, {
      onSubscribeError: (e) => secondErrors.push(e),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(firstErrors).toHaveLength(1);
    expect(secondErrors).toHaveLength(0);
  });

  test("a throwing onSubscribeError callback does not crash the unwind path", async () => {
    client.nextSubscribeError = new Error("transport error");
    expect(() => {
      backend.onSessionData("live", () => {}, {
        onSubscribeError: () => { throw new Error("callback threw"); },
      });
    }).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    // Real refcount probe: FakeBrokerClient.subscribe rejects BEFORE
    // activeSubscriptions.add runs, so checking that set is tautological.
    // Instead, verify the BrokerBackend.subscriberRefs map was unwound by
    // issuing a follow-up subscribe — if the prior ref leaked, this call
    // would reuse it and subscribeCallCount would stay at 1. A clean
    // unwind => fresh RPC.
    expect(client.subscribeCallCount).toBe(1);
    backend.onSessionData("live", () => {}, noopErr);
    await new Promise((r) => setTimeout(r, 0));
    expect(client.subscribeCallCount).toBe(2);
  });
});

describe("BrokerBackend.ingestEvent + onSessionLifecycle", () => {
  beforeEach(async () => {
    client.setHandler("list_sessions", () => okResp({
      sessions: [sessionInfo({ name: "live", id: SESSION_UUID_1, alive: true })],
    }));
    await backend.list();
  });

  function exitedEvent(id: string, exitCode?: number, signal?: number): EventBody {
    const ev: EventBody = { event: "session_exited", session_id: id };
    if (exitCode !== undefined) ev.exit_code = exitCode;
    if (signal !== undefined) ev.signal = signal;
    return ev;
  }

  test("session_exited flips cached alive=false and fires registered lifecycle callbacks", () => {
    const seen: SessionLifecycleEvent[] = [];
    const unsub = backend.onSessionLifecycle("live", (e) => seen.push(e));
    expect(unsub).not.toBeNull();
    expect(backend.isSessionAlive("live")).toBe(true);

    backend.ingestEvent(exitedEvent(SESSION_UUID_1, 0));

    expect(backend.isSessionAlive("live")).toBe(false);
    expect(seen).toEqual([{ kind: "exited", exitCode: 0, signal: undefined }]);
  });

  test("session_exited carries signal field when present, exit_code absent", () => {
    const seen: SessionLifecycleEvent[] = [];
    backend.onSessionLifecycle("live", (e) => seen.push(e));
    backend.ingestEvent({ event: "session_exited", session_id: SESSION_UUID_1, signal: 15 });
    expect(seen).toEqual([{ kind: "exited", exitCode: undefined, signal: 15 }]);
  });

  test("session_exited drops the triage cache for the affected session", async () => {
    client.setHandler("snapshot", () => okResp(styledSnapshot(["before"])));
    await backend.capturePaneForTriage("live"); // populate cache
    let snapshotCalls = 0;
    client.setHandler("snapshot", () => {
      snapshotCalls++;
      return okResp(styledSnapshot(["after"]));
    });

    backend.ingestEvent(exitedEvent(SESSION_UUID_1));

    await backend.capturePaneForTriage("live");
    expect(snapshotCalls).toBe(1); // cache miss → fresh RPC
  });

  test("session_exited for unknown id is a no-op (no throw, no callback fires)", () => {
    const seen: SessionLifecycleEvent[] = [];
    backend.onSessionLifecycle("live", (e) => seen.push(e));
    backend.ingestEvent(exitedEvent(SESSION_UUID_2));
    expect(seen).toEqual([]);
    expect(backend.isSessionAlive("live")).toBe(true);
  });

  test("snapshot_invalidated drops the triage cache without touching liveness", async () => {
    client.setHandler("snapshot", () => okResp(styledSnapshot(["v1"])));
    await backend.capturePaneForTriage("live");
    let snapshotCalls = 0;
    client.setHandler("snapshot", () => {
      snapshotCalls++;
      return okResp(styledSnapshot(["v2"]));
    });

    backend.ingestEvent({ event: "snapshot_invalidated", session_id: SESSION_UUID_1 });

    expect(backend.isSessionAlive("live")).toBe(true);
    await backend.capturePaneForTriage("live");
    expect(snapshotCalls).toBe(1);
  });

  test("session_resized is a no-op (does not mutate liveness or fire lifecycle)", () => {
    const seen: SessionLifecycleEvent[] = [];
    backend.onSessionLifecycle("live", (e) => seen.push(e));
    backend.ingestEvent({ event: "session_resized", session_id: SESSION_UUID_1, cols: 200, rows: 60 });
    expect(seen).toEqual([]);
    expect(backend.isSessionAlive("live")).toBe(true);
  });

  test("unknown event names are silently ignored (additive protocol)", () => {
    const seen: SessionLifecycleEvent[] = [];
    backend.onSessionLifecycle("live", (e) => seen.push(e));
    backend.ingestEvent({ event: "session_started", session: sessionInfo({ name: "live", id: SESSION_UUID_1 }) });
    backend.ingestEvent({ event: "v2_only_event", session_id: SESSION_UUID_1 });
    expect(seen).toEqual([]);
    expect(backend.isSessionAlive("live")).toBe(true);
  });

  test("onSessionLifecycle returns null for unknown sessions", () => {
    expect(backend.onSessionLifecycle("ghost", () => {})).toBeNull();
  });

  test("unsubscribed callback does not fire on subsequent session_exited", () => {
    const seen: SessionLifecycleEvent[] = [];
    const unsub = backend.onSessionLifecycle("live", (e) => seen.push(e))!;
    unsub();
    backend.ingestEvent(exitedEvent(SESSION_UUID_1, 0));
    expect(seen).toEqual([]);
  });

  test("unsubscribe is idempotent", () => {
    const seen: SessionLifecycleEvent[] = [];
    const unsub = backend.onSessionLifecycle("live", (e) => seen.push(e))!;
    unsub();
    unsub();
    backend.ingestEvent(exitedEvent(SESSION_UUID_1));
    expect(seen).toEqual([]);
  });

  test("multiple subscribers all receive the exit event", () => {
    const a: SessionLifecycleEvent[] = [];
    const b: SessionLifecycleEvent[] = [];
    backend.onSessionLifecycle("live", (e) => a.push(e));
    backend.onSessionLifecycle("live", (e) => b.push(e));
    backend.ingestEvent(exitedEvent(SESSION_UUID_1, 137, 9));
    expect(a).toEqual([{ kind: "exited", exitCode: 137, signal: 9 }]);
    expect(b).toEqual([{ kind: "exited", exitCode: 137, signal: 9 }]);
  });

  test("a callback that throws does not block other subscribers", () => {
    const seen: SessionLifecycleEvent[] = [];
    backend.onSessionLifecycle("live", () => { throw new Error("boom"); });
    backend.onSessionLifecycle("live", (e) => seen.push(e));
    backend.ingestEvent(exitedEvent(SESSION_UUID_1, 0));
    expect(seen).toEqual([{ kind: "exited", exitCode: 0, signal: undefined }]);
  });

  test("a callback that detaches itself during dispatch does not skip others", () => {
    const seen: string[] = [];
    let unsubA: (() => void) | null = null;
    unsubA = backend.onSessionLifecycle("live", () => {
      seen.push("a");
      unsubA?.();
    });
    backend.onSessionLifecycle("live", () => seen.push("b"));
    backend.ingestEvent(exitedEvent(SESSION_UUID_1));
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  // Regression: onReplayTruncated must reach lifecycle subscribers as a
  // `replay_truncated` event so the WS layer can force a viewer reconnect
  // for fresh prefill.
  test("handleReplayTruncated fires a replay_truncated event to subscribers", () => {
    const seen: SessionLifecycleEvent[] = [];
    backend.onSessionLifecycle("live", (e) => seen.push(e));
    backend.handleReplayTruncated(SESSION_UUID_1);
    expect(seen).toEqual([{ kind: "replay_truncated" }]);
  });

  test("handleReplayTruncated for unknown id is a silent no-op", () => {
    const seen: SessionLifecycleEvent[] = [];
    backend.onSessionLifecycle("live", (e) => seen.push(e));
    backend.handleReplayTruncated(SESSION_UUID_2);
    expect(seen).toEqual([]);
  });

  test("handleReplayTruncated does NOT touch alive state (cache stays valid)", () => {
    expect(backend.isSessionAlive("live")).toBe(true);
    backend.handleReplayTruncated(SESSION_UUID_1);
    // The session is still alive in the broker — only its replay window
    // overran. Liveness must not flip; only the WS reconnect is forced.
    expect(backend.isSessionAlive("live")).toBe(true);
  });
});

describe("BrokerBackend.getSessionPrefill (snapshot → ANSI bytes)", () => {
  beforeEach(async () => {
    client.setHandler("list_sessions", () => okResp({
      sessions: [sessionInfo({ name: "live", id: SESSION_UUID_1 })],
    }));
    await backend.list();
  });

  test("returns empty data for unknown session", async () => {
    client.setHandler("list_sessions", () => okResp({ sessions: [] }));
    const prefill = await backend.getSessionPrefill("ghost");
    expect(prefill.data.length).toBe(0);
    expect(prefill.seq).toBeUndefined();
  });

  test("returns empty data when the broker rejects the snapshot RPC", async () => {
    client.setHandler("snapshot", () => errResp("internal_error"));
    const prefill = await backend.getSessionPrefill("live");
    expect(prefill.data.length).toBe(0);
    expect(prefill.seq).toBeUndefined();
  });

  test("renders snapshot to ANSI: clear + scrollback + visible + cursor", async () => {
    client.setHandler("snapshot", () => okResp(styledSnapshot(["hello"], ["older"])));
    const prefill = await backend.getSessionPrefill("live");
    const text = prefill.data.toString("utf8");
    expect(text.startsWith("\x1b[2J\x1b[3J\x1b[H\x1b[0m")).toBe(true);
    expect(text).toContain("older\r\n");
    expect(text).toContain("hello");
    // Cursor positioning lands at the end (1-based).
    expect(text).toMatch(/\x1b\[1;1H\x1b\[\?25h$/);
  });

  test("seq from snapshot is returned as bigint", async () => {
    const snap = styledSnapshot(["line"]);
    snap.snapshot.seq = 9001;
    client.setHandler("snapshot", () => okResp(snap));
    const prefill = await backend.getSessionPrefill("live");
    expect(prefill.seq).toBe(9001n);
  });

  test("seq is undefined when snapshot has no seq field", async () => {
    const snap = styledSnapshot(["line"]);
    delete (snap.snapshot as { seq?: number }).seq;
    client.setHandler("snapshot", () => okResp(snap));
    const prefill = await backend.getSessionPrefill("live");
    expect(prefill.seq).toBeUndefined();
  });
});
