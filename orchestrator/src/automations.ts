import { CronExpressionParser } from "cron-parser";
import { randomBytes } from "node:crypto";
import { db, getProjectInOrg, getTask, roleOf } from "./db.ts";
import { can } from "./access.ts";
import { overBudget } from "./budget.ts";
import { audit } from "./audit.ts";
import { startTask, followUp, MAX_TURNS } from "./start.ts";
import { notify } from "./notifications.ts";
import { HttpError } from "./http.ts";

db.exec(`
  create table if not exists automations (
    id text primary key, org_id text not null references orgs(id) on delete cascade,
    project_id text not null references projects(id) on delete cascade,
    user_id text not null references users(id) on delete cascade,
    name text not null, prompt text not null, kind text not null,
    cron text, timezone text not null, interval_minutes integer not null,
    max_runs_day integer not null, enabled integer not null, next_run_at integer not null,
    last_task_id text, last_error text, created_at integer not null
  );
  create table if not exists automation_runs (
    automation_id text not null references automations(id) on delete cascade,
    task_id text not null, created_at integer not null
  );
  create index if not exists automation_due on automations(enabled, next_run_at);
`);

export type Automation = {
  id: string;
  org_id: string;
  project_id: string;
  user_id: string;
  name: string;
  prompt: string;
  kind: "cron" | "autonomous";
  cron: string | null;
  timezone: string;
  interval_minutes: number;
  max_runs_day: number;
  enabled: number;
  next_run_at: number;
  last_task_id: string | null;
  last_error: string | null;
  created_at: number;
};
export const getAutomation = (id: string, org: string) =>
  db
    .prepare("select * from automations where id = ? and org_id = ?")
    .get(id, org) as Automation | undefined;
export const listAutomations = (org: string) =>
  db
    .prepare(
      "select a.*, p.name as project_name from automations a join projects p on p.id = a.project_id where a.org_id = ? order by a.created_at desc",
    )
    .all(org);

export function nextRun(
  a: Pick<Automation, "kind" | "cron" | "timezone" | "interval_minutes">,
  now = Date.now(),
): number {
  if (a.kind === "autonomous") return now + a.interval_minutes * 60_000;
  return CronExpressionParser.parse(a.cron!, {
    tz: a.timezone,
    currentDate: new Date(now),
  })
    .next()
    .getTime();
}

export function automationFields(input: any) {
  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 100
  )
    throw new HttpError(400, "Nom invalide (100 caractères au plus).");
  if (
    typeof input.prompt !== "string" ||
    !input.prompt.trim() ||
    input.prompt.length > 20_000
  )
    throw new HttpError(400, "Mission invalide (20 000 caractères au plus).");
  if (input.kind !== "cron" && input.kind !== "autonomous")
    throw new HttpError(400, "Type d'agent invalide.");
  const timezone = input.timezone ?? "Europe/Paris";
  try {
    new Intl.DateTimeFormat("fr", { timeZone: timezone });
  } catch {
    throw new HttpError(400, "Fuseau horaire invalide.");
  }
  const interval = input.interval_minutes ?? 60,
    max = input.max_runs_day ?? 4;
  if (
    !Number.isInteger(interval) ||
    interval < 5 ||
    interval > 10080 ||
    !Number.isInteger(max) ||
    max < 1 ||
    max > 100
  )
    throw new HttpError(
      400,
      "Intervalle : 5 à 10 080 minutes ; plafond : 1 à 100 exécutions par jour UTC.",
    );
  const cron = input.kind === "cron" ? input.cron : null;
  if (
    input.kind === "cron" &&
    (typeof cron !== "string" ||
      cron.length > 100 ||
      cron.trim().split(/\s+/).length !== 5)
  )
    throw new HttpError(400, "Une expression cron à cinq champs est requise.");
  const fields = {
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    kind: input.kind as Automation["kind"],
    cron,
    timezone,
    interval_minutes: interval,
    max_runs_day: max,
    enabled: input.enabled === false || input.enabled === 0 ? 0 : 1,
  };
  try {
    nextRun(fields);
  } catch {
    throw new HttpError(400, "Expression cron invalide.");
  }
  return fields;
}

export function saveAutomation(
  orgId: string,
  userId: string,
  input: any,
  existing?: Automation,
) {
  const fields = automationFields({ ...existing, ...input });
  const projectId = input.project_id ?? existing?.project_id;
  if (!getProjectInOrg(projectId, orgId))
    throw new HttpError(400, "Projet introuvable.");
  const id = existing?.id ?? randomBytes(8).toString("hex");
  if (
    !existing &&
    (
      db
        .prepare("select count(*) as n from automations where org_id = ?")
        .get(orgId) as { n: number }
    ).n >= 100
  )
    throw new HttpError(409, "Limite de 100 agents planifiés atteinte.");
  const next =
    fields.kind === "autonomous" && !existing ? Date.now() : nextRun(fields);
  db.prepare(
    `insert into automations (id, org_id, project_id, user_id, name, prompt, kind, cron, timezone, interval_minutes, max_runs_day, enabled, next_run_at, created_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set project_id=excluded.project_id, user_id=excluded.user_id,
    name=excluded.name, prompt=excluded.prompt, kind=excluded.kind, cron=excluded.cron, timezone=excluded.timezone,
    interval_minutes=excluded.interval_minutes, max_runs_day=excluded.max_runs_day, enabled=excluded.enabled, next_run_at=excluded.next_run_at, last_error=null`,
  ).run(
    id,
    orgId,
    projectId,
    userId,
    fields.name,
    fields.prompt,
    fields.kind,
    fields.cron,
    fields.timezone,
    fields.interval_minutes,
    fields.max_runs_day,
    fields.enabled,
    next,
    existing?.created_at ?? Date.now(),
  );
  if (existing && !existing.enabled && fields.enabled)
    db.prepare("update automations set last_task_id=null where id=?").run(id);
  return getAutomation(id, orgId)!;
}

function pause(a: Automation, reason: string) {
  db.prepare("update automations set enabled=0, last_error=? where id=?").run(
    reason,
    a.id,
  );
  notify(
    a.user_id,
    a.org_id,
    "Agent mis en pause",
    `${a.name} : ${reason}`,
    `/o/${a.org_id}/automations`,
    `pause:${a.id}:${a.last_task_id}:${reason}`,
  );
}

export function runAutomation(a: Automation, now = Date.now()) {
  const role = roleOf(a.org_id, a.user_id);
  if (!role || !can(role, "project:manage")) {
    pause(a, "Les droits de la personne responsable ont changé.");
    return null;
  }
  const project = getProjectInOrg(a.project_id, a.org_id);
  if (!project) return null;
  if (overBudget(a.org_id)) {
    pause(a, "Budget mensuel épuisé.");
    return null;
  }
  const last = a.last_task_id ? getTask(a.last_task_id) : undefined;
  if (last && (last.status === "failed" || last.last_error)) {
    pause(
      a,
      "La dernière exécution a échoué. Vérifie le résultat avant de reprendre.",
    );
    return null;
  }
  // Do not pile up proposals on the same project; a manual task also blocks the scheduler.
  if (
    db
      .prepare(
        "select 1 from tasks where project = ? and status in ('queued','running')",
      )
      .get(a.project_id)
  )
    return null;
  if (
    a.kind === "autonomous" &&
    last &&
    (last.status === "no_changes" ||
      db
        .prepare(
          "select 1 from events where task_id=? and turn=? and type='no_changes'",
        )
        .get(last.id, last.turn))
  ) {
    pause(a, "Mission terminée : aucune modification supplémentaire.");
    return null;
  }
  const day = Math.floor(now / 86_400_000) * 86_400_000;
  const count = (
    db
      .prepare(
        "select count(*) as n from automation_runs where automation_id=? and created_at>=?",
      )
      .get(a.id, day) as { n: number }
  ).n;
  if (count >= a.max_runs_day) {
    db.prepare("update automations set next_run_at=? where id=?").run(
      day + 86_400_000,
      a.id,
    );
    return null;
  }
  if (a.kind === "autonomous" && last && last.turn >= MAX_TURNS) {
    pause(
      a,
      "Limite de tours atteinte. Vérifie la proposition avant de reprendre.",
    );
    return null;
  }
  db.exec("begin immediate");
  try {
    const prompt = `${a.prompt}\n\nMission ${a.kind === "autonomous" ? "autonome" : "planifiée"} : réalise une amélioration concrète et bornée. Si l'objectif est déjà atteint, ne modifie rien. Ne répète pas une modification déjà présente.`;
    let started: { taskId: string; conversationId: string };
    if (a.kind === "autonomous" && last?.status === "done") {
      const conv = db
        .prepare("select id from conversations where task_id=? and org_id=?")
        .get(last.id, a.org_id) as { id: string } | undefined;
      if (!conv) throw new Error("Conversation introuvable");
      followUp(last.id, conv.id, prompt);
      started = { taskId: last.id, conversationId: conv.id };
    } else
      started = startTask({
        orgId: a.org_id,
        userId: a.user_id,
        project,
        prompt,
        note: `Agent « ${a.name} » déclenché côté serveur.`,
      });
    db.prepare("update tasks set automation_id=? where id=?").run(
      a.id,
      started.taskId,
    );
    db.prepare(
      "insert into automation_runs (automation_id, task_id, created_at) values (?,?,?)",
    ).run(a.id, started.taskId, now);
    db.prepare(
      "update automations set last_task_id=?, next_run_at=?, last_error=null where id=?",
    ).run(started.taskId, nextRun(a, now), a.id);
    db.exec("commit");
    audit(
      { orgId: a.org_id, userId: a.user_id },
      "automation.run",
      { type: "task", id: started.taskId },
      { automationId: a.id },
    );
    return started;
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
}

export function tickAutomations(now = Date.now()) {
  const due = db
    .prepare(
      "select * from automations where enabled=1 and next_run_at<=? order by next_run_at limit 20",
    )
    .all(now) as Automation[];
  for (const a of due) {
    try {
      runAutomation(a, now);
    } catch {
      pause(a, "Le déclenchement a échoué. Vérifie la configuration.");
    }
  }
}
export function startAutomations() {
  tickAutomations();
  const timer = setInterval(() => tickAutomations(), 15_000);
  timer.unref();
  return () => clearInterval(timer);
}
