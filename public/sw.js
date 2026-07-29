// Wolfpack push notification service worker

/**
 * Sanitize a notification-click URL against an open-redirect attack.
 *
 * History: a previous version guarded with `url.startsWith("/")` and treated
 * any leading-slash input as a safe relative path. That allowed
 * protocol-relative URLs like `//evil.com` to pass through (they literally
 * start with `/`), and the browser would navigate to `https://evil.com/`.
 *
 * Strategy: resolve through the URL parser using `origin` as the base, then
 * confirm the resolved origin matches. The parser handles every wonky form
 * (protocol-relative, backslash variants, fragments, etc.) so we don't have
 * to maintain a guard-list.
 *
 * @param {string} url - raw URL from the push payload (may be hostile)
 * @param {string} origin - service-worker origin (e.g. self.location.origin)
 * @returns {string} a same-origin path-only URL, or `"/"` on any mismatch
 */
function sanitizeNotificationUrl(url, origin) {
  try {
    const resolved = new URL(url, origin);
    if (resolved.origin !== origin) return "/";
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return "/";
  }
}

async function routeNotificationClick(windowClients, url, origin, openWindow) {
  const targetUrl = new URL(sanitizeNotificationUrl(url, origin), origin).href;
  for (const client of windowClients) {
    let clientOrigin;
    try { clientOrigin = new URL(client.url).origin; }
    catch { continue; }
    if (clientOrigin !== origin) continue;

    const navigated = typeof client.navigate === "function"
      ? await client.navigate(targetUrl)
      : null;
    const focusTarget = navigated && typeof navigated.focus === "function" ? navigated : client;
    if (typeof focusTarget.focus === "function") return focusTarget.focus();
    return navigated;
  }
  return openWindow(targetUrl);
}

// Exposed for unit tests (Node `vm` context). No-op in browsers where
// `module` is undefined.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { sanitizeNotificationUrl, routeNotificationClick };
}

self.addEventListener("push", (event) => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || "Wolfpack", {
      body: data.body || "",
      tag: data.tag || "wolfpack",
      icon: "/icon-192.png",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Only allow same-origin URLs to prevent open-redirect via push payload.
  // See sanitizeNotificationUrl above for the rationale.
  const url = sanitizeNotificationUrl(
    event.notification.data?.url || "/",
    self.location.origin,
  );
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) =>
      routeNotificationClick(
        windowClients,
        url,
        self.location.origin,
        (targetUrl) => clients.openWindow(targetUrl),
      )),
  );
});
