import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { BookOpen, Bot, Check, FileText, Plus, ScrollText, Sparkles, Wand2, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, Section } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { ErrorBox, errorText, FormError, Skeleton } from "../../components/ui/Feedback";
import { Field, Input, Textarea } from "../../components/ui/Field";
import { Markdown } from "../../components/ui/Markdown";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { fmtUsd } from "../../lib/format";
import { invalidateOrg, knowledgeQuery } from "../../lib/queries";
import type { Project } from "../../lib/types";
import { useOrg } from "../../lib/useOrg";
import { NewConversationDialog } from "../conversations/ConversationsPage";
import { GENERATE_PROMPT, kindOf, pathFor, SLUG, type TemplateKey } from "./aiTemplates";
import { useProject } from "./ProjectContext";

const MAX_INSTRUCTIONS = 4000;
type RepoFile = { path: string; size: number };

function Instructions({ p }: { p: Project }) {
  const { orgId, isAdmin } = useOrg();
  const toast = useToast();
  const [text, setText] = useState<string | null>(null);
  const value = text ?? p.instructions ?? "";
  const save = useMutation({
    mutationFn: () => api.patch(`/api/orgs/${orgId}/projects/${p.id}`, { instructions: value.trim() || null }),
    onSuccess: () => { invalidateOrg(orgId, "projects"); setText(null); toast("Instructions enregistrées."); },
  });
  return (
    <Card className="grid gap-3 p-5">
      <p className="text-sm text-muted">Un texte écrit par ton équipe, ajouté au contexte de l'agent <b>et</b> de l'assistant pour ce projet seulement. Il ne change ni les droits de l'agent ni les règles de la plateforme.</p>
      <Textarea aria-label="Instructions du projet" value={value} readOnly={!isAdmin} maxLength={MAX_INSTRUCTIONS} rows={6} onChange={(e) => setText(e.target.value)}
        placeholder={"Ex. : Les prix sont en euros, avec la virgule.\nChaque nouvelle page reprend l'en-tête de index.html."} />
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted tnum">{value.length} / {MAX_INSTRUCTIONS}</span>
        {isAdmin ? <Button variant="primary" loading={save.isPending} disabled={text === null || value === (p.instructions ?? "")} onClick={() => save.mutate()}>Enregistrer</Button> : <span className="text-xs text-muted">Un administrateur peut les modifier.</span>}
      </div>
      <FormError error={save.error} />
    </Card>
  );
}

function AgentSettings({ p }: { p: Project }) {
  const { orgId, isAdmin } = useOrg();
  const toast = useToast();
  const [model, setModel] = useState(p.agentModel ?? "");
  const [turns, setTurns] = useState(p.agentMaxTurns?.toString() ?? "");
  const [budget, setBudget] = useState(p.agentBudgetUsd?.toString() ?? "");
  const dirty = model !== (p.agentModel ?? "") || turns !== (p.agentMaxTurns?.toString() ?? "") || budget !== (p.agentBudgetUsd?.toString() ?? "");
  const save = useMutation({
    mutationFn: () => api.patch(`/api/orgs/${orgId}/projects/${p.id}`, { agentModel: model.trim() || null, agentMaxTurns: turns.trim() ? Number(turns) : null, agentBudgetUsd: budget.trim() ? Number(budget) : null }),
    onSuccess: () => { invalidateOrg(orgId, "projects"); toast("Réglages enregistrés."); },
  });
  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Modèle" hint="Vide : celui par défaut de l'agent.">{(id) => <Input id={id} value={model} onChange={(e) => setModel(e.target.value)} disabled={!isAdmin} maxLength={100} placeholder="par défaut" className="font-mono text-[13px]" />}</Field>
          <Field label="Tours maximum" hint="1 à 100. Vide : 30.">{(id) => <Input id={id} type="number" min={1} max={100} step={1} value={turns} onChange={(e) => setTurns(e.target.value)} disabled={!isAdmin} placeholder="30" />}</Field>
          <Field label="Budget par exécution ($)" hint="0,1 à 50. Vide : le réglage de la plateforme.">{(id) => <Input id={id} type="number" min={0.1} max={50} step={0.1} value={budget} onChange={(e) => setBudget(e.target.value)} disabled={!isAdmin} placeholder="défaut" />}</Field>
        </div>
        <FormError error={save.error} />
        {isAdmin && <div><Button variant="primary" type="submit" loading={save.isPending} disabled={!dirty}>Enregistrer</Button></div>}
      </form>
    </Card>
  );
}

function Preview({ p, path, onClose }: { p: Project; path: string; onClose: () => void }) {
  const { orgId } = useOrg();
  const q = useQuery({ queryKey: ["org", orgId, "ai-file", p.id, path], queryFn: () => api.get<{ content: string }>(`/api/orgs/${orgId}/projects/${p.id}/ai-file?path=${encodeURIComponent(path)}`), retry: false });
  return (
    <Dialog open onClose={onClose} wide title={path} description="Tel qu'il est sur la branche de base du dépôt.">
      {q.isPending ? <Skeleton className="h-40" /> : q.error ? <ErrorBox error={q.error} /> : /\.md$/.test(path) ? <div className="max-h-[60vh] overflow-auto"><Markdown>{q.data.content}</Markdown></div> : <pre className="max-h-[60vh] overflow-auto font-mono text-xs">{q.data.content}</pre>}
    </Dialog>
  );
}

function NameDialog({ kind, onClose, onPick }: { kind: "rule" | "skill" | "subagent"; onClose: () => void; onPick: (name: string) => void }) {
  const [name, setName] = useState("");
  const label = kind === "rule" ? "règle" : kind === "skill" ? "skill" : "sous-agent";
  return (
    <Dialog open onClose={onClose} title={`Nouvelle ${label}`} description="Le nom devient celui du fichier : minuscules, chiffres et tirets.">
      <form onSubmit={(e) => { e.preventDefault(); onPick(name); }} className="grid gap-4">
        <Field label="Nom" error={name && !SLUG.test(name) ? "Minuscules, chiffres et tirets, 40 caractères au plus." : null}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value.toLowerCase())} required autoFocus className="font-mono text-[13px]" placeholder={kind === "skill" ? "page-contact" : kind === "rule" ? "style-des-textes" : "relecteur"} />}</Field>
        <p className="text-xs text-muted">Sera créé : <code className="font-mono">{SLUG.test(name) ? pathFor(kind, name) : "…"}</code> — dans l'éditeur, sur une branche, avant toute relecture.</p>
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Annuler</Button><Button type="submit" variant="primary" disabled={!SLUG.test(name)}>Ouvrir dans l'éditeur</Button></div>
      </form>
    </Dialog>
  );
}

const GROUPS: { kind: "rule" | "skill" | "subagent"; title: string; hint: string; icon: typeof FileText }[] = [
  { kind: "rule", title: "Règles", hint: ".claude/rules/*.md — des consignes courtes et ciblées, lues avec CLAUDE.md.", icon: ScrollText },
  { kind: "skill", title: "Skills", hint: ".claude/skills/<nom>/SKILL.md — une compétence que l'agent choisit quand elle correspond à la demande.", icon: Wand2 },
  { kind: "subagent", title: "Sous-agents", hint: ".claude/agents/*.md — des spécialistes auxquels l'agent peut déléguer.", icon: Bot },
];

export function ProjectAI() {
  const { orgId, isMember } = useOrg();
  const { project: p } = useProject();
  const navigate = useNavigate();
  const files = useQuery({ queryKey: ["org", orgId, "ai-files", p.id], queryFn: () => api.get<{ files: RepoFile[] }>(`/api/orgs/${orgId}/projects/${p.id}/ai-files`), retry: false, staleTime: 30_000 });
  const knowledge = useQuery(knowledgeQuery(orgId));
  const [preview, setPreview] = useState<string | null>(null);
  const [naming, setNaming] = useState<"rule" | "skill" | "subagent" | null>(null);
  const [generate, setGenerate] = useState<string | null>(null);
  const list = files.data?.files ?? [];
  const has = (path: string) => list.some((f) => f.path === path);
  const applicable = (knowledge.data ?? []).filter((k) => (k.projectId === p.id || k.projectId === null) && k.enabled).length;
  const edit = (path: string, template?: TemplateKey) => ({ to: "/o/$orgId/projects/$projectId/editor" as const, params: { orgId, projectId: p.id }, search: { open: path, ...(template ? { template } : {}) } });

  const Row = ({ f }: { f: RepoFile }) => (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <FileText className="size-4 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{f.path}</span>
      <span className="tnum text-xs text-muted">{f.size.toLocaleString("fr-FR")} o</span>
      <Button size="sm" variant="ghost" onClick={() => setPreview(f.path)}>Aperçu</Button>
      {isMember && <Link {...edit(f.path)}><Button size="sm">Modifier</Button></Link>}
    </li>
  );
  const Core = ({ path, kind, text }: { path: "CLAUDE.md" | "AGENTS.md"; kind: "claude" | "agents"; text: string }) => (
    <Card className="grid gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div><p className="font-mono text-sm font-medium">{path}</p><p className="mt-0.5 text-[13px] text-muted">{text}</p></div>
        {files.data && (has(path) ? <Badge tone="ok"><Check className="mr-1 inline size-3" aria-hidden />Présent</Badge> : <Badge tone="warn"><X className="mr-1 inline size-3" aria-hidden />Absent</Badge>)}
      </div>
      {files.data && isMember && (
        <div className="flex flex-wrap gap-2">
          {has(path) ? <><Button size="sm" variant="ghost" onClick={() => setPreview(path)}>Aperçu</Button><Link {...edit(path)}><Button size="sm">Modifier dans l'éditeur</Button></Link></> :
            <><Link {...edit(path, kind)}><Button size="sm" variant="primary" icon={<Plus className="size-3.5" />}>Créer depuis un modèle</Button></Link><Button size="sm" icon={<Sparkles className="size-3.5" />} onClick={() => setGenerate(GENERATE_PROMPT[kind])}>Faire écrire par l'agent</Button></>}
        </div>
      )}
    </Card>
  );

  return (
    <div className="grid gap-10">
      <Section title="Ce que l'agent reçoit à chaque tâche" hint="Dans cet ordre. Tout est visible, rien n'est caché.">
        <Card className="p-5">
          <ol className="grid gap-2.5 text-sm">
            {([
              ["Les règles de la plateforme", "bac à sable isolé, pas de git ni de réseau, plus petit changement possible", true],
              ["CLAUDE.md du dépôt (et ses règles et skills)", "lus par l'agent dans le dépôt", files.data ? has("CLAUDE.md") : null],
              ["Les instructions du projet", "ci-dessous, écrites dans Atelier", !!p.instructions],
              [`Les connaissances applicables (${applicable})`, "celles du projet et de l'organisation, choisies selon la demande", applicable > 0],
            ] as [string, string, boolean | null][]).map(([t, d, ok], i) => (
              <li key={t} className="flex items-start gap-3"><span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${ok ? "bg-ok text-white" : "bg-line text-muted"}`}>{ok ? <Check className="size-3" aria-hidden /> : i + 1}</span><span><b>{t}</b><span className="text-muted"> — {d}</span></span></li>
            ))}
          </ol>
          <p className="mt-4 border-t border-line pt-3 text-xs text-muted">Réglages : modèle <b className="text-ink">{p.agentModel ?? "par défaut"}</b> · {p.agentMaxTurns ?? 30} tours · {p.agentBudgetUsd ? fmtUsd(p.agentBudgetUsd) : "budget de la plateforme"} par exécution. L'agent ne voit jamais de secret. Le chargement des règles et skills par le vrai agent Claude n'a pas encore été vérifié ici.</p>
        </Card>
      </Section>

      <Section title="Instructions du projet" hint="Dans Atelier : pas besoin de toucher au dépôt."><Instructions key={p.instructions ?? ""} p={p} /></Section>
      <Section title="Réglages de l'agent"><AgentSettings key={`${p.agentModel}${p.agentMaxTurns}${p.agentBudgetUsd}`} p={p} /></Section>

      <Section title="Fichiers d'instructions du dépôt" hint="Versionnés avec le code, relus comme le code. Lus sur la branche de base."
        actions={<Button size="sm" variant="ghost" onClick={() => void files.refetch()} loading={files.isFetching}>Actualiser</Button>}>
        {!isMember ? <Card className="p-5 text-sm text-muted">Le contenu du dépôt est réservé aux membres.</Card> : files.error ? <ErrorBox error={files.error} retry={() => void files.refetch()} /> : files.isPending ? <Skeleton className="h-32" /> : (
          <div className="grid gap-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Core path="CLAUDE.md" kind="claude" text="Ce que l'agent lit en premier : le projet, les commandes, les conventions, les interdits." />
              <Core path="AGENTS.md" kind="agents" text="Le même rôle pour d'autres outils de code. Pour que l'agent Claude le lise aussi, ajoute la ligne @AGENTS.md dans CLAUDE.md." />
            </div>
            {GROUPS.map((g) => {
              const items = list.filter((f) => kindOf(f.path) === g.kind);
              return (
                <Card key={g.kind} className="overflow-hidden">
                  <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
                    <div className="flex min-w-0 items-start gap-3"><g.icon className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden /><div><p className="text-sm font-medium">{g.title} <span className="tnum font-normal text-muted">{items.length}</span></p><p className="text-xs text-muted">{g.hint}</p></div></div>
                    {isMember && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setNaming(g.kind)}>Nouvelle</Button>}
                  </div>
                  {items.length ? <ul className="divide-y divide-line">{items.map((f) => <Row key={f.path} f={f} />)}</ul> : <p className="px-4 py-4 text-sm text-muted">Aucune pour l'instant.</p>}
                </Card>
              );
            })}
          </div>
        )}
      </Section>

      <p className="flex items-center gap-2 text-xs text-muted"><BookOpen className="size-3.5" aria-hidden />Pour du contenu qui change souvent (ton, vocabulaire, règles métier), les <Link to="/o/$orgId/projects/$projectId/knowledge" params={{ orgId, projectId: p.id }} className="font-medium text-accent hover:underline">connaissances</Link> sont plus simples que des fichiers.</p>

      {preview && <Preview p={p} path={preview} onClose={() => setPreview(null)} />}
      {naming && <NameDialog kind={naming} onClose={() => setNaming(null)} onPick={(name) => {
        const kind = naming; setNaming(null);
        navigate(edit(pathFor(kind, name), kind) as never);
      }} />}
      {generate && <NewConversationDialog open onClose={() => setGenerate(null)} initial={{ mode: "task", text: generate }} defaultProject={p.id} />}
    </div>
  );
}
