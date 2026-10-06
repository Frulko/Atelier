import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, GitBranch } from "lucide-react";
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools } from "@/components/ai-elements/prompt-input";
import { Badge } from "../../components/ui/Badge";
import { Card } from "../../components/ui/Card";
import { FormError } from "../../components/ui/Feedback";
import { api } from "../../lib/api";
import { useTaskEvents } from "../../lib/events";
import { fmtUsd } from "../../lib/format";
import { isActive, STATUS_LABEL, STATUS_TONE } from "../../lib/labels";
import { invalidateOrg, taskQuery } from "../../lib/queries";
import type { ConversationDetail } from "../../lib/types";
import { useOrg } from "../../lib/useOrg";
import { EventRow } from "../tasks/EventRow";

/**
 * Une tâche vue comme une conversation : chaque message de la personne ouvre un « tour » de l'agent, dont le journal
 * (étapes, outils, vérifications, résultat) s'affiche juste en dessous. Un message de suite relance l'agent sur la même
 * branche : la proposition ouverte se met à jour.
 */
export function TaskThread({ detail }: { detail: ConversationDetail }) {
  const { orgId, me, isAdmin } = useOrg();
  const { conversation: c, messages } = detail;
  const taskId = c.taskId!;
  const events = useTaskEvents(orgId, taskId);
  const q = useQuery(taskQuery(orgId, taskId));
  const t = q.data ?? detail.task;
  const live = !!t && isActive(t.status);
  const canFollowUp = !!t && (t.user_id === me?.user.id || isAdmin);

  const send = useMutation({
    mutationFn: (text: string) => api.post(`/api/orgs/${orgId}/conversations/${c.id}/messages`, { text }),
    onSuccess: () => { invalidateOrg(orgId, "conversation", c.id); invalidateOrg(orgId, "task", taskId); invalidateOrg(orgId, "conversations"); },
  });

  const users = messages.filter((m) => m.role === "user");
  const turnOf = (e: { turn?: number }) => e.turn ?? 1;
  const reason = !t ? "" : live ? "L'agent travaille : tu pourras demander un ajustement à la fin de ce tour."
    : t.status !== "done" ? "Cette tâche n'a pas de proposition à ajuster : lance une nouvelle tâche."
    : !canFollowUp ? "Seule la personne qui a lancé la tâche, ou un administrateur, peut demander un ajustement."
    : (t.turn ?? 1) >= 10 ? "Limite de 10 tours atteinte : lance une nouvelle tâche." : "";

  return (
    <div className="grid gap-4">
      {t && (
        <Card className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-sm">
          <Badge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge>
          {t.branch && <span className="flex items-center gap-1.5 font-mono text-[13px]"><GitBranch className="size-3.5 text-muted" aria-hidden />{t.branch}</span>}
          {t.mr_url && <a href={t.mr_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline">Demande de fusion <ExternalLink className="size-3.5" aria-hidden /></a>}
          <span className="text-muted">Coût déclaré : <span className="tnum text-ink">{t.cost ? fmtUsd(t.cost) : "—"}</span></span>
          {t.status === "done" && canFollowUp && c.projectId && (
            <Link to="/o/$orgId/projects/$projectId/editor" params={{ orgId, projectId: c.projectId }} search={{ task: taskId }} className="text-[13px] font-medium text-accent hover:underline">Ouvrir dans l'éditeur</Link>
          )}
          <Link to="/o/$orgId/tasks/$taskId" params={{ orgId, taskId }} className="ml-auto text-[13px] font-medium text-muted hover:text-ink">Détail de la tâche</Link>
        </Card>
      )}
      <Card className="p-4 sm:p-6">
        <ol className="mx-auto grid max-w-3xl gap-8" aria-live={live ? "polite" : "off"}>
          {users.map((m, i) => {
            const turn = i + 1;
            const mine = events.filter((e) => turnOf(e) === turn);
            return (
              <li key={m.id} className="grid gap-4" data-testid={`turn-${turn}`}>
                <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-secondary px-4 py-3 text-sm">{m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}</div>
                {turn > 1 && <p className="text-xs font-medium text-muted">Ajustement {turn - 1}</p>}
                {mine.length > 0 && <ol>{mine.map((e, k) => <EventRow key={e.id} e={e} last={k === mine.length - 1} />)}</ol>}
              </li>
            );
          })}
        </ol>
      </Card>
      <PromptInput className="mx-auto w-full max-w-3xl" onSubmit={(m) => { const text = m.text.trim(); if (text && !reason && !send.isPending) send.mutate(text); }}>
        <PromptInputBody>
          <PromptInputTextarea aria-label="Demander un ajustement" disabled={!!reason} maxLength={20000}
            placeholder={reason || "Demande un ajustement — l'agent reprend la même branche. Entrée pour envoyer."} />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools><span className="px-2 text-xs text-muted">{reason ? "" : "Un nouveau tour de l'agent, sur la même proposition."}</span></PromptInputTools>
          <PromptInputSubmit disabled={!!reason} status={send.isPending ? "submitted" : undefined} />
        </PromptInputFooter>
      </PromptInput>
      <FormError error={send.error} />
    </div>
  );
}
