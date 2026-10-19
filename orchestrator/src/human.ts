import { randomBytes, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { db, getTask, getTaskInOrg, getProjectInOrg, roleOf, updateTask, addEvent, type User, type Task } from "./db.ts";
import { can } from "./access.ts";
import { body, HttpError, json } from "./http.ts";
import { encrypt, decrypt } from "./vault.ts";
import { assertNoSecretText } from "./security.ts";
import { audit } from "./audit.ts";
import { notify } from "./notifications.ts";
import { enqueue } from "./pipeline.ts";
import { projectBudget, availableBudget, dayBounds } from "./budget.ts";

export type Channel = { id:string; org_id:string; provider:"telegram"|"discord"; destination:string; allowed_users:string; share_content:number; ciphertext:Buffer; cursor:string|null; owner_id:string; last_error:string|null };
export type Question = { id:string; org_id:string; task_id:string; turn:number; kind:"technical"|"budget"; question:string; options_json:string; state:"pending"|"answered"|"expired"|"cancelled"; answer:string|null; created_at:number; expires_at:number; answered_at:number|null; answered_by:string|null };
db.exec(`
 create table if not exists human_channels (
  id text primary key, org_id text not null references orgs(id) on delete cascade, provider text not null,
  destination text not null, allowed_users text not null, share_content integer not null, ciphertext blob not null,
  token_hash text not null, cursor text, owner_id text not null, last_error text, unique(org_id,provider), unique(provider,destination)
 );
 create unique index if not exists telegram_bot_owner on human_channels(token_hash) where provider='telegram';
 create table if not exists human_questions (
  id text primary key, org_id text not null references orgs(id) on delete cascade, task_id text not null references tasks(id) on delete cascade,
  turn integer not null, kind text not null, question text not null, options_json text not null, state text not null,
  answer text, created_at integer not null, expires_at integer not null, answered_at integer, answered_by text
 );
 create index if not exists human_task on human_questions(task_id,turn,state);
 create table if not exists human_deliveries (
  question_id text not null references human_questions(id) on delete cascade,
  channel_id text not null references human_channels(id) on delete cascade,
  message_id text, attempts integer not null default 0, next_attempt integer not null default 0,
  primary key(question_id,channel_id)
 );
`);
export const getQuestion = (id:string) => db.prepare("select * from human_questions where id=?").get(id) as Question|undefined;
export const questionsFor = (org:string,task:string) => db.prepare("select * from human_questions where org_id=? and task_id=? order by created_at,id").all(org,task) as Question[];
export const channelJson = (org:string) => (db.prepare("select provider,destination,allowed_users,share_content,last_error from human_channels where org_id=?").all(org) as {provider:string;destination:string;allowed_users:string;share_content:number;last_error:string|null}[]).map(c=>({provider:c.provider,destination:c.destination,allowedUsers:JSON.parse(c.allowed_users),shareContent:!!c.share_content,lastError:c.last_error}));
export function saveChannel(org:string,user:string,b:any) {
  if(!["telegram","discord"].includes(b.provider) || typeof b.destination!=="string" || !/^-?\d{1,22}$/.test(b.destination))throw new HttpError(400,"Canal invalide.");
  if(!Array.isArray(b.allowedUsers) || !b.allowedUsers.length || b.allowedUsers.length>20 || !b.allowedUsers.every((id:unknown)=>typeof id==="string" && /^\d{1,22}$/.test(id)))throw new HttpError(400,"Indique les identifiants des techniciens autorisés.");
  if(typeof b.shareContent!=="boolean")throw new HttpError(400,"Choisis si le contenu peut être partagé.");
  const previous=db.prepare("select * from human_channels where org_id=? and provider=?").get(org,b.provider) as Channel|undefined;
  const token=b.token===undefined && previous ? decrypt(previous.ciphertext,org,`human:${previous.id}`) : b.token;
  if(typeof token!=="string" || token.length<20 || token.length>300 || /[\s\x00-\x1f]/.test(token) || (b.provider==="telegram" && !/^\d+:[\w-]+$/.test(token)))throw new HttpError(400,"Jeton de bot invalide.");
  const id=randomBytes(8).toString("hex");
  db.exec("savepoint human_channel");
  try {
    db.prepare("delete from human_channels where org_id=? and provider=?").run(org,b.provider);
    db.prepare("insert into human_channels (id,org_id,provider,destination,allowed_users,share_content,ciphertext,token_hash,owner_id) values (?,?,?,?,?,?,?,?,?)").run(id,org,b.provider,b.destination,JSON.stringify([...new Set(b.allowedUsers)]),Number(b.shareContent),encrypt(token,org,`human:${id}`),createHash("sha256").update(token).digest("hex"),user);
    db.exec("release human_channel");
  }catch{db.exec("rollback to human_channel; release human_channel");throw new HttpError(409,"Ce bot Telegram ou ce canal est déjà affecté à une organisation.");}
  audit({orgId:org,userId:user},"human.channel_set",{type:"channel",id},{provider:b.provider});
}
function persistQuestion(task:Task,question:string,options:string[],kind:Question["kind"],expiresAt:number) {
  const existing=questionsFor(task.org_id!,task.id).find(q=>q.state==="pending" && q.turn===task.turn);
  if(existing)return existing;
  const count=questionsFor(task.org_id!,task.id).filter(q=>q.turn===task.turn).length;
  if(count>=8)throw new HttpError(409,"Limite de huit demandes humaines par tour atteinte.");
  const id=randomBytes(8).toString("hex");
  db.prepare("insert into human_questions (id,org_id,task_id,turn,kind,question,options_json,state,created_at,expires_at) values (?,?,?,?,?,?,?,'pending',?,?)").run(id,task.org_id!,task.id,task.turn,kind,question,JSON.stringify(options),Date.now(),expiresAt);
  addEvent(task.id,"step","Une décision du technicien est nécessaire.");
  if(task.user_id)notify(task.user_id,task.org_id!,"Décision humaine requise","Une tâche attend un technicien.",`/o/${task.org_id}/tasks/${task.id}`,`human:${id}`);
  audit({orgId:task.org_id!,userId:task.user_id},"human.question",{type:"question",id},{kind,taskId:task.id});
  return getQuestion(id)!;
}
export async function askHuman(task:Task,b:any) {
  if(task.status!=="running" || !task.user_id || !can(roleOf(task.org_id!,task.user_id)??"viewer","task:create"))throw new HttpError(403,"Cette tâche ne peut pas demander de décision.");
  if(typeof b.question!=="string" || !b.question.trim() || b.question.length>1000 || !Array.isArray(b.options) || b.options.length<2 || b.options.length>4 || !b.options.every((v:unknown)=>typeof v==="string" && v.trim() && v.length<=120) || new Set(b.options).size!==b.options.length)throw new HttpError(400,"Une question et deux à quatre choix sont requis.");
  await assertNoSecretText([b.question,...b.options].join("\n"),task.org_id!).catch(()=>{throw new HttpError(422,"Un secret potentiel est présent dans la question.");});
  const current=getTask(task.id)!;
  if(current.status!=="running" || !current.user_id || !can(roleOf(current.org_id!,current.user_id)??"viewer","task:create"))throw new HttpError(409,"La tâche n'est plus en cours.");
  return persistQuestion(current,b.question.trim(),b.options.map((v:string)=>v.trim()),"technical",Date.now()+24*3600_000);
}
export function askBudget(task:Task) {
  const budget=projectBudget(task.org_id!,task.project);
  return persistQuestion(task,"Le budget journalier du projet est atteint. Accorder une rallonge de 1 USD pour aujourd'hui ?",["Ajouter 1 USD aujourd'hui","Attendre demain"],"budget",budget.resetsAt);
}
export async function answerHuman(q:Question,answer:string,actor:{userId?:string;external?:string}) {
  const current=getQuestion(q.id)!;
  if(current.state!=="pending" || current.expires_at<=Date.now())throw new HttpError(409,"Cette question n'attend plus de réponse.");
  if(typeof answer!=="string" || !/^[1-4]$/.test(answer) || Number(answer)>JSON.parse(q.options_json).length)throw new HttpError(400,"Réponds avec le numéro d'un choix.");
  const task=getTask(q.task_id),role=task?.user_id?roleOf(q.org_id,task.user_id):undefined;
  if(!task || !["running","queued"].includes(task.status) || !role || !can(role,"task:create"))throw new HttpError(409,"La tâche n'est plus autorisée à reprendre.");
  if(actor.userId && !can(roleOf(q.org_id,actor.userId)??"viewer","project:manage"))throw new HttpError(403,"Droits de technicien requis.");
  db.exec("savepoint human_answer");
  try {
    if(q.kind==="budget" && answer==="1") {
      const p=getProjectInOrg(task.project,q.org_id)!;
      const {start}=dayBounds(p.budget_timezone||"Europe/Paris");
      db.prepare("insert into budget_extensions values (?,?,?,?,?,?,?)").run(randomBytes(8).toString("hex"),q.org_id,task.project,start,1,q.id,Date.now());
    }
    db.prepare("update human_questions set state='answered',answer=?,answered_at=?,answered_by=? where id=? and state='pending'").run(answer,Date.now(),actor.userId??actor.external??"technician",q.id);
    db.exec("release human_answer");
  }catch(e){db.exec("rollback to human_answer; release human_answer");throw e;}
  audit({orgId:q.org_id,userId:actor.userId??null},"human.answer",{type:"question",id:q.id},{taskId:q.task_id,choice:Number(answer),...(actor.external?{technician:actor.external}:{})});
  addEvent(q.task_id,"step",q.kind==="budget" && answer==="2"?"Le technicien demande d'attendre le prochain jour.":"Décision du technicien reçue.");
  if(task.waiting_question_id===q.id && !(q.kind==="budget" && answer==="2")) {
    updateTask(task.id,{waiting_question_id:null});
    enqueue(task.id);
  }
}
export function humanContext(task:Task) {
  return questionsFor(task.org_id!,task.id).filter(q=>q.kind==="technical" && q.state==="answered").map(q=>`Décision humaine (tour ${q.turn}) : ${q.question}\nChoix retenu : ${(JSON.parse(q.options_json) as string[])[Number(q.answer)-1]}`).join("\n\n");
}
export async function humanApi(req:IncomingMessage,res:ServerResponse,url:URL,user:User) {
  const m=/^\/api\/orgs\/([0-9a-f]{16})\/(human-channels|questions|projects)(?:\/([0-9a-f]{8,16}|telegram|discord))?(?:\/(answer|budget))?$/.exec(url.pathname);
  if(!m || (m[2]==="projects" && m[4]!=="budget"))return false;
  const [,org,kind,id,sub]=m,role=roleOf(org!,user.id);
  if(!role)throw new HttpError(404,"Introuvable.");
  const admin=can(role,"project:manage");
  if(kind==="projects") {
    if(req.method!=="GET")throw new HttpError(405,"Méthode refusée.");
    json(res,200,projectBudget(org!,id!));return true;
  }
  if(kind==="human-channels") {
    if(!admin)throw new HttpError(403,"Droits de technicien requis.");
    if(req.method==="GET")json(res,200,channelJson(org!));
    else if(req.method==="PUT" && !id){saveChannel(org!,user.id,await body(req,8000));json(res,200,channelJson(org!));}
    else if(req.method==="DELETE" && ["telegram","discord"].includes(id!)){db.prepare("delete from human_channels where org_id=? and provider=?").run(org!,id!);audit({orgId:org!,userId:user.id},"human.channel_delete",{type:"channel",id:id!});json(res,200,{ok:true});}
    else throw new HttpError(405,"Méthode refusée.");
    return true;
  }
  if(req.method==="GET" && !id) {
    const taskId=url.searchParams.get("task");
    if(taskId){if(!getTaskInOrg(taskId,org!))throw new HttpError(404,"Tâche introuvable.");json(res,200,questionsFor(org!,taskId));}
    else {if(!admin)throw new HttpError(403,"Droits de technicien requis.");json(res,200,db.prepare("select * from human_questions where org_id=? and (state='pending' or (kind='budget' and state='answered' and answer='2' and expires_at>?)) order by created_at desc limit 100").all(org!,Date.now()));}
    return true;
  }
  const q=id?getQuestion(id):undefined;
  if(!q || q.org_id!==org)throw new HttpError(404,"Question introuvable.");
  if(req.method==="POST" && sub==="answer") {if(!admin)throw new HttpError(403,"Droits de technicien requis.");const b=await body(req,1000);await answerHuman(q,b.answer,{userId:user.id});json(res,200,getQuestion(q.id));return true;}
  throw new HttpError(405,"Méthode refusée.");
}

const tokenOf=(c:Channel)=>decrypt(c.ciphertext,c.org_id,`human:${c.id}`);
async function botApi(c:Channel,route:string,payload:unknown|undefined,fetcher:typeof fetch) {
  const token=tokenOf(c),telegram=c.provider==="telegram";
  const url=telegram?`https://api.telegram.org/bot${token}/${route}`:`https://discord.com/api/v10/channels/${c.destination}/messages${route}`;
  const response=await fetcher(url,{method:payload===undefined?"GET":"POST",redirect:"error",signal:AbortSignal.timeout(15_000),headers:{"content-type":"application/json",...(!telegram?{authorization:`Bot ${token}`}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
  if(!response.ok)throw new Error("Canal indisponible : vérifie le jeton et les permissions du bot.");
  const text=await response.text();
  if(text.length>1_000_000)throw new Error("Réponse du canal trop volumineuse.");
  const value=JSON.parse(text);
  if(telegram && !value.ok)throw new Error("Canal Telegram indisponible.");
  return telegram?value.result:value;
}
export async function receiveHumanReply(c:Channel,messageId:string,userId:string,answer:string) {
  if(!(JSON.parse(c.allowed_users) as string[]).includes(userId) || !can(roleOf(c.org_id,c.owner_id)??"viewer","project:manage"))return;
  if(!db.prepare("select 1 from human_channels where id=?").get(c.id))return;
  const q=db.prepare("select q.* from human_questions q join human_deliveries d on q.id=d.question_id where d.channel_id=? and d.message_id=? and q.state='pending'").get(c.id,messageId) as Question|undefined;
  if(!q)return;
  try{await answerHuman(q,answer.trim(),{external:`${c.provider}:${userId}`});}catch(e){if(!(e instanceof HttpError))throw e;}
}
async function poll(c:Channel,fetcher:typeof fetch) {
  if(c.provider==="telegram") {
    const updates=await botApi(c,"getUpdates",{offset:c.cursor===null?-1:Number(c.cursor),timeout:0,limit:100,allowed_updates:["message"]},fetcher) as any[];
    for(const u of updates) {
      if(c.cursor!==null) {
        const m=u.message;
        if(m && String(m.chat?.id)===c.destination && !m.from?.is_bot && m.reply_to_message?.message_id && typeof m.text==="string")await receiveHumanReply(c,String(m.reply_to_message.message_id),String(m.from?.id),m.text);
      }
      db.prepare("update human_channels set cursor=? where id=?").run(String(u.update_id+1),c.id);
    }
    if(c.cursor===null && !updates.length)db.prepare("update human_channels set cursor='0' where id=?").run(c.id);
  }else {
    // shortcut: dedicated technician channels only; use a Gateway consumer for chats exceeding 100 messages between polls.
    const messages=await botApi(c,"?limit=100",undefined,fetcher) as any[];
    if(c.cursor!==null)for(const m of messages.slice().reverse())if(!m.author?.bot && m.message_reference?.message_id && typeof m.content==="string")await receiveHumanReply(c,String(m.message_reference.message_id),String(m.author?.id),m.content);
    db.prepare("update human_channels set cursor='ready' where id=?").run(c.id);
  }
}
export async function tickHuman(fetcher:typeof fetch=fetch,now=Date.now()) {
  for(const q of db.prepare("select * from human_questions where expires_at<=? and (state='pending' or (kind='budget' and state='answered' and answer='2'))").all(now) as Question[]) {
    db.prepare("update human_questions set state='expired' where id=?").run(q.id);
    const task=getTask(q.task_id);
    if(task?.waiting_question_id===q.id) {
      updateTask(task.id,{waiting_question_id:null});
      if(q.kind==="technical")updateTask(task.id,{last_error:"La question technique a expiré sans réponse."});
      enqueue(task.id);
    }
  }
  for(const c of db.prepare("select * from human_channels").all() as Channel[]) {
    if(!can(roleOf(c.org_id,c.owner_id)??"viewer","project:manage")){db.prepare("update human_channels set last_error=? where id=?").run("Canal suspendu : les droits de son responsable ont changé. Un administrateur doit réenregistrer le canal.",c.id);continue;}
    try {
      await poll(c,fetcher);
      db.prepare("insert or ignore into human_deliveries (question_id,channel_id) select id,? from human_questions where org_id=? and state='pending' and expires_at>?").run(c.id,c.org_id,now);
      const pending=db.prepare("select q.*,d.attempts from human_questions q join human_deliveries d on d.question_id=q.id where d.channel_id=? and d.message_id is null and d.next_attempt<=? and q.state='pending' and q.expires_at>? limit 10").all(c.id,now,now) as (Question&{attempts:number})[];
      for(const q of pending) {
        const origin=process.env.ATELIER_PUBLIC_URL;
        if(!origin)throw new Error("Configure ATELIER_PUBLIC_URL pour les demandes humaines.");
        let text=`Atelier : une décision technique est requise.\n${new URL(`/o/${q.org_id}/tasks/${q.task_id}`,origin).href}\nRéponds à ce message avec le numéro du choix dans Atelier.`;
        if(c.share_content) {
          await assertNoSecretText([q.question,...JSON.parse(q.options_json)].join("\n"),q.org_id);
          text=`Atelier — ${q.question}\n${(JSON.parse(q.options_json) as string[]).map((v,i)=>`${i+1}. ${v}`).join("\n")}\n${new URL(`/o/${q.org_id}/tasks/${q.task_id}`,origin).href}\nRéponds à ce message par un numéro.`;
        }
        try {
          const sent=await botApi(c,c.provider==="telegram"?"sendMessage":"",c.provider==="telegram"?{chat_id:c.destination,text:text.replaceAll("@","＠"),link_preview_options:{is_disabled:true},reply_markup:{force_reply:true,selective:true}}:{content:text,allowed_mentions:{parse:[]},flags:4},fetcher);
          const id=String(c.provider==="telegram"?sent.message_id:sent.id);
          if(!/^\d+$/.test(id))throw new Error("Réponse du bot invalide.");
          db.prepare("update human_deliveries set message_id=? where question_id=? and channel_id=?").run(id,q.id,c.id);
        }catch{
          db.prepare("update human_deliveries set attempts=attempts+1,next_attempt=? where question_id=? and channel_id=?").run(now+Math.min(3600_000,30_000*2**Math.min(q.attempts,7)),q.id,c.id);
          throw new Error("Envoi indisponible : nouvelle tentative prévue.");
        }
      }
      db.prepare("update human_channels set last_error=null where id=?").run(c.id);
    }catch{db.prepare("update human_channels set last_error=? where id=?").run("Canal indisponible : vérifie jeton, permissions et configuration. Les questions restent accessibles dans Atelier.",c.id);}
  }
}
let polling=false;
export function startHuman() {
  const timer=setInterval(()=>{if(!polling){polling=true;void tickHuman().catch(()=>console.warn("human: traitement indisponible")).finally(()=>{polling=false;});}},10_000);
  timer.unref();return()=>clearInterval(timer);
}
