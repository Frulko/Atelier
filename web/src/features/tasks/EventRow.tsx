import clsx from "clsx";
import { AlertTriangle, Check, CircleDot, ExternalLink, FileCode2, Wrench } from "lucide-react";
import type { TaskEvent } from "../../lib/types";

/** Une ligne du journal, présentée selon sa nature : étape, message de l'agent, outil, échec de vérification, fin. */
export function EventRow({ e, last }: { e: TaskEvent; last: boolean }) {
  const mr = e.type === "done" && /^(Prêt|Proposition mise à jour) : https?:/.test(e.text) ? e.text.replace(/^[^:]+ : /, "") : null;
  const icon = e.type === "error" ? <AlertTriangle className="size-3.5" /> : e.type === "check_failed" ? <Wrench className="size-3.5" /> : e.type === "done" ? <Check className="size-3.5" /> : e.type === "tool" ? <FileCode2 className="size-3.5" /> : <CircleDot className="size-3.5" />;
  const tone = e.type === "error" || e.type === "check_failed" ? "bg-bad-soft text-bad" : e.type === "done" ? "bg-ok-soft text-ok" : e.type === "step" ? "bg-accent-soft text-accent" : "bg-line text-muted";
  return (
    <li className="relative flex gap-4 pb-5">
      {!last && <span className="absolute left-[13px] top-7 h-full w-px bg-line-strong" aria-hidden />}
      <span className={clsx("z-10 grid size-7 shrink-0 place-items-center rounded-full", tone)} aria-hidden>{icon}</span>
      <div className="min-w-0 flex-1 pt-0.5">
        {e.type === "text" && <p className="whitespace-pre-wrap rounded-xl bg-raised px-3.5 py-2.5 text-[15px] leading-relaxed text-ink ring-1 ring-line">{e.text}</p>}
        {e.type === "tool" && <p className="font-mono text-[13px] text-muted">{e.text}</p>}
        {e.type === "step" && <p className="text-[15px] font-medium text-ink">{e.text}</p>}
        {e.type === "check_failed" && <><p className="text-sm font-medium text-bad">La vérification a échoué : l'agent est relancé avec cette sortie.</p><pre className="mt-2 max-h-48 overflow-auto rounded-xl bg-bad-soft p-3 font-mono text-xs text-bad">{e.text}</pre></>}
        {e.type === "error" && <p className="text-[15px] font-medium text-bad">{e.text}</p>}
        {e.type === "done" && (mr ? <a href={mr} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[15px] font-medium text-ok hover:underline">{e.text.startsWith("Proposition mise à jour") ? "Proposition mise à jour" : "Proposition prête"} : ouvrir la demande de fusion <ExternalLink className="size-3.5" /></a> : <p className="text-[15px] font-medium text-ok">{e.text}</p>)}
        {!["text", "tool", "step", "check_failed", "error", "done"].includes(e.type) && <p className="font-mono text-xs text-muted">{e.text}</p>}
        <p className="mt-0.5 text-[11px] text-faint">{new Date(e.ts).toLocaleTimeString("fr-FR")}</p>
      </div>
    </li>
  );
}
