import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, ShieldAlert, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card, Section, Stat } from "../../components/ui/Card";
import { ConfirmButton } from "../../components/ui/ConfirmButton";
import { EmptyState, Skeleton } from "../../components/ui/Feedback";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { fmtPct, fmtUsd } from "../../lib/format";
import { FORGE_LABEL } from "../../lib/labels";
import { conversationsQuery, invalidateOrg, knowledgeQuery, secretsQuery, statsQuery, statusQuery, tasksQuery } from "../../lib/queries";
import type { AccessCheck } from "../../lib/types";
import { useOrg } from "../../lib/useOrg";
import { ProjectCard } from "../overview/ProjectsHealth";
import { useProject } from "./ProjectContext";
import { ConversationRows, KnowledgeRows, TaskRows } from "./projectRows";

const ACCESS_TEXT: Record<string, string> = {
  auth: "Le dépôt refuse ce jeton (absent, expiré ou sans les droits d'écriture).",
  not_found: "Dépôt introuvable : l'adresse est peut-être fausse, ou le jeton n'y a pas accès.",
  timeout: "Le dépôt n'a pas répondu à temps.",
  unreachable: "Impossible de joindre le dépôt.",
};
function AccessResult({ r }: { r: AccessCheck }) {
  const good = r.ok && r.branchFound, partial = r.ok && !r.branchFound;
  return (
    <div role="status" className={`flex items-start gap-3 rounded-xl p-4 text-sm ${good ? "bg-ok-soft text-ok" : partial ? "bg-warn-soft text-warn" : "bg-bad-soft text-bad"}`}>
      {good ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <div>
        <p className="font-medium">{good ? "Tout répond : le dépôt est joignable et la branche existe." : partial ? "Le dépôt répond, mais la branche de base n'existe pas." : ACCESS_TEXT[r.error ?? "unreachable"]}</p>
        <p className="mt-0.5 text-xs opacity-80">Vérifié en {r.ms} ms{r.detail && !r.ok ? ` · ${r.detail}` : ""}</p>
      </div>
    </div>
  );
}

const NewButton = ({ then }: { then?: () => void }) => { const { openNew } = useProject(); const { isMember } = useOrg(); return isMember ? <Button variant="primary" onClick={() => { openNew(); then?.(); }}>Nouveau</Button> : null; };

export function ProjectOverview() {
  const { orgId } = useOrg();
  const { project: p } = useProject();
  const stats = useQuery(statsQuery(orgId, 30));
  const tasks = useQuery(tasksQuery(orgId, { project: p.id }, 0));
  const convs = useQuery(conversationsQuery(orgId, undefined, p.id));
  const knowledge = useQuery(knowledgeQuery(orgId));
  const status = useQuery(statusQuery(orgId));
  const st = stats.data?.byProject.find((x) => x.id === p.id);
  const ps = status.data?.find((x) => x.projectId === p.id);
  const mine = (knowledge.data ?? []).filter((k) => k.projectId === p.id || k.projectId === null);
  const own = mine.filter((k) => k.projectId === p.id);
  const rate = st && st.done + st.failed > 0 ? st.done / (st.done + st.failed) : null;
  const Empty = (t: string, h: string) => <EmptyState title={t} hint={h} />;
  const more = (to: "tasks" | "conversations" | "knowledge") => <Link to={`/o/$orgId/projects/$projectId/${to}` as "/o/$orgId/projects/$projectId/tasks"} params={{ orgId, projectId: p.id }} search={{} as never} className="text-[13px] text-muted hover:text-ink">Tout voir</Link>;
  return (
    <div className="grid gap-8">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat index={2} label="Tâches · 30 jours" value={st?.tasks ?? 0} sub={st ? `${st.done} réussie${st.done > 1 ? "s" : ""} · ${st.failed} échec${st.failed > 1 ? "s" : ""}` : undefined} />
        <Stat index={3} label="Taux de réussite" value={fmtPct(rate)} tone={rate == null ? undefined : rate >= 0.8 ? "ok" : rate < 0.5 ? "bad" : undefined} />
        <Stat index={4} label="Dépense · 30 jours" value={fmtUsd(st?.spendUsd ?? 0)} />
      </div>
      <div className="grid gap-8 xl:grid-cols-[1fr_1.4fr]">
        <Section title="État du projet" hint="Site, dernier commit et déploiement.">{ps ? <ProjectCard s={ps} /> : <Skeleton className="h-52" />}</Section>
        <Section title="Tâches récentes" actions={more("tasks")}>
          <Card className="overflow-hidden">{tasks.data?.items.length ? <TaskRows items={tasks.data.items.slice(0, 5)} orgId={orgId} /> : Empty("Aucune tâche sur ce projet", "Lance la première depuis « Nouveau ».")}</Card>
        </Section>
      </div>
      <div className="grid gap-8 xl:grid-cols-2">
        <Section title="Conversations récentes" actions={more("conversations")}>
          <Card className="overflow-hidden">{convs.data?.items.length ? <ConversationRows items={convs.data.items.slice(0, 5)} orgId={orgId} /> : Empty("Aucune conversation", "Discute avec l'assistant à propos de ce projet.")}</Card>
        </Section>
        <Section title="Ce que l'assistant et l'agent savent" hint={`${own.length} connaissance${own.length > 1 ? "s" : ""} propre${own.length > 1 ? "s" : ""} au projet, ${mine.length - own.length} commune${mine.length - own.length > 1 ? "s" : ""}.`} actions={more("knowledge")}>
          <Card className="overflow-hidden">{mine.length ? <KnowledgeRows items={mine.slice(0, 4)} projectId={p.id} /> : Empty("Aucune connaissance", "Le ton, les règles, le vocabulaire du projet.")}</Card>
        </Section>
      </div>
    </div>
  );
}

export function ProjectTasks() {
  const { orgId } = useOrg();
  const { project: p } = useProject();
  const tasks = useQuery(tasksQuery(orgId, { project: p.id }, 0));
  const items = tasks.data?.items ?? [];
  return (
    <Section title="Tâches du projet" hint={tasks.data ? `${tasks.data.total} au total${tasks.data.total > items.length ? `, les ${items.length} plus récentes` : ""}.` : undefined}
      actions={<Link to="/o/$orgId/tasks" params={{ orgId }} search={{ project: p.id }} className="text-[13px] text-muted hover:text-ink">Filtrer dans toutes les tâches</Link>}>
      <Card className="overflow-hidden">{tasks.isLoading ? <Skeleton className="m-3 h-40" /> : items.length ? <TaskRows items={items} orgId={orgId} /> : <EmptyState title="Aucune tâche sur ce projet" hint="Les demandes apparaîtront ici." action={<NewButton />} />}</Card>
    </Section>
  );
}

export function ProjectConversations() {
  const { orgId } = useOrg();
  const { project: p } = useProject();
  const convs = useQuery(conversationsQuery(orgId, undefined, p.id));
  const items = convs.data?.items ?? [];
  return (
    <Section title="Conversations du projet" hint="Tes discussions et toutes les tâches de l'équipe liées à ce projet.">
      <Card className="overflow-hidden">{convs.isLoading ? <Skeleton className="m-3 h-40" /> : items.length ? <ConversationRows items={items} orgId={orgId} /> : <EmptyState title="Aucune conversation" hint="Discute avec l'assistant ou lance une tâche." action={<NewButton />} />}</Card>
    </Section>
  );
}

export function ProjectKnowledge() {
  const { orgId, isAdmin } = useOrg();
  const { project: p } = useProject();
  const knowledge = useQuery(knowledgeQuery(orgId));
  const mine = (knowledge.data ?? []).filter((k) => k.projectId === p.id || k.projectId === null);
  return (
    <Section title="Connaissances applicables" hint="Propres à ce projet, et communes à toute l'organisation : l'assistant et l'agent les lisent toutes."
      actions={<span className="flex gap-3 text-[13px]">
        {isAdmin && <Link to="/o/$orgId/knowledge" params={{ orgId }} search={{ project: p.id }} className="font-medium text-accent hover:underline">Ajouter pour ce projet</Link>}
        <Link to="/o/$orgId/knowledge" params={{ orgId }} search={{}} className="text-muted hover:text-ink">Gérer toutes les connaissances</Link>
      </span>}>
      <Card className="overflow-hidden">{knowledge.isLoading ? <Skeleton className="m-3 h-40" /> : mine.length ? <KnowledgeRows items={mine} projectId={p.id} /> : <EmptyState title="Aucune connaissance" hint="Écris le ton, les règles et le vocabulaire une fois : ils serviront à chaque demande." />}</Card>
    </Section>
  );
}

export function ProjectSettings() {
  const { orgId, isAdmin } = useOrg();
  const { project: p } = useProject();
  const navigate = useNavigate();
  const toast = useToast();
  const secrets = useQuery({ ...secretsQuery(orgId), enabled: isAdmin });
  const secret = secrets.data?.find((s) => s.id === p.gitSecretId);
  const [access, setAccess] = useState<AccessCheck | null>(null);
  const verify = useMutation({ mutationFn: () => api.post<AccessCheck>(`/api/orgs/${orgId}/projects/${p.id}/verify`), onSuccess: setAccess, onError: (e) => toast(e instanceof Error ? e.message : "Échec", "bad") });
  const del = useMutation({
    mutationFn: () => api.del(`/api/orgs/${orgId}/projects/${p.id}`),
    onSuccess: () => { invalidateOrg(orgId, "projects"); toast("Projet supprimé."); navigate({ to: "/o/$orgId/projects", params: { orgId } }); },
    onError: (e) => toast(e instanceof Error ? e.message : "Échec", "bad"),
  });
  return (
    <div className="grid gap-8 xl:grid-cols-[1.2fr_1fr]">
      <Section title="Configuration">
        <Card className="p-5">
          <dl className="grid gap-5 text-sm sm:grid-cols-2">
            {([
              ["Dépôt", <span className="break-all font-mono text-[13px]">{p.repo}</span>],
              ["Branche de base", <span className="font-mono">{p.branch}</span>],
              ["Forge", FORGE_LABEL[p.forge]],
              ["Moteur d'agent", p.engine],
              ["Site", p.siteUrl ? <a href={p.siteUrl} target="_blank" rel="noopener noreferrer" className="break-all font-mono text-[13px] text-accent hover:underline">{p.siteUrl}</a> : <span className="text-muted">Non renseigné</span>],
              ["Adresse de santé", p.healthUrl ? <span className="break-all font-mono text-[13px]">{p.healthUrl}</span> : <span className="text-muted">{p.siteUrl ? "Celle du site" : "Aucune : pas de surveillance"}</span>],
              ["Vérification", <code className="rounded bg-line/70 px-1.5 py-0.5 font-mono text-[13px]">{p.check}</code>],
              ["Jeton git", p.gitSecretId ? (isAdmin ? (secret ? <span>{secret.label} <span className="font-mono text-xs text-muted">{secret.hint}</span></span> : "…") : "Configuré") : <span className="text-warn">Aucun</span>],
            ] as [string, React.ReactNode][]).map(([k, v]) => <div key={k}><dt className="label">{k}</dt><dd className="mt-1.5 text-ink">{v}</dd></div>)}
            <div className="sm:col-span-2"><dt className="label">Chemins protégés</dt><dd className="mt-1.5">{p.protectedPaths.length ? <ul className="grid gap-1">{p.protectedPaths.map((x) => <li key={x} className="flex items-center gap-1.5 font-mono text-[13px]"><ShieldAlert className="size-3.5 text-warn" aria-hidden />{x}</li>)}</ul> : <span className="text-muted">Aucun</span>}<p className="mt-1.5 text-xs text-muted">Toute modification d'un de ces chemins exige une relecture humaine.</p></dd></div>
          </dl>
        </Card>
      </Section>
      {isAdmin && (
        <div className="grid content-start gap-8">
          <Section title="Accès au dépôt" hint="Teste le jeton et la branche, sans rien cloner.">
            <Card className="grid gap-4 p-5">
              <div><Button icon={<ShieldCheck className="size-4" />} loading={verify.isPending} onClick={() => verify.mutate()}>Vérifier l'accès</Button></div>
              {access && <AccessResult r={access} />}
            </Card>
          </Section>
          <Section title="Zone dangereuse"><Card className="flex items-center justify-between gap-4 p-5"><p className="text-sm text-muted">Supprime le projet de l'organisation. Les tâches passées restent dans l'historique.</p><ConfirmButton variant="danger" icon={<Trash2 className="size-4" />} onConfirm={() => del.mutate()} loading={del.isPending}>Supprimer</ConfirmButton></Card></Section>
        </div>
      )}
    </div>
  );
}
