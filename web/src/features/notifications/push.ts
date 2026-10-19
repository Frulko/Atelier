import { api } from "../../lib/api";

export const pushSupported = () =>
  window.isSecureContext &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;
export async function enablePush() {
  if (!pushSupported())
    throw new Error(
      "Les notifications push nécessitent HTTPS et un navigateur compatible.",
    );
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error(
      "Autorise les notifications dans les paramètres de ton navigateur pour les activer.",
    );
  const registration = await navigator.serviceWorker.register("/sw.js", {
    scope: "/",
  });
  await navigator.serviceWorker.ready;
  const { publicKey } = await api.get<{ publicKey: string }>("/api/me/push");
  const key = Uint8Array.from(
    atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    }));
  try {
    await api.post("/api/me/push", subscription.toJSON());
  } catch (e) {
    await subscription.unsubscribe();
    throw e;
  }
}
export async function disablePush() {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const sub = await registration?.pushManager.getSubscription();
  if (sub) {
    await api.del("/api/me/push", { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
}
