/**
 * The focus assistant's own pinned pi session is a helper, not a session: it is reached through the assistant ui
 * (talk, the needs-you header, the terminal's Focus header) and never shown as a session card, counted, or ranked.
 * Lookups (open, kill, notification routes, `wolfpack list`) still see it; only render and count sites filter.
 * `pinned` comes from the owning server, so peer groups and the first paint before `/api/focus` behave the same.
 */
export const FOCUS_ASSISTANT_SESSION_NAME = "assistant";
export interface FocusSessionLike { readonly name: string; readonly pinned?: boolean }
export function isFocusAssistantSession(session: FocusSessionLike): boolean {
  return session.pinned === true && session.name === FOCUS_ASSISTANT_SESSION_NAME;
}
/** Returns the caller's own element type (the dashboard's session groups are untyped and must stay that way). */
export function withoutFocusAssistant<A extends readonly FocusSessionLike[]>(sessions: A): A[number][] {
  return sessions.filter(session => !isFocusAssistantSession(session));
}
