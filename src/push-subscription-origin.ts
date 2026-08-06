/** Resolves a push resource only when it remains on the currently visited Wolfpack origin. */
export function sameOriginPushUrl(currentOrigin: string, path: string): string {
  const current = new URL(currentOrigin);
  const resolved = new URL(path, current);
  if (resolved.origin !== current.origin) {
    throw new Error("push enrollment must remain on the current same origin");
  }
  return resolved.href;
}
