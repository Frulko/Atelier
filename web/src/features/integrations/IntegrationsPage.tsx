import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Brain, CheckCircle2, CircleDashed, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, PageHeader, Section } from "../../components/ui/Card";
import { ConfirmButton } from "../../components/ui/ConfirmButton";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState, ErrorBox, FormError, Skeleton } from "../../components/ui/Feedback";
import { Field, Input, Select } from "../../components/ui/Field";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { relTime } from "../../lib/format";
import { PROVIDER_LABEL } from "../../lib/labels";
import { invalidateOrg, secretsQuery } from "../../lib/queries";
import { useOrg } from "../../lib/useOrg";
import type { Secret } from "../../lib/types";

const PROVIDERS = ["anthropic", "openai", "openrouter"];

function SecretDialog({ open, onClose, secret, initialKind }: { open: boolean; onClose: () => void; secret?: Secret; initialKind?: Secret["kind"] }) {
  const { orgId } = useOrg();
  const toast = useToast();
  const [kind, setKind] = useState<Secret["kind"]>(secret?.kind ?? initialKind ?? "git_token");
  const [provider, setProvider] = useState(secret?.provider ?? "anthropic");
  const [label, setLabel] = useState(secret?.label ?? "");
  const [value, setValue] = useState("");
  const done = () => { setValue(""); onClose(); };
  const save = useMutation({
    mutationFn: () => secret
      ? api.patch(`/api/orgs/${orgId}/secrets/${secret.id}`, { label, ...(value ? { value } : {}) })
      : api.post(`/api/orgs/${orgId}/secrets`, { kind, label, value, ...(kind === "provider_key" ? { provider } : {}) }),
    onSuccess: () => { invalidateOrg(orgId, "secrets"); invalidateOrg(orgId, "audit"); toast(secret ? (value ? "Valeur remplacée." : "Libellé enregistré.") : "Secret enregistré."); done(); },
  });
  return (
    <Dialog open={open} onClose={done} title={secret ? "Modifier le secret" : "Ajouter un secret"} description="Chiffré au repos. Une fois enregistrée, la valeur n'est plus jamais affichée.">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="grid gap-4">
        {!secret && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Type">{(id) => <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as Secret["kind"])}><option value="git_token">Jeton git</option><option value="provider_key">Clé de modèle</option></Select>}</Field>
            {kind === "provider_key" && <Field label="Fournisseur">{(id) => <Select id={id} value={provider} onChange={(e) => setProvider(e.target.value)}>{PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}</Select>}</Field>}
          </div>
        )}
        <Field label="Libellé">{(id) => <Input id={id} value={label} maxLength={80} required onChange={(e) => setLabel(e.target.value)} placeholder={kind === "provider_key" ? "Clé de l'équipe" : "GitLab de l'équipe"} autoFocus />}</Field>
        <Field label={secret ? "Nouvelle valeur" : "Valeur"} hint={secret ? "Laisse vide pour garder la valeur actuelle. Remplacer ne casse aucun projet : l'identifiant reste le même." : kind === "git_token" ? "GitLab : droits api + write_repository. GitHub : repo." : undefined}>
          {(id) => <Input id={id} type="password" value={value} onChange={(e) => setValue(e.target.value)} required={!secret} autoComplete="off" spellCheck={false} className="font-mono text-[13px]" />}
        </Field>
        <FormError error={save.error} />
        <div className="flex justify-end gap-2"><Button onClick={done}>Annuler</Button><Button variant="primary" type="submit" loading={save.isPending}>Enregistrer</Button></div>
      </form>
    </Dialog>
  );
}

export function IntegrationsPage() {
  const { orgId } = useOrg();
  const secrets = useQuery(secretsQuery(orgId));
  const toast = useToast();
  const [dialog, setDialog] = useState<{ secret?: Secret; kind?: Secret["kind"] } | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/orgs/${orgId}/secrets/${id}`),
    onSuccess: () => { invalidateOrg(orgId, "secrets"); invalidateOrg(orgId, "audit"); toast("Secret supprimé."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Échec", "bad"),
  });
  const list = secrets.data ?? [];
  const git = list.filter((s) => s.kind === "git_token"), keys = list.filter((s) => s.kind === "provider_key");

  const row = (s: Secret) => (
    <tr key={s.id}>
      <td className="px-4 py-3.5"><p className="text-[15px] text-ink">{s.label}</p><p className="font-mono text-xs text-muted">{s.hint}{s.provider ? ` · ${PROVIDER_LABEL[s.provider] ?? s.provider}` : ""}</p></td>
      <td className="px-4 py-3.5">{s.usedBy.length ? <span className="flex flex-wrap gap-1.5">{s.usedBy.map((p) => <Link key={p.id} to="/o/$orgId/projects/$projectId" params={{ orgId, projectId: p.id }}><Badge tone="info">{p.name}</Badge></Link>)}</span> : <span className="text-[13px] text-faint">{s.kind === "git_token" ? "Aucun projet" : "—"}</span>}</td>
      <td className="whitespace-nowrap px-4 py-3.5 text-[13px] text-muted">{s.last_used_at ? relTime(s.last_used_at) : "jamais"}</td>
      <td className="whitespace-nowrap px-4 py-3.5 text-right"><span className="inline-flex gap-1.5">
        <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setDialog({ secret: s })} aria-label={`Modifier ${s.label}`}>Modifier</Button>
        <ConfirmButton size="sm" icon={<Trash2 className="size-3.5" />} disabled={s.usedBy.length > 0} title={s.usedBy.length ? "Utilisé par un projet : détache-le d'abord." : undefined} onConfirm={() => del.mutate(s.id)} aria-label={`Supprimer ${s.label}`}>Supprimer</ConfirmButton>
      </span></td>
    </tr>
  );
  const table = (rows: Secret[]) => (
    <Card className="overflow-x-auto"><table className="w-full min-w-[40rem] text-left text-sm">
      <thead><tr className="border-b border-line">{["Secret", "Utilisé par", "Dernier usage", ""].map((h, i) => <th key={i} className="label px-4 py-3 font-normal">{h}</th>)}</tr></thead>
      <tbody className="divide-y divide-line">{rows.map(row)}</tbody>
    </table></Card>
  );

  return (
    <>
      <PageHeader title="Intégrations" subtitle="Les accès dont l'agent a besoin : à ton dépôt git, et aux fournisseurs de modèles. Jamais visibles du bac à sable."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setDialog({})}>Ajouter un secret</Button>} />
      {secrets.isError && <ErrorBox error={secrets.error} retry={() => secrets.refetch()} />}

      <Section title="Fournisseurs de modèles" hint="Le proxy utilise la clé la plus récente de chaque fournisseur." className="mb-10" index={1}>
        <ul className="grid gap-4 md:grid-cols-3">
          {PROVIDERS.map((p, i) => {
            const k = keys.filter((x) => x.provider === p).at(-1);
            return (
              <li key={p} className="rise" style={{ ["--i" as string]: i }}>
                <Card className="flex h-full flex-col gap-3 p-5">
                  <div className="flex items-center justify-between"><span className="flex items-center gap-2 font-display text-xl"><Brain className="size-4 text-muted" aria-hidden />{PROVIDER_LABEL[p]}</span>{k ? <CheckCircle2 className="size-5 text-ok" aria-label="Configuré" /> : <CircleDashed className="size-5 text-faint" aria-label="Non configuré" />}</div>
                  <p className="flex-1 text-sm text-muted">{k ? <>Clé « {k.label} » <span className="font-mono text-xs">{k.hint}</span>{k.last_used_at ? ` · utilisée ${relTime(k.last_used_at)}` : " · jamais utilisée"}</> : "Aucune clé : les tâches ne pourront pas appeler ce fournisseur."}</p>
                  <Button size="sm" onClick={() => setDialog(k ? { secret: k } : { kind: "provider_key" })}>{k ? "Remplacer la clé" : "Ajouter une clé"}</Button>
                </Card>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Jetons git" hint="Pour cloner, pousser une branche et ouvrir la demande de fusion." className="mb-10" index={2}>
        {secrets.isLoading ? <Skeleton className="h-32" /> : git.length ? table(git) : <EmptyState icon={<KeyRound className="size-5" />} title="Aucun jeton git" hint="Sans jeton, seuls les dépôts publics ou locaux sont accessibles." action={<Button onClick={() => setDialog({ kind: "git_token" })}>Ajouter un jeton</Button>} />}
      </Section>

      {keys.length > 0 && <Section title="Toutes les clés de modèles" hint="Une organisation peut en garder plusieurs ; seule la plus récente par fournisseur est utilisée." index={3}>{table(keys)}</Section>}
      {dialog && <SecretDialog key={dialog.secret?.id ?? dialog.kind ?? "new"} open onClose={() => setDialog(null)} secret={dialog.secret} initialKind={dialog.kind} />}
    </>
  );
}
