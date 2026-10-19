import { askBudget, getQuestion, humanContext } from "./human.ts";
import { randomBytes } from "node:crypto";
import { cfg } from "./config.ts";
import { addEvent, db, getProjectById, getTask, listKnowledge, updateTask, roleOf, bus } from "./db.ts";
import { renderKnowledge, selectKnowledge } from "./knowledge.ts";
import { rowToProject } from "./projects.ts";
import { issueTaskToken, revokeTaskTokens } from "./tokens.ts";
import { clone, changedFiles, commitAndPush, openMergeRequest, cleanup, workspace, revision, trackedPaths } from "./git.ts";
import { runAgent, runCheck, kill, installDependencies } from "./sandbox.ts";

import { assertSafeFiles, assertNoSecretText, safeLogText, taskLogRedactor } from "./security.ts";
import { taskContext } from "./task-context.ts";
import { notifyTask } from "./notifications.ts";
import { queueRelease, runtimeOf } from "./releases.ts";
import { reserveBudget, settleBudget, availableBudget, projectBudget, overBudget } from "./budget.ts";
import { can } from "./access.ts";

export const newId = () => randomBytes(4).toString("hex");

const cancelled = new Set<string>();
const current = new Map<string, string>(); // taskId → nom du conteneur en cours

export const cancel = (id: string) => {
  cancelled.add(id);
  db.prepare("update human_questions set state='cancelled' where task_id=? and (state='pending' or (kind='budget' and state='answered' and answer='2'))").run(id);
  const task=getTask(id);
  if(task?.waiting_question_id)updateTask(id,{waiting_question_id:null});
  if(task?.workspace_saved && task.status==="queued") {
    updateTask(id,{workspace_saved:0});
    void cleanup(id).catch(()=>console.warn("pipeline: nettoyage différé indisponible"));
  }
  revokeTaskTokens(id);
  const c = current.get(id);
  if (c) { revokeTaskTokens(c); void kill(c); }
};

// File d'attente : une tâche à la fois (suffisant pour une petite équipe).
let queue: Promise<unknown> = Promise.resolve();
export const enqueue = (id: string) => { queue = queue.then(() => execute(id)).catch(() => { console.warn("pipeline: exécution interrompue"); }); };

async function execute(id: string) {
  const task = getTask(id);
  if (!task) return;
  if (task.status !== "queued") { cancelled.delete(id); return; } // annulée avant son tour, ou déjà prise en charge : jamais deux exécutions de la même tâche
  if(task.waiting_question_id) {
    const q=getQuestion(task.waiting_question_id);
    if(q && (q.state==="pending" || (q.kind==="budget" && q.answer==="2" && q.expires_at>Date.now())))return;
  }
  let keepWorkspace=false;
  let redact = (text: string, limit?: number) => safeLogText(text, [], limit);
  const log = (type: string, text: string) => addEvent(id, type, redact(text));
  const command = (type: string, data: { id: string; command?: string; output?: string; state?: string; source?: string }) => {
    if (!data.id || data.id.length > 200 || redact(data.id) !== data.id) return;
    addEvent(id, type, JSON.stringify({ ...data,
      command: data.command === undefined ? undefined : redact(data.command, 8000),
      output: data.output === undefined ? undefined : redact(data.output),
    }));
  };
  const branch = `atelier/${id}`;
  let hold: {id:string;amount:number} | undefined;
  let agentStarted=false, reported=true;
  let cost = task.cost; // un ajustement s'ajoute au coût déjà dépensé
  const followup = task.turn > 1; // tour d'ajustement : même branche, la proposition ouverte se met à jour
  const ask = task.followup ?? task.prompt;
  const assertActive = () => {
    if (cancelled.has(id)) throw new Error("cancelled");
    const role = task.org_id && task.user_id ? roleOf(task.org_id, task.user_id) : undefined;
    if (!role || !can(role, "task:create")) throw new Error("Les droits nécessaires à cette exécution ont été retirés.");
  };
  try {
    redact = await taskLogRedactor(task.org_id!);
    assertActive();
    if(task.last_error?.includes("question technique a expiré"))throw new Error(task.last_error);
    if (overBudget(task.org_id!)) throw new Error("Budget mensuel épuisé.");
    updateTask(id, { status: "running", branch, last_error: null });
    const row = getProjectById(task.project);
    if (!row) throw new Error("Projet introuvable (supprimé ?).");
    const p = rowToProject(row); // déchiffre le token git ici, le temps de la tâche
    try {hold=reserveBudget(row.org_id,row.id,p.agentBudgetUsd??Number(cfg.maxBudgetUsd),id);}
    catch(e) {
      if(availableBudget(row.org_id)>0 && projectBudget(row.org_id,row.id).remainingUsd===0) {
        const q=askBudget(task);
        keepWorkspace=true;
        updateTask(id,{status:"queued",waiting_question_id:q.id});
        return;
      }
      throw e;
    }
    const token = issueTaskToken(id, row.org_id,"model",hold.id); // jeton valable pour cette tâche seulement ; révoqué à la fin
    log("step", task.workspace_saved?"Reprise du travail sauvegardé…":"Copie du projet dans le bac à sable…");
    const ws = task.workspace_saved ? workspace(id) : await clone(p, id, branch, followup).catch((e) => {
      if (followup) throw new Error("La branche de cette tâche n'existe plus (proposition déjà fusionnée ou supprimée) : lance une nouvelle tâche.");
      throw e;
    });
    assertActive();

    await assertSafeFiles(ws.tree, await trackedPaths(ws), row.org_id);

    // Les connaissances de l'équipe, choisies pour CETTE demande (même sélection que l'assistant), et dites dans le journal.
    const sel = selectKnowledge(listKnowledge(row.org_id), row.id, ask);
    const knowledge = renderKnowledge(sel.chosen);
    if (sel.chosen.length) log("step", `Connaissances données à l'agent : ${sel.chosen.map((k) => k.title).join(", ")}.`);

    if (p.instructions) log("step", "Instructions du projet données à l'agent.");

    if (!cfg.fakeAgent) {
      assertActive();
      const installName = `atelier-${id}-initial-install`; current.set(id, installName);
      await installDependencies(installName, ws.tree, token);
    }
    const context = [taskContext(task),humanContext(task)].filter(Boolean).join("\n\n");
    let prompt = context;
    let files: string[] = [];
    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
      await assertNoSecretText(`${prompt}\n${knowledge}\n${p.instructions??""}`,row.org_id);
      assertActive();
      log("step", attempt === 1 ? "L'agent travaille…" : `L'agent corrige (essai ${attempt}/${cfg.maxAttempts})…`);
      const name = `atelier-${id}-agent${attempt}`;
      current.set(id, name);
      const remaining=hold.amount-(cost-task.cost);
      if(remaining<0.000001) throw new Error("Budget de cette exécution épuisé.");
      agentStarted=true; reported=false;
      const r = await runAgent({ name, tree: ws.tree, prompt, engine: p.engine, token, knowledge, instructions: p.instructions, model: p.agentModel, subagentModel:p.subagentModel, maxTurns: p.agentMaxTurns, budgetUsd: remaining, onEvent: (e) => {
        if ((e.type === "command_start" || e.type === "command_result") && typeof e.commandId === "string") {
          command(e.type, { id: `${name}:${e.commandId}`, command: typeof e.command === "string" ? e.command : undefined,
            output: typeof e.output === "string" ? e.output : undefined, state: e.state === "failed" || e.state === "interrupted" || e.state === "background" ? e.state : "completed",
            source: e.source === "Sous-agent" ? "Sous-agent" : "Agent" });
        } else if (e.type !== "result") {
          const text=[e.text, e.name, e.detail].filter(Boolean).join(" ");
          if(text.trim())log(e.type,text);
        }
      } });
      reported=r.reported;
      cost += r.cost;
      updateTask(id, { cost });
      assertActive();
      if(r.waiting) {
        const q=getQuestion(r.waiting);
        if(!q || q.task_id!==id || q.turn!==task.turn || q.state==="cancelled")throw new Error("Question humaine invalide.");
        keepWorkspace=true;
        updateTask(id,{status:"queued",waiting_question_id:q.id,workspace_saved:1});
        if(q.state==="answered") {updateTask(id,{waiting_question_id:null});enqueue(id);}
        log("step","Travail sauvegardé : attente d'une décision humaine, sans agent actif.");
        return;
      }
      if (!r.ok) throw new Error("L'agent n'a pas terminé correctement.");

      if (!cfg.fakeAgent) {
        const installName = `atelier-${id}-install${attempt}`;
        current.set(id, installName);
        await installDependencies(installName, ws.tree, token);
      }
      assertActive();
      files = await changedFiles(ws);
      assertActive();
      if (!files.length) {
        updateTask(id, { status: followup ? "done" : "no_changes" }); // un ajustement sans effet laisse la proposition telle qu'elle est
        log("no_changes", followup ? "Aucune modification supplémentaire : la proposition reste telle quelle." : "Aucun fichier modifié.");
        return;
      }

      log("step", "Vérification du projet…");
      const cname = `atelier-${id}-check${attempt}`;
      current.set(id, cname);
      command("command_start", { id: cname, command: p.check, source: "Vérification" });
      const check = await runCheck(cname, ws.tree, p.check, text => redact(text, Number.MAX_SAFE_INTEGER));
      command("command_result", { id: cname, output: check.output, state: check.ok ? "completed" : "failed" });
      assertActive();
      if (check.ok) {
        files = await changedFiles(ws);
        if (p.check.trim() === "true" || !p.check.trim()) log("warning", "Aucun contrôle configuré : cette proposition ne pourra pas être publiée automatiquement.");
        break;
      }
      log("check_failed", check.output);
      if (attempt === cfg.maxAttempts) throw new Error("La vérification échoue encore après les corrections.");
      prompt = `La vérification automatique (« ${p.check} ») a échoué avec cette sortie :\n\n${check.output}\n\nCorrige le projet pour qu'elle passe, sans changer la demande initiale : ${context}`;
    }

    // La proposition = tous les tours : on cumule les fichiers déjà modifiés avant cet ajustement.
    const before: string[] = followup ? JSON.parse(task.files_json ?? "[]") : [];
    const all = [...new Set([...before, ...files])];
    const flagged = all.filter((f) => p.protectedPaths.some((pp) => f.startsWith(pp)));
    updateTask(id, { files_json: JSON.stringify(all.slice(0, 200)), flagged: flagged.length });
    const title = `${flagged.length ? "[REVUE REQUISE] " : ""}atelier : ${task.prompt.split("\n")[0].slice(0, 70)}`;
    await assertSafeFiles(ws.tree, files, row.org_id);
    assertActive();
    log("step", "Envoi de la branche…");
    await commitAndPush(p, ws, branch, followup ? `atelier : ajustement ${task.turn} — ${ask.split("\n")[0].slice(0, 60)}\n\nTâche atelier ${id}` : `${title}\n\nTâche atelier ${id}`);
    updateTask(id, { pushed_sha: await revision(ws) });
    assertActive();
    if (followup) {
      updateTask(id, { status: "done", followup: null });
      log("done", task.mr_url ? `Proposition mise à jour : ${task.mr_url}` : `Branche ${branch} mise à jour.`);
      if (runtimeOf(row)?.preview) { try { queueRelease(row.org_id, row.id, task.user_id!, id); } catch (e) { log("error", `Aperçu : ${(e as Error).message}`); } }
      return;
    }
    const description = [
      `Demande : ${task.prompt}`, "", `Fichiers modifiés (${files.length}) :`, ...files.map((f) => `- ${f}`),
      ...(flagged.length ? ["", "⚠️ **Chemins protégés touchés — relecture humaine obligatoire :**", ...flagged.map((f) => `- ${f}`)] : []),
      "", `Coût agent : ${cost.toFixed(2)} $`,
    ].join("\n");
    const mr = await openMergeRequest(p, branch, title, description);
    updateTask(id, { mr_url: mr });
    assertActive();
    updateTask(id, { status: "done" });
    log("done", mr ? `Prêt : ${mr}` : `Branche ${branch} envoyée.`);
    if (runtimeOf(row)?.preview) { try { queueRelease(row.org_id, row.id, task.user_id!, id); } catch (e) { log("error", `Aperçu : ${(e as Error).message}`); } }
  } catch (e: any) {
    const stopped = e.message === "cancelled";
    // Un ajustement qui échoue ou qu'on annule ne défait pas la proposition déjà envoyée : la tâche reste « terminée ».
    updateTask(id, { status: followup ? "done" : stopped ? "cancelled" : "failed", last_error: stopped ? "Tâche annulée." : redact(String(e.message || e),2000) });
    log(stopped ? "step" : "error", stopped ? "Tâche annulée." : String(e.message || e));
  } finally {
    revokeTaskTokens(id);
    if(hold) settleBudget(hold.id,agentStarted && !reported && !cfg.fakeAgent);
    current.delete(id);
    cancelled.delete(id);
    if(!keepWorkspace) {await cleanup(id); updateTask(id,{workspace_saved:0,waiting_question_id:null});}
    if(!keepWorkspace && !getTask(id)?.waiting_question_id)notifyTask(id);
    bus.emit("task:finished", id);
  }
}

export function resumeQueuedTasks() {
  const rows = db.prepare("select id from tasks where status = 'queued' order by created_at, rowid").all() as { id: string }[];
  for (const row of rows) enqueue(row.id);
}
