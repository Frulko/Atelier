import { randomBytes } from "node:crypto";
import { cfg } from "./config.ts";
import { addEvent, getProjectById, getTask, updateTask } from "./db.ts";
import { rowToProject } from "./projects.ts";
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
  if (task.status === "cancelled") return;
  const log = (type: string, text: string) => addEvent(id, type, text);
  const branch = `atelier/${id}`;
  let cost = 0;
  try {
    updateTask(id, { status: "running", branch });
    const row = getProjectById(task.project);
    if (!row) throw new Error("Projet introuvable (supprimé ?).");
    const p = rowToProject(row); // déchiffre le token git ici, le temps de la tâche
    log("step", "Copie du projet dans le bac à sable…");
    const ws = await clone(p, id, branch);

    let prompt = task.prompt;
    let files: string[] = [];
    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
      if (cancelled.has(id)) throw new Error("cancelled");
      log("step", attempt === 1 ? "L'agent travaille…" : `L'agent corrige (essai ${attempt}/${cfg.maxAttempts})…`);
      const name = `atelier-${id}-agent${attempt}`;
      current.set(id, name);
      const r = await runAgent({ name, tree: ws.tree, prompt, engine: p.engine, onEvent: (e) => log(e.type, [e.text, e.name, e.detail].filter(Boolean).join(" ")) });
      cost += r.cost;
      updateTask(id, { cost });
      if (cancelled.has(id)) throw new Error("cancelled");
      if (!r.ok) throw new Error("L'agent n'a pas terminé correctement.");

      files = await changedFiles(ws);
      if (!files.length) { updateTask(id, { status: "no_changes" }); log("step", "Aucun fichier modifié."); return; }

      log("step", "Vérification du projet…");
      const cname = `atelier-${id}-check${attempt}`;
      current.set(id, cname);
      const check = await runCheck(cname, ws.tree, p.check);
      if (check.ok) break;
      log("check_failed", check.output);
      if (attempt === cfg.maxAttempts) throw new Error("La vérification échoue encore après les corrections.");
      prompt = `La vérification automatique (« ${p.check} ») a échoué avec cette sortie :\n\n${check.output}\n\nCorrige le projet pour qu'elle passe, sans changer la demande initiale : ${task.prompt}`;
    }

    const flagged = files.filter((f) => p.protectedPaths.some((pp) => f.startsWith(pp)));
    const title = `${flagged.length ? "[REVUE REQUISE] " : ""}atelier : ${task.prompt.split("\n")[0].slice(0, 70)}`;
    log("step", "Envoi de la branche…");
    await commitAndPush(p, ws, branch, `${title}\n\nTâche atelier ${id}`);
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
    updateTask(id, { status: stopped ? "cancelled" : "failed" });
    log(stopped ? "step" : "error", stopped ? "Tâche annulée." : String(e.message || e));
  } finally {
    current.delete(id);
    cancelled.delete(id);
    await cleanup(id);
  }
}
