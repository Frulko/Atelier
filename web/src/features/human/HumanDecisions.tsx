import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Field, Input, Select, Textarea } from "../../components/ui/Field";
import { FormError } from "../../components/ui/Feedback";
import { api } from "../../lib/api";
import { invalidateOrg } from "../../lib/queries";
import { useOrg } from "../../lib/useOrg";
import { fmtDate } from "../../lib/format";

type Channel = { provider:"telegram"|"discord"; destination:string; allowedUsers:string[]; shareContent:boolean; lastError:string|null };
type Question = {id:string;task_id:string;question:string;options_json:string;kind:"technical"|"budget";state:string;answer:string|null;expires_at:number};
export function HumanQuestions({taskId}:{taskId?:string}) {
  const {orgId,isAdmin}=useOrg();
  const q=useQuery({queryKey:["org",orgId,"questions",taskId??"pending"],queryFn:()=>api.get<Question[]>(`/api/orgs/${orgId}/questions${taskId?`?task=${taskId}`:""}`),refetchInterval:5000});
  const answer=useMutation({mutationFn:({id,choice}:{id:string;choice:string})=>api.post(`/api/orgs/${orgId}/questions/${id}/answer`,{answer:choice}),onSuccess:()=>invalidateOrg(orgId)});
  const questions=q.data?.filter(x=>x.state==="pending" || (x.state==="answered" && x.kind==="budget" && x.answer==="2" && x.expires_at>Date.now()))??[];
  if(!questions.length)return <FormError error={q.error}/>;
  return <div className="grid gap-3">{questions.map(x=><Card key={x.id} className="grid gap-3 border-warn/30 bg-warn-soft/20 p-5">
    <div><p className="label text-warn">{x.kind==="budget"?"Rallonge journalière":"Décision du technicien"}</p><h3 className="mt-2 font-display text-xl">{x.question}</h3></div>
    <p className="text-xs text-muted">{x.kind==="budget"?"Sans accord, reprise possible au prochain jour. Le plafond mensuel reste applicable.":"L'agent est suspendu et son travail sauvegardé."} Échéance : {fmtDate(x.expires_at)}.</p>
    {!taskId && <Link to="/o/$orgId/tasks/$taskId" params={{orgId,taskId:x.task_id}} className="text-sm text-accent hover:underline">Voir la tâche</Link>}
    {x.state==="pending" ? <div className="flex flex-wrap gap-2">{(JSON.parse(x.options_json) as string[]).map((label,i)=><Button key={i} disabled={!isAdmin || answer.isPending} onClick={()=>answer.mutate({id:x.id,choice:String(i+1)})}>{i+1}. {label}</Button>)}</div>:<p className="text-sm text-muted">Le technicien a demandé d'attendre demain.</p>}
    {!isAdmin && <p className="text-xs text-muted">Un administrateur ou un technicien autorisé sur le bot peut répondre.</p>}
    <FormError error={answer.error}/>
  </Card>)}</div>;
}

export function HumanSettings() {
  const {orgId}=useOrg();
  const q=useQuery({queryKey:["org",orgId,"human-channels"],queryFn:()=>api.get<Channel[]>(`/api/orgs/${orgId}/human-channels`),refetchInterval:15000});
  const [provider,setProvider]=useState<"telegram"|"discord">("telegram"),[destination,setDestination]=useState<string|null>(null),[users,setUsers]=useState<string|null>(null),[shared,setShared]=useState<boolean|null>(null),[token,setToken]=useState("");
  const current=q.data?.find(c=>c.provider===provider);
  const save=useMutation({mutationFn:()=>api.put(`/api/orgs/${orgId}/human-channels`,{provider,destination:destination??current?.destination??"",allowedUsers:(users??current?.allowedUsers.join(" ")??"").split(/[\s,]+/).filter(Boolean),shareContent:shared??current?.shareContent??false,...(token?{token}:{})}),onSuccess:()=>{setToken("");invalidateOrg(orgId,"human-channels");}});
  const remove=useMutation({mutationFn:()=>api.del(`/api/orgs/${orgId}/human-channels/${provider}`),onSuccess:()=>{setToken("");setDestination(null);setUsers(null);setShared(null);invalidateOrg(orgId,"human-channels");}});
  return <div className="grid gap-5"><HumanQuestions/><Card className="grid gap-4 p-6">
    <p className="text-sm text-muted">Les deux bots peuvent fonctionner ensemble. Seuls les identifiants de techniciens autorisés peuvent répondre. Une réponse peut relancer du code et accorder 1 $ supplémentaire au projet pour la journée.</p>
    <form className="grid gap-4" onSubmit={e=>{e.preventDefault();save.mutate();}}>
      <Field label="Canal du technicien">{id=><Select id={id} value={provider} onChange={e=>{setProvider(e.target.value as "telegram"|"discord");setDestination(null);setUsers(null);setShared(null);setToken("");}}><option value="telegram">Telegram</option><option value="discord">Discord</option></Select>}</Field>
      <div className="grid gap-4 sm:grid-cols-2"><Field label={provider==="telegram"?"Identifiant du chat Telegram":"Identifiant du salon Discord"}>{id=><Input id={id} required value={destination??current?.destination??""} onChange={e=>setDestination(e.target.value)} className="font-mono"/>}</Field><Field label="Jeton du bot" hint={current?"Configuré. Laisse vide pour conserver le jeton.":"Le jeton est chiffré et ne sera jamais réaffiché."}>{id=><Input id={id} type="password" autoComplete="new-password" required={!current} value={token} onChange={e=>setToken(e.target.value)}/>}</Field></div>
      <Field label="Identifiants des techniciens autorisés" hint="Identifiants numériques des utilisateurs, séparés par des espaces ou des virgules.">{id=><Textarea id={id} required rows={2} value={users??current?.allowedUsers.join(" ")??""} onChange={e=>setUsers(e.target.value)}/>}</Field>
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={shared??current?.shareContent??false} onChange={e=>setShared(e.target.checked)}/><span>Transmettre la question et ses choix au service de messagerie.<span className="mt-1 block text-xs text-muted">Désactivé : seul un message générique et un lien vers Atelier sont envoyés. Aucun code ou journal n'est joint.</span></span></label>
      <p className="text-xs text-muted">{provider==="telegram"?"Utilise un bot dédié à Atelier, ajouté au chat, sans webhook existant. Réponds directement au message du bot par le numéro du choix.":"Utilise un salon privé dédié et un bot autorisé à lire et envoyer des messages. Active Message Content Intent. Réponds directement au message du bot par le numéro du choix."}</p>
      {current?.lastError && <p role="alert" className="text-sm text-warn">{current.lastError}</p>}
      <FormError error={save.error??remove.error??q.error}/>
      <div className="flex gap-2"><Button variant="primary" type="submit" loading={save.isPending}>Enregistrer le canal</Button>{current&&<Button onClick={()=>remove.mutate()} loading={remove.isPending}>Désactiver ce canal</Button>}</div>
    </form>
    <p className="text-xs text-muted">Aucune question n'est envoyée avant configuration. Sans bot disponible, les décisions restent accessibles dans Atelier.</p>
  </Card></div>;
}
