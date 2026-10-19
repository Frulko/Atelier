self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data?.json();
  } catch {
    return;
  }
  if (
    !data ||
    typeof data.url !== "string" ||
    !/^\/o\/[0-9a-f]{16}(?:\/|$)/.test(data.url)
  )
    return;
  event.waitUntil(
    self.registration.showNotification("Atelier", {
      body: "Une activité de ton projet est terminée. Ouvre Atelier pour consulter le résultat.",
      tag: typeof data.tag === "string" ? data.tag : "atelier",
      data: { url: data.url },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(
    event.notification.data?.url || "/",
    self.location.origin,
  );
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        const client = clients.find((c) =>
          c.url.startsWith(self.location.origin),
        );
        if (client) {
          await client.navigate(url.href);
          return client.focus();
        }
        return self.clients.openWindow(url.href);
      }),
  );
});
