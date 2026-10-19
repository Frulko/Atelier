import type { Task } from "../../lib/types";
export const COLUMNS = {todo:"À faire",doing:"En suivi",blocked:"Bloqué",review:"À valider",done:"Terminé"} as const;
export type Column = keyof typeof COLUMNS;
export function columnOf(task:Task):Column {
  if(task.waiting_question_id)return "blocked";
  if(task.board_column)return task.board_column;
  if(task.status==="queued")return "todo";
  if(task.status==="running")return "doing";
  if(task.status==="failed" || task.status==="cancelled")return "blocked";
  return task.status==="done"?"review":"done";
}
