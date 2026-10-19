import webpush from "web-push";
import { db, getProjectById, getTask, roleOf } from "./db.ts";
import { decrypt, encrypt } from "./vault.ts";

// Push delivery is an outbox: recording the result never depends on a browser or a push service.
db.exec(`
  create table if not exists notifications (
    id integer primary key autoincrement, user_id text not null references users(id) on delete cascade,
    org_id text not null references orgs(id) on delete cascade, title text not null, body text not null,
    url text not null, dedupe text unique, created_at integer not null, read_at integer,
    pushed_at integer, attempts integer not null default 0, next_attempt_at integer not null default 0
  );
  create index if not exists notifications_user on notifications(user_id, created_at);
  create table if not exists push_subscriptions (
    endpoint text primary key, user_id text not null references users(id) on delete cascade,
    subscription text not null, created_at integer not null
  );
`);

export function vapidKeys(): { publicKey: string; privateKey: string } {
  const stored = db
    .prepare("select value from meta where key = 'vapid'")
    .get() as { value: string } | undefined;
  if (stored)
    return JSON.parse(
      decrypt(Buffer.from(stored.value, "base64"), "platform", "vapid"),
    );
  const keys = webpush.generateVAPIDKeys();
  db.prepare("insert into meta (key, value) values ('vapid', ?)").run(
    encrypt(JSON.stringify(keys), "platform", "vapid").toString("base64"),
  );
  return keys;
}

export function validSubscription(
  value: unknown,
): value is webpush.PushSubscription {
  if (!value || typeof value !== "object") return false;
  const s = value as webpush.PushSubscription;
  try {
    const u = new URL(s.endpoint);
    // Only browser push services: accepting an arbitrary URL here would turn notifications into SSRF.
    const hosts = [
      "fcm.googleapis.com",
      "updates.push.services.mozilla.com",
      "push.services.mozilla.com",
      "web.push.apple.com",
      "notify.windows.com",
    ];
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      s.endpoint.length <= 2048 &&
      hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)) &&
      typeof s.keys?.p256dh === "string" &&
      /^[A-Za-z0-9_-]{87}={0,2}$/.test(s.keys.p256dh) &&
      typeof s.keys?.auth === "string" &&
      /^[A-Za-z0-9_-]{22}={0,2}$/.test(s.keys.auth)
    );
  } catch {
    return false;
  }
}

export function subscribe(userId: string, value: unknown) {
  if (!validSubscription(value)) throw new Error("Abonnement push invalide.");
  const count = db
    .prepare("select count(*) as n from push_subscriptions where user_id = ?")
    .get(userId) as { n: number };
  const old = db
    .prepare("select user_id from push_subscriptions where endpoint = ?")
    .get(value.endpoint) as { user_id: string } | undefined;
  if (old && old.user_id !== userId)
    throw new Error(
      "Désactive les notifications de l'autre compte sur cet appareil avant de les activer.",
    );
  if (!old && count.n >= 10)
    throw new Error("Limite de 10 appareils atteinte.");
  db.prepare(
    "insert into push_subscriptions (endpoint, user_id, subscription, created_at) values (?,?,?,?) on conflict(endpoint) do update set subscription = excluded.subscription",
  ).run(value.endpoint, userId, JSON.stringify(value), Date.now());
}

export function notify(
  userId: string,
  orgId: string,
  title: string,
  body: string,
  url: string,
  dedupe: string,
) {
  if (!roleOf(orgId, userId)) return;
  db.prepare(
    "insert or ignore into notifications (user_id, org_id, title, body, url, dedupe, created_at) values (?,?,?,?,?,?,?)",
  ).run(userId, orgId, title, body, url, dedupe, Date.now());
  db.prepare(
    "delete from notifications where user_id = ? and id not in (select id from notifications where user_id = ? order by id desc limit 200)",
  ).run(userId, userId);
}

export function notifyTask(id: string) {
  const task = getTask(id);
  if (!task?.user_id || !task.org_id) return;
  const project = getProjectById(task.project);
  const title = task.last_error
    ? "L'agent a rencontré une erreur"
    : task.status === "cancelled"
      ? "Tâche annulée"
      : task.status === "no_changes"
        ? "Aucune modification nécessaire"
        : "La proposition est prête";
  notify(
    task.user_id,
    task.org_id,
    title,
    project?.name ?? "Projet",
    `/o/${task.org_id}/tasks/${id}`,
    `task:${id}:${task.turn}:${task.status}:${task.last_error ? "error" : "ok"}`,
  );
}

export function listNotifications(userId: string) {
  return db
    .prepare(
      "select n.id, n.org_id as orgId, n.title, n.body, n.url, n.created_at as createdAt, n.read_at as readAt from notifications n join memberships m on m.org_id = n.org_id and m.user_id = n.user_id where n.user_id = ? order by n.id desc limit 100",
    )
    .all(userId);
}

let delivering = false;
export async function deliverNotifications(
  send = webpush.sendNotification,
  now = Date.now(),
) {
  if (delivering) return;
  delivering = true;
  try {
    const rows = db
      .prepare(
        "select * from notifications where pushed_at is null and next_attempt_at <= ? and attempts < 5 order by id limit 30",
      )
      .all(now) as {
      id: number;
      user_id: string;
      org_id: string;
      url: string;
      attempts: number;
      created_at: number;
    }[];
    for (const n of rows) {
      let retry = false;
      if (roleOf(n.org_id, n.user_id) && now - n.created_at < 86_400_000) {
        const subs = db
          .prepare(
            "select endpoint, subscription from push_subscriptions where user_id = ?",
          )
          .all(n.user_id) as { endpoint: string; subscription: string }[];
        for (const s of subs) {
          try {
            await send(
              JSON.parse(s.subscription),
              JSON.stringify({
                title: "Atelier",
                body: "Une activité de ton projet est terminée. Ouvre Atelier pour consulter le résultat.",
                url: n.url,
                tag: `atelier-${n.id}`,
              }),
              {
                vapidDetails: {
                  subject:
                    process.env.ATELIER_PUSH_SUBJECT ||
                    "mailto:admin@atelier.local",
                  ...vapidKeys(),
                },
                TTL: 86400,
                timeout: 5000,
              },
            );
          } catch (e) {
            const code = (e as { statusCode?: number }).statusCode;
            if (code === 404 || code === 410)
              db.prepare(
                "delete from push_subscriptions where endpoint = ?",
              ).run(s.endpoint);
            else retry = true;
          }
        }
      }
      db.prepare(
        "update notifications set pushed_at = ?, attempts = attempts + 1, next_attempt_at = ? where id = ?",
      ).run(
        retry ? null : now,
        now + Math.min(3600_000, 30_000 * 2 ** n.attempts),
        n.id,
      );
    }
  } finally {
    delivering = false;
  }
}

export function startNotifications() {
  const tick = () =>
    void deliverNotifications().catch(() =>
      console.warn("push: livraison temporairement indisponible"),
    );
  tick();
  const timer = setInterval(tick, 15_000);
  timer.unref();
  return () => clearInterval(timer);
}
