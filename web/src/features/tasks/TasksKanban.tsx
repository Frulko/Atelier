import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { StatusPill } from "../../components/ui/Badge";
import { Select } from "../../components/ui/Field";
import { FormError } from "../../components/ui/Feedback";
import { api } from "../../lib/api";
import { invalidateOrg } from "../../lib/queries";
import { useOrg } from "../../lib/useOrg";
import type { Task } from "../../lib/types";
import { COLUMNS, columnOf, type Column } from "./kanban";

export function TasksKanban({tasks}:{tasks:Task[]}) {
  const {orgId,isAdmin,isMember,me}=useOrg();
  const [dragged,setDragged]=useState<string|null>(null);
  const move=useMutation({mutationFn:({id,column}:{id:string;column:Column|null})=>api.patch(`/api/orgs/${orgId}/tasks/${id}`,{boardColumn:column}),onSuccess:()=>invalidateOrg(orgId)});
  const editable=(task:Task)=>!move.isPending && !task.waiting_question_id && (isAdmin || (isMember && task.user_id===me?.user.id));
  return <div className="grid gap-3">
    <p className="text-xs text-muted">Les colonnes organisent ton suivi. Déplacer une carte ne lance ni n’arrête l’agent ; son état réel reste affiché. Les décisions en attente restent dans « Bloqué ». Jusqu’à 100 tâches par page, selon les filtres.</p>
    <FormError error={move.error}/>
    <div className="grid items-start gap-3 overflow-x-auto pb-3 md:grid-cols-[repeat(5,minmax(15rem,1fr))]" aria-label="Tableau Kanban">
      {(Object.entries(COLUMNS) as [Column,string][]).map(([column,label])=>{
        const cards=tasks.filter(t=>columnOf(t)===column);
        return <section key={column} aria-label={label} onDragOver={e=>{if(dragged)e.preventDefault();}} onDrop={e=>{
          e.preventDefault();const task=tasks.find(t=>t.id===dragged);setDragged(null);
          if(task && editable(task) && columnOf(task)!==column)move.mutate({id:task.id,column});
        }} className="min-h-36 rounded-lg border border-line bg-subtle p-3">
          <h2 className="mb-3 flex justify-between text-sm font-medium">{label}<span className="rounded bg-line px-2 text-xs tabular-nums">{cards.length}</span></h2>
          <ol className="grid gap-3">{cards.map(t=><li key={t.id} draggable={editable(t)} onDragStart={e=>{setDragged(t.id);e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("text/plain",t.id);}} onDragEnd={()=>setDragged(null)} className="grid gap-3 rounded-lg border border-line-strong bg-raised p-3 shadow-xs">
            <div className="flex flex-wrap items-center gap-2"><StatusPill status={t.status}/>{t.waiting_question_id && <span className="text-xs text-warn">Décision requise</span>}</div>
            <Link to="/o/$orgId/tasks/$taskId" params={{orgId,taskId:t.id}} className="line-clamp-3 break-words text-sm font-medium hover:text-accent">{t.prompt}</Link>
            <p className="truncate text-xs text-muted">{t.project_name??"Projet supprimé"}</p>
            {t.flagged>0 && <p className="text-xs text-warn">Relecture obligatoire</p>}
            {editable(t) && <Select aria-label={`Déplacer : ${t.prompt}`} value={t.board_column??"auto"} onChange={e=>move.mutate({id:t.id,column:e.target.value==="auto"?null:e.target.value as Column})}>
              <option value="auto">Suivi automatique</option>{Object.entries(COLUMNS).map(([value,name])=><option key={value} value={value}>{name}</option>)}
            </Select>}
          </li>)}</ol>
          {!cards.length && <p className="py-5 text-center text-xs text-muted">Aucune tâche</p>}
        </section>;
      })}
    </div>
  </div>;
}
