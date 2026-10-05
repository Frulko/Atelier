import { addEvent, createTask, insertConversation, insertMessage, type ProjectRow } from "./db.ts";
import { enqueue, newId } from "./pipeline.ts";
import { titleFrom } from "./chat.ts";

/**
 * Lance une tâche ET sa conversation : toute tâche est une conversation (mode « task »), dont le premier message est la
 * demande. Un seul point d'entrée, pour que toutes les façons de créer une tâche (formulaire, conversation, relance,
 * promotion d'une discussion) aient le même résultat.
 */
export function startTask(o: { orgId: string; userId: string; project: ProjectRow; prompt: string; parentConversationId?: string | null; note?: string }) {
  const taskId = newId();
  createTask(taskId, o.orgId, o.userId, o.project.id, o.prompt);
  addEvent(taskId, "step", o.note ?? "Demande reçue, en file d'attente.");
  const conversationId = insertConversation({ org_id: o.orgId, user_id: o.userId, project_id: o.project.id, mode: "task", title: titleFrom(o.prompt), task_id: taskId, parent_id: o.parentConversationId ?? null });
  insertMessage(conversationId, "user", [{ type: "text", text: o.prompt }]);
  enqueue(taskId);
  return { taskId, conversationId };
}
