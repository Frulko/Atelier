import { tool } from "ai";
import { z } from "zod";
import { db, getConversationFor, getConversationByTask, getProjectInOrg, getTaskInOrg, roleOf, type ConversationRow } from "./db.ts";
import { can } from "./access.ts";
import { startTask, followUp, MAX_TURNS } from "./start.ts";
import { assertBudget } from "./budget.ts";
import { assertNoSecretText } from "./security.ts";
import { audit } from "./audit.ts";

db.exec(`create table if not exists chat_task_launches (
  message_id text primary key references messages(id) on delete cascade,
  task_id text not null references tasks(id) on delete cascade
);`);

/** Tools are bound to the stored conversation, never to a model-supplied organization or project. */
export function chatActions(conv:ConversationRow,messageId:string,signal:AbortSignal) {
  const authorize=()=>{
    const current=getConversationFor(conv.id,conv.org_id,conv.user_id);
    if(signal.aborted || !current?.actions_enabled || current.mode!=="chat" || !current.project_id || current.project_id!==conv.project_id || !can(roleOf(conv.org_id,conv.user_id)??"viewer","task:create"))throw new Error("Actions désactivées ou droits retirés.");
    const project=getProjectInOrg(current.project_id,conv.org_id);
    if(!project)throw new Error("Projet introuvable.");
    return project;
  };
  const details=(id:string)=>{
    const project=authorize(),task=getTaskInOrg(id,conv.org_id);
    if(!task || task.project!==project.id)throw new Error("Tâche introuvable dans ce projet.");
    return {taskId:task.id,conversationId:getConversationByTask(task.id)?.id??null,prompt:task.prompt,status:task.status,waitingForTechnician:!!task.waiting_question_id};
  };
  const prior=()=> (db.prepare("select task_id from chat_task_launches where message_id=?").get(messageId) as {task_id:string}|undefined)?.task_id;
  const prompt=z.string().trim().min(1).max(20000);
  return {
    start_task:tool({description:"Lancer une tâche de l’agent pour lire, analyser ou modifier le projet. Seulement si la personne demande une action, une tâche au plus par message. Elle continue en arrière-plan. Son contexte de discussion est transmis à l’agent.",inputSchema:z.object({prompt}),execute:async({prompt})=>{
      authorize();
      const previous=prior();if(previous)return details(previous);
      await assertNoSecretText(prompt,conv.org_id);
      const project=authorize();
      const concurrent=prior();if(concurrent)return details(concurrent);
      assertBudget(conv.org_id);
      const {taskId}=startTask({orgId:conv.org_id,userId:conv.user_id,project,prompt,parentConversationId:conv.id});
      db.prepare("insert into chat_task_launches values (?,?)").run(messageId,taskId);
      audit({orgId:conv.org_id,userId:conv.user_id},"task.create",{type:"task",id:taskId},{from:"chat",conversationId:conv.id});
      return details(taskId);
    }}),
    follow_up_task:tool({description:"Demander un ajustement d’une tâche terminée du même projet, sur sa branche existante. Une action au plus par message.",inputSchema:z.object({taskId:z.string().regex(/^[a-f0-9]{8}$/),prompt}),execute:async({taskId,prompt})=>{
      authorize();const previous=prior();if(previous)return details(previous);
      await assertNoSecretText(prompt,conv.org_id);
      const project=authorize(),concurrent=prior();if(concurrent)return details(concurrent);
      const task=getTaskInOrg(taskId,conv.org_id),thread=task?getConversationByTask(task.id):undefined;
      if(!task || task.project!==project.id || !thread || (task.user_id!==conv.user_id && !can(roleOf(conv.org_id,conv.user_id)??"viewer","task:cancel_any")))throw new Error("Ajustement non autorisé.");
      if(task.status!=="done" || task.turn>=MAX_TURNS)throw new Error("Attends une tâche terminée avec des tours disponibles.");
      assertBudget(conv.org_id);followUp(task.id,thread.id,prompt);
      db.prepare("insert into chat_task_launches values (?,?)").run(messageId,task.id);
      audit({orgId:conv.org_id,userId:conv.user_id},"task.followup",{type:"task",id:task.id},{from:"chat",conversationId:conv.id});
      return details(task.id);
    }}),
    task_status:tool({description:"Lire le statut réel d’une tâche de ce projet, sans inventer son avancement.",inputSchema:z.object({taskId:z.string().regex(/^[a-f0-9]{8}$/)}),execute:async({taskId})=>details(taskId)}),
  };
}
