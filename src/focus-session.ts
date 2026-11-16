/**
 * The focus assistant's own pinned pi session is a helper, not a session: it is reached through the assistant ui
 * (talk, the needs-you header, the terminal's Focus header) and never shown as a session card, counted, or ranked.
 * Lookups (open, kill, notification routes, `wolfpack list`) still see it; only render and count sites filter.
 * Only owning-home proof bound to the exact UUID/folder identifies a helper. Names and generic pinning alone
 * never hide unrelated local or peer sessions, including before the first `/api/focus` response.
 */
export const FOCUS_ASSISTANT_SESSION_NAME = "assistant";
export const FOCUS_ASSISTANT_CHAT_SESSION_NAME = "assistant-chat";
export const FOCUS_ASSISTANT_SESSION_NAMES = [FOCUS_ASSISTANT_SESSION_NAME, FOCUS_ASSISTANT_CHAT_SESSION_NAME] as const;
export type FocusAssistantRole = typeof FOCUS_ASSISTANT_SESSION_NAMES[number];
export function isFocusAssistantName(name: string): name is FocusAssistantRole {
  return FOCUS_ASSISTANT_SESSION_NAMES.some(role => role === name);
}
export interface FocusAssistantOwnership { readonly name: FocusAssistantRole; readonly folder: string; readonly sessionId: string }
export function isFocusAssistantOwnership(value: unknown): value is FocusAssistantOwnership {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(key => ["name", "folder", "sessionId"].includes(key)) && typeof v.name === "string" && isFocusAssistantName(v.name)
    && typeof v.folder === "string" && v.folder.length > 0 && v.folder.length <= 4096
    && typeof v.sessionId === "string" && v.sessionId.length > 0 && v.sessionId.length <= 256;
}
export interface FocusSessionLike {
  readonly name: string;
  readonly pinned?: boolean;
  readonly identity?: { readonly wolfpackSessionId?: string; readonly projectPath?: string };
  /** Owning home server's proof, bound to this exact launch incarnation; never inferred by a viewer. */
  readonly focusAssistant?: FocusAssistantOwnership;
}
export function isFocusAssistantSession(session: FocusSessionLike): boolean {
  const owner = session.focusAssistant;
  return session.pinned === true && isFocusAssistantOwnership(owner) && session.name === owner.name
    && session.identity?.wolfpackSessionId === owner.sessionId && session.identity.projectPath === owner.folder;
}
/** Returns the caller's own element type (the dashboard's session groups are untyped and must stay that way). */
export function withoutFocusAssistant<A extends readonly FocusSessionLike[]>(sessions: A): A[number][] {
  return sessions.filter(session => !isFocusAssistantSession(session));
}
