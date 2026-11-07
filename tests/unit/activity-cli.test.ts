import { expect, test } from "bun:test";
import { ACTIVITY_KIND, type ActivityRow } from "../../src/activity-journal.ts";
import { formatActivityRow, parseActivityCommand } from "../../src/cli/activity.ts";

test("activity CLI parses read options and ack", () => {
  expect(parseActivityCommand([])).toEqual({ action: "read", since: 0, limit: 500, json: false });
  expect(parseActivityCommand(["--since", "12", "--limit", "3", "--json"])).toEqual({ action: "read", since: 12, limit: 3, json: true });
  expect(parseActivityCommand(["ack", "inbox/catch-up-20261106T100000Z.json", "--json"])).toEqual({ action: "ack", file: "inbox/catch-up-20261106T100000Z.json", json: true });
  for (const bad of [["--since"], ["--since", "-1"], ["--limit", "5000"], ["ack"], ["ack", "a", "b"], ["--wat"]]) expect(() => parseActivityCommand(bad)).toThrow();
});

test("human output is one line per row with untrusted text flattened", () => {
  const row: ActivityRow = { seq: 3, at: "2026-11-06T10:00:00.000Z", kind: ACTIVITY_KIND.SESSION_STATE, session: "app", state: "needs-input", label: "Needs input", message: "line one\nline two" };
  expect(formatActivityRow(row)).toBe("#3 2026-11-06T10:00:00.000Z session.state app needs-input Needs input — line one line two");
  expect(formatActivityRow({ seq: 4, at: "2026-11-06T10:05:00.000Z", kind: ACTIVITY_KIND.INPUT, session: "app", source: "browser", bucket: "2026-11-06T10:05:00.000Z" })).toBe("#4 2026-11-06T10:05:00.000Z input app browser");
});
