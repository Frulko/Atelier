import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, GitCommitHorizontal, RefreshCw, Rocket } from "lucide-react";
import { Badge, StatusPill } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, Section } from "../../components/ui/Card";
import { errorText } from "../../components/ui/Feedback";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { fmtPct, relTime } from "../../lib/format";
import { invalidateOrg, statusQuery } from "../../lib/queries";
import type { ProjectStatus } from "../../lib/types";
import { useOrg } from "../../lib/useOrg";

/** Lien vers le commit sur la forge (GitHub ou GitLab) ; rien pour une forge inconnue. */
export const commitUrl = (p: Pick<ProjectStatus, "repo" | "forge">, sha: string) => {
  try {
    const u = new URL(p.repo); const path = u.pathname.replace(/\.git$/, "");
    return p.forge === "github" ? `${u.origin}${path}/commit/${sha}` : p.forge === "gitlab" ? `${u.origin}${path}/-/commit/${sha}` : null;
  } catch { return null; }
};

/** Petite frise des derniers contrôles : une barre par contrôle, verte en ligne, rouge hors ligne. */
function Pulse({ history }: { history: ProjectStatus["history"] }) {
  if (!history.length) return null;
  return (
    <svg viewBox={`0 0 ${history.length * 6} 16`} className="h-4 w-full max-w-[180px]" role="img" aria-label={`${history.filter((h) => h.ok).length} contrôles réussis sur ${history.length}`} preserveAspectRatio="none">
      {history.map((h, i) => <rect key={h.ts} x={i * 6} y={h.ok ? 2 : 6} width="4" height={h.ok ? 12 : 8} rx="1" className={h.ok ? "fill-ok" : "fill-bad"} />)}
    </svg>
  );
}

function Health({ s }: { s: ProjectStatus }) {
  const target = s.healthUrl || s.siteUrl;
  if (!target) return <Badge>Non surveillé</Badge>;
  if (!s.health) return <Badge>Premier contrôle en cours…</Badge>;
  return s.health.ok
    ? <Badge tone="ok">En ligne{s.health.ms != null ? ` · ${s.health.ms} ms` : ""}</Badge>
    : <Badge tone="bad">Hors ligne{s.health.error ? ` · ${s.health.error}` : ""}</Badge>;
}

function ProjectCard({ s }: { s: ProjectStatus }) {
  const { orgId, isMember } = useOrg();
  const toast = useToast();
  const refresh = useMutation({
    mutationFn: () => api.post(`/api/orgs/${orgId}/projects/${s.projectId}/refresh`),
    onSuccess: () => invalidateOrg(orgId, "status"),
    onError: (e) => toast(errorText(e)),
  });
  const c = s.git?.commit;
  const cu = c ? commitUrl(s, c.sha) : null;
  return (
    <Card className="grid gap-3 p-4" data-testid={`project-status-${s.slug}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link to="/o/$orgId/projects/$projectId" params={{ orgId, projectId: s.projectId }} className="block truncate font-medium text-ink hover:text-accent">{s.name}</Link>
          {s.siteUrl ? <a href={s.siteUrl} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 truncate font-mono text-xs text-accent hover:underline"><span className="truncate">{s.siteUrl.replace(/^https?:\/\//, "")}</span><ExternalLink className="size-3 shrink-0" aria-hidden /></a> : <span className="text-xs text-muted">Aucune adresse de site</span>}
        </div>
        <Health s={s} />
      </div>
      {(s.healthUrl || s.siteUrl) && (
        <div className="flex items-center gap-3 text-xs text-muted">
          <Pulse history={s.history} />
          <span>{s.uptime24h == null ? "—" : `${fmtPct(s.uptime24h)} sur 24 h`}{s.health ? ` · contrôlé ${relTime(s.health.checkedAt)}` : ""}</span>
        </div>
      )}
      <div className="grid gap-2 border-t border-line pt-3 text-[13px]">
        <div className="flex items-start gap-2">
          <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          {c ? (
            <div className="min-w-0">
              <p className="truncate text-ink">{c.subject}</p>
              <p className="text-xs text-muted">
                {cu ? <a href={cu} target="_blank" rel="noopener noreferrer" className="font-mono text-accent hover:underline">{c.sha.slice(0, 7)}</a> : <span className="font-mono">{c.sha.slice(0, 7)}</span>}
                {" · "}{c.author} · {relTime(c.at)} · <span className="font-mono">{s.branch}</span>
              </p>
            </div>
          ) : <p className="text-muted">{s.git?.error ? `Dépôt injoignable : ${s.git.error}` : "Dernier commit : en cours de lecture…"}</p>}
        </div>
        <div className="flex items-start gap-2">
          <Rocket className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          {s.deploy ? <p className="text-ink">{s.deploy.environment || "Déploiement"} · <span className={s.deploy.status === "success" ? "text-ok" : s.deploy.status === "failed" || s.deploy.status === "failure" || s.deploy.status === "error" ? "text-bad" : "text-warn"}>{s.deploy.status}</span> · {relTime(s.deploy.at)}{s.deploy.url && <> · <a href={s.deploy.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">ouvrir</a></>}</p>
            : <p className="text-muted">Aucun déploiement remonté par la forge.</p>}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line pt-3 text-xs text-muted">
        {s.lastTask ? <Link to="/o/$orgId/tasks/$taskId" params={{ orgId, taskId: s.lastTask.id }} className="flex items-center gap-2 hover:text-ink">Dernière tâche <StatusPill status={s.lastTask.status} /> {relTime(s.lastTask.created_at)}</Link> : <span>Aucune tâche</span>}
        {isMember && <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={refresh.isPending} onClick={() => refresh.mutate()} aria-label={`Actualiser ${s.name}`}>Actualiser</Button>}
      </div>
    </Card>
  );
}

/** « Projets » du tableau de bord : où en est chacun, en un coup d'œil. */
export function ProjectsHealth() {
  const { orgId } = useOrg();
  const q = useQuery(statusQuery(orgId));
  if (!q.data?.length) return null;
  const down = q.data.filter((s) => s.health && !s.health.ok).length;
  return (
    <div data-tour="projects-health"><Section title="Projets" hint={down ? `${down} hors ligne` : "Santé, dernier commit et déploiement, mis à jour en continu."} className="mb-10" index={1}>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{q.data.map((s) => <ProjectCard key={s.projectId} s={s} />)}</div>
    </Section></div>
  );
}
