import { ChevronDown, ChevronRight, File, FilePlus2, Folder, FolderPlus, Link2, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Field";
import { FormError } from "../../components/ui/Feedback";
import { useToast } from "../../components/ui/Toast";
import { errorText } from "../../components/ui/Feedback";
import { editorApi, type Entry } from "./api";

type Ask = { kind: "file" | "dir" | "rename"; dir: string; from?: string } | null;
const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** L'arbre des fichiers : un dossier se charge à l'ouverture. Créer, renommer, supprimer passent par l'API (le serveur reste seul juge des chemins). */
export function FileTree({ org, session, dirty, selected, onOpen, onChanged, onRemoved, onRenamed }: {
  org: string; session: string; dirty: Set<string>; selected: string | null;
  onOpen: (path: string) => void; onChanged: () => void; onRemoved: (path: string) => void; onRenamed: (from: string, to: string) => void;
}) {
  const toast = useToast();
  const [dirs, setDirs] = useState<Record<string, Entry[] | "loading">>({});
  const [open, setOpen] = useState<Set<string>>(new Set([""]));
  const [target, setTarget] = useState("");      // dossier où créer
  const [ask, setAsk] = useState<Ask>(null);
  const [name, setName] = useState("");
  const [err, setErr] = useState<unknown>(null);

  const load = useCallback(async (dir: string) => {
    try { const r = await editorApi.tree(org, session, dir); setDirs((d) => ({ ...d, [dir]: r.entries })); }
    catch (e) { toast(errorText(e), "bad"); setDirs((d) => { const { [dir]: _, ...rest } = d; return rest; }); }
  }, [org, session, toast]);
  useEffect(() => { void load(""); }, [load]);

  const toggle = (dir: string) => setOpen((s) => { const n = new Set(s); if (n.has(dir)) n.delete(dir); else { n.add(dir); if (!dirs[dir]) void load(dir); } return n; });
  const reload = async (...which: string[]) => { await Promise.all([...new Set(which)].map((d) => load(d))); onChanged(); };

  const submit = async () => {
    if (!ask) return;
    const n = name.trim();
    try {
      if (ask.kind === "rename") { const to = (ask.dir ? `${ask.dir}/` : "") + n; await editorApi.op(org, session, { op: "rename", from: ask.from!, to }); onRenamed(ask.from!, to); await reload(ask.dir); }
      else { const path = (ask.dir ? `${ask.dir}/` : "") + n; await editorApi.op(org, session, { op: "create", path, type: ask.kind === "dir" ? "dir" : "file" }); setOpen((s) => new Set(s).add(ask.dir)); await reload(ask.dir); if (ask.kind === "file") onOpen(path); }
      setAsk(null); setErr(null);
    } catch (e) { setErr(e); }
  };
  const remove = async (e: Entry) => {
    try { await editorApi.op(org, session, { op: "delete", path: e.path }); onRemoved(e.path); await reload(parentOf(e.path)); }
    catch (er) { toast(errorText(er), "bad"); }
  };
  const start = (a: NonNullable<Ask>, initial = "") => { setName(initial); setErr(null); setAsk(a); };

  const rows = (dir: string, depth: number): React.ReactNode => {
    const list = dirs[dir];
    if (!list || list === "loading") return <li className="px-3 py-1 text-xs text-muted" style={{ paddingLeft: 12 + depth * 14 }}>…</li>;
    return list.map((e) => (
      <li key={e.path}>
        <div className={`group flex items-center gap-1 rounded-md pr-1 text-[13px] ${selected === e.path ? "bg-line" : "hover:bg-line/60"}`} style={{ paddingLeft: 6 + depth * 14 }}>
          {e.type === "dir" ? (
            <button type="button" onClick={() => { toggle(e.path); setTarget(e.path); }} className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left" aria-expanded={open.has(e.path)}>
              {open.has(e.path) ? <ChevronDown className="size-3.5 shrink-0" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0" aria-hidden />}
              <Folder className="size-3.5 shrink-0 text-accent" aria-hidden /><span className="truncate">{e.name}</span>
            </button>
          ) : (
            <button type="button" disabled={e.type === "link"} onClick={() => { onOpen(e.path); setTarget(parentOf(e.path)); }} title={e.type === "link" ? "Lien symbolique : non modifiable ici" : e.path}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-[18px] text-left disabled:opacity-50">
              {e.type === "link" ? <Link2 className="size-3.5 shrink-0" aria-hidden /> : <File className="size-3.5 shrink-0 text-muted" aria-hidden />}
              <span className={`truncate ${dirty.has(e.path) ? "italic" : ""}`}>{e.name}</span>{dirty.has(e.path) && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="non enregistré" />}
            </button>
          )}
          <span className="hidden shrink-0 gap-0.5 group-focus-within:flex group-hover:flex">
            <button type="button" aria-label={`Renommer ${e.name}`} onClick={() => start({ kind: "rename", dir: parentOf(e.path), from: e.path }, e.name)} className="rounded p-1 text-muted hover:text-ink"><Pencil className="size-3" /></button>
            <button type="button" aria-label={`Supprimer ${e.name}`} onClick={() => remove(e)} className="rounded p-1 text-muted hover:text-bad"><Trash2 className="size-3" /></button>
          </span>
        </div>
        {e.type === "dir" && open.has(e.path) && <ul>{rows(e.path, depth + 1)}</ul>}
      </li>
    ));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="label">Fichiers</span>
        <span className="flex gap-1">
          <button type="button" aria-label="Nouveau fichier" onClick={() => start({ kind: "file", dir: target })} className="rounded p-1 text-muted hover:bg-line hover:text-ink"><FilePlus2 className="size-4" /></button>
          <button type="button" aria-label="Nouveau dossier" onClick={() => start({ kind: "dir", dir: target })} className="rounded p-1 text-muted hover:bg-line hover:text-ink"><FolderPlus className="size-4" /></button>
        </span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto py-1" aria-label="Arbre des fichiers">{rows("", 0)}</ul>
      <Dialog open={!!ask} onClose={() => setAsk(null)} title={ask?.kind === "rename" ? "Renommer" : ask?.kind === "dir" ? "Nouveau dossier" : "Nouveau fichier"}
        description={ask && ask.kind !== "rename" ? `Dans ${ask.dir || "la racine du projet"}` : undefined}>
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="grid gap-4">
          <Field label="Nom">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required autoFocus maxLength={200} pattern="[^/\\]+" title="Un nom, sans barre oblique" className="font-mono text-[13px]" />}</Field>
          <FormError error={err} />
          <div className="flex justify-end gap-2"><Button onClick={() => setAsk(null)}>Annuler</Button><Button type="submit" variant="primary">{ask?.kind === "rename" ? "Renommer" : "Créer"}</Button></div>
        </form>
      </Dialog>
    </div>
  );
}
