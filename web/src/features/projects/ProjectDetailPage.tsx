import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, BookOpen, CheckCircle2, ExternalLink, GitBranch, ListChecks, MessageSquare, Pencil, Pin, Plus, ShieldAlert, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { Avatar } from "../../components/ui/Avatar";
import { Badge, StatusPill } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, Section, Stat } from "../../components/ui/Card";
import { Tabs } from "../../components/ui/Tabs";
import { ConfirmButton } from "../../components/ui/ConfirmButton";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState, ErrorBox, Skeleton } from "../../components/ui/Feedback";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { fmtPct, fmtUsd, relTime } from "../../lib/format";
import { FORGE_LABEL } from "../../lib/labels";
import { conversationsQuery, invalidateOrg, knowledgeQuery, projectsQuery, secretsQuery, statsQuery, statusQuery, tasksQuery } from "../../lib/queries";
import { useOrg } from "../../lib/useOrg";
import type { AccessCheck, Conversation, KnowledgeBrief, Project, Task } from "../../lib/types";
import { NewConversationDialog } from "../conversations/ConversationsPage";
import { ProjectCard } from "../overview/ProjectsHealth";
import { ProjectForm } from "./ProjectForm";
import { repoLabel } from "./ProjectsPage";

const route = getRouteApi("/o/$orgId/projects/$projectId");

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

type Tab = "apercu" | "taches" | "conversations" | "connaissances" | "configuration";

function TaskRows({ items, orgId }: { items: Task[]; orgId: string }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((t) => (
        <li key={t.id}><Link to="/o/$orgId/tasks/$taskId" params={{ orgId, taskId: t.id }} className="group flex items-center gap-3 px-4 py-3 transition hover:bg-line/40">
          <Avatar name={t.user_email} size={26} />
          <div className="min-w-0 flex-1"><p className="truncate text-[15px] group-hover:text-accent">{t.prompt}</p><p className="text-xs text-muted">{t.user_email ?? "—"} · {relTime(t.created_at)}{t.cost ? ` · ${fmtUsd(t.cost)}` : ""}{t.turn > 1 ? ` · ${t.turn - 1} ajustement${t.turn > 2 ? "s" : ""}` : ""}</p></div>
          <StatusPill status={t.status} />
        </Link></li>
      ))}
    </ul>
  );
}

function ConversationRows({ items, orgId }: { items: Conversation[]; orgId: string }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((c) => (
        <li key={c.id}><Link to="/o/$orgId/conversations/$conversationId" params={{ orgId, conversationId: c.id }} search={{}} className="group flex items-start gap-3 px-4 py-3 transition hover:bg-line/40">
          {c.mode === "chat" ? <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /> : <ListChecks className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />}
          <div className="min-w-0 flex-1"><p className="truncate text-[15px] group-hover:text-accent">{c.title}</p>{c.preview && <p className="truncate text-[13px] text-muted">{c.preview}</p>}</div>
          <div className="shrink-0 text-right"><Badge>{c.mode === "chat" ? "Discussion" : "Tâche"}</Badge><p className="mt-1 text-xs text-faint">{relTime(c.updatedAt)}</p></div>
        </Link></li>
      ))}
    </ul>
  );
}

function KnowledgeRows({ items, projectId, orgId }: { items: KnowledgeBrief[]; projectId: string; orgId: string }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((k) => (
        <li key={k.id} className="flex items-start gap-3 px-4 py-3">
          <BookOpen className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className={`truncate text-[15px] ${k.enabled ? "" : "text-muted line-through"}`}>{k.title}</p>
            <p className="line-clamp-2 text-[13px] text-muted">{k.excerpt}</p>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            <Badge tone={k.projectId === projectId ? "accent" : "muted"}>{k.projectId === projectId ? "Ce projet" : "Toute l'organisation"}</Badge>
            {k.pinned && <Badge tone="info"><Pin className="mr-1 inline size-3" aria-hidden />Épinglée</Badge>}
            {!k.enabled && <Badge tone="warn">Désactivée</Badge>}
          </div>
        </li>
      ))}
    </ul>
  );
}

const Empty = ({ title, hint, action }: { title: string; hint: string; action?: React.ReactNode }) => <EmptyState title={title} hint={hint} action={action} />;

export function ProjectDetailPage() {
  const { orgId, isAdmin, isMember } = useOrg();
  const { projectId } = route.useParams();
  const tab = ((route.useSearch() as { tab?: Tab }).tab ?? "apercu") as Tab;
  const navigate = useNavigate();
  const toast = useToast();
  const projects = useQuery(projectsQuery(orgId));
  const stats = useQuery(statsQuery(orgId, 30));
  const secrets = useQuery({ ...secretsQuery(orgId), enabled: isAdmin });
  const tasks = useQuery(tasksQuery(orgId, { project: projectId }, 0));
  const convs = useQuery(conversationsQuery(orgId, undefined, projectId));
  const knowledge = useQuery(knowledgeQuery(orgId));
  const status = useQuery(statusQuery(orgId));
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [access, setAccess] = useState<AccessCheck | null>(null);

  const p = projects.data?.find((x) => x.id === projectId);
  const st = stats.data?.byProject.find((x) => x.id === projectId);
  const ps = status.data?.find((x) => x.projectId === projectId);
  const secret = secrets.data?.find((s) => s.id === p?.gitSecretId);
  const mine = (knowledge.data ?? []).filter((k) => k.projectId === projectId || k.projectId === null);
  const own = mine.filter((k) => k.projectId === projectId);
  const taskItems = tasks.data?.items ?? [], convItems = convs.data?.items ?? [];
  const setTab = (t: Tab) => navigate({ to: ".", search: t === "apercu" ? {} : { tab: t }, replace: true });

  const verify = useMutation({ mutationFn: () => api.post<AccessCheck>(`/api/orgs/${orgId}/projects/${projectId}/verify`), onSuccess: setAccess, onError: (e) => toast(e instanceof Error ? e.message : "Échec", "bad") });
  const del = useMutation({
    mutationFn: () => api.del(`/api/orgs/${orgId}/projects/${projectId}`),
    onSuccess: () => { invalidateOrg(orgId, "projects"); toast("Projet supprimé."); navigate({ to: "/o/$orgId/projects", params: { orgId } }); },
    onError: (e) => toast(e instanceof Error ? e.message : "Échec", "bad"),
  });

  const back = <Link to="/o/$orgId/projects" params={{ orgId }} className="rise mb-5 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" />Tous les projets</Link>;
  if (projects.isLoading) return <div className="grid gap-4"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-40" /></div>;
  if (!p) return <>{back}<ErrorBox error={new Error("Projet introuvable.")} /></>;

  const health = ps?.health;
  return (
    <>
      {back}
      <header className="rise mb-6 flex flex-wrap items-start justify-between gap-4" style={{ ["--i" as string]: 1 }}>
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge tone={p.forge === "none" ? "muted" : "info"}>{FORGE_LABEL[p.forge]}</Badge>
            <span className="inline-flex items-center gap-1 font-mono text-xs text-muted"><GitBranch className="size-3" aria-hidden />{p.branch}</span>
            {(p.healthUrl || p.siteUrl) && (health ? <Badge tone={health.ok ? "ok" : "bad"}>{health.ok ? "En ligne" : "Hors ligne"}</Badge> : <Badge>Contrôle en cours…</Badge>)}
            {p.protectedPaths.length > 0 && <Badge tone="warn">{p.protectedPaths.length} chemin{p.protectedPaths.length > 1 ? "s" : ""} protégé{p.protectedPaths.length > 1 ? "s" : ""}</Badge>}
          </div>
          <h1 className="font-display text-3xl leading-tight">{p.name}</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
            <a href={p.repo.startsWith("http") ? p.repo : undefined} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-mono hover:text-accent">{repoLabel(p.repo)}{p.repo.startsWith("http") && <ExternalLink className="size-3" aria-hidden />}</a>
            {p.siteUrl && <a href={p.siteUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-mono hover:text-accent">{p.siteUrl.replace(/^https?:\/\//, "")}<ExternalLink className="size-3" aria-hidden /></a>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isMember && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Nouveau</Button>}
          {isAdmin && <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Modifier</Button>}
        </div>
      </header>

      <div className="rise mb-8 overflow-x-auto" style={{ ["--i" as string]: 2 }}>
        <Tabs<Tab> label="Sections du projet" value={tab} onChange={setTab} items={[
          { value: "apercu", label: "Aperçu" },
          { value: "taches", label: "Tâches", count: tasks.data?.total },
          { value: "conversations", label: "Conversations", count: convs.data?.total },
          { value: "connaissances", label: "Connaissances", count: mine.length },
          { value: "configuration", label: "Configuration" },
        ]} />
      </div>

      {tab === "apercu" && (
        <div className="grid gap-8">
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat index={2} label="Tâches · 30 jours" value={st?.tasks ?? 0} sub={st ? `${st.done} réussie${st.done > 1 ? "s" : ""} · ${st.failed} échec${st.failed > 1 ? "s" : ""}` : undefined} />
            <Stat index={3} label="Taux de réussite" value={st && st.done + st.failed > 0 ? fmtPct(st.done / (st.done + st.failed)) : "—"} tone={st && st.done + st.failed > 0 ? (st.done / (st.done + st.failed) >= 0.8 ? "ok" : st.done / (st.done + st.failed) < 0.5 ? "bad" : undefined) : undefined} />
            <Stat index={4} label="Dépense · 30 jours" value={fmtUsd(st?.spendUsd ?? 0)} />
          </div>
          <div className="grid gap-8 xl:grid-cols-[1fr_1.4fr]">
            <Section title="État du projet" hint="Site, dernier commit et déploiement.">{ps ? <ProjectCard s={ps} /> : <Skeleton className="h-52" />}</Section>
            <Section title="Tâches récentes" actions={<button type="button" onClick={() => setTab("taches")} className="text-[13px] text-muted hover:text-ink">Tout voir</button>}>
              <Card className="overflow-hidden">{taskItems.length ? <TaskRows items={taskItems.slice(0, 5)} orgId={orgId} /> : <Empty title="Aucune tâche sur ce projet" hint="Lance la première depuis « Nouveau »." />}</Card>
            </Section>
          </div>
          <div className="grid gap-8 xl:grid-cols-2">
            <Section title="Conversations récentes" actions={<button type="button" onClick={() => setTab("conversations")} className="text-[13px] text-muted hover:text-ink">Tout voir</button>}>
              <Card className="overflow-hidden">{convItems.length ? <ConversationRows items={convItems.slice(0, 5)} orgId={orgId} /> : <Empty title="Aucune conversation" hint="Discute avec l'assistant à propos de ce projet." />}</Card>
            </Section>
            <Section title="Ce que l'assistant et l'agent savent" hint={`${own.length} connaissance${own.length > 1 ? "s" : ""} propre${own.length > 1 ? "s" : ""} au projet, ${mine.length - own.length} commune${mine.length - own.length > 1 ? "s" : ""}.`}
              actions={<button type="button" onClick={() => setTab("connaissances")} className="text-[13px] text-muted hover:text-ink">Tout voir</button>}>
              <Card className="overflow-hidden">{mine.length ? <KnowledgeRows items={mine.slice(0, 4)} projectId={projectId} orgId={orgId} /> : <Empty title="Aucune connaissance" hint="Le ton, les règles, le vocabulaire du projet." />}</Card>
            </Section>
          </div>
        </div>
      )}

      {tab === "taches" && (
        <Section title="Tâches du projet" hint={tasks.data ? `${tasks.data.total} au total${tasks.data.total > taskItems.length ? `, les ${taskItems.length} plus récentes` : ""}.` : undefined}
          actions={<Link to="/o/$orgId/tasks" params={{ orgId }} search={{ project: projectId }} className="text-[13px] text-muted hover:text-ink">Filtrer dans toutes les tâches</Link>}>
          <Card className="overflow-hidden">{tasks.isLoading ? <Skeleton className="m-3 h-40" /> : taskItems.length ? <TaskRows items={taskItems} orgId={orgId} /> : <Empty title="Aucune tâche sur ce projet" hint="Les demandes apparaîtront ici." action={isMember ? <Button variant="primary" onClick={() => setCreating(true)}>Nouveau</Button> : undefined} />}</Card>
        </Section>
      )}

      {tab === "conversations" && (
        <Section title="Conversations du projet" hint="Tes discussions et toutes les tâches de l'équipe liées à ce projet.">
          <Card className="overflow-hidden">{convs.isLoading ? <Skeleton className="m-3 h-40" /> : convItems.length ? <ConversationRows items={convItems} orgId={orgId} /> : <Empty title="Aucune conversation" hint="Discute avec l'assistant ou lance une tâche." action={isMember ? <Button variant="primary" onClick={() => setCreating(true)}>Nouveau</Button> : undefined} />}</Card>
        </Section>
      )}

      {tab === "connaissances" && (
        <Section title="Connaissances applicables" hint="Propres à ce projet, et communes à toute l'organisation : l'assistant et l'agent les lisent toutes."
          actions={<span className="flex gap-3 text-[13px]">
            {isAdmin && <Link to="/o/$orgId/knowledge" params={{ orgId }} search={{ project: projectId }} className="font-medium text-accent hover:underline">Ajouter pour ce projet</Link>}
            <Link to="/o/$orgId/knowledge" params={{ orgId }} search={{}} className="text-muted hover:text-ink">Gérer toutes les connaissances</Link>
          </span>}>
          <Card className="overflow-hidden">{knowledge.isLoading ? <Skeleton className="m-3 h-40" /> : mine.length ? <KnowledgeRows items={mine} projectId={projectId} orgId={orgId} /> : <Empty title="Aucune connaissance" hint="Écris le ton, les règles et le vocabulaire une fois : ils serviront à chaque demande." />}</Card>
        </Section>
      )}

      {tab === "configuration" && (
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
      )}

      <Dialog open={editing} onClose={() => setEditing(false)} wide title="Modifier le projet">
        <ProjectForm project={p as Project} onCancel={() => setEditing(false)} onDone={() => { setEditing(false); toast("Projet enregistré."); }} />
      </Dialog>
      {creating && <NewConversationDialog open onClose={() => setCreating(false)} defaultProject={p.id} />}
    </>
  );
}
