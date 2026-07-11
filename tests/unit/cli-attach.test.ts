import { describe, expect, test } from "bun:test";
import {
  attachWsUrl,
  createRawModeRestorer,
  explainWsClose,
  parseAttachCommand,
  resolveAttachTarget,
  terminalSize,
} from "../../src/cli/attach.ts";

describe("parseAttachCommand", () => {
  test("parses session, takeover, and prefill modes", () => {
    expect(parseAttachCommand(["alpha"])).toEqual({ session: "alpha", takeControl: false, prefillMode: "full" });
    expect(parseAttachCommand(["alpha", "--take-control", "--prefill", "none"]))
      .toEqual({ session: "alpha", takeControl: true, prefillMode: "none" });
    expect(parseAttachCommand(["--force", "--no-prefill", "alpha"]))
      .toEqual({ session: "alpha", takeControl: true, prefillMode: "none" });
    expect(parseAttachCommand(["alpha", "--prefill=full"]))
      .toEqual({ session: "alpha", takeControl: false, prefillMode: "full" });
  });

  test("rejects unknown flags, bad prefill values, and extra targets", () => {
    expect(parseAttachCommand(["alpha", "beta"])).toBeNull();
    expect(parseAttachCommand(["alpha", "--wat"])).toBeNull();
    expect(parseAttachCommand(["alpha", "--prefill", "fast"])).toBeNull();
  });
});

describe("resolveAttachTarget", () => {
  test("resolves exact target or the only active session", () => {
    expect(resolveAttachTarget("alpha", ["alpha", "beta"])).toEqual({ ok: true, session: "alpha" });
    expect(resolveAttachTarget(undefined, ["solo"])).toEqual({ ok: true, session: "solo" });
  });

  test("rejects invalid, missing, absent, and ambiguous targets", () => {
    expect(resolveAttachTarget("bad/name", ["bad/name"]).ok).toBe(false);
    expect(resolveAttachTarget("gamma", ["alpha", "beta"])).toEqual({ ok: false, message: 'session "gamma" not found' });
    expect(resolveAttachTarget(undefined, [])).toEqual({ ok: false, message: "no active sessions" });
    expect(resolveAttachTarget(undefined, ["alpha", "beta"])).toEqual({
      ok: false,
      message: "multiple sessions; specify one: alpha, beta",
    });
  });
});

describe("attach terminal helpers", () => {
  test("uses stdout dimensions with stable fallbacks", () => {
    expect(terminalSize({ columns: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });
    expect(terminalSize({ columns: 0, rows: Number.NaN })).toEqual({ cols: 80, rows: 24 });
  });

  test("raw-mode restorer restores once", () => {
    const calls: boolean[] = [];
    const stream = {
      isTTY: true,
      setRawMode: (enabled: boolean) => { calls.push(enabled); },
      resume: () => {},
      pause: () => {},
    };
    const restore = createRawModeRestorer(stream);
    restore();
    restore();
    expect(calls).toEqual([true, false]);
  });

  test("maps ws close codes to cli exit semantics", () => {
    expect(explainWsClose(1000, "")).toEqual({ exitCode: 0, message: null });
    expect(explainWsClose(4001, "")).toEqual({ exitCode: 3, message: "session unavailable" });
    expect(explainWsClose(4002, "")).toEqual({ exitCode: 2, message: "attach displaced by another viewer" });
    expect(explainWsClose(1011, "subscribe rpc failed")).toEqual({ exitCode: 4, message: "subscribe rpc failed" });
  });

  test("builds /ws/pty url and appends jwt token when configured", () => {
    const prev = process.env.WOLFPACK_JWT_SECRET;
    process.env.WOLFPACK_JWT_SECRET = "x".repeat(32);
    try {
      const url = new URL(attachWsUrl("alpha", "https://box.example.test:9999/"));
      expect(url.protocol).toBe("wss:");
      expect(url.pathname).toBe("/ws/pty");
      expect(url.searchParams.get("session")).toBe("alpha");
      expect(url.searchParams.get("token")).toBeTruthy();
    } finally {
      if (prev === undefined) delete process.env.WOLFPACK_JWT_SECRET;
      else process.env.WOLFPACK_JWT_SECRET = prev;
    }
  });
});
