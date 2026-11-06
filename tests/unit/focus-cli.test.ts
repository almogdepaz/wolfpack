import { expect, test } from "bun:test";
import { parseFocusCommand, updateFocusWithRetry } from "../../src/cli/focus.ts";

test("focus CLI parses every operation with explicit link/project/machine fields", () => {
  expect(parseFocusCommand(["add", "ship", "--id", "ship", "--project", "/a", "--on", "sgt", "--sessions", "a,b", "--json"]).op).toEqual({ type: "add", intention: { id: "ship", title: "ship", project: "/a", machine: "sgt", sessions: ["a", "b"] } });
  expect(parseFocusCommand(["edit", "ship", "new title"]).op).toEqual({ type: "edit", id: "ship", patch: { title: "new title" } });
  for (const cmd of ["done", "undo", "drop"] as const) expect(parseFocusCommand([cmd, "ship"]).op).toEqual({ type: cmd, id: "ship" });
  expect(parseFocusCommand(["reorder", "b", "a"]).op).toEqual({ type: "reorder", ids: ["b", "a"] });
  expect(parseFocusCommand(["nudge", "do this"]).op).toEqual({ type: "nudge", text: "do this", author: "assistant" });
  expect(parseFocusCommand(["note", "remember"]).op).toEqual({ type: "note", text: "remember" });
  expect(parseFocusCommand(["day-summary", "2026-11-05", "4", "2", "1"]).op).toEqual({ type: "day-summary", summary: { date: "2026-11-05", done: 4, carried: 2, questions: 1 } });
  expect(() => parseFocusCommand(["done", "ship", "junk"])).toThrow();
  expect(() => parseFocusCommand(["add", "ship", "--wat", "x"])).toThrow();
});
test("remote focus help never resolves a machine or starts a server", () => {
  const child = Bun.spawnSync([process.execPath, "src/cli/index.ts", "--machine", "peer", "focus", "--help"], { cwd: process.cwd(), env: { ...process.env, WOLFPACK_TEST: "1", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toContain("wolfpack focus");
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
