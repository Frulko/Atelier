import { randomBytes } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { db, getOrg, getProjectInOrg, monthSpend } from "./db.ts";
import { HttpError } from "./http.ts";

db.exec(`create table if not exists budget_extensions (
  id text primary key, org_id text not null references orgs(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade, day_start integer not null,
  usd real not null, question_id text unique not null, created_at integer not null
);`);

export function overBudget(orgId: string, now = Date.now()): boolean {
  const cap = getOrg(orgId)?.budget_usd_month;
  return cap != null && monthSpend(orgId, now) >= cap;
}

export function dayBounds(timezone: string, now = Date.now()) {
  const start = CronExpressionParser.parse("0 0 * * *", { tz: timezone, currentDate: new Date(now + 1) }).prev().getTime();
  const end = CronExpressionParser.parse("0 0 * * *", { tz: timezone, currentDate: new Date(start + 1) }).next().getTime();
  return { start, end };
}
const held = (org: string, project?: string, except?: string) => (db.prepare(`
  select coalesce(sum(max(0,h.amount-coalesce((select sum(e.usd) from expenses e where e.hold_id=h.id),0))),0) as n
  from budget_holds h where h.org_id=? and (? is null or h.project_id=?) and (? is null or h.id!=?)
`).get(org, project ?? null, project ?? null, except ?? null, except ?? null) as {n:number}).n;

export function projectBudget(org: string, project: string, now = Date.now(), exceptHold?: string) {
  const p = getProjectInOrg(project, org);
  if (!p) throw new HttpError(404, "Projet introuvable.");
  const timezone = p.budget_timezone || "Europe/Paris", {start,end} = dayBounds(timezone, now);
  const spent = (db.prepare(`select coalesce(sum(e.usd),0) as n from expenses e
    left join tasks t on t.id=e.task_id where e.org_id=? and coalesce(e.project_id,t.project)=? and e.ts>=? and e.ts<?`)
    .get(org, project, start, end) as {n:number}).n;
  const reserved = held(org, project, exceptHold);
  const extra=(db.prepare("select coalesce(sum(usd),0) as n from budget_extensions where org_id=? and project_id=? and day_start=?").get(org,project,start) as {n:number}).n;
  const baseCap=p.budget_usd_day??null, cap=baseCap===null?null:baseCap+extra;
  return { baseCapUsd:baseCap, extraUsd:extra, capUsd:cap, spentUsd:spent, reservedUsd:reserved, remainingUsd:cap === null ? null : Math.max(0,cap-spent-reserved), timezone, resetsAt:end };
}

export function availableBudget(org: string, project?: string, exceptHold?: string) {
  const o = getOrg(org);
  if (!o) throw new HttpError(404, "Organisation introuvable.");
  const monthly = o.budget_usd_month === null ? Infinity : Math.max(0,o.budget_usd_month-monthSpend(org)-held(org,undefined,exceptHold));
  const daily = project ? projectBudget(org,project,Date.now(),exceptHold).remainingUsd ?? Infinity : Infinity;
  return Math.min(monthly,daily);
}
export function assertBudget(org: string, project?: string, exceptHold?: string) {
  if (availableBudget(org,project,exceptHold) < 0.000001)
    throw new HttpError(402, "Budget disponible épuisé (plafond journalier ou mensuel, réservations comprises).");
}
export function reserveBudget(org: string, project: string | undefined, requested: number, taskId?: string, exact = false) {
  if (!Number.isFinite(requested) || requested < 0) throw new Error("Budget invalide.");
  const available = availableBudget(org,project);
  if (available < 0.000001 || (exact && requested > available + 1e-9))
    throw new HttpError(402, "Le budget disponible ne couvre pas cette exécution. Réduis sa taille ou relève le plafond.");
  const amount = Math.min(requested, available), id = randomBytes(16).toString("hex");
  db.prepare("insert into budget_holds values (?,?,?,?,?,?)").run(id,org,project??null,taskId??null,amount,Date.now());
  return {id,amount};
}
export function settleBudget(id: string, uncertain = false) {
  const h = db.prepare("select * from budget_holds where id=?").get(id) as {org_id:string;project_id:string|null;task_id:string|null;amount:number} | undefined;
  if (!h) return;
  db.exec("savepoint settle_budget");
  try {
    const meteringExists=!!db.prepare("select 1 from sqlite_master where name='model_charges'").get();
    const metered=meteringExists?(db.prepare("select coalesce(sum(usd),0) as n from model_charges where hold_id=?").get(id) as {n:number}).n:0;
    if (uncertain || metered>0) {
      const spent = (db.prepare("select coalesce(sum(usd),0) as n from expenses where hold_id=?").get(id) as {n:number}).n;
      const remainder = Math.max(0,(uncertain?Math.max(h.amount,metered):metered)-spent);
      if (remainder) db.prepare("insert into expenses (org_id,task_id,project_id,hold_id,ts,usd) values (?,?,?,?,?,?)").run(h.org_id,h.task_id,h.project_id,id,Date.now(),remainder);
    }
    db.prepare("delete from budget_holds where id=?").run(id);
    db.exec("release settle_budget");
  } catch(e) { db.exec("rollback to settle_budget; release settle_budget"); throw e; }
}
export function recoverBudgets() {
  for (const h of db.prepare("select id from budget_holds").all() as {id:string}[]) settleBudget(h.id,true);
}
