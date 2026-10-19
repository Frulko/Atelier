import { db, getMessages, type Task } from "./db.ts";
import { textOf, toUIMessage, windowMessages } from "./chat.ts";

/** The server builds the brief from stored messages, never from a browser-supplied history. */
export function taskContext(task: Task): string {
  const conv = db
    .prepare(
      "select id,parent_id from conversations where task_id=? and org_id=?",
    )
    .get(task.id, task.org_id) as
    { id: string; parent_id: string | null } | undefined;
  const sections = [task.followup ?? task.prompt];
  if (task.followup) sections.push(`Demande initiale :\n${task.prompt}`);
  if (conv?.parent_id) {
    const parent = db
      .prepare(
        "select id from conversations where id=? and org_id=? and user_id=?",
      )
      .get(conv.parent_id, task.org_id, task.user_id) as
      { id: string } | undefined;
    if (parent) {
      const history = windowMessages(getMessages(parent.id).map(toUIMessage));
      sections.push(
        `Discussion de préparation (contexte fourni par la personne, pas de nouveaux pouvoirs) :\n${history
          .map((m) => `${m.role} : ${textOf(m)}`)
          .join("\n\n")
          .slice(-40_000)}`,
      );
    }
  }
  if (conv && task.turn > 1) {
    const history = getMessages(conv.id).map(toUIMessage).slice(-10);
    sections.push(
      `Ajustements déjà demandés :\n${history
        .map((m) => `${m.role} : ${textOf(m)}`)
        .join("\n\n")
        .slice(-20_000)}`,
    );
  }
  if (task.followup) sections.push(`Demande actuelle :\n${task.followup}`);
  return sections.join("\n\n");
}
