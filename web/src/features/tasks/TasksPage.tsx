import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { FilterX, ListChecks, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Avatar } from "../../components/ui/Avatar";
import { StatusPill } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, PageHeader } from "../../components/ui/Card";
import { EmptyState, ErrorBox, Skeleton } from "../../components/ui/Feedback";
import { Input, Select } from "../../components/ui/Field";
import { Pagination } from "../../components/ui/Pagination";
import { dayRange, fmtDuration, fmtUsd, fmtDateTime, relTime } from "../../lib/format";
import { STATUS_LABEL, STATUS_TONE, STATUSES } from "../../lib/labels";
import { membersQuery, PAGE_SIZE, projectsQuery, tasksQuery } from "../../lib/queries";
import { compact } from "../../lib/search";
import { useDebounced } from "../../lib/useDebounced";
import { useOrg } from "../../lib/useOrg";
import type { Status } from "../../lib/types";
import { NewTaskDialog } from "./NewTaskDialog";
import clsx from "clsx";

const route = getRouteApi("/o/$orgId/tasks");

export function TasksPage() {
  const { orgId, isAdmin, isMember, me } = useOrg();
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/o/$orgId/tasks" });
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState(search.q ?? "");
  const dq = useDebounced(q);

  const statuses = (search.status ?? "").split(",").filter(Boolean) as Status[];
  const page = (search.page ?? 1) - 1;
  const set = (patch: Record<string, string | number | undefined>) => navigate({ search: (prev) => compact({ ...prev, ...patch, page: patch.page ?? undefined }) as never });

  useEffect(() => { if ((search.q ?? "") !== dq) set({ q: dq || undefined }); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps

  const filters = { status: search.status, project: search.project, user: search.user, q: search.q, ...dayRange(search.from, search.to) };
  const tasks = useQuery(tasksQuery(orgId, filters, page));
  const projects = useQuery(projectsQuery(orgId));
  const members = useQuery({ ...membersQuery(orgId), enabled: isAdmin });
  const active = !!(search.status || search.project || search.user || search.q || search.from || search.to);
  const mine = me && search.user === me.user.id;

  const toggle = (s: Status) => { const next = statuses.includes(s) ? statuses.filter((x) => x !== s) : [...statuses, s]; set({ status: next.join(",") || undefined }); };
  const reset = () => { setQ(""); navigate({ search: {} as never }); };

  return (
    <>
      <PageHeader title="Tâches" subtitle="Chaque demande à l'agent, de la file d'attente à la proposition prête à relire."
        actions={isMember ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Nouvelle tâche</Button> : undefined} />

      <Card className="rise mb-5 grid gap-4 p-4" style={{ ["--i" as string]: 1 }}>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrer par statut">
          {STATUSES.map((s) => {
            const on = statuses.includes(s);
            return <button key={s} type="button" aria-pressed={on} onClick={() => toggle(s)}
              className={clsx("rounded-full border px-3 py-1 text-[13px] font-medium transition", on ? "border-ink bg-ink text-paper" : "border-line-strong text-muted hover:border-ink hover:text-ink")}
              data-tone={STATUS_TONE[s]}>{STATUS_LABEL[s]}</button>;
          })}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[1.3fr_1fr_1.25fr_auto_auto]">
          <div className="relative sm:col-span-2 xl:col-span-1"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-faint" aria-hidden /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher dans les demandes…" aria-label="Rechercher" className="pl-9" /></div>
          <Select aria-label="Projet" value={search.project ?? ""} onChange={(e) => set({ project: e.target.value || undefined })}><option value="">Tous les projets</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          {isAdmin
            ? <Select aria-label="Demandeur" value={search.user ?? ""} onChange={(e) => set({ user: e.target.value || undefined })}><option value="">Tous les membres</option>{members.data?.map((m) => <option key={m.userId} value={m.userId}>{m.email}</option>)}</Select>
            : <Button variant={mine ? "primary" : "secondary"} aria-pressed={!!mine} onClick={() => set({ user: mine ? undefined : me?.user.id })}>Mes tâches</Button>}
          <label className="flex items-center gap-2 text-[13px] text-muted">Du<Input type="date" value={search.from ?? ""} onChange={(e) => set({ from: e.target.value || undefined })} aria-label="À partir du" className="w-40" /></label>
          <label className="flex items-center gap-2 text-[13px] text-muted">Au<Input type="date" value={search.to ?? ""} onChange={(e) => set({ to: e.target.value || undefined })} aria-label="Jusqu'au" className="w-40" /></label>
        </div>
        {active && <div className="flex items-center justify-between text-sm text-muted"><span className="tnum">{tasks.data ? `${tasks.data.total} résultat${tasks.data.total > 1 ? "s" : ""}` : "…"}</span><Button size="sm" variant="ghost" icon={<FilterX className="size-4" />} onClick={reset}>Réinitialiser les filtres</Button></div>}
      </Card>

      {tasks.isError && <ErrorBox error={tasks.error} retry={() => tasks.refetch()} />}
      {tasks.isLoading ? <div className="grid gap-2">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16" />)}</div>
        : tasks.data && tasks.data.items.length === 0 ? (
          active ? <EmptyState title="Aucune tâche ne correspond" hint="Essaie d'élargir les filtres." action={<Button onClick={reset}>Réinitialiser</Button>} />
            : <EmptyState icon={<ListChecks className="size-5" />} title="Aucune tâche pour l'instant" hint="Lance la première : l'agent prépare une proposition que tu pourras relire." action={isMember ? <Button variant="primary" onClick={() => setCreating(true)}>Nouvelle tâche</Button> : undefined} />
        ) : tasks.data && (
          <div className={clsx("rise transition-opacity", tasks.isPlaceholderData && "opacity-60")} style={{ ["--i" as string]: 2 }}>
            <Card className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-left text-sm">
                <thead><tr className="border-b border-line">{["Statut", "Demande", "Demandeur", "Durée", "Coût", "Lancée"].map((h) => <th key={h} className="label px-4 py-3 font-normal">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-line">
                  {tasks.data.items.map((t) => {
                    const ms = t.started_at && t.finished_at ? t.finished_at - t.started_at : null;
                    return (
                      <tr key={t.id} className="group relative transition hover:bg-line/40">
                        <td className="px-4 py-3.5"><StatusPill status={t.status} /></td>
                        <td className="max-w-md px-4 py-3.5">
                          <Link to="/o/$orgId/tasks/$taskId" params={{ orgId, taskId: t.id }} className="block truncate text-[15px] text-ink after:absolute after:inset-0 group-hover:text-accent">{t.prompt}</Link>
                          <span className="mt-0.5 block truncate text-xs text-muted">{t.project_name ?? "(projet supprimé)"}{t.flagged > 0 && <span className="ml-2 font-medium text-warn">· relecture obligatoire</span>}</span>
                        </td>
                        <td className="px-4 py-3.5"><span className="flex items-center gap-2"><Avatar name={t.user_email} size={24} /><span className="max-w-[10rem] truncate text-[13px] text-muted">{t.user_email ?? "—"}</span></span></td>
                        <td className="tnum px-4 py-3.5 text-muted">{fmtDuration(ms)}</td>
                        <td className="tnum px-4 py-3.5 text-muted">{t.cost ? fmtUsd(t.cost) : "—"}</td>
                        <td className="whitespace-nowrap px-4 py-3.5 text-[13px] text-muted" title={fmtDateTime(t.created_at)}>{relTime(t.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
            <Pagination page={page} size={PAGE_SIZE} total={tasks.data.total} onPage={(p) => set({ page: p === 0 ? undefined : p + 1 })} />
          </div>
        )}
      <NewTaskDialog open={creating} onClose={() => setCreating(false)} defaultProject={search.project} />
    </>
  );
}
