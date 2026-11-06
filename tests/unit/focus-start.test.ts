import { expect, test } from "bun:test";
import { emptyFocus, reduceFocus } from "../../src/focus-contract.ts";
import { linkStartedFocusSession } from "../../src/focus-start.ts";
const now = "2026-11-07T00:00:00.000Z";
const document = () => reduceFocus(emptyFocus(), [{ type: "add", intention: { id: "ship", title: "ship", sessions: ["prior-session"] } }], now);
test("start links exact identity and selected canonical project/machine while preserving prior links", () => {
  const doc = document();
  const op = linkStartedFocusSession(doc, "ship", { sessionId: "new-session", projectDir: "/canonical/project", machine: "home" });
  const saved = reduceFocus(doc, [op], now);
  expect(saved.intentions[0]).toMatchObject({ id: "ship", title: "ship", sessions: ["prior-session", "new-session"], project: "/canonical/project", machine: "home" });
  expect(linkStartedFocusSession(saved, "ship", { sessionId: "new-session", projectDir: "/canonical/project", machine: "home" })).toEqual(op);
});
test("a dropped intention is not recreated and an older server's missing exact identity cannot produce a name link", () => {
  expect(() => linkStartedFocusSession(emptyFocus(), "ship", { sessionId: "new", projectDir: "/project", machine: "home" })).toThrow("intention");
  expect(() => linkStartedFocusSession(document(), "ship", { projectDir: "/project", machine: "home" })).toThrow("exact session identity");
});
