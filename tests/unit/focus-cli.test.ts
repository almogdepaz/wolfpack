import { expect, test } from "bun:test";
import type { FocusTriage } from "../../src/focus-contract.ts";
import { parseFocusCommand, updateFocusWithRetry } from "../../src/cli/focus.ts";

test("focus CLI parses every operation with explicit link/project/machine fields", () => {
  expect(parseFocusCommand(["add", "ship", "--id", "ship", "--project", "/a", "--on", "sgt", "--sessions", "a,b", "--json"]).op).toEqual({ type: "add", intention: { id: "ship", title: "ship", project: "/a", machine: "sgt", sessions: ["a", "b"] } });
  expect(parseFocusCommand(["edit", "ship", "new title"]).op).toEqual({ type: "edit", id: "ship", patch: { title: "new title" } });
  for (const cmd of ["done", "undo", "drop"] as const) expect(parseFocusCommand([cmd, "ship"]).op).toEqual({ type: cmd, id: "ship" });
  expect(parseFocusCommand(["reorder", "b", "a"]).op).toEqual({ type: "reorder", ids: ["b", "a"] });
  expect(parseFocusCommand(["nudge", "do this"]).op).toEqual({ type: "nudge", text: "do this", author: "assistant" });
  expect(() => parseFocusCommand(["reply", "broker leak first"])).toThrow();
  expect(parseFocusCommand(["note", "remember"]).op).toEqual({ type: "note", text: "remember" });
  expect(parseFocusCommand(["day-summary", "2026-11-05", "4", "2", "1"]).op).toEqual({ type: "day-summary", summary: { date: "2026-11-05", done: 4, carried: 2, questions: 1 } });
  expect(() => parseFocusCommand(["done", "ship", "junk"])).toThrow();
  expect(() => parseFocusCommand(["add", "ship", "--wat", "x"])).toThrow();
});
test("focus next parses a JSON input file through the same reducer validation", () => {
  const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const root = mkdtempSync(join(tmpdir(), "focus-next-"));
  const file = join(root, "next.json");
  const rows: FocusTriage[] = [{ ref: { machine: "peer-id", sessionId: "session-id" }, stoppedAt: "2026-11-06T12:00:00Z", verdict: "quiet", reason: "Nothing for you" }];
  try {
    writeFileSync(file, JSON.stringify(rows));
    expect(parseFocusCommand(["next", file, "--json"])).toEqual({ json: true, op: { type: "next", rows, author: "assistant" } });
    const second = { ...rows[0]!, ref: { machine: "peer-id", sessionId: "second" } };
    writeFileSync(file, JSON.stringify([...rows, second]));
    expect(parseFocusCommand(["next", file, "--take", "Plan first; release depends on it.", "--about", "2,1", "--json"])).toEqual({ json: true,
      op: { type: "next", rows: [...rows, second], author: "assistant", take: { text: "Plan first; release depends on it.", about: [second.ref, rows[0]!.ref] } } });
    expect(parseFocusCommand(["next", file, "--take", "Where does add eggs belong?"]).op).toMatchObject({ take: { text: "Where does add eggs belong?", about: [] } });
    for (const flags of [["--about", "1"], ["--take"], ["--take", "hi", "--about"], ["--take", "hi", "--about", "0"],
      ["--take", "hi", "--about", "3"], ["--take", "hi", "--about", "1,1"], ["--take", "hi", "--about", "1.0"],
      ["--take", "hi", "--about", "1,"], ["--take", "hi", "--about", ""], ["--take", "hi", "--unknown", "1"],
      ["--take", "hi", "--take", "again"], ["--take", "x".repeat(201)]]) expect(() => parseFocusCommand(["next", file, ...flags])).toThrow();
    writeFileSync(file, JSON.stringify([{ ...rows[0], verdict: "sent" }]));
    expect(() => parseFocusCommand(["next", file])).toThrow();
    writeFileSync(file, "{bad json");
    expect(() => parseFocusCommand(["next", file])).toThrow();
    expect(() => parseFocusCommand(["next", file, "extra"])).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("remote focus help never resolves a machine or starts a server", () => {
  const child = Bun.spawnSync([process.execPath, "src/cli/index.ts", "--machine", "peer", "focus", "--help"], { cwd: process.cwd(), env: { ...process.env, WOLFPACK_TEST: "1", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toContain("wolfpack focus");
  expect(child.stdout.toString()).not.toContain("reply");
  expect(child.stderr.toString()).toBe("");
});

test("CLI CAS retries exactly once with fresh revision, not on ambiguous transport failure", async () => {
  const revisions: number[] = [];
  let reads = 0;
  const doc = await updateFocusWithRetry({ type: "done", id: "ship" }, async (_path, init) => {
    if (!init) return Response.json({ revision: ++reads, local: true });
    const body = JSON.parse(init.body as string);
    revisions.push(body.expectedRevision);
    return revisions.length === 1 ? Response.json({ revision: 2 }, { status: 409 }) : Response.json({ document: { revision: 3 } });
  });
  expect(revisions).toEqual([1, 2]);
  expect(doc.revision).toBe(3);
  let calls = 0;
  await expect(updateFocusWithRetry({ type: "done", id: "ship" }, async () => { if (++calls === 1) return Response.json({ revision: 1 }); throw new Error("disconnected"); })).rejects.toThrow("disconnected");
  expect(calls).toBe(2);
});

test("CLI home move refuses an enabled local assistant but permits same-home and stale non-home pins", async () => {
  const { focusHomeCommand } = await import("../../src/cli/focus.ts");
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "focus-cli-guard-")), path = join(dir, "config.json");
  const io = { path, installationId: () => "self-id" };
  const pin = { name: "assistant", cwd: join(dir, "assistant"), command: ["pi"], harness: "pi" };
  const base = { devDir: dir, port: 19865, pinnedSessions: [pin], futureKey: true };
  try {
    for (const focus of [undefined, { home: "self-id" }]) {
      writeFileSync(path, JSON.stringify({ ...base, ...(focus && { focus }) }));
      const before = readFileSync(path, "utf8");
      await expect(focusHomeCommand({ home: "peer-id" }, io)).rejects.toThrow("Disable this machine's assistant first");
      expect(readFileSync(path, "utf8")).toBe(before);
      expect((await focusHomeCommand({}, io)).local).toBe(true);
      expect((await focusHomeCommand({ home: "self-id" }, io)).local).toBe(true);
      expect((await focusHomeCommand({ home: null }, io)).local).toBe(true);
    }
    writeFileSync(path, JSON.stringify(base));
    const child = Bun.spawnSync([process.execPath, "src/cli/index.ts", "focus", "home", "peer-id"], {
      cwd: process.cwd(), env: { ...process.env, WOLFPACK_DIR: dir, WOLFPACK_TEST: "1", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode).toBe(1);
    expect(child.stderr.toString()).toContain("Disable this machine's assistant first");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(base);
    writeFileSync(path, JSON.stringify({ ...base, focus: { home: "peer-a" } }));
    expect((await focusHomeCommand({ home: "peer-b" }, io)).home).toBe("peer-b");
    expect(JSON.parse(readFileSync(path, "utf8")).futureKey).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("focus home writes or clears focus.home in the configured config and keeps every other field", async () => {
  const { parseFocusHomeCommand, focusHomeCommand } = await import("../../src/cli/focus.ts");
  expect(parseFocusHomeCommand(["home"])).toEqual({ json: false });
  expect(parseFocusHomeCommand(["home", "abc-123", "--json"])).toEqual({ json: true, home: "abc-123" });
  expect(parseFocusHomeCommand(["home", "--clear"])).toEqual({ json: false, home: null });
  for (const bad of [["home", "a", "b"], ["home", "bad id"], ["home", "--clear", "x"], ["home", "--wat"]]) expect(() => parseFocusHomeCommand(bad)).toThrow();
  const { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "focus-home-"));
  const path = join(dir, "config.json");
  const io = { path, installationId: () => "self-id" };
  const config = () => JSON.parse(readFileSync(path, "utf8"));
  try {
    // keys this build does not know (a newer release's settings) survive the rewrite
    writeFileSync(path, JSON.stringify({ devDir: "/dev", port: 18790, pinnedSessions: [], futureKey: { keep: true } }));
    expect(await focusHomeCommand({ json: false, home: "home-id" }, io)).toEqual({ home: "home-id", local: false, changed: true });
    expect(config()).toEqual({ devDir: "/dev", port: 18790, pinnedSessions: [], futureKey: { keep: true }, focus: { home: "home-id" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const child = Bun.spawnSync([process.execPath, "src/cli/index.ts", "focus", "home", "other-home"], {
      cwd: process.cwd(), env: { ...process.env, WOLFPACK_DIR: dir, WOLFPACK_TEST: "1", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toContain("restart wolfpack on this machine to apply"); // CLI is disk-only, unlike Settings.
    expect(child.stderr.toString()).toBe("");
    await focusHomeCommand({ home: "home-id" }, io);
    expect(await focusHomeCommand({ json: false }, io)).toEqual({ home: "home-id", local: false, changed: false });
    expect(await focusHomeCommand({ json: false, home: null }, io)).toEqual({ home: "self-id", local: true, changed: true });
    expect(config()).toEqual({ devDir: "/dev", port: 18790, pinnedSessions: [], futureKey: { keep: true } });
    writeFileSync(path, "{not json");
    await expect(focusHomeCommand({ json: false, home: "x" }, io)).rejects.toThrow("valid wolfpack config required");
    expect(readFileSync(path, "utf8")).toBe("{not json");
    rmSync(path);
    await expect(focusHomeCommand({ json: false, home: "x" }, io)).rejects.toThrow("valid wolfpack config required");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
