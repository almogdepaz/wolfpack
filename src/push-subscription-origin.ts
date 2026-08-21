export const PUSH_API_PATH = {
  vapidKey: "/api/push/vapid-key",
  subscribe: "/api/push/subscribe",
  unsubscribe: "/api/push/unsubscribe",
} as const;

export type PushApiPath = (typeof PUSH_API_PATH)[keyof typeof PUSH_API_PATH];
export type AuthenticatedPushRequest = (url: string, init?: RequestInit) => Promise<Response>;

/** Resolves a push resource only when it remains on the currently visited Wolfpack origin. */
export function sameOriginPushUrl(currentOrigin: string, path: string): string {
  const current = new URL(currentOrigin);
  const resolved = new URL(path, current);
  if (resolved.origin !== current.origin) {
    throw new Error("push enrollment must remain on the current same origin");
  }
  return resolved.href;
}

export function requestSameOriginPushApi(
  request: AuthenticatedPushRequest,
  currentOrigin: string,
  path: PushApiPath,
  init?: RequestInit,
): Promise<Response> {
  return request(sameOriginPushUrl(currentOrigin, path), init);
}
