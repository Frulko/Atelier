import { useMutation, useQuery } from "@tanstack/react-query";
import { BookOpen, FileUp, Pencil, Pin, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, PageHeader, Section } from "../../components/ui/Card";
import { ConfirmButton } from "../../components/ui/ConfirmButton";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState, ErrorBox, FormError, Skeleton } from "../../components/ui/Feedback";
import { Field, Input, Select, Textarea } from "../../components/ui/Field";
import { Markdown } from "../../components/ui/Markdown";
import { Tabs } from "../../components/ui/Tabs";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { relTime } from "../../lib/format";
import { invalidateOrg, knowledgeItemQuery, knowledgeQuery, projectsQuery } from "../../lib/queries";
import { useOrg } from "../../lib/useOrg";
import type { KnowledgeBrief, KnowledgePreview } from "../../lib/types";

const BUDGET = 24_000, MAX = 12_000;

function Editor({ open, onClose, item }: { open: boolean; onClose: () => void; item?: KnowledgeBrief }) {
  const { orgId } = useOrg();
  const toast = useToast();
  const projects = useQuery(projectsQuery(orgId));
  const full = useQuery({ ...knowledgeItemQuery(orgId, item?.id ?? ""), enabled: open && !!item });
  const [title, setTitle] = useState(item?.title ?? "");
  const [content, setContent] = useState<string | null>(null);
  const [scope, setScope] = useState(item?.projectId ?? "");
  const [enabled, setEnabled] = useState(item?.enabled ?? true);
  const [pinned, setPinned] = useState(item?.pinned ?? false);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const file = useRef<HTMLInputElement>(null);
  const text = content ?? full.data?.content ?? "";

  const save = useMutation({
    mutationFn: () => {
      const body = { title, content: text, projectId: scope || null, enabled, pinned };
      return item ? api.patch(`/api/orgs/${orgId}/knowledge/${item.id}`, body) : api.post(`/api/orgs/${orgId}/knowledge`, body);
    },
    onSuccess: () => { invalidateOrg(orgId, "knowledge"); invalidateOrg(orgId, "audit"); toast(item ? "Connaissance enregistrée." : "Connaissance ajoutée."); onClose(); },
  });
  const importFile = async (f: File | undefined) => {
    if (!f) return;
    const t = await f.text();
    if (t.length > MAX) { toast(`Fichier trop long (${t.length.toLocaleString("fr-FR")} caractères, ${MAX.toLocaleString("fr-FR")} au plus).`, "bad"); return; }
    setContent(t);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
  };
  const toggle = (label: string, hint: string, v: boolean, set: (b: boolean) => void) => (
    <label className="flex items-start gap-3 rounded-lg border border-line p-3 text-sm"><input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} className="mt-1 size-4 accent-[var(--accent)]" /><span><b className="font-medium">{label}</b><span className="block text-xs text-muted">{hint}</span></span></label>
  );

  return (
    <Dialog open={open} onClose={onClose} wide title={item ? "Modifier la connaissance" : "Nouvelle connaissance"} description="Un court document en Markdown que l'assistant et l'agent liront avant de répondre ou de modifier le code.">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-[1.4fr_1fr]">
          <Field label="Titre">{(id) => <Input id={id} value={title} maxLength={120} required autoFocus onChange={(e) => setTitle(e.target.value)} placeholder="Charte graphique du site" />}</Field>
          <Field label="Portée" hint="Visible par toute l'organisation, ou réservée à un projet.">
            {(id) => <Select id={id} value={scope} onChange={(e) => setScope(e.target.value)}><option value="">Toute l'organisation</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>Projet : {p.name}</option>)}</Select>}
          </Field>
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <Tabs label="Mode" value={tab} onChange={setTab} items={[{ value: "write", label: "Écrire" }, { value: "preview", label: "Aperçu" }]} />
            <div className="flex items-center gap-3">
              <span className={`tnum text-xs ${text.length > MAX ? "font-medium text-bad" : "text-muted"}`}>{text.length.toLocaleString("fr-FR")} / {MAX.toLocaleString("fr-FR")}</span>
              <input ref={file} type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" className="sr-only" aria-label="Importer un fichier" onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = ""; }} />
              <Button size="sm" icon={<FileUp className="size-3.5" />} onClick={() => file.current?.click()}>Importer un fichier</Button>
            </div>
          </div>
          {tab === "write"
            ? <Textarea aria-label="Contenu" value={text} onChange={(e) => setContent(e.target.value)} rows={12} required className="font-mono text-[13px]" placeholder={"# Ton et couleurs\n\n- Ton chaleureux, tutoiement.\n- Couleurs : crème (#f5efe6) et brun (#5b3a29)."} />
            : <div className="min-h-[18rem] rounded-md border border-line bg-surface p-4">{text.trim() ? <Markdown>{text}</Markdown> : <p className="text-sm text-muted">Rien à afficher.</p>}</div>}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {toggle("Activée", "Donnée à l'assistant et à l'agent.", enabled, setEnabled)}
          {toggle("Épinglée", "Toujours incluse en premier si la place manque.", pinned, setPinned)}
        </div>
        <FormError error={save.error} />
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Annuler</Button><Button variant="primary" type="submit" loading={save.isPending} disabled={!title.trim() || !text.trim() || text.length > MAX}>Enregistrer</Button></div>
      </form>
    </Dialog>
  );
}

function Tester() {
  const { orgId } = useOrg();
  const projects = useQuery(projectsQuery(orgId));
  const [project, setProject] = useState("");
  const [query, setQuery] = useState("");
  const run = useMutation({ mutationFn: () => api.post<KnowledgePreview>(`/api/orgs/${orgId}/knowledge/preview`, { projectId: project || null, query }) });
  const r = run.data;
  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); run.mutate(); }} className="grid gap-3 md:grid-cols-[1fr_2fr_auto] md:items-end">
        <Field label="Projet">{(id) => <Select id={id} value={project} onChange={(e) => setProject(e.target.value)}><option value="">Aucun (organisation seule)</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>
        <Field label="Une demande ou une question">{(id) => <Input id={id} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Quelle charte graphique pour la page Contact ?" />}</Field>
        <Button type="submit" icon={<Sparkles className="size-4" />} loading={run.isPending}>Tester</Button>
      </form>
      {r && (
        <div className="mt-4 border-t border-line pt-4 text-sm" data-testid="knowledge-preview">
          <p className="mb-2 text-muted"><b className="text-ink">{r.chosen.length}</b> connaissance{r.chosen.length > 1 ? "s" : ""} donnée{r.chosen.length > 1 ? "s" : ""} · <span className="tnum">{r.chars.toLocaleString("fr-FR")} / {r.budget.toLocaleString("fr-FR")}</span> caractères{r.omitted.length > 0 && <> · <b className="text-warn">{r.omitted.length} écartée{r.omitted.length > 1 ? "s" : ""}</b> faute de place</>}</p>
          <ul className="flex flex-wrap gap-2">
            {r.chosen.map((c) => <li key={c.id}><Badge tone="ok">{c.pinned && <Pin className="size-3" aria-hidden />}{c.title}</Badge></li>)}
            {r.omitted.map((c) => <li key={c.id}><Badge tone="muted" className="line-through">{c.title}</Badge></li>)}
            {!r.chosen.length && <li className="text-muted">Rien : aucune connaissance activée ne s'applique.</li>}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function KnowledgePage() {
  const { orgId, isAdmin } = useOrg();
  const list = useQuery(knowledgeQuery(orgId));
  const projects = useQuery(projectsQuery(orgId));
  const toast = useToast();
  const [editing, setEditing] = useState<{ item?: KnowledgeBrief } | null>(null);
  const [scope, setScope] = useState<"all" | "org" | "project">("all");
  const [q, setQ] = useState("");
  const name = new Map(projects.data?.map((p) => [p.id, p.name]));
  const patch = useMutation({
    mutationFn: (v: { id: string; body: Record<string, boolean> }) => api.patch(`/api/orgs/${orgId}/knowledge/${v.id}`, v.body),
    onSuccess: () => { invalidateOrg(orgId, "knowledge"); invalidateOrg(orgId, "audit"); },
    onError: (e) => toast(e instanceof Error ? e.message : "Échec", "bad"),
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/orgs/${orgId}/knowledge/${id}`), onSuccess: () => { invalidateOrg(orgId, "knowledge"); invalidateOrg(orgId, "audit"); toast("Connaissance supprimée."); }, onError: (e) => toast(e instanceof Error ? e.message : "Échec", "bad") });

  const all = list.data ?? [];
  const used = all.filter((k) => k.enabled).reduce((n, k) => n + k.chars, 0);
  const shown = all.filter((k) => (scope === "all" || (scope === "org" ? k.projectId === null : k.projectId !== null)) && (!q || `${k.title} ${k.excerpt}`.toLowerCase().includes(q.toLowerCase())));

  return (
    <>
      <PageHeader title="Connaissances" subtitle="Ce que l'assistant et l'agent doivent savoir de ton organisation : conventions, glossaire, règles métier."
        actions={isAdmin ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({})}>Nouvelle connaissance</Button> : undefined} />

      <Card className="rise mb-8 flex flex-wrap items-center gap-x-8 gap-y-3 p-5" style={{ ["--i" as string]: 1 }}>
        <div className="min-w-0 flex-1 basis-72"><p className="text-sm font-medium">Comment ça marche</p><p className="mt-1 text-sm text-muted">Chaque connaissance activée est donnée à l'assistant et à l'agent. Quand elles ne tiennent pas toutes dans le budget, les plus pertinentes pour la demande sont choisies — les épinglées en premier.</p></div>
        <div className="w-60"><div className="flex justify-between text-xs text-muted"><span>Texte activé</span><span className="tnum">{used.toLocaleString("fr-FR")} / {BUDGET.toLocaleString("fr-FR")}</span></div><div className="mt-1.5 h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={Math.min(100, Math.round((used / BUDGET) * 100))} aria-valuemin={0} aria-valuemax={100} aria-label="Budget de texte utilisé"><div className={`h-full rounded-full ${used > BUDGET ? "bg-warn" : "bg-accent"}`} style={{ width: `${Math.min(100, (used / BUDGET) * 100)}%` }} /></div>{used > BUDGET && <p className="mt-1 text-xs text-warn">Au-dessus du budget : seules les plus pertinentes sont données.</p>}</div>
      </Card>

      <Section title="Tester la sélection" hint="Vois exactement ce que l'assistant saurait pour une question donnée." className="mb-10" index={2}><Tester /></Section>

      <Section title="Bibliothèque" hint={all.length ? `${all.length} élément${all.length > 1 ? "s" : ""}` : undefined} index={3}
        actions={<div className="flex flex-wrap items-center gap-2"><div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-faint" aria-hidden /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrer…" aria-label="Filtrer" className="h-8 w-44 pl-8 text-[13px]" /></div><Tabs label="Portée" value={scope} onChange={setScope} items={[{ value: "all", label: "Toutes" }, { value: "org", label: "Organisation" }, { value: "project", label: "Projets" }]} /></div>}>
        {list.isError && <ErrorBox error={list.error} retry={() => list.refetch()} />}
        {list.isLoading ? <div className="grid gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>
          : !all.length ? <EmptyState icon={<BookOpen className="size-5" />} title="Aucune connaissance" hint={isAdmin ? "Ajoute la charte du site, un glossaire métier ou les règles de calcul : l'assistant et l'agent s'en serviront." : "Un administrateur peut en ajouter."} action={isAdmin ? <Button variant="primary" onClick={() => setEditing({})}>Ajouter la première</Button> : undefined} />
          : !shown.length ? <EmptyState title="Aucun résultat" hint="Essaie un autre filtre." />
          : (
            <ul className="grid gap-3">
              {shown.map((k, i) => (
                <li key={k.id} className="rise" style={{ ["--i" as string]: i }}>
                  <Card className={`flex flex-wrap items-start gap-4 p-5 ${k.enabled ? "" : "opacity-60"}`}>
                    <div className="min-w-0 flex-1 basis-80">
                      <div className="flex flex-wrap items-center gap-2"><h3 className="font-display text-base">{k.title}</h3>{k.pinned && <Badge tone="accent"><Pin className="size-3" aria-hidden />Épinglée</Badge>}<Badge tone={k.projectId ? "info" : "muted"}>{k.projectId ? `Projet : ${name.get(k.projectId) ?? "supprimé"}` : "Organisation"}</Badge>{!k.enabled && <Badge tone="warn">Désactivée</Badge>}</div>
                      <p className="mt-1.5 line-clamp-2 text-sm text-muted">{k.excerpt}</p>
                      <p className="mt-2 text-xs text-faint"><span className="tnum">{k.chars.toLocaleString("fr-FR")}</span> caractères · modifiée {relTime(k.updatedAt)}{k.author ? ` par ${k.author}` : ""}</p>
                    </div>
                    {isAdmin && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" aria-pressed={k.enabled} onClick={() => patch.mutate({ id: k.id, body: { enabled: !k.enabled } })}>{k.enabled ? "Désactiver" : "Activer"}</Button>
                        <Button size="sm" aria-pressed={k.pinned} icon={<Pin className="size-3.5" />} onClick={() => patch.mutate({ id: k.id, body: { pinned: !k.pinned } })}>{k.pinned ? "Désépingler" : "Épingler"}</Button>
                        <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setEditing({ item: k })} aria-label={`Modifier ${k.title}`}>Modifier</Button>
                        <ConfirmButton size="sm" icon={<Trash2 className="size-3.5" />} onConfirm={() => del.mutate(k.id)} aria-label={`Supprimer ${k.title}`}>Supprimer</ConfirmButton>
                      </div>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          )}
      </Section>
      {editing && <Editor key={editing.item?.id ?? "new"} open onClose={() => setEditing(null)} item={editing.item} />}
    </>
  );
}
