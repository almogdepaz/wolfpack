import core from "../skills/wolfpack-focus/core.md" with { type: "text" };
import worker from "../skills/wolfpack-focus/SKILL.md" with { type: "text" };
import chat from "../skills/wolfpack-focus-chat/SKILL.md" with { type: "text" };
import type { FocusAssistantRole } from "./focus-session.js";

/** Both explicit Pi skill seeds carry the same complete safety contract. */
export function focusAssistantSkill(role: FocusAssistantRole): string {
  return `${role === "assistant" ? worker : chat}\n${core}`;
}
