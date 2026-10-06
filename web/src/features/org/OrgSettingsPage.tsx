import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card, PageHeader, Section } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { FormError, Skeleton } from "../../components/ui/Feedback";
import { Field, Input, Select } from "../../components/ui/Field";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { fmtUsd } from "../../lib/format";
import { PROVIDER_LABEL } from "../../lib/labels";
import { invalidateOrg, meQuery, orgQuery, queryClient, refreshMe } from "../../lib/queries";
import { useOrg } from "../../lib/useOrg";

function DeleteDialog({ open, onClose, name }: { open: boolean; onClose: () => void; name: string }) {
  const { orgId } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const del = useMutation({
    mutationFn: () => api.del(`/api/orgs/${orgId}`, { confirm: typed }),
    onSuccess: async () => { queryClient.removeQueries({ queryKey: ["org", orgId] }); await refreshMe(queryClient); toast("Organisation supprimée."); navigate({ to: "/" }); },
  });
  return (
    <Dialog open={open} onClose={() => { setTyped(""); onClose(); }} title="Supprimer l'organisation" description="Cette action est définitive.">
      <form onSubmit={(e) => { e.preventDefault(); del.mutate(); }} className="grid gap-4">
        <ul className="grid gap-1.5 rounded-xl bg-bad-soft p-4 text-sm text-bad"><li>• Tous les projets, secrets et invitations</li><li>• Toutes les tâches, leur journal et l'historique d'usage</li><li>• Le journal d'audit de l'organisation</li><li>• L'accès de tous ses membres (leurs comptes restent)</li></ul>
        <Field label={<>Pour confirmer, tape <b className="font-mono">{name}</b></>}>{(id) => <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus />}</Field>
        <FormError error={del.error} />
        <div className="flex justify-end gap-2"><Button onClick={() => { setTyped(""); onClose(); }}>Annuler</Button><Button variant="danger" type="submit" loading={del.isPending} disabled={typed !== name}>Supprimer définitivement</Button></div>
      </form>
    </Dialog>
  );
}

/** Fournisseur et modèle de l'assistant de discussion : propres à l'organisation, la clé est celle de ses Intégrations. */
function ChatSettings() {
  const { orgId } = useOrg();
  const toast = useToast();
  const detail = useQuery(orgQuery(orgId));
  const c = detail.data?.chat;
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.patch(`/api/orgs/${orgId}`, { chatProvider: provider ?? c?.provider, chatModel: (model ?? c?.model ?? "").trim() }),
    onSuccess: () => { invalidateOrg(orgId); invalidateOrg(orgId, "audit"); setProvider(null); setModel(null); toast("Assistant enregistré."); },
  });
  if (!c) return <Skeleton className="h-24" />;
  const p = provider ?? c.provider, m = model ?? c.model;
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Fournisseur">{(id) => <Select id={id} value={p} onChange={(e) => setProvider(e.target.value)}>{c.providers.map((x) => <option key={x} value={x}>{PROVIDER_LABEL[x] ?? x}</option>)}</Select>}</Field>
        <Field label="Modèle" hint="Identifiant chez le fournisseur.">{(id) => <Input id={id} value={m} maxLength={100} required onChange={(e) => setModel(e.target.value)} className="font-mono text-[13px]" />}</Field>
      </div>
      <p className="text-xs text-muted">L'assistant utilise la clé de ce fournisseur déclarée dans <Link to="/o/$orgId/integrations" params={{ orgId }} className="font-medium text-accent hover:underline">Intégrations</Link>. Les tâches de l'agent ont leur propre réglage.</p>
      <FormError error={save.error} />
      <div><Button variant="primary" type="submit" loading={save.isPending} disabled={provider === null && model === null}>Appliquer</Button></div>
    </form>
  );
}

export function OrgSettingsPage() {
  const { orgId, org, isOwner } = useOrg();
  const detail = useQuery(orgQuery(orgId));
  const toast = useToast();
  const [name, setName] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const current = name ?? detail.data?.name ?? org?.name ?? "";
  const rename = useMutation({
    mutationFn: () => api.patch(`/api/orgs/${orgId}`, { name: current }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: meQuery.queryKey }); invalidateOrg(orgId); invalidateOrg(orgId, "audit"); setName(null); toast("Nom enregistré."); },
  });
  const copy = async () => { try { await navigator.clipboard.writeText(orgId); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* sélection manuelle possible */ } };

  return (
    <>
      <PageHeader title="Organisation" subtitle="Le nom, l'identité et la suppression de l'organisation." />
      <div className="grid max-w-3xl gap-10">
        <Section title="Général" index={1}>
          <Card className="grid gap-5 p-6">
            <form onSubmit={(e) => { e.preventDefault(); rename.mutate(); }} className="grid gap-4">
              <Field label="Nom de l'organisation">{(id) => <Input id={id} value={current} maxLength={80} required onChange={(e) => setName(e.target.value)} />}</Field>
              <FormError error={rename.error} />
              <div><Button variant="primary" type="submit" loading={rename.isPending} disabled={name === null || name.trim() === (detail.data?.name ?? "")}>Enregistrer</Button></div>
            </form>
            <div className="grid gap-1.5 border-t border-line pt-5">
              <p className="label">Identifiant</p>
              <div className="flex items-center gap-2"><code className="rounded-lg bg-line/70 px-2.5 py-1.5 font-mono text-[13px]">{orgId}</code><Button size="sm" icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} onClick={copy}>{copied ? "Copié" : "Copier"}</Button></div>
              <p className="text-xs text-muted">Utile pour échanger avec le support.</p>
            </div>
          </Card>
        </Section>

        <Section title="Assistant de discussion" index={2}>
          <Card className="p-6"><ChatSettings /></Card>
        </Section>

        <Section title="Budget des modèles" index={2}>
          <Card className="flex flex-wrap items-center justify-between gap-4 p-6">
            {detail.data ? <p className="text-[15px]">Plafond mensuel : <b>{detail.data.budgetUsdMonth == null ? "illimité" : fmtUsd(detail.data.budgetUsdMonth)}</b> · dépensé ce mois-ci : <b className="tnum">{fmtUsd(detail.data.monthSpendUsd)}</b></p> : <Skeleton className="h-6 w-2/3" />}
            <Link to="/o/$orgId/usage" params={{ orgId }}><Button>Gérer le budget</Button></Link>
          </Card>
        </Section>

        <Section title="Zone dangereuse" index={3}>
          <Card className="border-bad/30 p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-start gap-3"><TriangleAlert className="mt-0.5 size-5 shrink-0 text-bad" aria-hidden /><div><h3 className="font-display text-xl">Supprimer l'organisation</h3><p className="mt-1 max-w-md text-sm text-muted">Efface définitivement projets, secrets, tâches, usage et journal. Refusée tant que des tâches sont en cours.</p></div></div>
              <Button variant="danger" disabled={!isOwner} onClick={() => setDeleting(true)} title={isOwner ? undefined : "Réservé au propriétaire"}>Supprimer…</Button>
            </div>
            {!isOwner && <p className="mt-3 text-xs text-muted">Seul un propriétaire peut supprimer l'organisation.</p>}
          </Card>
        </Section>
      </div>
      <DeleteDialog open={deleting} onClose={() => setDeleting(false)} name={detail.data?.name ?? org?.name ?? ""} />
    </>
  );
}
