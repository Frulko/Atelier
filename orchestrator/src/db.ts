import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { cfg } from "./config.ts";

export const STATUSES = ["queued", "running", "done", "no_changes", "failed", "cancelled"] as const;
export type Status = (typeof STATUSES)[number];
export type Task = {
  project_name?: string | null;
  id: string; org_id: string | null; user_id: string | null; project: string; prompt: string; status: Status;
  branch: string | null; mr_url: string | null; cost: number; created_at: number;
  started_at: number | null; finished_at: number | null;
  /** Chemins modifiés (JSON, 200 au plus) et nombre d'entre eux qui touchent un chemin protégé. */
  files_json: string | null; flagged: number;
  user_email?: string | null;
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
  create table if not exists meta (key text primary key, value text not null);
  create table if not exists secrets (
    id text primary key, org_id text not null references orgs(id) on delete cascade,
    kind text not null check (kind in ('git_token','provider_key')), provider text,
    label text not null, hint text not null, ciphertext blob not null, created_at integer not null
  );
  create table if not exists projects (
    id text primary key, org_id text not null references orgs(id) on delete cascade,
    slug text not null, name text not null, repo text not null, branch text not null,
    forge text not null, check_cmd text not null, engine text not null, protected_paths text not null,
    git_secret_id text references secrets(id), created_at integer not null,
    unique (org_id, slug)
  );
  create table if not exists invitations (
    id text primary key, token_hash text not null unique,
    org_id text not null references orgs(id) on delete cascade, email text not null,
    role text not null check (role in ('owner','admin','member','viewer')),
    created_by text not null, created_at integer not null, expires_at integer not null
  );
  create table if not exists sessions (
    token_hash text primary key, user_id text not null references users(id) on delete cascade,
    created_at integer not null, expires_at integer not null
  );
`);
db.exec("pragma foreign_keys = on");

// Migration M1 → U3 : les bases créées avant les organisations n'ont pas ces colonnes.
const orgCols = (db.prepare("pragma table_info(orgs)").all() as { name: string }[]).map((c) => c.name);
if (!orgCols.includes("budget_usd_month")) db.exec("alter table orgs add column budget_usd_month real");
const taskCols = (db.prepare("pragma table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
if (!taskCols.includes("org_id")) db.exec("alter table tasks add column org_id text");
if (!taskCols.includes("user_id")) db.exec("alter table tasks add column user_id text");
if (!taskCols.includes("started_at")) db.exec("alter table tasks add column started_at integer");
if (!taskCols.includes("finished_at")) db.exec("alter table tasks add column finished_at integer");
if (!taskCols.includes("files_json")) db.exec("alter table tasks add column files_json text");
if (!taskCols.includes("flagged")) db.exec("alter table tasks add column flagged integer not null default 0");
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

const TASK_SELECT = `select t.*, p.name as project_name, u.email as user_email
  from tasks t left join projects p on p.id = t.project left join users u on u.id = t.user_id`;

export type TaskFilters = {
  status?: Status[]; project?: string; user?: string; q?: string; from?: number; to?: number; limit?: number; offset?: number;
};

/** Liste filtrée et paginée, TOUJOURS bornée à l'organisation. Les valeurs sont des paramètres liés, jamais du SQL. */
export function queryTasks(orgId: string, f: TaskFilters = {}): { items: Task[]; total: number; limit: number; offset: number } {
  const where = ["t.org_id = ?"]; const args: (string | number)[] = [orgId];
  if (f.status?.length) { where.push(`t.status in (${f.status.map(() => "?").join(",")})`); args.push(...f.status); }
  if (f.project) { where.push("t.project = ?"); args.push(f.project); }
  if (f.user) { where.push("t.user_id = ?"); args.push(f.user); }
  if (f.q) { where.push("t.prompt like ? escape '\\'"); args.push(`%${f.q.replace(/[\\%_]/g, "\\$&")}%`); }
  if (f.from != null) { where.push("t.created_at >= ?"); args.push(f.from); }
  if (f.to != null) { where.push("t.created_at < ?"); args.push(f.to); }
  const limit = Math.min(Math.max(f.limit ?? 25, 1), 100), offset = Math.max(f.offset ?? 0, 0);
  const w = where.join(" and ");
  const total = (db.prepare(`select count(*) as n from tasks t where ${w}`).get(...args) as { n: number }).n;
  const items = db.prepare(`${TASK_SELECT} where ${w} order by t.created_at desc, t.rowid desc limit ? offset ?`).all(...args, limit, offset) as Task[];
  return { items, total, limit, offset };
}

export const listTasks = (orgId: string) => queryTasks(orgId).items;

/** Détail d'une tâche de CETTE organisation, avec demandeur et nom du projet. */
export const getTaskDetail = (id: string, orgId: string) =>
  db.prepare(`${TASK_SELECT} where t.id = ? and t.org_id = ?`).get(id, orgId) as Task | undefined;

/** Tâches d'avant les organisations : rattachées à l'organisation donnée (une seule fois, au démarrage). */
export const adoptOrphanTasks = (orgId: string) =>
  db.prepare("update tasks set org_id = ? where org_id is null").run(orgId);

const TERMINAL: Status[] = ["done", "no_changes", "failed", "cancelled"];

export const updateTask = (id: string, patch: Partial<Pick<Task, "status" | "branch" | "mr_url" | "cost" | "started_at" | "finished_at" | "files_json" | "flagged">>) => {
  // Les horodatages suivent le statut : début au passage en « running », fin dès qu'un état terminal est atteint.
  if (patch.status === "running" && patch.started_at === undefined) patch = { ...patch, started_at: Date.now() };
  if (patch.status && TERMINAL.includes(patch.status) && patch.finished_at === undefined) patch = { ...patch, finished_at: Date.now() };
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

/* ---------------------------------- meta ---------------------------------- */

export const getMeta = (key: string) =>
  (db.prepare("select value from meta where key = ?").get(key) as { value: string } | undefined)?.value;
export const setMeta = (key: string, value: string) =>
  void db.prepare("insert into meta (key, value) values (?,?) on conflict(key) do update set value = excluded.value").run(key, value);

/* --------------------------------- secrets --------------------------------- */

export type SecretRow = { id: string; org_id: string; kind: "git_token" | "provider_key"; provider: string | null; label: string; hint: string; ciphertext: Buffer; created_at: number };
export type SecretMeta = Omit<SecretRow, "ciphertext" | "org_id">;

export const newSecretId = () => rid();
export const insertSecret = (s: Omit<SecretRow, "created_at">) =>
  void db.prepare("insert into secrets (id, org_id, kind, provider, label, hint, ciphertext, created_at) values (?,?,?,?,?,?,?,?)")
    .run(s.id, s.org_id, s.kind, s.provider, s.label, s.hint, s.ciphertext, Date.now());

/** Liste SANS le chiffré : l'API ne peut pas le divulguer, même par erreur. */
export const listSecrets = (orgId: string) =>
  db.prepare("select id, kind, provider, label, hint, created_at from secrets where org_id = ? order by created_at").all(orgId) as SecretMeta[];

export const getSecretRow = (id: string, orgId: string) =>
  db.prepare("select * from secrets where id = ? and org_id = ?").get(id, orgId) as SecretRow | undefined;

export const secretInUse = (id: string) =>
  !!db.prepare("select 1 from projects where git_secret_id = ?").get(id);

export const deleteSecret = (id: string, orgId: string) =>
  db.prepare("delete from secrets where id = ? and org_id = ?").run(id, orgId).changes > 0;

/* --------------------------------- projets --------------------------------- */

export type ProjectRow = {
  id: string; org_id: string; slug: string; name: string; repo: string; branch: string; forge: "gitlab" | "github" | "none";
  check_cmd: string; engine: string; protected_paths: string; git_secret_id: string | null; created_at: number;
};

export function insertProject(p: Omit<ProjectRow, "id" | "created_at">): string {
  const id = rid();
  db.prepare("insert into projects (id, org_id, slug, name, repo, branch, forge, check_cmd, engine, protected_paths, git_secret_id, created_at) values (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, p.org_id, p.slug, p.name, p.repo, p.branch, p.forge, p.check_cmd, p.engine, p.protected_paths, p.git_secret_id, Date.now());
  return id;
}

export const listProjects = (orgId: string) =>
  db.prepare("select * from projects where org_id = ? order by name").all(orgId) as ProjectRow[];

export const getProjectInOrg = (id: string, orgId: string) =>
  db.prepare("select * from projects where id = ? and org_id = ?").get(id, orgId) as ProjectRow | undefined;

/** Pour le pipeline (code de confiance, la tâche a déjà été rattachée à une organisation). */
export const getProjectById = (id: string) =>
  db.prepare("select * from projects where id = ?").get(id) as ProjectRow | undefined;

export function updateProject(id: string, orgId: string, patch: Partial<Omit<ProjectRow, "id" | "org_id" | "created_at">>) {
  const keys = Object.keys(patch);
  if (!keys.length) return false;
  return db.prepare(`update projects set ${keys.map((k) => `${k} = ?`).join(", ")} where id = ? and org_id = ?`)
    .run(...(Object.values(patch) as (string | null)[]), id, orgId).changes > 0;
}

export const deleteProject = (id: string, orgId: string) =>
  db.prepare("delete from projects where id = ? and org_id = ?").run(id, orgId).changes > 0;

export const countProjects = () => (db.prepare("select count(*) as n from projects").get() as { n: number }).n;

/** Tâches d'avant U4 : leur champ « project » contenait l'identifiant de la config ; il pointe désormais le projet en base. */
export const remapTaskProject = (orgId: string, from: string, to: string) =>
  void db.prepare("update tasks set project = ? where org_id = ? and project = ?").run(to, orgId, from);

/* ----------------------- organisation : budget mensuel ----------------------- */

export type OrgRow = { id: string; name: string; budget_usd_month: number | null };
export const getOrg = (id: string) =>
  db.prepare("select id, name, budget_usd_month from orgs where id = ?").get(id) as OrgRow | undefined;

/** null = pas de plafond. */
export const setOrgBudget = (orgId: string, usd: number | null) =>
  void db.prepare("update orgs set budget_usd_month = ? where id = ?").run(usd, orgId);

/** Dépense déclarée par les agents depuis le début du mois (UTC) pour cette organisation. */
export function monthSpend(orgId: string, now = Date.now()): number {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return (db.prepare("select coalesce(sum(cost), 0) as c from tasks where org_id = ? and created_at >= ? and created_at < ?").get(orgId, start, end) as { c: number }).c;
}

/** Clé de modèle la plus récente de l'organisation pour ce fournisseur. */
export const latestProviderSecret = (orgId: string, provider: string) =>
  db.prepare("select * from secrets where org_id = ? and kind = 'provider_key' and provider = ? order by created_at desc, rowid desc limit 1").get(orgId, provider) as SecretRow | undefined;

/* ------------------------------ membres et invitations ------------------------------ */

export type Member = { user_id: string; email: string; role: Role };
export const listMembers = (orgId: string) =>
  db.prepare("select m.user_id, u.email, m.role from memberships m join users u on u.id = m.user_id where m.org_id = ? order by u.email").all(orgId) as Member[];

export const setMemberRole = (orgId: string, userId: string, role: Role) =>
  db.prepare("update memberships set role = ? where org_id = ? and user_id = ?").run(role, orgId, userId).changes > 0;

export const removeMember = (orgId: string, userId: string) =>
  db.prepare("delete from memberships where org_id = ? and user_id = ?").run(orgId, userId).changes > 0;

export const countOwners = (orgId: string) =>
  (db.prepare("select count(*) as n from memberships where org_id = ? and role = 'owner'").get(orgId) as { n: number }).n;

export type Invitation = { id: string; token_hash: string; org_id: string; email: string; role: Role; created_by: string; created_at: number; expires_at: number };

/** Une seule invitation en attente par (organisation, e-mail) : la nouvelle remplace l'ancienne. */
export function insertInvitation(orgId: string, email: string, role: Role, createdBy: string, tokenHash: string, expiresAt: number) {
  db.prepare("delete from invitations where org_id = ? and email = ?").run(orgId, normEmail(email));
  const id = rid();
  db.prepare("insert into invitations (id, token_hash, org_id, email, role, created_by, created_at, expires_at) values (?,?,?,?,?,?,?,?)")
    .run(id, tokenHash, orgId, normEmail(email), role, createdBy, Date.now(), expiresAt);
  return id;
}

/** Sans le hash du jeton : l'API ne peut pas le divulguer. */
export const listInvitations = (orgId: string) =>
  db.prepare("select id, email, role, created_at, expires_at from invitations where org_id = ? and expires_at > ? order by created_at").all(orgId, Date.now()) as Omit<Invitation, "token_hash" | "org_id" | "created_by">[];

export const findInvitation = (tokenHash: string) =>
  db.prepare("select * from invitations where token_hash = ? and expires_at > ?").get(tokenHash, Date.now()) as Invitation | undefined;

export const deleteInvitation = (id: string, orgId: string) =>
  db.prepare("delete from invitations where id = ? and org_id = ?").run(id, orgId).changes > 0;

/** L'invitation est à usage unique : consommée dès qu'elle est acceptée. */
export const consumeInvitation = (tokenHash: string) =>
  void db.prepare("delete from invitations where token_hash = ?").run(tokenHash);

export const countOrgsOf = (userId: string) =>
  (db.prepare("select count(*) as n from memberships where user_id = ?").get(userId) as { n: number }).n;

/** Pour les tests : date de création arbitraire (les filtres par période en ont besoin). */
export const updateTaskCreatedAtForTest = (id: string, at: number) =>
  void db.prepare("update tasks set created_at = ? where id = ?").run(at, id);
