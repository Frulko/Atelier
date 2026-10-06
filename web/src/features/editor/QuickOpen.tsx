import { useEffect, useRef, useState } from "react";
import { File } from "lucide-react";
import { Dialog } from "../../components/ui/Dialog";
import { Input } from "../../components/ui/Field";
import { editorApi } from "./api";

/** « Aller au fichier » (Cmd/Ctrl+P) : on tape quelques lettres du chemin, flèches pour choisir, Entrée pour ouvrir. */
export function QuickOpen({ org, session, open, onClose, onPick }: { org: string; session: string; open: boolean; onClose: () => void; onPick: (path: string) => void }) {
  const [q, setQ] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [at, setAt] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!open) return;
    const n = ++seq.current;
    const t = setTimeout(() => { editorApi.search(org, session, q).then((r) => { if (n === seq.current) { setPaths(r.paths); setAt(0); } }).catch(() => { if (n === seq.current) setPaths([]); }); }, 120);
    return () => clearTimeout(t);
  }, [open, q, org, session]);
  useEffect(() => { if (!open) setQ(""); }, [open]);
  const pick = (p: string | undefined) => { if (p) { onPick(p); onClose(); } };
  return (
    <Dialog open={open} onClose={onClose} title="Aller au fichier" description="Tape quelques lettres du chemin.">
      <div className="grid gap-3">
        <Input aria-label="Nom du fichier" role="combobox" aria-expanded aria-controls="quick-open-list" aria-activedescendant={paths[at] ? `qo-${at}` : undefined} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="app.js, src/ap…" className="font-mono text-[13px]"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(i + 1, paths.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); pick(paths[at]); }
          }} />
        <ul id="quick-open-list" role="listbox" aria-label="Fichiers trouvés" className="max-h-72 overflow-y-auto rounded-lg border border-line">
          {paths.length === 0 && <li className="px-3 py-3 text-sm text-muted">Aucun fichier.</li>}
          {paths.map((p, i) => (
            <li key={p} id={`qo-${i}`} role="option" aria-selected={i === at} onMouseEnter={() => setAt(i)} onClick={() => pick(p)}
              className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 font-mono text-[13px] ${i === at ? "bg-line" : ""}`}><File className="size-3.5 shrink-0 text-muted" aria-hidden /><span className="truncate">{p}</span></li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
