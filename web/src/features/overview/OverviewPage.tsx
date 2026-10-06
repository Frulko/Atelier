import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, FolderGit2, KeyRound, Rocket } from "lucide-react";
import { useState } from "react";
import { DayBars } from "../../components/charts/DayBars";
import { Donut } from "../../components/charts/Donut";
import { HBars } from "../../components/charts/HBars";
import { SpendLine } from "../../components/charts/SpendLine";
import { Avatar } from "../../components/ui/Avatar";
import { StatusPill } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, PageHeader, Section, Stat } from "../../components/ui/Card";
import { EmptyState, ErrorBox, Skeleton } from "../../components/ui/Feedback";
import { Tabs } from "../../components/ui/Tabs";
import { fmtDuration, fmtPct, fmtUsd, relTime } from "../../lib/format";
import { isActive } from "../../lib/labels";
import { orgQuery, projectsQuery, statsQuery, tasksQuery } from "../../lib/queries";
import { useOrg } from "../../lib/useOrg";
import { FirstStepsCard } from "../guide/FirstSteps";
import { ProjectsHealth } from "./ProjectsHealth";
import type { Task } from "../../lib/types";

const PERIODS = [{ value: "7", label: "7 jours" }, { value: "30", label: "30 jours" }, { value: "90", label: "90 jours" }] as const;

function TaskRow({ t, orgId }: { t: Task; orgId: string }) {
  return (
    <li>
      <Link to="/o/$orgId/tasks/$taskId" params={{ orgId, taskId: t.id }} className="group flex items-center gap-4 px-4 py-3 transition hover:bg-line/40">
        <Avatar name={t.user_email} size={30} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] text-ink group-hover:text-accent">{t.prompt}</p>
          <p className="mt-0.5 truncate text-xs text-muted">{t.project_name ?? "(projet supprimé)"} · {t.user_email ?? "—"} · {relTime(t.created_at)}</p>
        </div>
        <StatusPill status={t.status} />
      </Link>
    </li>
  );
}

function Onboarding({ orgId }: { orgId: string }) {
  const steps = [
    { icon: KeyRound, title: "Ajouter un jeton git", text: "Un secret chiffré qui permet de cloner le dépôt et d'ouvrir les demandes de fusion.", to: "/o/$orgId/integrations", cta: "Ouvrir les intégrations" },
    { icon: FolderGit2, title: "Créer un projet", text: "Le dépôt à faire évoluer, sa branche, et la commande qui vérifie une modification.", to: "/o/$orgId/projects", cta: "Créer un projet" },
    { icon: Rocket, title: "Lancer une tâche", text: "Décris le changement souhaité en français : l'agent prépare une proposition à relire.", to: "/o/$orgId/tasks", cta: "Nouvelle tâche" },
  ] as const;
  return (
    <Section title="Pour démarrer" hint="Trois étapes pour une première proposition de modification." className="mb-10">
      <ol className="grid gap-4 md:grid-cols-3">
        {steps.map((s, i) => (
          <Card key={s.title} className="rise flex flex-col gap-3 p-5" style={{ ["--i" as string]: i }}>
            <div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-full bg-accent-soft font-mono text-sm font-medium text-accent">{i + 1}</span><s.icon className="size-5 text-muted" aria-hidden /></div>
            <h3 className="font-display text-xl">{s.title}</h3>
            <p className="flex-1 text-sm text-muted">{s.text}</p>
            <Link to={s.to} params={{ orgId }}><Button size="sm">{s.cta}</Button></Link>
          </Card>
        ))}
      </ol>
    </Section>
  );
}

export function OverviewPage() {
  const { orgId, org, isAdmin } = useOrg();
  const [days, setDays] = useState("30");
  const stats = useQuery(statsQuery(orgId, Number(days)));
  const recent = useQuery(tasksQuery(orgId, {}, 0));
  const projects = useQuery(projectsQuery(orgId));
  const detail = useQuery({ ...orgQuery(orgId), enabled: isAdmin });

  const s = stats.data;
  const active = (recent.data?.items ?? []).filter((t) => isActive(t.status));
  const noProject = projects.data && projects.data.length === 0;
  const cap = detail.data?.budgetUsdMonth, spent = detail.data?.monthSpendUsd ?? 0;
  const pct = cap ? Math.min(100, (spent / cap) * 100) : 0;

  return (
    <>
      <PageHeader title={org?.name ?? "Vue d'ensemble"} subtitle="Ce que ton équipe a demandé, ce qui a réussi, et ce que ça coûte."
        actions={<Tabs label="Période" value={days} onChange={setDays} items={PERIODS.map((p) => ({ ...p }))} />} />

      {stats.isError && <ErrorBox error={stats.error} retry={() => stats.refetch()} />}
      {noProject && (isAdmin ? <Onboarding orgId={orgId} /> : <EmptyState title="Aucun projet pour l'instant" hint="Un administrateur de l'organisation doit d'abord ajouter un projet." />)}

      {active.length > 0 && (
        <Card className="rise mb-8 overflow-hidden border-accent/40">
          <div className="flex items-center gap-3 border-b border-line bg-accent-soft px-4 py-2.5"><span className="pulse size-2 rounded-full bg-accent" aria-hidden /><h2 className="text-sm font-medium text-accent">{active.length} tâche{active.length > 1 ? "s" : ""} en cours</h2></div>
          <ul className="divide-y divide-line">{active.map((t) => <TaskRow key={t.id} t={t} orgId={orgId} />)}</ul>
        </Card>
      )}

      {!noProject && <FirstStepsCard />}
      <ProjectsHealth />

      <div className="mb-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {!s ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[8.4rem]" />) : (
          <>
            <Stat index={0} label="Tâches" value={s.totals.tasks} sub={`${s.totals.byStatus.running + s.totals.byStatus.queued} en cours · ${s.totals.byStatus.cancelled} annulée${s.totals.byStatus.cancelled > 1 ? "s" : ""}`} />
            <Stat index={1} label="Taux de réussite" value={fmtPct(s.totals.successRate)} tone={s.totals.successRate == null ? undefined : s.totals.successRate >= 0.8 ? "ok" : s.totals.successRate < 0.5 ? "bad" : undefined} sub={`${s.totals.byStatus.done} réussie${s.totals.byStatus.done > 1 ? "s" : ""} · ${s.totals.byStatus.failed} échec${s.totals.byStatus.failed > 1 ? "s" : ""}`} />
            <Stat index={2} label="Durée moyenne" value={fmtDuration(s.totals.avgDurationMs)} sub="de la prise en charge à la fin" />
            <Stat index={3} label="Dépense modèles" value={fmtUsd(s.totals.spendUsd)} sub={cap ? `${Math.round(pct)} % du plafond mensuel` : "sur la période"} tone={pct >= 90 ? "bad" : undefined} />
          </>
        )}
      </div>

      <div className="mb-10 grid gap-8 xl:grid-cols-[1.7fr_1fr]">
        <Section title="Activité" hint="Tâches lancées chaque jour." index={2}>
          <Card className="p-5">
            {s ? <DayBars data={s.perDay} /> : <Skeleton className="h-52" />}
            <div className="mt-3 flex gap-5 text-xs text-muted">{[["var(--ok)", "Réussies"], ["var(--bad)", "Échecs"], ["var(--line-strong)", "Autres"]].map(([c, l]) => <span key={l} className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: c }} />{l}</span>)}</div>
          </Card>
        </Section>
        <Section title="Répartition" hint="Par statut, sur la période." index={3}>
          <Card className="grid place-items-center p-5">
            {s ? <Donut center={s.totals.tasks} sub="tâches" segments={[
              { label: "Prêtes à valider", value: s.totals.byStatus.done, color: "var(--ok)" }, { label: "En cours", value: s.totals.byStatus.running, color: "var(--accent)" },
              { label: "En attente", value: s.totals.byStatus.queued, color: "var(--line-strong)" }, { label: "Aucun changement", value: s.totals.byStatus.no_changes, color: "var(--info)" },
              { label: "Échecs", value: s.totals.byStatus.failed, color: "var(--bad)" }, { label: "Annulées", value: s.totals.byStatus.cancelled, color: "var(--faint)" },
            ]} /> : <Skeleton className="h-36 w-full" />}
          </Card>
        </Section>
      </div>

      <div className="mb-10 grid gap-8 xl:grid-cols-[1.7fr_1fr]">
        <Section title="Dépense cumulée" hint="Coût déclaré par les agents, jour après jour." index={4}>
          <Card className="p-5">
            {s ? <SpendLine data={s.perDay} /> : <Skeleton className="h-44" />}
            {isAdmin && cap != null && (
              <div className="mt-4 border-t border-line pt-4">
                <div className="flex items-baseline justify-between text-sm"><span className="text-muted">Plafond mensuel</span><span className="tnum font-medium">{fmtUsd(spent)} <span className="text-muted">/ {fmtUsd(cap)}</span></span></div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Budget mensuel consommé"><div className={`h-full rounded-full ${pct >= 90 ? "bg-bad" : "bg-accent"}`} style={{ width: `${pct}%` }} /></div>
              </div>
            )}
          </Card>
        </Section>
        <Section title="Par projet" hint="Où part le travail." index={5}
          actions={<Link to="/o/$orgId/projects" params={{ orgId }} className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink">Tous les projets <ArrowUpRight className="size-3.5" /></Link>}>
          <Card className="p-5">
            <HBars rows={(s?.byProject ?? []).slice(0, 6).map((p) => ({ key: p.id, label: p.name, value: p.tasks, display: `${p.tasks} tâche${p.tasks > 1 ? "s" : ""}`, sub: `${p.done} réussie${p.done > 1 ? "s" : ""} · ${p.failed} échec${p.failed > 1 ? "s" : ""} · ${fmtUsd(p.spendUsd)}` }))} empty="Aucune tâche sur cette période." />
          </Card>
        </Section>
      </div>

      <Section title="Activité récente" index={6}
        actions={<Link to="/o/$orgId/tasks" params={{ orgId }} className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink">Toutes les tâches <ArrowUpRight className="size-3.5" /></Link>}>
        <Card className="overflow-hidden">
          {recent.isLoading ? <div className="grid gap-px p-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>
            : recent.data && recent.data.items.length ? <ul className="divide-y divide-line">{recent.data.items.slice(0, 6).map((t) => <TaskRow key={t.id} t={t} orgId={orgId} />)}</ul>
            : <EmptyState title="Pas encore de tâche" hint="Les demandes de ton équipe apparaîtront ici." />}
        </Card>
      </Section>
    </>
  );
}
