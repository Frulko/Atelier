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
  /** Tour de l'agent en cours ou dernier (1 = la demande initiale) et la demande de ce tour quand c'est un ajustement. */
  turn: number; followup: string | null;
  user_email?: string | null;
};
export type Evt = { id: number; task_id: string; ts: number; type: string; text: string; turn?: number };

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
  create table if not exists proxy_calls (
    id integer primary key autoincrement, ts integer not null,
    org_id text not null, task_id text not null, provider text not null, status integer not null
  );
  create index if not exists proxy_calls_org on proxy_calls(org_id, ts);
  create table if not exists audit_log (
    id integer primary key autoincrement, ts integer not null,
    org_id text, user_id text, action text not null,
    target_type text, target_id text, meta text, ip text
  );
  create index if not exists audit_org on audit_log(org_id, ts);
  create index if not exists audit_user on audit_log(user_id, ts);
  create table if not exists knowledge (
    id text primary key, org_id text not null references orgs(id) on delete cascade,
    project_id text references projects(id) on delete cascade,
    title text not null, content text not null, enabled integer not null default 1, pinned integer not null default 0,
    created_by text, created_at integer not null, updated_at integer not null
  );
  create index if not exists knowledge_org on knowledge(org_id);
  create table if not exists conversations (
    id text primary key, org_id text not null references orgs(id) on delete cascade,
    user_id text not null, project_id text references projects(id) on delete set null,
    mode text not null check (mode in ('chat','task')), title text not null,
    task_id text, parent_id text, created_at integer not null, updated_at integer not null
  );
  create index if not exists conversations_org on conversations(org_id, updated_at);
  create table if not exists messages (
    id text primary key, conversation_id text not null references conversations(id) on delete cascade,
    role text not null check (role in ('user','assistant')), parts text not null, meta text, created_at integer not null
  );
  create index if not exists messages_conv on messages(conversation_id, created_at);
  create table if not exists sessions (
    token_hash text primary key, user_id text not null references users(id) on delete cascade,
    created_at integer not null, expires_at integer not null
  );
`);
db.exec("pragma foreign_keys = on");

// Migration M1 → U3 : les bases créées avant les organisations n'ont pas ces colonnes.
const orgCols = (db.prepare("pragma table_info(orgs)").all() as { name: string }[]).map((c) => c.name);
if (!orgCols.includes("budget_usd_month")) db.exec("alter table orgs add column budget_usd_month real");
if (!orgCols.includes("chat_provider")) db.exec("alter table orgs add column chat_provider text");
if (!orgCols.includes("chat_model")) db.exec("alter table orgs add column chat_model text");
const taskCols = (db.prepare("pragma table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
if (!taskCols.includes("org_id")) db.exec("alter table tasks add column org_id text");
if (!taskCols.includes("user_id")) db.exec("alter table tasks add column user_id text");
if (!taskCols.includes("started_at")) db.exec("alter table tasks add column started_at integer");
if (!taskCols.includes("finished_at")) db.exec("alter table tasks add column finished_at integer");
if (!taskCols.includes("files_json")) db.exec("alter table tasks add column files_json text");
if (!taskCols.includes("flagged")) db.exec("alter table tasks add column flagged integer not null default 0");
if (!taskCols.includes("turn")) db.exec("alter table tasks add column turn integer not null default 1");
if (!taskCols.includes("followup")) db.exec("alter table tasks add column followup text");
const eventCols = (db.prepare("pragma table_info(events)").all() as { name: string }[]).map((c) => c.name);
if (!eventCols.includes("turn")) db.exec("alter table events add column turn integer not null default 1");
db.exec("create index if not exists tasks_org on tasks(org_id, created_at)");
const secretCols = (db.prepare("pragma table_info(secrets)").all() as { name: string }[]).map((c) => c.name);
if (!secretCols.includes("last_used_at")) db.exec("alter table secrets add column last_used_at integer");
const userCols = (db.prepare("pragma table_info(users)").all() as { name: string }[]).map((c) => c.name);
if (!userCols.includes("name")) db.exec("alter table users add column name text");
const sessCols = (db.prepare("pragma table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
if (!sessCols.includes("user_agent")) db.exec("alter table sessions add column user_agent text");
if (!sessCols.includes("ip")) db.exec("alter table sessions add column ip text");
if (!sessCols.includes("last_used_at")) db.exec("alter table sessions add column last_used_at integer");

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

export const updateTask = (id: string, patch: Partial<Pick<Task, "status" | "branch" | "mr_url" | "cost" | "started_at" | "finished_at" | "files_json" | "flagged" | "turn" | "followup">>) => {
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
  const turn = (db.prepare("select turn from tasks where id = ?").get(task_id) as { turn: number } | undefined)?.turn ?? 1;
  const r = db.prepare("insert into events (task_id, ts, type, text, turn) values (?,?,?,?,?)").run(task_id, ts, type, text, turn);
  bus.emit(task_id, { id: Number(r.lastInsertRowid), task_id, ts, type, text, turn } satisfies Evt);
};

export const getEvents = (task_id: string, afterId = 0) =>
  db.prepare("select * from events where task_id = ? and id > ? order by id").all(task_id, afterId) as Evt[];

/** Au démarrage, une tâche "running" est forcément orpheline (le conteneur a été tué avec nous). */
export const failOrphans = () =>
  db.prepare("update tasks set status = 'failed' where status in ('running','queued')").run();

/* ------------------------- utilisateurs / organisations ------------------------- */

export type Role = "owner" | "admin" | "member" | "viewer";
export type User = { id: string; email: string; name: string | null; password_hash: string; created_at: number };

const rid = () => randomBytes(8).toString("hex");
export const normEmail = (e: string) => e.trim().toLowerCase();

export const countUsers = () => (db.prepare("select count(*) as n from users").get() as { n: number }).n;

export const getUserByEmail = (email: string) =>
  db.prepare("select * from users where email = ?").get(normEmail(email)) as User | undefined;

export function createUser(email: string, passwordHash: string): User {
  const u: User = { id: rid(), email: normEmail(email), name: null, password_hash: passwordHash, created_at: Date.now() };
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

export type SessionRow = { token_hash: string; user_id: string; created_at: number; expires_at: number; user_agent: string | null; ip: string | null; last_used_at: number | null };

export const insertSession = (tokenHash: string, userId: string, now: number, expiresAt: number, userAgent: string | null = null, ip: string | null = null) =>
  db.prepare("insert into sessions (token_hash, user_id, created_at, expires_at, user_agent, ip, last_used_at) values (?,?,?,?,?,?,?)").run(tokenHash, userId, now, expiresAt, userAgent, ip, now);

export const touchSession = (tokenHash: string, now: number) =>
  void db.prepare("update sessions set last_used_at = ? where token_hash = ?").run(now, tokenHash);

export const listSessions = (userId: string) =>
  db.prepare("select * from sessions where user_id = ? and expires_at > ? order by coalesce(last_used_at, created_at) desc").all(userId, Date.now()) as SessionRow[];

/** Révoque UNE session de CETTE personne, désignée par le début de son empreinte (jamais le jeton). */
export const deleteSessionByPrefix = (userId: string, prefix: string) =>
  prefix.length >= 12 && db.prepare("delete from sessions where user_id = ? and token_hash like ? || '%'").run(userId, prefix).changes > 0;

export const setUserName = (userId: string, name: string | null) =>
  void db.prepare("update users set name = ? where id = ?").run(name, userId);

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

export type SecretRow = { id: string; org_id: string; kind: "git_token" | "provider_key"; provider: string | null; label: string; hint: string; ciphertext: Buffer; created_at: number; last_used_at: number | null };
export type SecretMeta = Omit<SecretRow, "ciphertext" | "org_id">;

export const newSecretId = () => rid();
export const insertSecret = (s: Omit<SecretRow, "created_at" | "last_used_at">) =>
  void db.prepare("insert into secrets (id, org_id, kind, provider, label, hint, ciphertext, created_at) values (?,?,?,?,?,?,?,?)")
    .run(s.id, s.org_id, s.kind, s.provider, s.label, s.hint, s.ciphertext, Date.now());

/** Liste SANS le chiffré : l'API ne peut pas le divulguer, même par erreur. */
export const listSecrets = (orgId: string) =>
  db.prepare("select id, kind, provider, label, hint, created_at, last_used_at from secrets where org_id = ? order by created_at").all(orgId) as SecretMeta[];

/** Quels projets utilisent chaque secret comme jeton git (pour la page « Intégrations »). */
export const secretUsers = (orgId: string) => {
  const by: Record<string, { id: string; name: string }[]> = {};
  for (const r of db.prepare("select git_secret_id as sid, id, name from projects where org_id = ? and git_secret_id is not null order by name").all(orgId) as { sid: string; id: string; name: string }[])
    (by[r.sid] ??= []).push({ id: r.id, name: r.name });
  return by;
};

/** Au plus une écriture par minute et par secret. */
export const touchSecret = (id: string, now = Date.now()) =>
  void db.prepare("update secrets set last_used_at = ? where id = ? and (last_used_at is null or last_used_at < ?)").run(now, id, now - 60_000);

export const updateSecret = (id: string, orgId: string, p: { label?: string; hint?: string; ciphertext?: Buffer }) => {
  const keys = Object.keys(p) as (keyof typeof p)[];
  if (!keys.length) return false;
  return db.prepare(`update secrets set ${keys.map((k) => `${k} = ?`).join(", ")} where id = ? and org_id = ?`)
    .run(...keys.map((k) => p[k] as string | Buffer), id, orgId).changes > 0;
};

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

export type OrgRow = { id: string; name: string; budget_usd_month: number | null; chat_provider: string | null; chat_model: string | null };
export const getOrg = (id: string) =>
  db.prepare("select id, name, budget_usd_month, chat_provider, chat_model from orgs where id = ?").get(id) as OrgRow | undefined;

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

/* ----------------------------------- audit ----------------------------------- */

export type AuditRow = {
  id: number; ts: number; org_id: string | null; user_id: string | null; action: string;
  target_type: string | null; target_id: string | null; meta: string | null; ip: string | null; user_email?: string | null;
};

export const insertAudit = (r: Omit<AuditRow, "id" | "user_email">) =>
  void db.prepare("insert into audit_log (ts, org_id, user_id, action, target_type, target_id, meta, ip) values (?,?,?,?,?,?,?,?)")
    .run(r.ts, r.org_id, r.user_id, r.action, r.target_type, r.target_id, r.meta, r.ip);

export type AuditFilters = { action?: string; user?: string; q?: string; from?: number; to?: number; limit?: number; offset?: number };

/** Journal d'UNE organisation. `action` : valeur exacte, ou préfixe terminé par un point (« member. »). */
export function queryAudit(orgId: string, f: AuditFilters = {}, maxLimit = 100): { items: AuditRow[]; total: number; limit: number; offset: number } {
  const where = ["a.org_id = ?"]; const args: (string | number)[] = [orgId];
  if (f.action) {
    if (f.action.endsWith(".")) { where.push("a.action like ? escape '\\'"); args.push(`${f.action.replace(/[\\%_]/g, "\\$&")}%`); }
    else { where.push("a.action = ?"); args.push(f.action); }
  }
  if (f.user) { where.push("a.user_id = ?"); args.push(f.user); }
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, "\\$&")}%`;
    where.push("(a.action like ? escape '\\' or a.meta like ? escape '\\' or u.email like ? escape '\\')"); args.push(like, like, like);
  }
  if (f.from != null) { where.push("a.ts >= ?"); args.push(f.from); }
  if (f.to != null) { where.push("a.ts < ?"); args.push(f.to); }
  const limit = Math.min(Math.max(f.limit ?? 50, 1), maxLimit), offset = Math.max(f.offset ?? 0, 0);
  const from = "from audit_log a left join users u on u.id = a.user_id";
  const w = where.join(" and ");
  const total = (db.prepare(`select count(*) as n ${from} where ${w}`).get(...args) as { n: number }).n;
  const items = db.prepare(`select a.*, u.email as user_email ${from} where ${w} order by a.ts desc, a.id desc limit ? offset ?`).all(...args, limit, offset) as AuditRow[];
  return { items, total, limit, offset };
}

/** Ce qu'une personne a fait elle-même, dans toutes ses organisations : pour la page « Mon compte ». */
export const userActivity = (userId: string, limit = 50) =>
  db.prepare("select a.*, o.name as org_name from audit_log a left join orgs o on o.id = a.org_id where a.user_id = ? order by a.ts desc, a.id desc limit ?")
    .all(userId, Math.min(Math.max(limit, 1), 200)) as (AuditRow & { org_name: string | null })[];

/* ------------------------------ statistiques et usage ------------------------------ */

export const recordProxyCall = (orgId: string, taskId: string, provider: string, status: number, ts = Date.now()) =>
  void db.prepare("insert into proxy_calls (ts, org_id, task_id, provider, status) values (?,?,?,?,?)").run(ts, orgId, taskId, provider, status);

const DAY = 86400_000;
/** Début (UTC) de la fenêtre de `days` jours finissant aujourd'hui, et fin exclusive (demain 00:00 UTC). */
export function dayWindow(days: number, now = Date.now()) {
  const n = Math.min(Math.max(Math.floor(days) || 30, 1), 365);
  const end = Math.floor(now / DAY) * DAY + DAY;
  return { days: n, from: end - n * DAY, to: end };
}
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type DayPoint = { day: string; tasks: number; done: number; failed: number; spendUsd: number; calls?: number };

/** Série par jour (UTC), SANS trou : un jour sans activité vaut zéro. */
function fillDays(w: { from: number; to: number }, rows: Record<string, Partial<DayPoint>>): DayPoint[] {
  const out: DayPoint[] = [];
  for (let t = w.from; t < w.to; t += DAY) {
    const k = dayKey(t), r = rows[k] ?? {};
    out.push({ day: k, tasks: r.tasks ?? 0, done: r.done ?? 0, failed: r.failed ?? 0, spendUsd: Math.round((r.spendUsd ?? 0) * 100) / 100, ...(r.calls !== undefined ? { calls: r.calls } : {}) });
  }
  return out;
}

export function orgStats(orgId: string, days: number, now = Date.now()) {
  const w = dayWindow(days, now);
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const r of db.prepare("select status, count(*) as n from tasks where org_id = ? and created_at >= ? and created_at < ? group by status").all(orgId, w.from, w.to) as { status: Status; n: number }[]) byStatus[r.status] = r.n;
  const tot = db.prepare("select count(*) as n, coalesce(sum(cost),0) as spend, avg(case when started_at is not null and finished_at is not null then finished_at - started_at end) as avgMs from tasks where org_id = ? and created_at >= ? and created_at < ?").get(orgId, w.from, w.to) as { n: number; spend: number; avgMs: number | null };
  const finished = byStatus.done + byStatus.failed;

  const perDayRows: Record<string, Partial<DayPoint>> = {};
  for (const r of db.prepare("select strftime('%Y-%m-%d', created_at/1000, 'unixepoch') as d, count(*) as n, sum(status='done') as done, sum(status='failed') as failed, coalesce(sum(cost),0) as spend from tasks where org_id = ? and created_at >= ? and created_at < ? group by d").all(orgId, w.from, w.to) as { d: string; n: number; done: number; failed: number; spend: number }[])
    perDayRows[r.d] = { tasks: r.n, done: r.done, failed: r.failed, spendUsd: r.spend };

  const byProject = db.prepare("select t.project as id, coalesce(p.name, '(projet supprimé)') as name, count(*) as tasks, sum(t.status='done') as done, sum(t.status='failed') as failed, coalesce(sum(t.cost),0) as spendUsd from tasks t left join projects p on p.id = t.project where t.org_id = ? and t.created_at >= ? and t.created_at < ? group by t.project order by tasks desc, name").all(orgId, w.from, w.to) as { id: string; name: string; tasks: number; done: number; failed: number; spendUsd: number }[];

  return {
    range: { days: w.days, from: w.from, to: w.to },
    totals: { tasks: tot.n, byStatus, successRate: finished ? byStatus.done / finished : null, avgDurationMs: tot.avgMs === null ? null : Math.round(tot.avgMs), spendUsd: Math.round(tot.spend * 100) / 100 },
    perDay: fillDays(w, perDayRows),
    byProject: byProject.map((r) => ({ ...r, spendUsd: Math.round(r.spendUsd * 100) / 100 })),
  };
}

export function orgUsage(orgId: string, days: number, now = Date.now()) {
  const w = dayWindow(days, now);
  const perDayRows: Record<string, Partial<DayPoint>> = {};
  for (const r of db.prepare("select strftime('%Y-%m-%d', created_at/1000, 'unixepoch') as d, count(*) as n, coalesce(sum(cost),0) as spend from tasks where org_id = ? and created_at >= ? and created_at < ? group by d").all(orgId, w.from, w.to) as { d: string; n: number; spend: number }[])
    perDayRows[r.d] = { tasks: r.n, spendUsd: r.spend };
  for (const r of db.prepare("select strftime('%Y-%m-%d', ts/1000, 'unixepoch') as d, count(*) as n from proxy_calls where org_id = ? and ts >= ? and ts < ? group by d").all(orgId, w.from, w.to) as { d: string; n: number }[])
    perDayRows[r.d] = { ...perDayRows[r.d], calls: r.n };
  const byMember = db.prepare("select t.user_id as userId, coalesce(u.email, '(compte supprimé)') as email, count(*) as tasks, sum(t.status='done') as done, sum(t.status='failed') as failed, coalesce(sum(t.cost),0) as spendUsd from tasks t left join users u on u.id = t.user_id where t.org_id = ? and t.created_at >= ? and t.created_at < ? group by t.user_id order by spendUsd desc, tasks desc").all(orgId, w.from, w.to) as { userId: string; email: string; tasks: number; done: number; failed: number; spendUsd: number }[];
  const byProvider = db.prepare("select provider, count(*) as calls, sum(status >= 400) as errors from proxy_calls where org_id = ? and ts >= ? and ts < ? group by provider order by calls desc").all(orgId, w.from, w.to) as { provider: string; calls: number; errors: number }[];
  const byProject = orgStats(orgId, days, now).byProject;
  const month = new Date(now), mStart = Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1), mEnd = Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1);
  const elapsed = Math.max((now - mStart) / (mEnd - mStart), 1 / 31);
  const spent = monthSpend(orgId, now);
  return {
    range: { days: w.days, from: w.from, to: w.to },
    perDay: fillDays(w, perDayRows),
    byProject, byMember: byMember.map((r) => ({ ...r, spendUsd: Math.round(r.spendUsd * 100) / 100 })), byProvider,
    budget: { capUsd: getOrg(orgId)?.budget_usd_month ?? null, monthSpendUsd: Math.round(spent * 100) / 100, projectedMonthUsd: Math.round((spent / elapsed) * 100) / 100 },
  };
}

/* --------------------------- organisation : nom, suppression --------------------------- */

export const renameOrg = (orgId: string, name: string) =>
  void db.prepare("update orgs set name = ? where id = ?").run(name, orgId);

export const activeTaskCount = (orgId: string) =>
  (db.prepare("select count(*) as n from tasks where org_id = ? and status in ('queued','running')").get(orgId) as { n: number }).n;

/** Supprime l'organisation et TOUT ce qui lui appartient, d'un seul bloc (tout ou rien). Les comptes des personnes restent. */
export function deleteOrgCascade(orgId: string) {
  db.exec("begin");
  try {
    db.prepare("delete from messages where conversation_id in (select id from conversations where org_id = ?)").run(orgId);
    db.prepare("delete from events where task_id in (select id from tasks where org_id = ?)").run(orgId);
    for (const t of ["conversations", "tasks", "proxy_calls", "audit_log", "invitations", "knowledge", "projects", "secrets", "memberships"]) db.prepare(`delete from ${t} where org_id = ?`).run(orgId);
    db.prepare("delete from orgs where id = ?").run(orgId);
    db.exec("commit");
  } catch (e) { db.exec("rollback"); throw e; }
}

/* ------------------------------- connaissances ------------------------------- */

export type KnowledgeRow = {
  id: string; org_id: string; project_id: string | null; title: string; content: string;
  enabled: number; pinned: number; created_by: string | null; created_at: number; updated_at: number; author_email?: string | null;
};

export function insertKnowledge(k: { org_id: string; project_id: string | null; title: string; content: string; enabled: boolean; pinned: boolean; created_by: string }): string {
  const id = rid(), now = Date.now();
  db.prepare("insert into knowledge (id, org_id, project_id, title, content, enabled, pinned, created_by, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?)")
    .run(id, k.org_id, k.project_id, k.title, k.content, k.enabled ? 1 : 0, k.pinned ? 1 : 0, k.created_by, now, now);
  return id;
}

export const listKnowledge = (orgId: string) =>
  db.prepare("select k.*, u.email as author_email from knowledge k left join users u on u.id = k.created_by where k.org_id = ? order by k.pinned desc, k.updated_at desc").all(orgId) as KnowledgeRow[];

export const getKnowledge = (id: string, orgId: string) =>
  db.prepare("select k.*, u.email as author_email from knowledge k left join users u on u.id = k.created_by where k.id = ? and k.org_id = ?").get(id, orgId) as KnowledgeRow | undefined;

export const countKnowledge = (orgId: string) =>
  (db.prepare("select count(*) as n from knowledge where org_id = ?").get(orgId) as { n: number }).n;

export function updateKnowledge(id: string, orgId: string, p: { project_id?: string | null; title?: string; content?: string; enabled?: number; pinned?: number }) {
  const keys = Object.keys(p) as (keyof typeof p)[];
  if (!keys.length) return false;
  return db.prepare(`update knowledge set ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? where id = ? and org_id = ?`)
    .run(...keys.map((k) => p[k] as string | number | null), Date.now(), id, orgId).changes > 0;
}

export const deleteKnowledge = (id: string, orgId: string) =>
  db.prepare("delete from knowledge where id = ? and org_id = ?").run(id, orgId).changes > 0;

export const setOrgChat = (orgId: string, provider: string | null, model: string | null) =>
  void db.prepare("update orgs set chat_provider = ?, chat_model = ? where id = ?").run(provider, model, orgId);

/* ------------------------------- conversations ------------------------------- */

export type Mode = "chat" | "task";
export type ConversationRow = {
  id: string; org_id: string; user_id: string; project_id: string | null; mode: Mode; title: string; task_id: string | null; parent_id: string | null;
  created_at: number; updated_at: number; user_email?: string | null; project_name?: string | null; message_count?: number; last_text?: string | null;
};
export const DEFAULT_TITLE = "Nouvelle conversation";

export function insertConversation(c: { org_id: string; user_id: string; project_id: string | null; mode: Mode; title?: string; task_id?: string | null; parent_id?: string | null }): string {
  const id = rid(), now = Date.now();
  db.prepare("insert into conversations (id, org_id, user_id, project_id, mode, title, task_id, parent_id, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?)")
    .run(id, c.org_id, c.user_id, c.project_id, c.mode, c.title ?? DEFAULT_TITLE, c.task_id ?? null, c.parent_id ?? null, now, now);
  return id;
}

const CONV_SELECT = `select c.*, u.email as user_email, p.name as project_name,
  (select count(*) from messages m where m.conversation_id = c.id) as message_count,
  (select m.parts from messages m where m.conversation_id = c.id order by m.created_at desc, m.rowid desc limit 1) as last_text
  from conversations c left join users u on u.id = c.user_id left join projects p on p.id = c.project_id`;

/** Les discussions sont PRIVÉES (leur auteur seul) ; les conversations de tâche sont visibles de toute l'organisation. */
export const getConversationFor = (id: string, orgId: string, userId: string) =>
  db.prepare(`${CONV_SELECT} where c.id = ? and c.org_id = ? and (c.mode = 'task' or c.user_id = ?)`).get(id, orgId, userId) as ConversationRow | undefined;

export const getConversationByTask = (taskId: string) =>
  db.prepare(`${CONV_SELECT} where c.task_id = ?`).get(taskId) as ConversationRow | undefined;

export function listConversations(orgId: string, userId: string, f: { mode?: Mode; project?: string; q?: string; limit?: number; offset?: number } = {}) {
  const where = ["c.org_id = ?", "(c.mode = 'task' or c.user_id = ?)"]; const args: (string | number)[] = [orgId, userId];
  if (f.mode) { where.push("c.mode = ?"); args.push(f.mode); }
  if (f.project) { where.push("c.project_id = ?"); args.push(f.project); }
  if (f.q) { where.push("c.title like ? escape '\\'"); args.push(`%${f.q.replace(/[\\%_]/g, "\\$&")}%`); }
  const limit = Math.min(Math.max(f.limit ?? 30, 1), 100), offset = Math.max(f.offset ?? 0, 0), w = where.join(" and ");
  const total = (db.prepare(`select count(*) as n from conversations c where ${w}`).get(...args) as { n: number }).n;
  const items = db.prepare(`${CONV_SELECT} where ${w} order by c.updated_at desc, c.rowid desc limit ? offset ?`).all(...args, limit, offset) as ConversationRow[];
  return { items, total, limit, offset };
}

export const touchConversation = (id: string) => void db.prepare("update conversations set updated_at = ? where id = ?").run(Date.now(), id);
export const setConversationTitle = (id: string, title: string) => void db.prepare("update conversations set title = ?, updated_at = ? where id = ?").run(title, Date.now(), id);
export const deleteConversation = (id: string, orgId: string) => db.prepare("delete from conversations where id = ? and org_id = ?").run(id, orgId).changes > 0;
export const countConversationsOf = (orgId: string, userId: string) =>
  (db.prepare("select count(*) as n from conversations where org_id = ? and user_id = ? and mode = 'chat'").get(orgId, userId) as { n: number }).n;

export type MessageRow = { id: string; conversation_id: string; role: "user" | "assistant"; parts: string; meta: string | null; created_at: number };

export function insertMessage(conversationId: string, role: "user" | "assistant", parts: unknown[], meta?: unknown, id = rid()): string {
  db.prepare("insert into messages (id, conversation_id, role, parts, meta, created_at) values (?,?,?,?,?,?)")
    .run(id, conversationId, role, JSON.stringify(parts), meta === undefined ? null : JSON.stringify(meta), Date.now());
  touchConversation(conversationId);
  return id;
}
export const getMessages = (conversationId: string) =>
  db.prepare("select * from messages where conversation_id = ? order by created_at, rowid").all(conversationId) as MessageRow[];
export const countMessages = (conversationId: string) =>
  (db.prepare("select count(*) as n from messages where conversation_id = ?").get(conversationId) as { n: number }).n;
/** « Régénérer » : on retire la dernière réponse de l'assistant (et seulement elle). */
export const deleteTrailingAssistant = (conversationId: string) =>
  void db.prepare("delete from messages where id = (select id from messages where conversation_id = ? order by created_at desc, rowid desc limit 1) and role = 'assistant'").run(conversationId);

/** Tokens consommés par les discussions (somme des métadonnées des réponses), pour la page d'usage. */
export function chatTokens(orgId: string, from: number, to: number) {
  let input = 0, output = 0, replies = 0;
  for (const r of db.prepare("select m.meta from messages m join conversations c on c.id = m.conversation_id where c.org_id = ? and m.role = 'assistant' and m.created_at >= ? and m.created_at < ? and m.meta is not null").all(orgId, from, to) as { meta: string }[]) {
    try { const u = JSON.parse(r.meta)?.usage; input += Number(u?.inputTokens) || 0; output += Number(u?.outputTokens) || 0; replies++; } catch { /* méta illisible : ignorée */ }
  }
  return { input, output, replies };
}
