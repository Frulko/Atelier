import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { FolderGit2, GitBranch, Plus, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, PageHeader } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState, ErrorBox, Skeleton } from "../../components/ui/Feedback";
import { fmtUsd } from "../../lib/format";
import { FORGE_LABEL } from "../../lib/labels";
import { projectsQuery, statsQuery } from "../../lib/queries";
import { useOrg } from "../../lib/useOrg";
import { ProjectForm } from "./ProjectForm";

export const repoLabel = (url: string) => { try { const u = new URL(url); return `${u.host}${u.pathname.replace(/\.git$/, "")}`; } catch { return url; } };

export function ProjectsPage() {
  const { orgId, isAdmin } = useOrg();
  const projects = useQuery(projectsQuery(orgId));
  const stats = useQuery(statsQuery(orgId, 30));
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const byId = new Map(stats.data?.byProject.map((p) => [p.id, p]));

  return (
    <>
      <PageHeader title="Projets" subtitle="Les dépôts que l'agent peut faire évoluer, et les règles qui encadrent chaque modification."
        actions={isAdmin ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Nouveau projet</Button> : undefined} />
      {projects.isError && <ErrorBox error={projects.error} retry={() => projects.refetch()} />}
      {projects.isLoading ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-48" />)}</div>
        : projects.data && projects.data.length === 0 ? <EmptyState icon={<FolderGit2 className="size-5" />} title="Aucun projet" hint={isAdmin ? "Ajoute un dépôt pour que ton équipe puisse y demander des modifications." : "Un administrateur doit ajouter un projet."} action={isAdmin ? <Button variant="primary" onClick={() => setCreating(true)}>Créer un projet</Button> : undefined} />
        : (
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {projects.data?.map((p, i) => {
              const st = byId.get(p.id);
              return (
                <li key={p.id} className="rise" style={{ ["--i" as string]: i }}>
                  <Link to="/o/$orgId/projects/$projectId" params={{ orgId, projectId: p.id }} className="group block h-full">
                    <Card className="flex h-full flex-col gap-4 p-5 transition group-hover:-translate-y-0.5 group-hover:border-line-strong">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0"><h2 className="truncate font-display text-xl text-ink group-hover:text-accent">{p.name}</h2><p className="mt-0.5 truncate font-mono text-xs text-muted">{repoLabel(p.repo)}</p></div>
                        <Badge tone={p.forge === "none" ? "muted" : "info"}>{FORGE_LABEL[p.forge]}</Badge>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-muted">
                        <span className="flex items-center gap-1.5 font-mono"><GitBranch className="size-3.5" aria-hidden />{p.branch}</span>
                        {p.protectedPaths.length > 0 && <span className="flex items-center gap-1.5 text-warn"><ShieldAlert className="size-3.5" aria-hidden />{p.protectedPaths.length} chemin{p.protectedPaths.length > 1 ? "s" : ""} protégé{p.protectedPaths.length > 1 ? "s" : ""}</span>}
                      </div>
                      <div className="mt-auto grid grid-cols-3 gap-2 border-t border-line pt-4" title="Sur les 30 derniers jours">
                        {[["Tâches", st?.tasks ?? 0], ["Réussies", st?.done ?? 0], ["Dépense", fmtUsd(st?.spendUsd ?? 0)]].map(([l, v]) => <div key={l}><p className="label !text-[0.62rem]">{l}</p><p className="tnum font-display mt-1 text-xl">{v}</p></div>)}
                      </div>
                    </Card>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      <Dialog open={creating} onClose={() => setCreating(false)} wide title="Nouveau projet" description="Un dépôt git, la façon de vérifier une modification, et les chemins qui exigent une relecture.">
        <ProjectForm onCancel={() => setCreating(false)} onDone={(p) => { setCreating(false); navigate({ to: "/o/$orgId/projects/$projectId", params: { orgId, projectId: p.id } }); }} />
      </Dialog>
    </>
  );
}
