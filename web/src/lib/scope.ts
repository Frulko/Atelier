import { useParams } from "@tanstack/react-router";
import { useOrg } from "./useOrg";

export type Target = { to: string; params: Record<string, string>; search: Record<string, string> };

/**
 * Où ouvrir une conversation ou une tâche ? Depuis l'espace d'un projet, DANS ce projet (son menu, son fil d'Ariane, son contexte) ;
 * ailleurs, sur les pages de l'organisation. Les cibles se passent telles quelles à <Link> et à navigate().
 */
export function useScope() {
  const { orgId } = useOrg();
  const { projectId } = useParams({ strict: false }) as { projectId?: string };
  const t = (inProject: string, plain: string, extra: Record<string, string>, search: Record<string, string> = {}): Target =>
    projectId ? { to: `/o/$orgId/projects/$projectId/${inProject}`, params: { orgId, projectId, ...extra }, search } : { to: `/o/$orgId/${plain}`, params: { orgId, ...extra }, search };
  return {
    projectId,
    conversation: (conversationId: string, search: Record<string, string> = {}) => t("conversations/$conversationId", "conversations/$conversationId", { conversationId }, search),
    conversations: () => t("conversations", "conversations", {}),
    task: (taskId: string) => t("tasks/$taskId", "tasks/$taskId", { taskId }),
  };
}
