import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { cfg } from "./config.ts";

export type Status = "queued" | "running" | "done" | "no_changes" | "failed" | "cancelled";
export type Task = {
  id: string; org_id: string | null; user_id: string | null; project: string; prompt: string; status: Status;
  branch: string | null; mr_url: string | null; cost: number; created_at: number;
};
export type Evt = { id: number; task_id: string; ts: number; type: string; text: string };

const db = new DatabaseSync(cfg.dbFile);
db.exec(`
  create table if not exists tasks (
    id text primary key, org_id text, user_id text, project text not null, prompt text not null,
    status text not null, branch text, mr_url text,
    cost real not null default 0, created_at integer not null
  );
  create table if not exists events (
    id integer primary key autoincrement, task_id text not null,
    ts integer not null, type text not null, text text not null
  );
  create index if not exists events_task on events(task_id, id);

  -- Multi-utilisateur (voir docs/MULTI-USER.md)
  create table if not exists users (
    id text primary key, email text not null unique,
    password_hash text not null, created_at integer not null
  );
  create table if not exists orgs (
    id text primary key, name text not null, created_at integer not null
  );
  create table if not exists memberships (
    org_id text not null references orgs(id) on delete cascade,
    user_id text not null references users(id) on delete cascade,
    role text not null check (role in ('owner','admin','member','viewer')),
    primary key (org_id, user_id)
  );
  create table if not exists sessions (
    token_hash text primary key, user_id text not null references users(id) on delete cascade,
    created_at integer not null, expires_at integer not null
  );
`);
db.exec("pragma foreign_keys = on");

// Migration M1 → U3 : les bases créées avant les organisations n'ont pas ces colonnes.
const taskCols = (db.prepare("pragma table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
if (!taskCols.includes("org_id")) db.exec("alter table tasks add column org_id text");
if (!taskCols.includes("user_id")) db.exec("alter table tasks add column user_id text");
db.exec("create index if not exists tasks_org on tasks(org_id, created_at)");

/** Diffuse chaque événement aux clients SSE connectés. */
export const bus = new EventEmitter();

export const createTask = (id: string, orgId: string, userId: string, project: string, prompt: string) =>
  db.prepare("insert into tasks (id, org_id, user_id, project, prompt, status, created_at) values (?,?,?,?,?,?,?)")
    .run(id, orgId, userId, project, prompt, "queued", Date.now());

/** Pour le code interne de confiance (pipeline). Les routes HTTP utilisent getTaskInOrg. */
export const getTask = (id: string) =>
  db.prepare("select * from tasks where id = ?").get(id) as Task | undefined;

/** Cloisonnement : une tâche d'une autre organisation est INTROUVABLE (même identifiant exact). */
export const getTaskInOrg = (id: string, orgId: string) =>
  db.prepare("select * from tasks where id = ? and org_id = ?").get(id, orgId) as Task | undefined;

export const listTasks = (orgId: string) =>
  db.prepare("select * from tasks where org_id = ? order by created_at desc limit 50").all(orgId) as Task[];

/** Tâches d'avant les organisations : rattachées à l'organisation donnée (une seule fois, au démarrage). */
export const adoptOrphanTasks = (orgId: string) =>
  db.prepare("update tasks set org_id = ? where org_id is null").run(orgId);

export const updateTask = (id: string, patch: Partial<Pick<Task, "status" | "branch" | "mr_url" | "cost">>) => {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.prepare(`update tasks set ${keys.map((k) => `${k} = ?`).join(", ")} where id = ?`)
    .run(...(Object.values(patch) as (string | number | null)[]), id);
  bus.emit(id, { id: 0, task_id: id, ts: Date.now(), type: "status", text: getTask(id)!.status } satisfies Evt);
};

export const addEvent = (task_id: string, type: string, text: string) => {
  const ts = Date.now();
  const r = db.prepare("insert into events (task_id, ts, type, text) values (?,?,?,?)").run(task_id, ts, type, text);
  bus.emit(task_id, { id: Number(r.lastInsertRowid), task_id, ts, type, text } satisfies Evt);
};

export const getEvents = (task_id: string, afterId = 0) =>
  db.prepare("select * from events where task_id = ? and id > ? order by id").all(task_id, afterId) as Evt[];

/** Au démarrage, une tâche "running" est forcément orpheline (le conteneur a été tué avec nous). */
export const failOrphans = () =>
  db.prepare("update tasks set status = 'failed' where status in ('running','queued')").run();

/* ------------------------- utilisateurs / organisations ------------------------- */

export type Role = "owner" | "admin" | "member" | "viewer";
export type User = { id: string; email: string; password_hash: string; created_at: number };

const rid = () => randomBytes(8).toString("hex");
export const normEmail = (e: string) => e.trim().toLowerCase();

export const countUsers = () => (db.prepare("select count(*) as n from users").get() as { n: number }).n;

export const getUserByEmail = (email: string) =>
  db.prepare("select * from users where email = ?").get(normEmail(email)) as User | undefined;

export function createUser(email: string, passwordHash: string): User {
  const u = { id: rid(), email: normEmail(email), password_hash: passwordHash, created_at: Date.now() };
  db.prepare("insert into users (id, email, password_hash, created_at) values (?,?,?,?)").run(u.id, u.email, u.password_hash, u.created_at);
  return u;
}

export function createOrg(name: string, ownerId: string) {
  const id = rid();
  db.prepare("insert into orgs (id, name, created_at) values (?,?,?)").run(id, name, Date.now());
  db.prepare("insert into memberships (org_id, user_id, role) values (?,?,'owner')").run(id, ownerId);
  return id;
}

export const addMember = (orgId: string, userId: string, role: Role) =>
  db.prepare("insert into memberships (org_id, user_id, role) values (?,?,?)").run(orgId, userId, role);

export const roleOf = (orgId: string, userId: string) =>
  (db.prepare("select role from memberships where org_id = ? and user_id = ?").get(orgId, userId) as { role: Role } | undefined)?.role;

export const orgsOf = (userId: string) =>
  db.prepare("select o.id, o.name, m.role from memberships m join orgs o on o.id = m.org_id where m.user_id = ? order by o.name").all(userId) as { id: string; name: string; role: Role }[];

export const getUserById = (id: string) =>
  db.prepare("select * from users where id = ?").get(id) as User | undefined;

export const updatePassword = (userId: string, hash: string) =>
  db.prepare("update users set password_hash = ? where id = ?").run(hash, userId);

/* -------------------------------- sessions -------------------------------- */

export type SessionRow = { token_hash: string; user_id: string; created_at: number; expires_at: number };

export const insertSession = (tokenHash: string, userId: string, now: number, expiresAt: number) =>
  db.prepare("insert into sessions (token_hash, user_id, created_at, expires_at) values (?,?,?,?)").run(tokenHash, userId, now, expiresAt);

export const findSession = (tokenHash: string) =>
  db.prepare("select * from sessions where token_hash = ?").get(tokenHash) as SessionRow | undefined;

export const extendSession = (tokenHash: string, expiresAt: number) =>
  db.prepare("update sessions set expires_at = ? where token_hash = ?").run(expiresAt, tokenHash);

export const deleteSession = (tokenHash: string) =>
  db.prepare("delete from sessions where token_hash = ?").run(tokenHash);

/** Toutes les sessions d'un utilisateur sauf (éventuellement) la courante : changement de mot de passe. */
export const deleteSessionsOf = (userId: string, exceptTokenHash = "") =>
  db.prepare("delete from sessions where user_id = ? and token_hash != ?").run(userId, exceptTokenHash);

export const purgeExpiredSessions = () =>
  db.prepare("delete from sessions where expires_at < ?").run(Date.now());

export const firstOrgId = () =>
  (db.prepare("select id from orgs order by created_at, id limit 1").get() as { id: string } | undefined)?.id;
