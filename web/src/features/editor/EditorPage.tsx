import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Check, ExternalLink, GitBranch, GitCommitHorizontal, Loader2, Play, ShieldAlert, X } from "lucide-react";
import type { editor as MonacoEditor } from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ConfirmButton } from "../../components/ui/ConfirmButton";
import { ErrorBox, errorText, FormError, Skeleton } from "../../components/ui/Feedback";
import { Textarea } from "../../components/ui/Field";
import { useToast } from "../../components/ui/Toast";
import { projectsQuery } from "../../lib/queries";
import { useOrg } from "../../lib/useOrg";
import { editorApi, type FileChange } from "./api";
import { FileTree } from "./FileTree";
import { QuickOpen } from "./QuickOpen";
import { TEMPLATES, type TemplateKey } from "../projects/aiTemplates";
import { ApiError } from "../../lib/api";
import { languageOf, monaco } from "./monaco";

const route = getRouteApi("/o/$orgId/projects/$projectId/editor");
const STATUS: Record<FileChange["status"], { label: string; tone: "ok" | "warn" | "bad" | "info" }> = { A: { label: "Ajouté", tone: "ok" }, M: { label: "Modifié", tone: "warn" }, D: { label: "Supprimé", tone: "bad" }, R: { label: "Renommé", tone: "info" } };
const SAVE_DELAY = 1000;

type Tab = { path: string; model: MonacoEditor.ITextModel; saved: string };
type Save = "idle" | "pending" | "saving" | "saved" | "error";

/** Découpe un diff unifié en blocs par fichier, pour montrer celui qu'on choisit. */
const patchFor = (diff: string, path: string) => diff.split(/^(?=diff --git )/m).find((b) => b.startsWith(`diff --git a/${path} `) || b.includes(` b/${path}\n`)) ?? "";

function Patch({ text }: { text: string }) {
  if (!text) return <p className="p-4 text-sm text-muted">Pas de détail à afficher (fichier trop gros ou binaire).</p>;
  return (
    <pre className="overflow-auto p-3 font-mono text-[12.5px] leading-relaxed" aria-label="Différences">
      {text.split("\n").map((l, i) => <div key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "bg-ok-soft text-ok" : l.startsWith("-") && !l.startsWith("---") ? "bg-bad-soft text-bad" : l.startsWith("@@") ? "text-info" : "text-muted"}>{l || " "}</div>)}
    </pre>
  );
}

export function EditorPage() {
  const { orgId } = useOrg();
  const { projectId } = route.useParams();
  const { task, open: openPath, template } = route.useSearch() as { task?: string; open?: string; template?: TemplateKey };
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const projects = useQuery(projectsQuery(orgId));
  const project = projects.data?.find((p) => p.id === projectId);

  const session = useQuery({ queryKey: ["editor", orgId, projectId, task ?? ""], queryFn: () => editorApi.open(orgId, projectId, task), staleTime: Infinity, gcTime: 0, retry: false, refetchOnWindowFocus: false });
  const sid = session.data?.id;

  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const tabsRef = useRef<Tab[]>([]); tabsRef.current = tabs;
  const [active, setActive] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [save, setSave] = useState<Save>("idle");
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [panel, setPanel] = useState<"changes" | "check">("changes");
  const [picked, setPicked] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [quick, setQuick] = useState(false);

  const changes = useQuery({ queryKey: ["editor-changes", sid], queryFn: () => editorApi.changes(orgId, sid!), enabled: !!sid, refetchOnWindowFocus: false });
  const refreshChanges = useCallback(() => { void qc.invalidateQueries({ queryKey: ["editor-changes", sid] }); }, [qc, sid]);

  // --- l'éditeur Monaco : un seul, qui change de « modèle » selon l'onglet
  useEffect(() => {
    if (!host.current || !sid) return;
    const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    const e = monaco.editor.create(host.current, { model: null, theme: dark ? "vs-dark" : "vs", automaticLayout: true, minimap: { enabled: false }, fontSize: 13.5, fontFamily: "'Geist Mono Variable', ui-monospace, Menlo, monospace", scrollBeyondLastLine: false, tabSize: 2, renderWhitespace: "selection", ariaLabel: "Éditeur de code" });
    ed.current = e;
    return () => { Object.values(timers.current).forEach(clearTimeout); tabsRef.current.forEach((t) => t.model.dispose()); e.dispose(); ed.current = null; };
  }, [sid]);

  const persist = useCallback(async (path: string) => {
    const t = tabsRef.current.find((x) => x.path === path);
    if (!t || !sid) return;
    const content = t.model.getValue();
    setSave("saving");
    try {
      await editorApi.save(orgId, sid, path, content);
      t.saved = content;
      setDirty((d) => { const n = new Set(d); if (t.model.getValue() === content) n.delete(path); return n; });
      setSave("saved"); refreshChanges();
    } catch (e) { setSave("error"); toast(`Enregistrement impossible : ${errorText(e)}`, "bad"); }
  }, [orgId, sid, refreshChanges, toast]);

  const schedule = useCallback((path: string) => {
    clearTimeout(timers.current[path]);
    setSave("pending");
    timers.current[path] = setTimeout(() => void persist(path), SAVE_DELAY);
  }, [persist]);

  useEffect(() => {
    ed.current?.addAction({ id: "atelier.save", label: "Enregistrer", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: () => { const p = ed.current?.getModel()?.uri.path.slice(1); if (p) { clearTimeout(timers.current[decodeURIComponent(p)]); void persist(decodeURIComponent(p)); } } });
  }, [sid, persist]);

  const openFile = useCallback(async (path: string) => {
    if (!sid) return;
    let t = tabsRef.current.find((x) => x.path === path);
    if (!t) {
      try {
        const f = await editorApi.read(orgId, sid, path);
        const model = monaco.editor.createModel(f.content, languageOf(path), monaco.Uri.from({ scheme: "file", path: `/${path}` }));
        t = { path, model, saved: f.content };
        model.onDidChangeContent(() => {
          setDirty((d) => { const n = new Set(d); if (model.getValue() === t!.saved) n.delete(path); else n.add(path); return n; });
          if (model.getValue() !== t!.saved) schedule(path);
        });
        setTabs((ts) => [...ts, t!]);
      } catch (e) { toast(errorText(e), "bad"); return; }
    }
    ed.current?.setModel(t.model); setActive(path); ed.current?.focus();
  }, [orgId, sid, schedule, toast]);

  // Arrivée depuis « IA » : ouvrir le fichier demandé, et le créer depuis son modèle s'il n'existe pas encore.
  const opened = useRef(false);
  useEffect(() => {
    if (!sid || !openPath || opened.current) return;
    opened.current = true;
    void (async () => {
      try { await editorApi.read(orgId, sid, openPath); }
      catch (e) {
        if (!(e instanceof ApiError && e.status === 404) || !template) { toast(errorText(e), "bad"); return; }
        const name = openPath.split("/").slice(-1)[0] === "SKILL.md" ? openPath.split("/").slice(-2)[0]! : openPath.split("/").slice(-1)[0]!.replace(/\.md$/, "");
        try { await editorApi.save(orgId, sid, openPath, TEMPLATES[template](name), true); refreshChanges(); } catch (er) { toast(errorText(er), "bad"); return; }
      }
      void openFile(openPath);
    })();
  }, [sid, openPath, template, orgId, openFile, refreshChanges, toast]);

  const closeTab = useCallback(async (path: string) => {
    if (dirty.has(path)) { clearTimeout(timers.current[path]); await persist(path); }
    const t = tabsRef.current.find((x) => x.path === path); if (!t) return;
    const rest = tabsRef.current.filter((x) => x.path !== path);
    setTabs(rest);
    if (active === path) { const n = rest.at(-1); ed.current?.setModel(n?.model ?? null); setActive(n?.path ?? null); }
    t.model.dispose();
  }, [active, dirty, persist]);

  const dropTab = (path: string) => { const t = tabsRef.current.find((x) => x.path === path || x.path.startsWith(`${path}/`)); if (t) { clearTimeout(timers.current[t.path]); void closeTabNoSave(t.path); } };
  const closeTabNoSave = async (path: string) => {
    const t = tabsRef.current.find((x) => x.path === path); if (!t) return;
    const rest = tabsRef.current.filter((x) => x.path !== path); setTabs(rest); setDirty((d) => { const n = new Set(d); n.delete(path); return n; });
    if (active === path) { const n = rest.at(-1); ed.current?.setModel(n?.model ?? null); setActive(n?.path ?? null); }
    t.model.dispose();
  };
  const renamed = (from: string, to: string) => { void closeTabNoSave(from); void openFile(to); };

  // --- vérification, validation, abandon
  const check = useMutation({ mutationFn: () => editorApi.check(orgId, sid!), onSuccess: () => setPanel("check"), onError: (e) => toast(errorText(e), "bad") });
  const flush = async () => { for (const p of [...dirty]) { clearTimeout(timers.current[p]); await persist(p); } };
  const commit = useMutation({
    mutationFn: async () => { await flush(); return editorApi.commit(orgId, sid!, message); },
    onSuccess: (r) => { setMessage(""); refreshChanges(); toast(r.mrUrl ? "Modifications envoyées : la demande de fusion est à jour." : "Modifications envoyées sur la branche."); },
  });
  const discard = useMutation({
    mutationFn: () => editorApi.discard(orgId, sid!),
    onSuccess: () => { qc.removeQueries({ queryKey: ["editor", orgId, projectId] }); navigate({ to: "/o/$orgId/projects/$projectId", params: { orgId, projectId } }); },
    onError: (e) => toast(errorText(e), "bad"),
  });

  useEffect(() => { // Cmd/Ctrl+P : aller au fichier (avant que le navigateur n'ouvre « Imprimer »)
    const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") { e.preventDefault(); setQuick(true); } };
    addEventListener("keydown", key); return () => removeEventListener("keydown", key);
  }, []);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty.size) e.preventDefault(); };
    addEventListener("beforeunload", warn); return () => removeEventListener("beforeunload", warn);
  }, [dirty]);

  const files = changes.data?.files ?? [];
  const shown = picked ?? files[0]?.path ?? null;
  const patch = useMemo(() => (changes.data && shown ? patchFor(changes.data.diff, shown) : ""), [changes.data, shown]);
  const back = <Link to="/o/$orgId/projects/$projectId" params={{ orgId, projectId }} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" />{project?.name ?? "Projet"}</Link>;

  if (session.isPending) return <div className="grid gap-4"><Skeleton className="h-8 w-1/3" /><Skeleton className="h-[60vh]" /><p className="text-sm text-muted"><Loader2 className="mr-2 inline size-4 animate-spin" aria-hidden />Copie du projet dans un espace privé…</p></div>;
  if (session.error) return <div className="grid gap-4">{back}<ErrorBox error={session.error} retry={() => void session.refetch()} /></div>;
  const s = session.data!;

  return (
    <div className="flex h-[calc(100dvh-5.5rem)] min-h-[34rem] flex-col gap-3" data-testid="editor">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          {back}
          <span className="inline-flex items-center gap-1.5 font-mono text-[13px]"><GitBranch className="size-3.5 text-muted" aria-hidden />{s.branch}</span>
          <span className="text-xs text-muted" aria-live="polite">{save === "pending" ? "Modifié…" : save === "saving" ? "Enregistrement…" : save === "saved" ? "Brouillon enregistré" : save === "error" ? "Échec de l'enregistrement" : ""}</span>
        </div>
        <ConfirmButton variant="danger" icon={<X className="size-4" />} onConfirm={() => discard.mutate()} loading={discard.isPending}>Abandonner l'édition</ConfirmButton>
      </div>
      <p className="rounded-lg border border-line bg-subtle px-3 py-2 text-[13px] text-muted">Tu édites une copie privée sur la branche <b className="font-mono text-ink">{s.branch}</b>. Rien n'est fusionné : « Valider » envoie la branche, et quelqu'un doit la relire. Les brouillons s'enregistrent tout seuls ; l'espace expire après 2 h d'inactivité. <kbd className="rounded border border-line bg-raised px-1 font-mono text-xs">Ctrl/⌘ P</kbd> pour aller à un fichier.</p>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[15rem_1fr]">
        <div className="min-h-0 overflow-hidden rounded-xl border border-line bg-raised">
          <FileTree org={orgId} session={s.id} dirty={dirty} selected={active} onOpen={(p) => void openFile(p)} onChanged={refreshChanges} onRemoved={dropTab} onRenamed={renamed} />
        </div>
        <div className="grid min-h-0 grid-rows-[1fr_15rem] gap-3">
          <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-raised">
            <div role="tablist" aria-label="Fichiers ouverts" className="flex min-h-[2.4rem] gap-px overflow-x-auto border-b border-line bg-subtle">
              {tabs.map((t) => (
                <div key={t.path} role="tab" aria-selected={active === t.path} className={`flex shrink-0 items-center gap-2 border-r border-line px-3 text-[13px] ${active === t.path ? "bg-raised font-medium" : "text-muted hover:text-ink"}`}>
                  <button type="button" onClick={() => { ed.current?.setModel(t.model); setActive(t.path); ed.current?.focus(); }} className="py-2">{t.path.split("/").pop()}{dirty.has(t.path) && <span className="ml-1.5 inline-block size-1.5 rounded-full bg-accent align-middle" aria-label="non enregistré" />}</button>
                  <button type="button" aria-label={`Fermer ${t.path}`} onClick={() => void closeTab(t.path)} className="rounded p-0.5 hover:bg-line"><X className="size-3" /></button>
                </div>
              ))}
            </div>
            <div className="relative min-h-0 flex-1">
              <div ref={host} className="absolute inset-0" />
              {!active && <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted">Choisis un fichier dans l'arbre.</div>}
            </div>
          </div>

          <div className="grid min-h-0 grid-cols-1 overflow-hidden rounded-xl border border-line bg-raised md:grid-cols-[1fr_17rem]">
            <div className="flex min-h-0 flex-col">
              <div role="tablist" aria-label="Panneau du bas" className="flex gap-1 border-b border-line px-2 py-1.5">
                {([["changes", `Modifications${files.length ? ` (${files.length})` : ""}`], ["check", "Vérification"]] as const).map(([v, l]) => (
                  <button key={v} role="tab" type="button" aria-selected={panel === v} onClick={() => setPanel(v)} className={`rounded-md px-2.5 py-1 text-[13px] font-medium ${panel === v ? "bg-line text-ink" : "text-muted hover:text-ink"}`}>{l}</button>
                ))}
              </div>
              {panel === "changes" ? (
                <div className="grid min-h-0 flex-1 grid-cols-[13rem_1fr]">
                  <ul className="overflow-y-auto border-r border-line text-[13px]" aria-label="Fichiers modifiés">
                    {files.length === 0 && <li className="p-3 text-muted">Aucune modification.</li>}
                    {files.map((f) => (
                      <li key={f.path}><button type="button" onClick={() => setPicked(f.path)} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${shown === f.path ? "bg-line" : "hover:bg-line/60"}`}>
                        <Badge tone={STATUS[f.status].tone}>{f.status}</Badge><span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>{f.path}</span>{f.protected && <ShieldAlert className="size-3.5 shrink-0 text-warn" aria-label="chemin protégé" />}
                      </button></li>
                    ))}
                  </ul>
                  <div className="min-h-0 overflow-auto">{files.length ? <Patch text={patch} /> : null}{changes.data?.truncated && <p className="p-3 text-xs text-warn">Diff tronqué : il est trop long pour être affiché en entier.</p>}</div>
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-auto p-3">
                  <Button size="sm" icon={check.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} disabled={check.isPending} onClick={() => { void flush().then(() => check.mutate()); }}>Lancer la vérification</Button>
                  <p className="mt-1 text-xs text-muted">Commande du projet : <code className="font-mono">{project?.check ?? "…"}</code>, dans un conteneur sans réseau.</p>
                  {check.data && <div className="mt-3"><p className={`flex items-center gap-1.5 text-sm font-medium ${check.data.ok ? "text-ok" : "text-bad"}`}>{check.data.ok ? <Check className="size-4" /> : <X className="size-4" />}{check.data.ok ? "La vérification passe." : "La vérification échoue."}</p><pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-subtle p-2 font-mono text-xs" data-testid="check-output">{check.data.output || "(aucune sortie)"}</pre></div>}
                </div>
              )}
            </div>
            <form onSubmit={(e) => { e.preventDefault(); commit.mutate(); }} className="grid content-start gap-2 border-t border-line p-3 md:border-l md:border-t-0">
              <label htmlFor="commit-msg" className="text-[13px] font-medium">Valider les modifications</label>
              <Textarea id="commit-msg" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Décris le changement en une phrase" maxLength={2000} className="min-h-0 text-[13px]" rows={2} />
              <Button type="submit" variant="primary" size="sm" icon={<GitCommitHorizontal className="size-3.5" />} loading={commit.isPending} disabled={!message.trim() || (files.length === 0 && dirty.size === 0)}>Valider et envoyer</Button>
              <FormError error={commit.error} />
              {commit.data && <p className="text-xs text-ok" role="status" data-testid="commit-result">{commit.data.files} fichier{commit.data.files > 1 ? "s" : ""} envoyé{commit.data.files > 1 ? "s" : ""}{commit.data.flagged.length ? ` · ${commit.data.flagged.length} en chemin protégé : relecture obligatoire` : ""}.{commit.data.mrUrl && <> <a href={commit.data.mrUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium underline">Demande de fusion <ExternalLink className="size-3" aria-hidden /></a></>}</p>}
            </form>
          </div>
        </div>
      </div>
    <QuickOpen org={orgId} session={s.id} open={quick} onClose={() => setQuick(false)} onPick={(p) => void openFile(p)} />
    </div>
  );
}
