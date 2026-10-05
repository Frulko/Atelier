import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import clsx from "clsx";
import { AlertTriangle, ArrowLeft, Check, CircleDot, ExternalLink, FileCode2, GitBranch, RotateCcw, ShieldAlert, Square, Wrench } from "lucide-react";
import { useEffect, useRef } from "react";
import { Avatar } from "../../components/ui/Avatar";
import { StatusPill } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ConfirmButton } from "../../components/ui/ConfirmButton";
import { Card, Section } from "../../components/ui/Card";
import { ErrorBox, Skeleton } from "../../components/ui/Feedback";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { useTaskEvents } from "../../lib/events";
import { fmtDateTime, fmtDuration, fmtUsd, parseFiles, relTime } from "../../lib/format";
import { isActive } from "../../lib/labels";
import { invalidateOrg, taskQuery } from "../../lib/queries";
import { useOrg } from "../../lib/useOrg";
import type { Task, TaskEvent } from "../../lib/types";

const route = getRouteApi("/o/$orgId/tasks/$taskId");

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="label">{label}</dt><dd className="mt-1.5 text-[15px] text-ink">{children}</dd></div>;
}

/** Une ligne du journal, présentée selon sa nature : étape, message de l'agent, outil, échec de vérification, fin. */
function EventRow({ e, last }: { e: TaskEvent; last: boolean }) {
  const mr = e.type === "done" && /^Prêt : https?:/.test(e.text) ? e.text.slice(7) : null;
  const icon = e.type === "error" ? <AlertTriangle className="size-3.5" /> : e.type === "check_failed" ? <Wrench className="size-3.5" /> : e.type === "done" ? <Check className="size-3.5" /> : e.type === "tool" ? <FileCode2 className="size-3.5" /> : <CircleDot className="size-3.5" />;
  const tone = e.type === "error" || e.type === "check_failed" ? "bg-bad-soft text-bad" : e.type === "done" ? "bg-ok-soft text-ok" : e.type === "step" ? "bg-accent-soft text-accent" : "bg-line text-muted";
  return (
    <li className="relative flex gap-4 pb-5">
      {!last && <span className="absolute left-[13px] top-7 h-full w-px bg-line-strong" aria-hidden />}
      <span className={clsx("z-10 grid size-7 shrink-0 place-items-center rounded-full", tone)} aria-hidden>{icon}</span>
      <div className="min-w-0 flex-1 pt-0.5">
        {e.type === "text" && <p className="whitespace-pre-wrap rounded-xl bg-raised px-3.5 py-2.5 text-[15px] leading-relaxed text-ink ring-1 ring-line">{e.text}</p>}
        {e.type === "tool" && <p className="font-mono text-[13px] text-muted">{e.text}</p>}
        {e.type === "step" && <p className="text-[15px] font-medium text-ink">{e.text}</p>}
        {e.type === "check_failed" && <><p className="text-sm font-medium text-bad">La vérification a échoué : l'agent est relancé avec cette sortie.</p><pre className="mt-2 max-h-48 overflow-auto rounded-xl bg-bad-soft p-3 font-mono text-xs text-bad">{e.text}</pre></>}
        {e.type === "error" && <p className="text-[15px] font-medium text-bad">{e.text}</p>}
        {e.type === "done" && (mr ? <a href={mr} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[15px] font-medium text-ok hover:underline">Proposition prête : ouvrir la demande de fusion <ExternalLink className="size-3.5" /></a> : <p className="text-[15px] font-medium text-ok">{e.text}</p>)}
        {!["text", "tool", "step", "check_failed", "error", "done"].includes(e.type) && <p className="font-mono text-xs text-muted">{e.text}</p>}
        <p className="mt-0.5 text-[11px] text-faint">{new Date(e.ts).toLocaleTimeString("fr-FR")}</p>
      </div>
    </li>
  );
}

export function TaskDetailPage() {
  const { orgId, me, isAdmin, isMember } = useOrg();
  const { taskId } = route.useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const q = useQuery(taskQuery(orgId, taskId));
  const t = q.data;
  const events = useTaskEvents(orgId, taskId);
  const bottom = useRef<HTMLDivElement>(null);
  const live = t ? isActive(t.status) : false;

  useEffect(() => { if (live) bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [events.length, live]);

  const cancel = useMutation({
    mutationFn: () => api.post(`/api/orgs/${orgId}/tasks/${taskId}/cancel`),
    onSuccess: () => { invalidateOrg(orgId, "task"); invalidateOrg(orgId, "tasks"); toast("Annulation demandée."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Échec", "bad"),
  });
  const retry = useMutation({
    mutationFn: () => api.post<Task>(`/api/orgs/${orgId}/tasks/${taskId}/retry`),
    onSuccess: (n) => { invalidateOrg(orgId, "tasks"); toast("Nouvelle tâche lancée."); navigate({ to: "/o/$orgId/tasks/$taskId", params: { orgId, taskId: n.id } }); },
    onError: (e) => toast(e instanceof Error ? e.message : "Échec", "bad"),
  });

  if (q.isLoading) return <div className="grid gap-4"><Skeleton className="h-10 w-2/3" /><Skeleton className="h-32" /><Skeleton className="h-64" /></div>;
  if (q.isError || !t) return <><Link to="/o/$orgId/tasks" params={{ orgId }} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" />Toutes les tâches</Link><ErrorBox error={q.error ?? new Error("Tâche introuvable.")} /></>;

  const files = parseFiles(t.files_json);
  const ms = t.started_at && t.finished_at ? t.finished_at - t.started_at : t.started_at && live ? Date.now() - t.started_at : null;
  const canCancel = live && (isAdmin || (isMember && t.user_id === me?.user.id));

  return (
    <>
      <Link to="/o/$orgId/tasks" params={{ orgId }} className="rise mb-5 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" />Toutes les tâches</Link>
      <header className="rise mb-8 flex flex-wrap items-start justify-between gap-4" style={{ ["--i" as string]: 1 }}>
        <div className="min-w-0 max-w-3xl">
          <div className="mb-3 flex items-center gap-3"><StatusPill status={t.status} /><span className="font-mono text-xs text-muted">#{t.id}</span></div>
          <h1 className="font-display text-[2rem] font-medium leading-snug text-ink">{t.prompt}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {t.mr_url && <a href={t.mr_url} target="_blank" rel="noopener noreferrer"><Button variant="primary" icon={<ExternalLink className="size-4" />}>Ouvrir la proposition</Button></a>}
          {canCancel && <ConfirmButton variant="secondary" icon={<Square className="size-3.5" />} onConfirm={() => cancel.mutate()} loading={cancel.isPending}>Annuler</ConfirmButton>}
          {!live && isMember && <Button icon={<RotateCcw className="size-4" />} onClick={() => retry.mutate()} loading={retry.isPending}>Relancer</Button>}
        </div>
      </header>

      {t.flagged > 0 && (
        <div role="alert" className="rise mb-6 flex items-start gap-3 rounded-2xl border border-warn/40 bg-warn-soft p-4 text-sm text-warn" style={{ ["--i" as string]: 2 }}>
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p><b>Relecture humaine obligatoire.</b> {t.flagged} fichier{t.flagged > 1 ? "s" : ""} modifié{t.flagged > 1 ? "s" : ""} touche{t.flagged > 1 ? "nt" : ""} un chemin protégé du projet. La demande de fusion est marquée en conséquence.</p>
        </div>
      )}

      <Card className="rise mb-10 p-6" style={{ ["--i" as string]: 3 }}>
        <dl className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
          <Meta label="Projet">{t.project_name ?? "(supprimé)"}</Meta>
          <Meta label="Demandée par"><span className="flex items-center gap-2"><Avatar name={t.user_email} size={24} /><span className="truncate">{t.user_email ?? "—"}</span></span></Meta>
          <Meta label="Lancée"><span title={fmtDateTime(t.created_at)}>{relTime(t.created_at)}</span></Meta>
          <Meta label="Durée"><span className="tnum">{fmtDuration(ms)}</span>{live && <span className="ml-2 text-xs text-accent">en cours</span>}</Meta>
          <Meta label="Coût déclaré"><span className="tnum">{t.cost ? fmtUsd(t.cost) : "—"}</span></Meta>
          <Meta label="Branche">{t.branch ? <span className="flex items-center gap-1.5 font-mono text-[13px]"><GitBranch className="size-3.5 text-muted" aria-hidden />{t.branch}</span> : "—"}</Meta>
          <Meta label="Fichiers modifiés"><span className="tnum">{files.length || "—"}</span></Meta>
          <Meta label="Terminée">{t.finished_at ? <span title={fmtDateTime(t.finished_at)}>{relTime(t.finished_at)}</span> : "—"}</Meta>
        </dl>
      </Card>

      <div className="grid gap-10 xl:grid-cols-[1.6fr_1fr]">
        <Section title={live ? "Journal en direct" : "Journal"} hint={live ? "Mis à jour en continu." : undefined} index={4}>
          {events.length === 0 ? <Skeleton className="h-32" /> : (
            <ol aria-live={live ? "polite" : "off"}>{events.map((e, i) => <EventRow key={e.id} e={e} last={i === events.length - 1} />)}</ol>
          )}
          <div ref={bottom} />
        </Section>
        <Section title="Fichiers modifiés" hint={files.length ? `${files.length} fichier${files.length > 1 ? "s" : ""}` : undefined} index={5}>
          <Card className="overflow-hidden">
            {files.length ? <ul className="divide-y divide-line">{files.map((f) => <li key={f} className="flex items-center gap-2.5 px-4 py-2.5 font-mono text-[13px] text-ink"><FileCode2 className="size-3.5 shrink-0 text-muted" aria-hidden /><span className="truncate">{f}</span></li>)}</ul>
              : <p className="px-4 py-8 text-center text-sm text-muted">{live ? "La liste apparaît quand l'agent a terminé." : "Aucun fichier modifié."}</p>}
          </Card>
        </Section>
      </div>
    </>
  );
}
