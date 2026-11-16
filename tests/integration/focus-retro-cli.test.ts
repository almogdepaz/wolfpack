import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOCUS_UI_ACTION as A, FOCUS_UI_CARD as C } from "../../src/focus-ui-log";
import { ACTIVITY_KIND as K } from "../../src/activity-journal";
import { parseFocusRetroCommand } from "../../src/cli/focus-retro";
const date = "2026-11-16", machine = "b8eb5e25-b8ac-4384-aa0a-c60f7dfcbded";
const at = (seconds: number) => new Date(Date.parse(`${date}T12:00:00.000Z`) + seconds * 1000).toISOString();
test("retro defaults to the current UTC date and rejects malformed or duplicate flags", () => {
  expect(parseFocusRetroCommand([], new Date("2026-11-16T23:30:00-05:00"))).toEqual({ date: "2026-11-17", json: false });
  expect(parseFocusRetroCommand(["--json", "--date", date])).toEqual({ date, json: true });
  for (const args of [["--json", "--json"], ["--date", "2026-2-01"], ["--date", "2026-11-31"], ["--date", "--json"]]) expect(() => parseFocusRetroCommand(args)).toThrow("Usage:");
});
test("retro CLI reads adjacent day files for midnight continuations without double-counting on the next date", () => {
  const root = mkdtempSync(join(tmpdir(), "focus-retro-midnight-"));
  const start = "2026-11-16T23:59:50.000Z", refresh = "2026-11-17T00:00:00.000Z", end = "2026-11-17T00:00:10.000Z";
  const visit = "a8eb5e25-b8ac-4384-aa0a-c60f7dfcbded";
  const target = { session: "work", sessionId: "mock:work", machine };
  const ui = [
    { seq: 1, at: start, visit, action: A.OPEN },
    { seq: 2, at: start, visit, action: A.SHOWN, cards: [{ ...target, rank: 1, kind: "action", reason: "needs-you" }] },
    { seq: 3, at: refresh, visit, action: A.SHOWN, cards: [{ ...target, rank: 1, kind: "action", reason: "needs-you" }] },
    { seq: 4, at: end, visit, action: A.CARD, control: C.REPLY, ...target },
    { seq: 5, at: end, visit, action: A.LEFT, visibleMs: 20_000 },
  ];
  const activity = [start, refresh, end].map((at, i) => ({ seq: i + 1, at, kind: K.SESSION_STATE, session: "work", sessionId: "mock:work", state: i === 2 ? "working" : "needs-input", label: "" }));
  try {
    for (const [dir, rows] of [["focus-ui", ui], ["activity", activity]] as const) {
      mkdirSync(join(root, dir));
      for (const day of [date, "2026-11-17"]) writeFileSync(join(root, dir, `${day}.jsonl`), rows.filter(r => r.at.startsWith(day)).map(r => JSON.stringify(r) + "\n").join(""));
    }
    writeFileSync(join(root, "machine-id"), machine);
    const run = (day: string) => Bun.spawnSync([process.execPath, "src/cli/index.ts", "focus", "retro", "--date", day, "--json"], { cwd: process.cwd(), env: { ...process.env, WOLFPACK_DIR: root, WOLFPACK_PORT: "19794", WOLFPACK_MACHINE_ID_PATH: join(root, "machine-id") }, stdout: "pipe", stderr: "pipe" });
    const first = run(date); expect(first.exitCode).toBe(0);
    const result = JSON.parse(first.stdout.toString());
    expect(result.visits[0]).toMatchObject({ leftAt: end, visibleMs: 20_000 });
    expect(result.cards[0].firstAction).toMatchObject({ control: C.REPLY, latencyMs: 20_000 });
    expect(result.needsInput[0]).toMatchObject({ resolvedAt: end, resolutionMs: 20_000, via: "focus" });
    const second = run("2026-11-17"); expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout.toString())).toEqual({ date: "2026-11-17", visits: [], cards: [], needsInput: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("focus retro CLI reads local day files offline, supports text/JSON and does not mutate the journals", () => {
  const root = mkdtempSync(join(tmpdir(), "focus-retro-cli-"));
  mkdirSync(join(root, "focus-ui")); mkdirSync(join(root, "activity"));
  const ui = [
    { seq: 1, at: at(0), visit: "a8eb5e25-b8ac-4384-aa0a-c60f7dfcbded", action: A.OPEN },
    { seq: 2, at: at(1), visit: "a8eb5e25-b8ac-4384-aa0a-c60f7dfcbded", action: A.SHOWN, cards: [{ session: "work", sessionId: "uuid", machine, rank: 1, kind: "action", reason: "needs-you" }, { session: "ignored-work", sessionId: "ignored", machine, rank: 2, kind: "action", reason: "rules" }] },
    { seq: 3, at: at(3), visit: "a8eb5e25-b8ac-4384-aa0a-c60f7dfcbded", action: A.CARD, control: C.REPLY, session: "work", sessionId: "uuid", machine },
    { seq: 4, at: at(5), visit: "a8eb5e25-b8ac-4384-aa0a-c60f7dfcbded", action: A.LEFT, visibleMs: 5000 },
  ].map(r => JSON.stringify(r) + "\n").join("");
  const activity = [
    { seq: 1, at: at(0), kind: K.SESSION_STATE, session: "work", sessionId: "uuid", state: "needs-input", label: "PRIVATE_LABEL" },
    { seq: 2, at: at(4), kind: K.SESSION_STATE, session: "work", sessionId: "uuid", state: "working", label: "PRIVATE_LABEL" },
  ].map(r => JSON.stringify(r) + "\n").join("");
  const path = join(root, "focus-ui", `${date}.jsonl`);
  writeFileSync(path, ui + '{"unfinished":'); writeFileSync(join(root, "activity", `${date}.jsonl`), activity); writeFileSync(join(root, "machine-id"), machine);
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, "src/cli/index.ts", ...args], { cwd: process.cwd(), env: { ...process.env, WOLFPACK_TEST: "1", WOLFPACK_DIR: root, WOLFPACK_PORT: "19794", WOLFPACK_MACHINE_ID_PATH: join(root, "machine-id"), NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  try {
    const json = run("focus", "retro", "--date", date, "--json");
    expect(json.exitCode).toBe(0);
    const result = JSON.parse(json.stdout.toString());
    expect(result.date).toBe(date);
    expect(result.cards[0].firstAction).toEqual({ control: C.REPLY, at: at(3), latencyMs: 2000 });
    expect(result.cards[1].firstAction).toBeNull();
    expect(result.needsInput[0]).toMatchObject({ resolutionMs: 4000, via: "focus" });
    expect(result.visits[0].visibleMs).toBe(5000);
    expect(json.stdout.toString()).not.toContain("PRIVATE_LABEL");
    const text = run("focus", "retro", "--date", date);
    expect(text.exitCode).toBe(0); expect(text.stdout.toString()).toContain("ignored"); expect(text.stdout.toString()).toContain("reply"); expect(text.stdout.toString()).toContain("focus");
    const empty = run("focus", "retro", "--date", "2026-11-15", "--json");
    expect(empty.exitCode).toBe(0); expect(JSON.parse(empty.stdout.toString()).cards).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(ui + '{"unfinished":');
    expect(readdirSync(root).sort()).toEqual(["activity", "focus-ui", "machine-id"]);
    for (const args of [["--date", "2026-02-30"], ["--date", "../oops"], ["--date"], ["--wat"], ["--date", date, "--date", date]]) expect(run("focus", "retro", ...args).exitCode).toBe(1);
    const remote = run("--machine", "peer", "focus", "retro", "--json");
    expect(remote.exitCode).not.toBe(0); expect(JSON.parse(remote.stdout.toString()).error).toEqual({ code: "INVALID_MACHINE_SELECTOR", message: "--machine is not supported for this command" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
