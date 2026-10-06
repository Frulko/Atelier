import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, Outlet, useMatchRoute, useNavigate } from "@tanstack/react-router";
import clsx from "clsx";
import { BookOpen, Code2, ExternalLink, GitBranch, LayoutDashboard, ListChecks, MessageSquare, Pencil, Plus, Settings, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { ErrorBox, Skeleton } from "../../components/ui/Feedback";
import { useToast } from "../../components/ui/Toast";
import { FORGE_LABEL } from "../../lib/labels";
import { conversationsQuery, knowledgeQuery, projectsQuery, statusQuery, tasksQuery } from "../../lib/queries";
import { useOrg } from "../../lib/useOrg";
import { NewConversationDialog } from "../conversations/ConversationsPage";
import { ProjectCtx } from "./ProjectContext";
import { ProjectForm } from "./ProjectForm";
import { repoLabel } from "./ProjectsPage";

const route = getRouteApi("/o/$orgId/projects/$projectId");

type Item = { to: string; label: string; icon: LucideIcon; exact?: boolean; count?: number; member?: boolean };

/**
 * Le gabarit d'un projet : un menu latéral PROPRE au projet (où que l'on soit dans le projet, il reste là), l'en-tête du projet,
 * puis la page choisie. Le fil d'Ariane est dans la barre du haut de l'application. L'éditeur prend toute la place : pas d'en-tête.
 */
export function ProjectLayout() {
  const { orgId, isMember, isAdmin } = useOrg();
  const { projectId } = route.useParams();
  const toast = useToast();
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const projects = useQuery(projectsQuery(orgId));
  const tasks = useQuery(tasksQuery(orgId, { project: projectId }, 0));
  const convs = useQuery(conversationsQuery(orgId, undefined, projectId));
  const knowledge = useQuery(knowledgeQuery(orgId));
  const status = useQuery(statusQuery(orgId));
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const p = projects.data?.find((x) => x.id === projectId);
  const inEditor = !!matchRoute({ to: "/o/$orgId/projects/$projectId/editor", params: { orgId, projectId } });
  const health = status.data?.find((x) => x.projectId === projectId)?.health;
  const knowledgeCount = (knowledge.data ?? []).filter((k) => k.projectId === projectId || k.projectId === null).length;
  const ctx = useMemo(() => (p ? { project: p, openNew: () => setCreating(true), openEdit: () => setEditing(true) } : null), [p]);

  if (projects.isLoading) return <div className="grid gap-4"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-40" /></div>;
  if (!p || !ctx) return <ErrorBox error={new Error("Projet introuvable.")} />;

  const base = "/o/$orgId/projects/$projectId";
  const items: Item[] = [
    { to: base, label: "Aperçu", icon: LayoutDashboard, exact: true },
    { to: `${base}/tasks`, label: "Tâches", icon: ListChecks, count: tasks.data?.total },
    { to: `${base}/conversations`, label: "Conversations", icon: MessageSquare, count: convs.data?.total },
    { to: `${base}/knowledge`, label: "Connaissances", icon: BookOpen, count: knowledgeCount },
    { to: `${base}/editor`, label: "Éditeur", icon: Code2, member: true },
    { to: `${base}/settings`, label: "Configuration", icon: Settings },
  ];

  return (
    <ProjectCtx.Provider value={ctx}>
      <div className={clsx("grid gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)]")}>
        <nav aria-label="Menu du projet" className="lg:sticky lg:top-[5.25rem] lg:self-start">
          <p className="mb-2 hidden truncate px-3 text-xs font-medium uppercase tracking-wide text-faint lg:block">{p.name}</p>
          <ul className="flex gap-1 overflow-x-auto pb-1 lg:grid lg:overflow-visible lg:pb-0">
            {items.filter((i) => !i.member || isMember).map((i) => (
              <li key={i.to} className="shrink-0">
                <Link to={i.to as "/o/$orgId/projects/$projectId"} params={{ orgId, projectId }} activeOptions={{ exact: !!i.exact }}
                  className="flex items-center gap-2.5 rounded-md px-3 py-2 text-[14px] font-medium text-muted transition-colors hover:bg-line/60 hover:text-ink"
                  activeProps={{ className: "!bg-line !text-ink [&>svg]:!text-accent", "aria-current": "page" }}>
                  <i.icon className="size-4" aria-hidden />{i.label}
                  {i.count !== undefined && <span className="tnum ml-auto text-xs font-normal opacity-60">{i.count}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0">
          {!inEditor && (
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
          )}
          <Outlet />
        </div>
      </div>

      <Dialog open={editing} onClose={() => setEditing(false)} wide title="Modifier le projet">
        <ProjectForm project={p} onCancel={() => setEditing(false)} onDone={() => { setEditing(false); toast("Projet enregistré."); }} />
      </Dialog>
      {creating && <NewConversationDialog open onClose={() => setCreating(false)} defaultProject={p.id} />}
    </ProjectCtx.Provider>
  );
}
