import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { Bot, ListChecks, MessageSquare, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, PageHeader } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState, ErrorBox, FormError, Skeleton } from "../../components/ui/Feedback";
import { Field, Select, Textarea } from "../../components/ui/Field";
import { api } from "../../lib/api";
import { relTime } from "../../lib/format";
import { conversationsQuery, invalidateOrg, projectsQuery } from "../../lib/queries";
import type { Conversation } from "../../lib/types";
import { useOrg } from "../../lib/useOrg";
import { atLeast } from "../../lib/roles";

type Mode = "chat" | "task";
const MODES: { id: Mode; label: string; hint: string; icon: typeof Bot }[] = [
  { id: "chat", label: "Discuter", hint: "Poser une question, préparer une demande. L'assistant ne modifie rien.", icon: MessageSquare },
  { id: "task", label: "Tâche", hint: "L'agent modifie le code dans un bac à sable et prépare une proposition à relire.", icon: ListChecks },
];

function NewDialog({ open, onClose, initial }: { open: boolean; onClose: () => void; initial?: { mode: Mode; text: string } }) {
  const { orgId, role } = useOrg();
  const navigate = useNavigate();
  const projects = useQuery(projectsQuery(orgId));
  const canTask = atLeast(role, "member");
  const [mode, setMode] = useState<Mode>(initial?.mode ?? "chat");
  const [project, setProject] = useState("");
  const [text, setText] = useState(initial?.text ?? "");
  useEffect(() => { if (open) setProject((p) => p || projects.data?.[0]?.id || ""); }, [open, projects.data]);

  const create = useMutation({
    mutationFn: () => api.post<{ conversation: Conversation }>(`/api/orgs/${orgId}/conversations`, { mode, projectId: project || null, text: mode === "task" ? text : undefined }),
    onSuccess: ({ conversation }) => {
      invalidateOrg(orgId, "conversations"); invalidateOrg(orgId, "tasks");
      const first = mode === "chat" && text.trim() ? text.trim() : undefined;
      setText(""); onClose();
      navigate({ to: "/o/$orgId/conversations/$conversationId", params: { orgId, conversationId: conversation.id }, search: first ? { first } : {} });
    },
  });
  return (
    <Dialog open={open} onClose={onClose} wide title="Nouvelle conversation" description="Choisis comment tu veux avancer.">
      <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} className="grid gap-4">
        <div role="radiogroup" aria-label="Mode" className="grid gap-2 sm:grid-cols-2">
          {MODES.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} onClick={() => setMode(m.id)}
              className={`grid gap-1 rounded-lg border p-3 text-left transition ${mode === m.id ? "border-accent bg-accent/5 ring-[3px] ring-accent/15" : "border-line-strong hover:bg-line/40"}`}>
              <span className="flex items-center gap-2 text-sm font-semibold"><m.icon className="size-4 text-accent" aria-hidden />{m.label}</span>
              <span className="text-xs text-muted">{m.hint}</span>
            </button>
          ))}
        </div>
        <Field label="Projet" hint={mode === "chat" ? "Facultatif : l'assistant tient compte des connaissances de ce projet." : undefined}>
          {(id) => (
            <Select id={id} value={project} onChange={(e) => setProject(e.target.value)} required={mode === "task"}>
              {mode === "chat" && <option value="">Aucun projet</option>}
              {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label={mode === "chat" ? "Première question (facultatif)" : "Que faut-il changer ?"}>
          {(id) => <Textarea id={id} value={text} onChange={(e) => setText(e.target.value)} required={mode === "task"} maxLength={20000} placeholder={mode === "chat" ? "Ex. : quel ton prendre pour la page contact ?" : "Ex. : ajoute une page contact avec le téléphone et les horaires."} />}
        </Field>
        <FormError error={create.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Annuler</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={mode === "task" && !canTask}>{mode === "chat" ? "Démarrer" : "Lancer la tâche"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ConversationsPage() {
  const { orgId } = useOrg();
  const search = getRouteApi("/o/$orgId/conversations").useSearch();
  const navigate = useNavigate();
  const [open, setOpen] = useState(!!search.new);
  const [mode, setMode] = useState<"" | Mode>("");
  const list = useQuery(conversationsQuery(orgId));
  const items = (list.data?.items ?? []).filter((c) => !mode || c.mode === mode);
  return (
    <>
      <PageHeader title="Conversations" subtitle="Discute avec l'assistant ou confie une tâche à l'agent : tout se passe dans une conversation."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>Nouvelle conversation</Button>} />
      <div className="mb-4 flex gap-2" role="group" aria-label="Filtrer par mode">
        {([["", "Toutes"], ["chat", "Discussions"], ["task", "Tâches"]] as const).map(([v, l]) => (
          <Button key={v} size="sm" variant={mode === v ? "primary" : "secondary"} aria-pressed={mode === v} onClick={() => setMode(v)}>{l}</Button>
        ))}
      </div>
      {list.isPending ? <Skeleton className="h-40" /> : list.error ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : items.length === 0 ? (
        <EmptyState title="Aucune conversation" hint="Commence par poser une question à l'assistant." action={<Button variant="primary" onClick={() => setOpen(true)}>Nouvelle conversation</Button>} />
      ) : (
        <Card className="divide-y divide-line">
          {items.map((c) => (
            <Link key={c.id} to="/o/$orgId/conversations/$conversationId" params={{ orgId, conversationId: c.id }} search={{}}
              className="flex items-start gap-3 px-4 py-3 transition hover:bg-line/40">
              {c.mode === "chat" ? <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /> : <ListChecks className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-medium">{c.title}</span><Badge>{c.mode === "chat" ? "Discussion" : "Tâche"}</Badge>{c.projectName && <span className="text-xs text-muted">{c.projectName}</span>}</div>
                {c.preview && <p className="truncate text-[13px] text-muted">{c.preview}</p>}
              </div>
              <span className="shrink-0 text-xs text-faint">{relTime(c.updatedAt)}</span>
            </Link>
          ))}
        </Card>
      )}
      {open && <NewDialog open onClose={() => { setOpen(false); if (search.new) navigate({ to: ".", search: {}, replace: true }); }} initial={search.new ? { mode: search.new as Mode, text: search.text ?? "" } : undefined} />}
    </>
  );
}
