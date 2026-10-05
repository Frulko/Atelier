import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { HBars } from "../../components/charts/HBars";
import { SimpleBars } from "../../components/charts/SimpleBars";
import { SpendLine } from "../../components/charts/SpendLine";
import { Avatar } from "../../components/ui/Avatar";
import { Button } from "../../components/ui/Button";
import { Card, PageHeader, Section, Stat } from "../../components/ui/Card";
import { ErrorBox, FormError, Skeleton } from "../../components/ui/Feedback";
import { Field, Input } from "../../components/ui/Field";
import { Tabs } from "../../components/ui/Tabs";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { fmtInt, fmtPct, fmtUsd } from "../../lib/format";
import { PROVIDER_LABEL } from "../../lib/labels";
import { invalidateOrg, usageQuery } from "../../lib/queries";
import { useOrg } from "../../lib/useOrg";

const PERIODS = [{ value: "7", label: "7 jours" }, { value: "30", label: "30 jours" }, { value: "90", label: "90 jours" }];

function BudgetCard({ cap, spent, projected }: { cap: number | null; spent: number; projected: number }) {
  const { orgId } = useOrg();
  const toast = useToast();
  const [value, setValue] = useState(cap == null ? "" : String(cap));
  const save = useMutation({
    mutationFn: (v: number | null) => api.patch(`/api/orgs/${orgId}`, { budgetUsdMonth: v }),
    onSuccess: (_d, v) => { invalidateOrg(orgId, "usage"); invalidateOrg(orgId, "stats"); invalidateOrg(orgId, "audit"); invalidateOrg(orgId); toast(v == null ? "Plafond supprimé." : "Plafond enregistré."); },
  });
  const pct = cap ? Math.min(100, (spent / cap) * 100) : 0, over = cap != null && projected > cap;
  return (
    <Card className="p-6">
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div>
          <p className="label">Budget du mois en cours</p>
          <p className="tnum font-display mt-2 text-4xl">{fmtUsd(spent)}{cap != null && <span className="text-2xl text-muted"> / {fmtUsd(cap)}</span>}</p>
          {cap != null ? (
            <>
              <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Budget consommé"><div className={`h-full rounded-full transition-all ${pct >= 90 ? "bg-bad" : "bg-accent"}`} style={{ width: `${pct}%` }} /></div>
              <p className={`mt-3 flex items-center gap-2 text-sm ${over ? "font-medium text-warn" : "text-muted"}`}>{over && <AlertTriangle className="size-4" aria-hidden />}Projection fin de mois : <b className="tnum">{fmtUsd(projected)}</b>{over ? " — au-dessus du plafond" : ""}</p>
              {pct >= 100 && <p className="mt-2 text-sm font-medium text-bad">Plafond atteint : les nouvelles tâches sont refusées jusqu'au mois prochain ou à un relèvement.</p>}
            </>
          ) : <p className="mt-3 text-sm text-muted">Aucun plafond : la dépense n'est pas limitée. Projection fin de mois : <b className="tnum text-ink">{fmtUsd(projected)}</b>.</p>}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); save.mutate(value === "" ? null : Number(value)); }} className="grid content-start gap-3 rounded-xl bg-line/40 p-4">
          <Field label="Plafond mensuel (en $)" hint="Atteint, les nouvelles tâches sont refusées. Vide : illimité.">{(id) => <Input id={id} type="number" min="0" max="1000000" step="1" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Illimité" />}</Field>
          <FormError error={save.error} />
          <div className="flex gap-2"><Button variant="primary" type="submit" loading={save.isPending}>Enregistrer</Button>{cap != null && <Button onClick={() => { setValue(""); save.mutate(null); }}>Supprimer le plafond</Button>}</div>
        </form>
      </div>
    </Card>
  );
}

export function UsagePage() {
  const { orgId } = useOrg();
  const [days, setDays] = useState("30");
  const u = useQuery(usageQuery(orgId, Number(days)));
  const d = u.data;
  const totalCalls = d?.byProvider.reduce((n, p) => n + p.calls, 0) ?? 0, totalErrors = d?.byProvider.reduce((n, p) => n + p.errors, 0) ?? 0;

  return (
    <>
      <PageHeader title="Usage" subtitle="Ce que consomment les agents : dépense, appels aux modèles, et qui les sollicite."
        actions={<Tabs label="Période" value={days} onChange={setDays} items={PERIODS} />} />
      {u.isError && <ErrorBox error={u.error} retry={() => u.refetch()} />}
      {d ? <div className="rise mb-10"><BudgetCard key={`${d.budget.capUsd}`} cap={d.budget.capUsd} spent={d.budget.monthSpendUsd} projected={d.budget.projectedMonthUsd} /></div> : <Skeleton className="mb-10 h-56" />}

      <div className="mb-10 grid gap-4 sm:grid-cols-3">
        {d ? <>
          <Stat index={1} label="Dépense · période" value={fmtUsd(d.perDay.reduce((n, p) => n + p.spendUsd, 0))} />
          <Stat index={2} label="Appels aux modèles" value={fmtInt(totalCalls)} sub={`${fmtInt(d.perDay.reduce((n, p) => n + p.tasks, 0))} tâches`} />
          <Stat index={3} label="Appels en erreur" value={totalCalls ? fmtPct(totalErrors / totalCalls) : "—"} tone={totalCalls && totalErrors / totalCalls > 0.1 ? "bad" : undefined} sub={`${totalErrors} sur ${totalCalls}`} />
        </> : [0, 1, 2].map((i) => <Skeleton key={i} className="h-32" />)}
      </div>

      <div className="mb-10 grid gap-8 xl:grid-cols-2">
        <Section title="Dépense cumulée" index={3}><Card className="p-5">{d ? <SpendLine data={d.perDay} cap={Number(days) >= 28 && d.budget.capUsd ? d.budget.capUsd : undefined} /> : <Skeleton className="h-44" />}</Card></Section>
        <Section title="Appels aux modèles" hint="Par jour, tous fournisseurs confondus." index={4}><Card className="p-5">{d ? <SimpleBars unit="appels" data={d.perDay.map((p) => ({ day: p.day, value: p.calls ?? 0 }))} /> : <Skeleton className="h-44" />}</Card></Section>
      </div>

      <div className="grid gap-8 xl:grid-cols-3">
        <Section title="Par membre" index={5}><Card className="p-5">
          <HBars empty="Aucune activité sur la période." rows={(d?.byMember ?? []).map((m) => ({ key: m.userId, label: <span className="flex items-center gap-2"><Avatar name={m.email} size={22} />{m.email}</span>, value: m.spendUsd, display: fmtUsd(m.spendUsd), sub: `${m.tasks} tâche${m.tasks > 1 ? "s" : ""} · ${m.done} réussie${m.done > 1 ? "s" : ""} · ${m.failed} échec${m.failed > 1 ? "s" : ""}` }))} />
        </Card></Section>
        <Section title="Par projet" index={6}><Card className="p-5">
          <HBars empty="Aucune activité sur la période." rows={(d?.byProject ?? []).map((p) => ({ key: p.id, label: p.name, value: p.spendUsd, display: fmtUsd(p.spendUsd), sub: `${p.tasks} tâche${p.tasks > 1 ? "s" : ""}` }))} />
        </Card></Section>
        <Section title="Par fournisseur" index={7}><Card className="p-5">
          <HBars empty="Aucun appel sur la période." rows={(d?.byProvider ?? []).map((p) => ({ key: p.provider, label: PROVIDER_LABEL[p.provider] ?? p.provider, value: p.calls, display: `${fmtInt(p.calls)} appels`, sub: p.errors ? `${p.errors} en erreur (${fmtPct(p.errors / p.calls)})` : "aucune erreur" }))} />
        </Card></Section>
      </div>
    </>
  );
}
