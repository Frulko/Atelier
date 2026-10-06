import { randomBytes } from "node:crypto";
import { cfg } from "./config.ts";
import { addEvent, getProjectById, getTask, listKnowledge, updateTask } from "./db.ts";
import { renderKnowledge, selectKnowledge } from "./knowledge.ts";
import { rowToProject } from "./projects.ts";
import { issueTaskToken, revokeTaskTokens } from "./tokens.ts";
import { clone, changedFiles, commitAndPush, openMergeRequest, cleanup } from "./git.ts";
import { runAgent, runCheck, kill } from "./sandbox.ts";

export const newId = () => randomBytes(4).toString("hex");

const cancelled = new Set<string>();
const current = new Map<string, string>(); // taskId → nom du conteneur en cours

export const cancel = (id: string) => {
  cancelled.add(id);
  const c = current.get(id);
  if (c) kill(c);
};

// File d'attente : une tâche à la fois (suffisant pour une petite équipe).
let queue: Promise<unknown> = Promise.resolve();
export const enqueue = (id: string) => { queue = queue.then(() => execute(id)).catch(() => {}); };

async function execute(id: string) {
  const task = getTask(id)!;
  if (task.status !== "queued") { cancelled.delete(id); return; } // annulée avant son tour, ou déjà prise en charge : jamais deux exécutions de la même tâche
  const log = (type: string, text: string) => addEvent(id, type, text);
  const branch = `atelier/${id}`;
  let cost = task.cost; // un ajustement s'ajoute au coût déjà dépensé
  const followup = task.turn > 1; // tour d'ajustement : même branche, la proposition ouverte se met à jour
  const ask = task.followup ?? task.prompt;
  try {
    updateTask(id, { status: "running", branch });
    const row = getProjectById(task.project);
    if (!row) throw new Error("Projet introuvable (supprimé ?).");
    const p = rowToProject(row); // déchiffre le token git ici, le temps de la tâche
    const token = issueTaskToken(id, row.org_id); // jeton valable pour cette tâche seulement ; révoqué à la fin
    log("step", "Copie du projet dans le bac à sable…");
    const ws = await clone(p, id, branch, followup).catch((e) => {
      if (followup) throw new Error("La branche de cette tâche n'existe plus (proposition déjà fusionnée ou supprimée) : lance une nouvelle tâche.");
      throw e;
    });

    // Les connaissances de l'équipe, choisies pour CETTE demande (même sélection que l'assistant), et dites dans le journal.
    const sel = selectKnowledge(listKnowledge(row.org_id), row.id, ask);
    const knowledge = renderKnowledge(sel.chosen);
    if (sel.chosen.length) log("step", `Connaissances données à l'agent : ${sel.chosen.map((k) => k.title).join(", ")}.`);

    if (p.instructions) log("step", "Instructions du projet données à l'agent.");

    let prompt = ask;
    let files: string[] = [];
    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
      if (cancelled.has(id)) throw new Error("cancelled");
      log("step", attempt === 1 ? "L'agent travaille…" : `L'agent corrige (essai ${attempt}/${cfg.maxAttempts})…`);
      const name = `atelier-${id}-agent${attempt}`;
      current.set(id, name);
      const r = await runAgent({ name, tree: ws.tree, prompt, engine: p.engine, token, knowledge, instructions: p.instructions, model: p.agentModel, maxTurns: p.agentMaxTurns, budgetUsd: p.agentBudgetUsd, onEvent: (e) => log(e.type, [e.text, e.name, e.detail].filter(Boolean).join(" ")) });
      cost += r.cost;
      updateTask(id, { cost });
      if (cancelled.has(id)) throw new Error("cancelled");
      if (!r.ok) throw new Error("L'agent n'a pas terminé correctement.");

      files = await changedFiles(ws);
      if (!files.length) {
        updateTask(id, { status: followup ? "done" : "no_changes" }); // un ajustement sans effet laisse la proposition telle qu'elle est
        log("step", followup ? "Aucune modification supplémentaire : la proposition reste telle quelle." : "Aucun fichier modifié.");
        return;
      }

      log("step", "Vérification du projet…");
      const cname = `atelier-${id}-check${attempt}`;
      current.set(id, cname);
      const check = await runCheck(cname, ws.tree, p.check);
      if (check.ok) break;
      log("check_failed", check.output);
      if (attempt === cfg.maxAttempts) throw new Error("La vérification échoue encore après les corrections.");
      prompt = `La vérification automatique (« ${p.check} ») a échoué avec cette sortie :\n\n${check.output}\n\nCorrige le projet pour qu'elle passe, sans changer la demande initiale : ${ask}`;
    }

    // La proposition = tous les tours : on cumule les fichiers déjà modifiés avant cet ajustement.
    const before: string[] = followup ? JSON.parse(task.files_json ?? "[]") : [];
    const all = [...new Set([...before, ...files])];
    const flagged = all.filter((f) => p.protectedPaths.some((pp) => f.startsWith(pp)));
    updateTask(id, { files_json: JSON.stringify(all.slice(0, 200)), flagged: flagged.length });
    const title = `${flagged.length ? "[REVUE REQUISE] " : ""}atelier : ${task.prompt.split("\n")[0].slice(0, 70)}`;
    log("step", "Envoi de la branche…");
    await commitAndPush(p, ws, branch, followup ? `atelier : ajustement ${task.turn} — ${ask.split("\n")[0].slice(0, 60)}\n\nTâche atelier ${id}` : `${title}\n\nTâche atelier ${id}`);
    if (followup) {
      updateTask(id, { status: "done", followup: null });
      log("done", task.mr_url ? `Proposition mise à jour : ${task.mr_url}` : `Branche ${branch} mise à jour.`);
      return;
    }
    const description = [
      `Demande : ${task.prompt}`, "", `Fichiers modifiés (${files.length}) :`, ...files.map((f) => `- ${f}`),
      ...(flagged.length ? ["", "⚠️ **Chemins protégés touchés — relecture humaine obligatoire :**", ...flagged.map((f) => `- ${f}`)] : []),
      "", `Coût agent : ${cost.toFixed(2)} $`,
    ].join("\n");
    const mr = await openMergeRequest(p, branch, title, description);
    updateTask(id, { status: "done", mr_url: mr });
    log("done", mr ? `Prêt : ${mr}` : `Branche ${branch} envoyée.`);
  } catch (e: any) {
    const stopped = e.message === "cancelled";
    // Un ajustement qui échoue ou qu'on annule ne défait pas la proposition déjà envoyée : la tâche reste « terminée ».
    updateTask(id, { status: followup ? "done" : stopped ? "cancelled" : "failed" });
    log(stopped ? "step" : "error", stopped ? "Tâche annulée." : String(e.message || e));
  } finally {
    revokeTaskTokens(id);
    current.delete(id);
    cancelled.delete(id);
    await cleanup(id);
  }
}
