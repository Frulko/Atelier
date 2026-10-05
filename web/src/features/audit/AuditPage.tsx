import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import clsx from "clsx";
import { Download, FilterX, ScrollText, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Avatar } from "../../components/ui/Avatar";
import { Button } from "../../components/ui/Button";
import { Card, PageHeader } from "../../components/ui/Card";
import { EmptyState, ErrorBox, Skeleton } from "../../components/ui/Feedback";
import { Input, Select } from "../../components/ui/Field";
import { Pagination } from "../../components/ui/Pagination";
import { qs } from "../../lib/api";
import { dayRange, fmtDate, fmtTime } from "../../lib/format";
import { AUDIT_GROUPS, auditTone, describeAudit } from "../../lib/labels";
import { auditQuery, membersQuery } from "../../lib/queries";
import { compact } from "../../lib/search";
import { useDebounced } from "../../lib/useDebounced";
import { useOrg } from "../../lib/useOrg";

const route = getRouteApi("/o/$orgId/audit");
const SIZE = 25;
const DOT = { ok: "bg-ok", bad: "bg-bad", warn: "bg-warn", info: "bg-info", accent: "bg-accent", muted: "bg-faint" } as const;

export function AuditPage() {
  const { orgId } = useOrg();
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/o/$orgId/audit" });
  const [q, setQ] = useState(search.q ?? "");
  const dq = useDebounced(q);
  const set = (patch: Record<string, string | number | undefined>) => navigate({ search: (prev) => compact({ ...prev, ...patch, page: patch.page ?? undefined }) as never });
  useEffect(() => { if ((search.q ?? "") !== dq) set({ q: dq || undefined }); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps

  const filters = { action: search.action, user: search.user, q: search.q, ...dayRange(search.from, search.to) };
  const page = (search.page ?? 1) - 1;
  const audit = useQuery(auditQuery(orgId, filters, page, SIZE));
  const members = useQuery(membersQuery(orgId));
  const active = !!(search.action || search.user || search.q || search.from || search.to);
  const csv = `/api/orgs/${orgId}/audit${qs({ ...filters, format: "csv" })}`;

  return (
    <>
      <PageHeader title="Journal d'audit" subtitle="Qui a fait quoi, quand et depuis où. Le journal est en ajout seul : personne ne peut y modifier ni y supprimer une ligne."
        actions={<a href={csv} download><Button icon={<Download className="size-4" />}>Exporter en CSV</Button></a>} />

      <Card className="rise mb-5 grid gap-4 p-4" style={{ ["--i" as string]: 1 }}>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Famille d'événements">
          {AUDIT_GROUPS.map((g) => {
            const on = (search.action ?? "") === g.value;
            return <button key={g.value} type="button" aria-pressed={on} onClick={() => set({ action: g.value || undefined })} className={clsx("rounded-full border px-3 py-1 text-[13px] font-medium transition", on ? "border-ink bg-ink text-paper" : "border-line-strong text-muted hover:border-ink hover:text-ink")}>{g.label}</button>;
          })}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[1.4fr_1.2fr_auto_auto]">
          <div className="relative"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-faint" aria-hidden /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher (membre, projet, rôle…)" aria-label="Rechercher" className="pl-9" /></div>
          <Select aria-label="Auteur" value={search.user ?? ""} onChange={(e) => set({ user: e.target.value || undefined })}><option value="">Tous les auteurs</option>{members.data?.map((m) => <option key={m.userId} value={m.userId}>{m.email}</option>)}</Select>
          <label className="flex items-center gap-2 text-[13px] text-muted">Du<Input type="date" value={search.from ?? ""} onChange={(e) => set({ from: e.target.value || undefined })} aria-label="À partir du" className="w-40" /></label>
          <label className="flex items-center gap-2 text-[13px] text-muted">Au<Input type="date" value={search.to ?? ""} onChange={(e) => set({ to: e.target.value || undefined })} aria-label="Jusqu'au" className="w-40" /></label>
        </div>
        {active && <div className="flex items-center justify-between text-sm text-muted"><span className="tnum">{audit.data ? `${audit.data.total} événement${audit.data.total > 1 ? "s" : ""}` : "…"}</span><Button size="sm" variant="ghost" icon={<FilterX className="size-4" />} onClick={() => { setQ(""); navigate({ search: {} as never }); }}>Réinitialiser</Button></div>}
      </Card>

      {audit.isError && <ErrorBox error={audit.error} retry={() => audit.refetch()} />}
      {audit.isLoading ? <div className="grid gap-2">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-14" />)}</div>
        : audit.data && audit.data.items.length === 0 ? <EmptyState icon={<ScrollText className="size-5" />} title={active ? "Aucun événement ne correspond" : "Le journal est vide"} hint={active ? "Essaie d'élargir les filtres." : "Les actions de ton équipe y seront enregistrées."} />
        : audit.data && (
          <div className={clsx("rise transition-opacity", audit.isPlaceholderData && "opacity-60")} style={{ ["--i" as string]: 2 }}>
            <Card className="overflow-hidden">
              <ol className="divide-y divide-line">
                {audit.data.items.map((e) => (
                  <li key={e.id} className="grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-1 px-4 py-3.5 sm:grid-cols-[8.5rem_1fr_auto]">
                    <time dateTime={new Date(e.ts).toISOString()} className="row-span-2 font-mono text-xs leading-snug text-muted sm:row-span-1"><span className="block text-ink">{fmtTime(e.ts)}</span>{fmtDate(e.ts)}</time>
                    <div className="flex min-w-0 items-start gap-3">
                      <span className={clsx("mt-2 size-2 shrink-0 rounded-full", DOT[auditTone(e.action)])} aria-hidden />
                      <p className="min-w-0 text-[15px] leading-snug text-ink">
                        <span className="inline-flex items-center gap-1.5 font-medium">{e.userEmail ? <><Avatar name={e.userEmail} size={20} />{e.userEmail}</> : <span className="text-muted">Système</span>}</span>{" "}
                        <span className="text-muted">{describeAudit(e)}</span>
                      </p>
                    </div>
                    <div className="hidden items-center gap-3 text-right sm:flex"><code className="rounded bg-line/70 px-1.5 py-0.5 font-mono text-[11px] text-muted">{e.action}</code><span className="w-24 font-mono text-[11px] text-faint">{e.ip ?? ""}</span></div>
                  </li>
                ))}
              </ol>
            </Card>
            <Pagination page={page} size={SIZE} total={audit.data.total} onPage={(p) => set({ page: p === 0 ? undefined : p + 1 })} />
          </div>
        )}
    </>
  );
}
