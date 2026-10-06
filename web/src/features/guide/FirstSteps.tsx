import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { conversationsQuery, knowledgeQuery, projectsQuery, tasksQuery } from "../../lib/queries";
import { useOrg } from "../../lib/useOrg";
import { BAKERY } from "./starters";

const DISMISS = (org: string, user: string) => `atelier.firststeps.${user}.${org}`;
const readFlag = (k: string) => { try { return localStorage.getItem(k) === "1"; } catch { return false; } };

type Step = { id: string; title: string; why: string; done: boolean; action: ReactNode };

/** « Premiers pas » : l'histoire d'une boulangerie qui veut une page Contact. Chaque étape se coche toute seule d'après les vraies données. */
export function useFirstSteps() {
  const { orgId, me, isAdmin, isMember } = useOrg();
  const knowledge = useQuery(knowledgeQuery(orgId));
  const conversations = useQuery(conversationsQuery(orgId));
  const tasks = useQuery(tasksQuery(orgId, { user: me?.user.id }, 0));
  const projects = useQuery(projectsQuery(orgId));
  const mine = tasks.data?.items ?? [];
  const finished = mine.filter((t) => t.status === "done");
  const convOfTask = (id: string) => conversations.data?.items.find((c) => c.taskId === id);
  const adjusted = mine.find((t) => t.turn > 1);
  const noForge = !!projects.data?.length && projects.data.every((p) => p.forge === "none");

  const link = (label: string, to: string, params: Record<string, string>, search?: Record<string, string>, primary = true) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <Link to={to as any} params={params as any} search={search as any}><Button size="sm" variant={primary ? "primary" : "secondary"}>{label}</Button></Link>;
  const first = finished[0];

  const steps: Step[] = [
    { id: "knowledge", title: "Écrire une connaissance", done: (knowledge.data?.length ?? 0) > 0,
      why: "Le ton et les couleurs du site, écrits une fois : l'assistant et l'agent les liront à chaque demande.",
      action: isAdmin ? link("Ajouter « Ton et couleurs »", "/o/$orgId/knowledge", { orgId }, { starter: "bakery" }) : <span className="text-xs text-muted">Un administrateur peut l'ajouter.</span> },
    { id: "ask", title: "Poser une question à l'assistant", done: !!conversations.data?.items.some((c) => c.mode === "chat" && c.userId === me?.user.id),
      why: "Discuter ne modifie rien : c'est l'endroit pour préparer ta demande. Regarde les sources : il cite les connaissances utilisées.",
      action: isMember ? link("Poser la question", "/o/$orgId/conversations", { orgId }, { new: "chat", text: BAKERY.ask }) : null },
    { id: "task", title: "Lancer une tâche", done: mine.length > 0,
      why: "L'agent travaille dans un bac à sable, sur une copie du projet. Tu peux suivre son journal en direct.",
      action: isMember ? link("Demander la page Contact", "/o/$orgId/conversations", { orgId }, { new: "task", text: BAKERY.task }) : null },
    { id: "review", title: "Lire la proposition", done: finished.length > 0,
      why: "Quand l'agent a fini, la vérification automatique est passée : tu vois les fichiers modifiés et le journal. Rien n'est publié.",
      action: first ? link("Voir la proposition", "/o/$orgId/tasks/$taskId", { orgId, taskId: first.id }) : <span className="text-xs text-muted">Disponible quand la tâche est terminée.</span> },
    { id: "adjust", title: "Demander un ajustement", done: !!adjusted,
      why: "Une tâche est aussi une conversation : écris à l'agent ce qu'il faut changer, il reprend la même proposition.",
      action: first && convOfTask(first.id) ? link("Demander un ajustement", "/o/$orgId/conversations/$conversationId", { orgId, conversationId: convOfTask(first.id)!.id }, undefined) : null },
    { id: "merge", title: "Relire et fusionner", done: mine.some((t) => !!t.mr_url) || (finished.length > 0 && noForge),
      why: noForge ? "Ici les projets n'ont pas de forge : la branche est envoyée sans demande de fusion. Avec GitLab ou GitHub, tu la relis et tu la fusionnes toi-même." : "La demande de fusion s'ouvre sur ta forge : tu la relis et tu la fusionnes toi-même. Atelier ne fusionne jamais.",
      action: mine.find((t) => t.mr_url) ? <a href={mine.find((t) => t.mr_url)!.mr_url!} target="_blank" rel="noopener noreferrer"><Button size="sm" variant="primary">Ouvrir la demande de fusion</Button></a> : null },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return { steps, doneCount, loading: knowledge.isPending || tasks.isPending || conversations.isPending };
}

export function FirstStepsList() {
  const { steps, doneCount } = useFirstSteps();
  const firstOpen = steps.findIndex((s) => !s.done);
  return (
    <div data-testid="first-steps">
      <div className="mb-3 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount} aria-label="Avancement des premiers pas"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
        <span className="text-xs font-medium text-muted">{doneCount} sur {steps.length}</span>
      </div>
      <ol className="grid gap-2">
        {steps.map((s, i) => (
          <li key={s.id} data-done={s.done} className={`flex items-start gap-3 rounded-lg border p-3 ${i === firstOpen ? "border-accent/50 bg-accent-soft/60" : "border-line"}`}>
            <span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${s.done ? "bg-ok text-white" : "bg-line text-muted"}`} aria-hidden>{s.done ? <Check className="size-3" /> : i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{s.title}<span className="sr-only">{s.done ? " — fait" : " — à faire"}</span></p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{s.why}</p>
              {!s.done && s.action && <div className="mt-2">{s.action}</div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Carte du tableau de bord : visible tant que les premiers pas ne sont pas finis, et que la personne ne l'a pas fermée. */
export function FirstStepsCard() {
  const { orgId, me, isMember } = useOrg();
  const { doneCount, steps, loading } = useFirstSteps();
  const key = me ? DISMISS(orgId, me.user.id) : "";
  const [hidden, setHidden] = useState(() => !!key && readFlag(key));
  if (!isMember || loading || hidden || doneCount === steps.length) return null;
  const close = () => { try { localStorage.setItem(key, "1"); } catch { /* tant pis : la carte reviendra */ } setHidden(true); };
  return (
    <Card className="rise mb-8 p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div><h2 className="font-display text-base">Premiers pas</h2><p className="text-sm text-muted">Un cas concret, pas à pas : une boulangerie veut une page Contact. <Link to="/o/$orgId/guide" params={{ orgId }} className="font-medium text-accent hover:underline">Ouvrir le guide</Link></p></div>
        <button type="button" onClick={close} aria-label="Masquer les premiers pas" className="rounded-md p-1 text-muted hover:bg-line/60 hover:text-ink"><X className="size-4" /></button>
      </div>
      <FirstStepsList />
    </Card>
  );
}
