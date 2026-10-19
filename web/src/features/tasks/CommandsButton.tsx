import { useMemo, useState } from "react";
import { TerminalSquare } from "lucide-react";
import { Terminal, TerminalActions, TerminalContent, TerminalCopyButton, TerminalHeader, TerminalStatus, TerminalTitle } from "@/components/ai-elements/terminal";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import type { TaskEvent } from "../../lib/types";
import { COMMAND_STATE, commandsOf } from "./commands";
import { useOrg } from "../../lib/useOrg";

export function CommandsButton({ events, running, taskId }: { events: TaskEvent[]; running: boolean; taskId:string }) {
  const { orgId } = useOrg();
  const [open, setOpen] = useState(false);
  const [follow, setFollow] = useState(true);
  const commands = useMemo(() => commandsOf(events, running), [events, running]);
  const output = useMemo(() => commands.map(c =>
    `${new Date(c.ts).toLocaleTimeString("fr-FR")} · Tour ${c.turn} · ${c.source}\n$ ${c.command}\n${c.output ? c.output + "\n" : ""}→ ${COMMAND_STATE[c.state]}`,
  ).join("\n\n"), [commands]);

  return <>
    <Button icon={<TerminalSquare className="size-4" aria-hidden />} onClick={() => setOpen(true)} aria-haspopup="dialog">
      Commandes <span className="rounded bg-line/70 px-1.5 text-xs tabular-nums">{commands.length}</span>
    </Button>
    <a href={`/api/orgs/${orgId}/tasks/${taskId}/logs`} download className="inline-flex h-9 items-center rounded-md border border-line-strong px-3 text-sm font-medium hover:bg-line/50">Exporter le journal</a>
    <Dialog open={open} onClose={() => setOpen(false)} title="Commandes" wide
      description="Lecture seule. Les commandes apparaissent à leur lancement ; leur sortie est reçue à la fin.">
      {commands.length ? <>
        <Terminal output={output} isStreaming={running} autoScroll={follow}>
          <TerminalHeader>
            <TerminalTitle>Journal des commandes</TerminalTitle>
            <TerminalActions><TerminalStatus><span className="size-1.5 rounded-full bg-emerald-400" aria-hidden />En direct</TerminalStatus><TerminalCopyButton aria-label="Copier les commandes" /></TerminalActions>
          </TerminalHeader>
          <TerminalContent className="max-h-[55dvh] text-xs sm:text-sm" />
        </Terminal>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted">{commands.length} commande{commands.length > 1 ? "s" : ""} · {running ? "Mise à jour automatique" : "Historique conservé"}</span>
          <Button size="sm" variant={follow ? "secondary" : "ghost"} aria-pressed={follow} onClick={() => setFollow(v => !v)}>Suivre le direct</Button>
        </div>
      </> : <p className="rounded-lg border border-dashed border-line p-8 text-center text-sm text-muted">
        {running ? "Aucune commande pour le moment. Elles apparaîtront ici dès leur lancement." : "Aucune commande enregistrée pour cette tâche."}
      </p>}
    </Dialog>
  </>;
}
