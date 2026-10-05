import { useChat } from "@ai-sdk/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { DefaultChatTransport, type UIMessage } from "ai";
import { Bot, BookIcon, ChevronDownIcon, Copy, ListChecks, Paperclip, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { Attachment, AttachmentInfo, AttachmentPreview, AttachmentRemove, Attachments } from "@/components/ai-elements/attachments";
import { Conversation as ChatScroll, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput, PromptInputActionAddAttachments, PromptInputActionMenu, PromptInputActionMenuContent, PromptInputActionMenuTrigger, PromptInputBody,
  PromptInputFooter, PromptInputHeader, PromptInputSubmit, PromptInputTextarea, PromptInputTools, usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { Sources, SourcesContent, SourcesTrigger } from "@/components/ai-elements/sources";
import { Button } from "../../components/ui/Button";
import { Card, PageHeader } from "../../components/ui/Card";
import { ErrorBox, errorText, FormError, Skeleton } from "../../components/ui/Feedback";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { conversationQuery, invalidateOrg } from "../../lib/queries";
import type { Conversation } from "../../lib/types";
import { useOrg } from "../../lib/useOrg";
import { TaskThread } from "./TaskThread";

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
        : <TaskThread detail={q.data} />}
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
/** Un fichier texte joint est stocké comme du texte (« Fichier joint « nom » : … ») : on n'en montre que le nom. */
const ATTACHED_TEXT = /^Fichier joint « (.+?) » :\n/;
const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.csv,.json,.yml,.yaml,.xml,.txt";
const FILE_ERRORS = { max_files: "4 fichiers au plus par message.", max_file_size: "Un fichier dépasse 4 Mo.", accept: "Type de fichier non accepté (images, PDF, texte)." };

function MessageBody({ message }: { message: UIMessage }) {
  const files = message.parts.filter((p) => p.type === "file");
  return (
    <>
      {files.length > 0 && (
        <Attachments variant="inline" className="ml-0">
          {files.map((f, i) => (
            <Attachment key={i} data={{ ...f, id: `${message.id}-${i}` }}><AttachmentPreview /><AttachmentInfo /></Attachment>
          ))}
        </Attachments>
      )}
      {message.parts.map((p, i) => {
        if (p.type !== "text") return null;
        const attached = message.role === "user" ? ATTACHED_TEXT.exec(p.text) : null;
        if (attached) return <span key={i} className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs"><Paperclip className="size-3.5" aria-hidden />{attached[1]}</span>;
        return message.role === "user" ? <p key={i} className="whitespace-pre-wrap">{p.text}</p> : <MessageResponse key={i}>{p.text}</MessageResponse>;
      })}
    </>
  );
}

/** Les fichiers choisis, avec leur aperçu et un bouton pour les retirer, au-dessus de la zone de saisie. */
function PickedFiles() {
  const picked = usePromptInputAttachments();
  if (!picked.files.length) return null;
  return (
    <Attachments variant="inline" className="ml-0 px-2 pt-2">
      {picked.files.map((f) => <Attachment key={f.id} data={f} onRemove={() => picked.remove(f.id)}><AttachmentPreview /><AttachmentInfo /><AttachmentRemove /></Attachment>)}
    </Attachments>
  );
}

const textOf = (m: UIMessage) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
const withoutFiles = (t: string) => t.replace(/Fichier joint « .+? » :\n(`{3,})\n[\s\S]*?\n\1\s*/g, "").trim();

function ChatWindow({ conversation, initial }: { conversation: Conversation; initial: UIMessage[] }) {
  const { orgId } = useOrg();
  const search = route.useSearch();
  const navigate = useNavigate();
  const toast = useToast();
  const transport = useMemo(() => new DefaultChatTransport({
    api: `/api/orgs/${orgId}/conversations/${conversation.id}/chat`, credentials: "same-origin",
    // le serveur garde l'historique : on n'envoie que le dernier message (sinon les pièces jointes repartiraient à chaque tour)
    prepareSendMessagesRequest: ({ id, messages, trigger }) => ({ body: { id, trigger, messages: messages.slice(-1) } }),
  }), [orgId, conversation.id]);
  const { messages, sendMessage, status, stop, regenerate, error } = useChat({
    id: conversation.id, messages: initial, transport,
    onFinish: () => { invalidateOrg(orgId, "conversations"); },
  });
  const busy = status === "submitted" || status === "streaming";

  const sent = useRef(false);
  useEffect(() => {
    if (search.first && !sent.current && messages.length === 0) {
      sent.current = true;
      sendMessage({ text: search.first });
      navigate({ to: ".", search: {}, replace: true });
    }
  }, [search.first]); // eslint-disable-line react-hooks/exhaustive-deps

  const last = messages.at(-1);
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const promote = useMutation({
    mutationFn: (prompt: string) => api.post<{ conversation: Conversation }>(`/api/orgs/${orgId}/conversations`, { mode: "task", projectId: conversation.projectId, text: prompt, parentId: conversation.id }),
    onSuccess: ({ conversation: c }) => { invalidateOrg(orgId, "conversations"); invalidateOrg(orgId, "tasks"); navigate({ to: "/o/$orgId/conversations/$conversationId", params: { orgId, conversationId: c.id }, search: {} }); },
    onError: (e) => toast(errorText(e)),
  });

  return (
    <Card className="flex h-[calc(100dvh-14rem)] min-h-[26rem] flex-col overflow-hidden">
      <ChatScroll className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {messages.length === 0 && <ConversationEmptyState icon={<Bot className="size-6" />} title="Pose ta question" description="L'assistant connaît les connaissances de l'organisation. Il ne peut pas modifier le code : pour cela, lance une tâche." />}
          {messages.map((m) => {
            const sources = (m.metadata as { sources?: { id: string; title: string }[] } | undefined)?.sources;
            return (
              <Message key={m.id} from={m.role}>
                <MessageContent><MessageBody message={m} /></MessageContent>
                {m.role === "assistant" && !!sources?.length && (
                  <Sources className="mb-0">
                    <SourcesTrigger count={sources.length}>
                      <p className="font-medium">Sources : {sources.length} connaissance{sources.length > 1 ? "s" : ""}</p><ChevronDownIcon className="size-4" />
                    </SourcesTrigger>
                    <SourcesContent>{sources.map((s) => <Link key={s.id} to="/o/$orgId/knowledge" params={{ orgId }} className="flex items-center gap-2 font-medium"><BookIcon className="size-4" />{s.title}</Link>)}</SourcesContent>
                  </Sources>
                )}
                {m === last && m.role === "assistant" && !busy && (
                  <MessageActions>
                    <MessageAction tooltip="Copier" label="Copier" onClick={() => navigator.clipboard?.writeText(textOf(m)).then(() => toast("Copié."))}><Copy className="size-3.5" /></MessageAction>
                    <MessageAction tooltip="Régénérer" label="Régénérer" onClick={() => regenerate()}><RotateCw className="size-3.5" /></MessageAction>
                    {conversation.projectId && lastUser && (
                      <MessageAction tooltip="Lancer comme tâche" label="Lancer comme tâche" disabled={promote.isPending} onClick={() => promote.mutate(withoutFiles(textOf(lastUser)) || textOf(lastUser))}><ListChecks className="size-3.5" /></MessageAction>
                    )}
                  </MessageActions>
                )}
              </Message>
            );
          })}
          {status === "submitted" && <p className="text-sm text-muted">L'assistant réfléchit…</p>}
          {error && <FormError error={new Error(chatError(error))} />}
        </ConversationContent>
        <ConversationScrollButton />
      </ChatScroll>
      <div className="border-t border-line p-3">
        <PromptInput className="mx-auto max-w-3xl" accept={ACCEPT} multiple maxFiles={4} maxFileSize={4_000_000} globalDrop onError={(e) => toast(FILE_ERRORS[e.code])}
          onSubmit={(m) => { if (busy || (!m.text.trim() && !m.files.length)) return; sendMessage({ text: m.text.trim(), files: m.files }); }}>
          <PromptInputHeader><PickedFiles /></PromptInputHeader>
          <PromptInputBody><PromptInputTextarea aria-label="Ton message" placeholder="Écris ton message — Entrée pour envoyer, Maj+Entrée pour un retour à la ligne" maxLength={20000} /></PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger aria-label="Joindre un fichier" />
                <PromptInputActionMenuContent><PromptInputActionAddAttachments label="Joindre des fichiers ou des images" /></PromptInputActionMenuContent>
              </PromptInputActionMenu>
            </PromptInputTools>
            <PromptInputSubmit status={status} onStop={() => stop()} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </Card>
  );
}
