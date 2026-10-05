import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, ExternalLink, Pencil, Plus, ShieldAlert, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { Avatar } from "../../components/ui/Avatar";
import { Badge, StatusPill } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, Section, Stat } from "../../components/ui/Card";
import { ConfirmButton } from "../../components/ui/ConfirmButton";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState, ErrorBox, Skeleton } from "../../components/ui/Feedback";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { fmtPct, fmtUsd, relTime } from "../../lib/format";
import { FORGE_LABEL } from "../../lib/labels";
import { invalidateOrg, projectsQuery, secretsQuery, statsQuery, tasksQuery } from "../../lib/queries";
import { useOrg } from "../../lib/useOrg";
import type { AccessCheck } from "../../lib/types";
import { NewTaskDialog } from "../tasks/NewTaskDialog";
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

export function ProjectDetailPage() {
  const { orgId, isAdmin, isMember } = useOrg();
  const { projectId } = route.useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const projects = useQuery(projectsQuery(orgId));
  const stats = useQuery(statsQuery(orgId, 30));
  const secrets = useQuery({ ...secretsQuery(orgId), enabled: isAdmin });
  const recent = useQuery(tasksQuery(orgId, { project: projectId }, 0));
  const [editing, setEditing] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [access, setAccess] = useState<AccessCheck | null>(null);

  const p = projects.data?.find((x) => x.id === projectId);
  const st = stats.data?.byProject.find((x) => x.id === projectId);
  const secret = secrets.data?.find((s) => s.id === p?.gitSecretId);

  const verify = useMutation({ mutationFn: () => api.post<AccessCheck>(`/api/orgs/${orgId}/projects/${projectId}/verify`), onSuccess: setAccess, onError: (e) => toast(e instanceof Error ? e.message : "Échec", "bad") });
  const del = useMutation({
    mutationFn: () => api.del(`/api/orgs/${orgId}/projects/${projectId}`),
    onSuccess: () => { invalidateOrg(orgId, "projects"); toast("Projet supprimé."); navigate({ to: "/o/$orgId/projects", params: { orgId } }); },
    onError: (e) => toast(e instanceof Error ? e.message : "Échec", "bad"),
  });

  const back = <Link to="/o/$orgId/projects" params={{ orgId }} className="rise mb-5 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" />Tous les projets</Link>;
  if (projects.isLoading) return <div className="grid gap-4"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-40" /></div>;
  if (!p) return <>{back}<ErrorBox error={new Error("Projet introuvable.")} /></>;

  return (
    <>
      {back}
      <header className="rise mb-8 flex flex-wrap items-start justify-between gap-4" style={{ ["--i" as string]: 1 }}>
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2"><Badge tone={p.forge === "none" ? "muted" : "info"}>{FORGE_LABEL[p.forge]}</Badge><span className="font-mono text-xs text-muted">{p.slug}</span></div>
          <h1 className="font-display text-4xl font-medium leading-tight">{p.name}</h1>
          <a href={p.repo.startsWith("http") ? p.repo : undefined} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-flex items-center gap-1.5 font-mono text-[13px] text-muted hover:text-accent">{repoLabel(p.repo)}{p.repo.startsWith("http") && <ExternalLink className="size-3" aria-hidden />}</a>
        </div>
        <div className="flex flex-wrap gap-2">
          {isMember && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setLaunching(true)}>Nouvelle tâche</Button>}
          {isAdmin && <Button icon={<ShieldCheck className="size-4" />} loading={verify.isPending} onClick={() => verify.mutate()}>Vérifier l'accès</Button>}
          {isAdmin && <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Modifier</Button>}
          {isAdmin && <ConfirmButton variant="danger" icon={<Trash2 className="size-4" />} onConfirm={() => del.mutate()} loading={del.isPending}>Supprimer</ConfirmButton>}
        </div>
      </header>

      {access && <div className="rise mb-8"><AccessResult r={access} /></div>}

      <div className="mb-10 grid gap-4 sm:grid-cols-3">
        <Stat index={2} label="Tâches · 30 jours" value={st?.tasks ?? 0} />
        <Stat index={3} label="Taux de réussite" value={st && st.done + st.failed > 0 ? fmtPct(st.done / (st.done + st.failed)) : "—"} />
        <Stat index={4} label="Dépense · 30 jours" value={fmtUsd(st?.spendUsd ?? 0)} />
      </div>

      <div className="grid gap-10 xl:grid-cols-[1fr_1.5fr]">
        <Section title="Configuration" index={5}>
          <Card className="p-5">
            <dl className="grid gap-5 text-sm">
              {([
                ["Branche de base", <span className="font-mono">{p.branch}</span>],
                ["Vérification", <code className="rounded bg-line/70 px-1.5 py-0.5 font-mono text-[13px]">{p.check}</code>],
                ["Moteur d'agent", p.engine],
                ["Jeton git", p.gitSecretId ? (isAdmin ? (secret ? <span>{secret.label} <span className="font-mono text-xs text-muted">{secret.hint}</span></span> : "…") : "Configuré") : <span className="text-warn">Aucun</span>],
                ["Chemins protégés", p.protectedPaths.length ? <ul className="grid gap-1">{p.protectedPaths.map((x) => <li key={x} className="flex items-center gap-1.5 font-mono text-[13px]"><ShieldAlert className="size-3.5 text-warn" aria-hidden />{x}</li>)}</ul> : <span className="text-muted">Aucun</span>],
              ] as [string, React.ReactNode][]).map(([k, v]) => <div key={k}><dt className="label">{k}</dt><dd className="mt-1.5 text-ink">{v}</dd></div>)}
            </dl>
          </Card>
        </Section>
        <Section title="Tâches récentes" index={6} actions={<Link to="/o/$orgId/tasks" params={{ orgId }} search={{ project: projectId }} className="text-[13px] text-muted hover:text-ink">Tout voir</Link>}>
          <Card className="overflow-hidden">
            {recent.isLoading ? <Skeleton className="m-3 h-32" /> : recent.data && recent.data.items.length ? (
              <ul className="divide-y divide-line">
                {recent.data.items.slice(0, 8).map((t) => (
                  <li key={t.id}><Link to="/o/$orgId/tasks/$taskId" params={{ orgId, taskId: t.id }} className="group flex items-center gap-3 px-4 py-3 transition hover:bg-line/40">
                    <Avatar name={t.user_email} size={26} /><div className="min-w-0 flex-1"><p className="truncate text-[15px] group-hover:text-accent">{t.prompt}</p><p className="text-xs text-muted">{t.user_email} · {relTime(t.created_at)}</p></div><StatusPill status={t.status} />
                  </Link></li>
                ))}
              </ul>
            ) : <EmptyState title="Aucune tâche sur ce projet" hint="Les demandes apparaîtront ici." />}
          </Card>
        </Section>
      </div>

      <Dialog open={editing} onClose={() => setEditing(false)} wide title="Modifier le projet">
        <ProjectForm project={p} onCancel={() => setEditing(false)} onDone={() => { setEditing(false); toast("Projet enregistré."); }} />
      </Dialog>
      <NewTaskDialog open={launching} onClose={() => setLaunching(false)} defaultProject={p.id} />
    </>
  );
}
