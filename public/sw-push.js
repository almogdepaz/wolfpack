// Wolfpack push notification service worker
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
  // Only allow same-origin or relative URLs to prevent open-redirect via push payload
  let url = event.notification.data?.url || "/";
  if (url.startsWith("/")) { /* relative — ok */ }
  else { try { if (new URL(url).origin !== self.location.origin) url = "/"; } catch { url = "/"; } }
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      // Focus existing wolfpack window if open
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      // Otherwise open a new one
      return clients.openWindow(url);
    }),
  );
});
