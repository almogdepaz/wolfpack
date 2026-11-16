import { expect, test } from "bun:test";
import { isFocusAssistantSession, withoutFocusAssistant } from "../../src/focus-session.ts";
import { withoutAssistantRows } from "../../src/focus-coverage.ts";
import { ACTIVITY_KIND } from "../../src/activity-journal.ts";

for (const name of ["assistant", "assistant-chat"] as const) {
  const owner = { name, folder: "/private/assistant", sessionId: `${name}-id` };
  const managed = { name, pinned: true, identity: { wolfpackSessionId: owner.sessionId, projectPath: owner.folder }, focusAssistant: owner };
  test(`${name}: only owning-server proof bound to the exact incarnation and folder is excluded`, () => {
    expect(isFocusAssistantSession(managed)).toBe(true);
    for (const ordinary of [
      { name, pinned: true, identity: { projectPath: "/other", agentKind: "shell" } },
      { ...managed, focusAssistant: undefined }, // unrelated peer, no owning-home proof
      { ...managed, pinned: false },
      { ...managed, identity: { ...managed.identity, projectPath: "/other" } },
      { ...managed, identity: { ...managed.identity, wolfpackSessionId: "replacement" } },
    ]) {
      expect(isFocusAssistantSession(ordinary)).toBe(false);
      expect(withoutFocusAssistant([ordinary])).toEqual([ordinary]);
    }
  });
  test(`${name}: journal namesakes remain, and only UUID-bound proven history is filtered`, () => {
    const base = { seq: 1, at: "2026-11-16T10:00:00.000Z", kind: ACTIVITY_KIND.INPUT, session: name, sessionId: owner.sessionId, source: "browser" as const, bucket: "2026-11-16T10:00:00.000Z" };
    expect(withoutAssistantRows([base])).toEqual([base]);
    expect(withoutAssistantRows([{ ...base, focusAssistant: owner }])).toEqual([]);
    const replacement = { ...base, sessionId: "unrelated-id", focusAssistant: owner };
    expect(withoutAssistantRows([replacement])).toEqual([replacement]);
  });
}
