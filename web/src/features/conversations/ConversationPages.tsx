import { useChat } from "@ai-sdk/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { DefaultChatTransport } from "ai";
import { Bot, Copy, ListChecks, MessageSquare, Plus, RotateCw, Send, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, PageHeader } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState, ErrorBox, errorText, FormError, Skeleton } from "../../components/ui/Feedback";
import { Field, Select, Textarea } from "../../components/ui/Field";
import { Markdown } from "../../components/ui/Markdown";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { relTime } from "../../lib/format";
import { conversationQuery, conversationsQuery, invalidateOrg, projectsQuery } from "../../lib/queries";
import type { Conversation } from "../../lib/types";
import { useOrg } from "../../lib/useOrg";
import { atLeast } from "../../lib/roles";

type Mode = "chat" | "task";
const MODES: { id: Mode; label: string; hint: string; icon: typeof Bot }[] = [
  { id: "chat", label: "Discuter", hint: "Poser une question, préparer une demande. L'assistant ne modifie rien.", icon: MessageSquare },
  { id: "task", label: "Tâche", hint: "L'agent modifie le code dans un bac à sable et prépare une proposition à relire.", icon: ListChecks },
];

function NewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { orgId, role } = useOrg();
  const navigate = useNavigate();
  const projects = useQuery(projectsQuery(orgId));
  const canTask = atLeast(role, "member");
  const [mode, setMode] = useState<Mode>("chat");
  const [project, setProject] = useState("");
  const [text, setText] = useState("");
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
  const [open, setOpen] = useState(false);
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
      <NewDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

const route = getRouteApi("/o/$orgId/conversations/$conversationId");

export function ConversationPage() {
  const { orgId } = useOrg();
  const { conversationId } = route.useParams();
  const q = useQuery(conversationQuery(orgId, conversationId));
  if (q.isPending) return <Skeleton className="h-80" />;
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />;
  const { conversation: c, messages, task } = q.data;
  return (
    <>
      <PageHeader title={c.title} subtitle={<>{c.mode === "chat" ? "Discussion privée avec l'assistant" : "Tâche"}{c.projectName ? ` · ${c.projectName}` : ""}</>}
        actions={c.mode === "chat" ? <DeleteButton id={c.id} /> : task ? <Link to="/o/$orgId/tasks/$taskId" params={{ orgId, taskId: task.id }}><Button>Voir la tâche</Button></Link> : undefined} />
      {c.mode === "chat"
        ? <ChatWindow key={c.id} conversation={c} initial={messages} />
        : <Card className="grid gap-3 p-4">{messages.map((m) => <div key={m.id} className="rounded-lg bg-line/40 p-3 text-sm">{m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}</div>)}</Card>}
    </>
  );
}

function DeleteButton({ id }: { id: string }) {
  const { orgId } = useOrg();
  const navigate = useNavigate();
  const del = useMutation({
    mutationFn: () => api.del(`/api/orgs/${orgId}/conversations/${id}`),
    onSuccess: () => { invalidateOrg(orgId, "conversations"); navigate({ to: "/o/$orgId/conversations", params: { orgId } }); },
  });
  return <Button variant="ghost" icon={<Trash2 className="size-4" />} loading={del.isPending} onClick={() => del.mutate()}>Supprimer</Button>;
}

/** Le serveur répond en JSON `{error}` avant le flux ; sinon le message du SDK est déjà lisible. */
const chatError = (e: Error) => { try { return (JSON.parse(e.message) as { error?: string }).error ?? e.message; } catch { return e.message; } };

function ChatWindow({ conversation, initial }: { conversation: Conversation; initial: import("ai").UIMessage[] }) {
  const { orgId } = useOrg();
  const search = route.useSearch();
  const navigate = useNavigate();
  const toast = useToast();
  const transport = useMemo(() => new DefaultChatTransport({ api: `/api/orgs/${orgId}/conversations/${conversation.id}/chat`, credentials: "same-origin" }), [orgId, conversation.id]);
  const { messages, sendMessage, status, stop, regenerate, error } = useChat({
    id: conversation.id, messages: initial, transport,
    onFinish: () => { invalidateOrg(orgId, "conversations"); },
  });
  const [text, setText] = useState("");
  const busy = status === "submitted" || status === "streaming";
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages, status]);

  const sent = useRef(false);
  useEffect(() => {
    if (search.first && !sent.current && messages.length === 0) {
      sent.current = true;
      sendMessage({ text: search.first });
      navigate({ to: ".", search: {}, replace: true });
    }
  }, [search.first]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => { const t = text.trim(); if (!t || busy) return; setText(""); sendMessage({ text: t }); };
  const last = messages.at(-1);
  const textOf = (m: (typeof messages)[number]) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  const promote = useMutation({
    mutationFn: (prompt: string) => api.post<{ conversation: Conversation }>(`/api/orgs/${orgId}/conversations`, { mode: "task", projectId: conversation.projectId, text: prompt, parentId: conversation.id }),
    onSuccess: ({ conversation: c }) => { invalidateOrg(orgId, "conversations"); invalidateOrg(orgId, "tasks"); navigate({ to: "/o/$orgId/conversations/$conversationId", params: { orgId, conversationId: c.id }, search: {} }); },
    onError: (e) => toast(errorText(e)),
  });
  const lastUser = [...messages].reverse().find((m) => m.role === "user");

  return (
    <Card className="flex h-[calc(100dvh-14rem)] min-h-[26rem] flex-col">
      <div className="flex-1 overflow-y-auto p-4" aria-live="polite">
        {messages.length === 0 && <EmptyState icon={<Bot className="size-6" />} title="Pose ta question" hint="L'assistant connaît les connaissances de l'organisation. Il ne peut pas modifier le code : pour cela, lance une tâche." />}
        <div className="mx-auto grid max-w-3xl gap-4">
          {messages.map((m) => {
            const sources = (m.metadata as { sources?: { id: string; title: string }[] } | undefined)?.sources;
            return m.role === "user" ? (
              <div key={m.id} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-primary-ink">{textOf(m)}</div>
            ) : (
              <div key={m.id} className="grid max-w-[95%] gap-2">
                <Markdown>{textOf(m) || "…"}</Markdown>
                {!!sources?.length && <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">Sources : {sources.map((s) => <Badge key={s.id}>{s.title}</Badge>)}</p>}
                {m === last && !busy && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => navigator.clipboard?.writeText(textOf(m)).then(() => toast("Copié."))}>Copier</Button>
                    <Button size="sm" variant="ghost" icon={<RotateCw className="size-3.5" />} onClick={() => regenerate()}>Régénérer</Button>
                    {conversation.projectId && lastUser && <Button size="sm" variant="ghost" icon={<ListChecks className="size-3.5" />} loading={promote.isPending} onClick={() => promote.mutate(textOf(lastUser))}>Lancer comme tâche</Button>}
                  </div>
                )}
              </div>
            );
          })}
          {status === "submitted" && <p className="text-sm text-muted">L'assistant réfléchit…</p>}
          {error && <FormError error={new Error(chatError(error))} />}
          <div ref={end} />
        </div>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex items-end gap-2 border-t border-line p-3">
        <Textarea aria-label="Ton message" value={text} onChange={(e) => setText(e.target.value)} rows={1} maxLength={20000} placeholder="Écris ton message — Entrée pour envoyer, Maj+Entrée pour un retour à la ligne"
          className="min-h-10 flex-1 resize-none" onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
        {busy ? <Button onClick={() => stop()} icon={<Square className="size-4" />}>Arrêter</Button> : <Button type="submit" variant="primary" disabled={!text.trim()} icon={<Send className="size-4" />}>Envoyer</Button>}
      </form>
    </Card>
  );
}
