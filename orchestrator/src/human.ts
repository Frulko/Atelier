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

export type Channel = { id:string; org_id:string; provider:"telegram"|"discord"; destination:string; allowed_users:string; share_content:number; ciphertext:Buffer; cursor:string|null; owner_id:string; last_error:string|null; connection_mode:"bot"|"webhook"; discord_kind:"text"|"forum"; forum_tag:string|null };
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
for(const [table,column,definition] of [
  ["human_channels","connection_mode","text not null default 'bot'"],
  ["human_channels","discord_kind","text not null default 'text'"],
  ["human_channels","forum_tag","text"],
  ["human_deliveries","thread_id","text"],
])if(!(db.prepare(`pragma table_info(${table})`).all() as {name:string}[]).some(c=>c.name===column))db.exec(`alter table ${table} add column ${column} ${definition}`);
export const getQuestion = (id:string) => db.prepare("select * from human_questions where id=?").get(id) as Question|undefined;
export const questionsFor = (org:string,task:string) => db.prepare("select * from human_questions where org_id=? and task_id=? order by created_at,id").all(org,task) as Question[];
const decisionText=(text:string)=>text.normalize("NFKC").toLocaleLowerCase("fr").replace(/[\p{P}\p{Z}\s]+/gu," ").trim();
export const channelJson = (org:string) => (db.prepare("select provider,destination,allowed_users,share_content,last_error,connection_mode,discord_kind,forum_tag from human_channels where org_id=?").all(org) as Pick<Channel,"provider"|"destination"|"allowed_users"|"share_content"|"last_error"|"connection_mode"|"discord_kind"|"forum_tag">[]).map(c=>({provider:c.provider,destination:c.connection_mode==="webhook"?"":c.destination,allowedUsers:JSON.parse(c.allowed_users),shareContent:!!c.share_content,lastError:c.last_error,connectionMode:c.connection_mode,discordKind:c.discord_kind,forumTag:c.forum_tag??""}));
function webhookUrl(value:string) {
  let url:URL;
  try{url=new URL(value);}catch{throw new HttpError(400,"Indique l’URL complète du webhook Discord.");}
  if(url.origin!=="https://discord.com" || url.username || url.password || url.search || url.hash || !/^\/api(?:\/v10)?\/webhooks\/\d{1,22}\/[\w-]{20,200}$/.test(url.pathname))throw new HttpError(400,"URL de webhook invalide : utilise https://discord.com/api/webhooks/… sans paramètres.");
  return url;
}
export function saveChannel(org:string,user:string,b:any) {
  if(!["telegram","discord"].includes(b.provider))throw new HttpError(400,"Choisis Telegram ou Discord.");
  const mode=b.provider==="discord"?(b.connectionMode??"bot"):"bot",kind=b.provider==="discord"?(b.discordKind??"text"):"text";
  if(!["bot","webhook"].includes(mode) || !["text","forum"].includes(kind))throw new HttpError(400,"Type de connexion ou de salon invalide.");
  if(mode==="bot" && (typeof b.destination!=="string" || !(b.provider==="discord"?/^\d{1,22}$/:/^-?\d{1,22}$/).test(b.destination)))throw new HttpError(400,b.provider==="discord"?"L’identifiant du salon doit être numérique, pas son nom. Dans Discord : Paramètres → Avancés → Mode développeur, puis clic droit sur le salon → Copier l’identifiant.":"Indique l’identifiant numérique du chat Telegram.");
  if(!Array.isArray(b.allowedUsers) || (mode==="bot" && !b.allowedUsers.length) || b.allowedUsers.length>20 || !b.allowedUsers.every((id:unknown)=>typeof id==="string" && /^\d{1,22}$/.test(id)))throw new HttpError(400,"Indique les identifiants numériques des techniciens autorisés.");
  const tag=kind==="forum"?(b.forumTag??""):"";
  if(typeof tag!=="string" || (tag && !/^\d{1,22}$/.test(tag)))throw new HttpError(400,"L’identifiant de l’étiquette du forum doit être numérique.");
  if(typeof b.shareContent!=="boolean")throw new HttpError(400,"Choisis si le contenu peut être partagé.");
  const previous=db.prepare("select * from human_channels where org_id=? and provider=?").get(org,b.provider) as Channel|undefined;
  const token=b.token===undefined && previous && previous.connection_mode===mode ? decrypt(previous.ciphertext,org,`human:${previous.id}`) : b.token;
  let destination=b.destination;
  if(mode==="webhook") {
    if(typeof token!=="string")throw new HttpError(400,"Indique l’URL du webhook Discord.");
    destination=webhookUrl(token).pathname.split("/").at(-2)!;
  }else {
    if(typeof token==="string" && /^https?:/i.test(token))throw new HttpError(400,"Cette valeur est une URL de webhook. Choisis le mode Webhook, ou colle le jeton de la page Bot du portail développeur Discord.");
    if(typeof token!=="string" || token.length<20 || token.length>300 || /[\s\x00-\x1f]/.test(token) || (b.provider==="telegram" && !/^\d+:[\w-]+$/.test(token)))throw new HttpError(400,"Jeton de bot invalide.");
  }
  const id=randomBytes(8).toString("hex");
  db.exec("savepoint human_channel");
  try {
    db.prepare("delete from human_channels where org_id=? and provider=?").run(org,b.provider);
    db.prepare("insert into human_channels (id,org_id,provider,destination,allowed_users,share_content,ciphertext,token_hash,owner_id,connection_mode,discord_kind,forum_tag) values (?,?,?,?,?,?,?,?,?,?,?,?)").run(id,org,b.provider,destination,JSON.stringify([...new Set(b.allowedUsers)]),Number(b.shareContent),encrypt(token,org,`human:${id}`),createHash("sha256").update(token).digest("hex"),user,mode,kind,tag||null);
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
  const sameOptions=(options:string[])=>JSON.stringify(options.map(decisionText).sort())===JSON.stringify((b.options as string[]).map(decisionText).sort());
  const answered=questionsFor(current.org_id!,current.id).reverse().find(q=>q.turn===current.turn && q.kind==="technical" && q.state==="answered" && decisionText(q.question)===decisionText(b.question) && sameOptions(JSON.parse(q.options_json)));
  if(answered)return answered;
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
  const latest=new Map<string,Question>();
  for(const q of questionsFor(task.org_id!,task.id).filter(q=>q.kind==="technical" && q.state==="answered"))latest.set(JSON.stringify([q.turn,decisionText(q.question),(JSON.parse(q.options_json) as string[]).map(decisionText).sort()]),q);
  const answered=[...latest.values()];
  if(!answered.length)return "";
  return `# Décisions humaines déjà reçues\nCes demandes sont terminées. Applique les choix ci-dessous et poursuis le travail sauvegardé. Ne redemande pas un choix déjà tranché, même en reformulant la question. Si la demande initiale était seulement de poser cette question, elle est satisfaite : confirme le choix et termine sans modifier de fichier.\n\n${answered.map(q=>`Décision humaine (tour ${q.turn}, ${q.id}) : ${q.question}\nChoix retenu : ${q.answer}. ${(JSON.parse(q.options_json) as string[])[Number(q.answer)-1]}`).join("\n\n")}`;
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
class ChannelError extends Error {}
async function botApi(c:Channel,route:string,payload:unknown|undefined,fetcher:typeof fetch) {
  const token=tokenOf(c),telegram=c.provider==="telegram";
  const webhook=c.connection_mode==="webhook";
  const url=telegram?`https://api.telegram.org/bot${token}/${route}`:webhook?`${webhookUrl(token).href}?wait=true`:`https://discord.com/api/v10${route}`;
  const response=await fetcher(url,{method:payload===undefined?"GET":"POST",redirect:"error",signal:AbortSignal.timeout(15_000),headers:{"content-type":"application/json",...(!telegram&&!webhook?{authorization:`Bot ${token}`}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
  if(!response.ok)throw new ChannelError(response.status===401?"Authentification refusée : vérifie le jeton du bot ou le webhook.":response.status===403?"Accès refusé : le bot doit voir le salon, lire son historique et envoyer des messages, y compris dans les fils.":response.status===404?"Salon ou webhook introuvable : vérifie l’identifiant et l’accès du bot.":response.status===429?"Limite Discord/Telegram atteinte : nouvelle tentative automatique.":response.status===400?"Configuration refusée : vérifie le type texte/forum et l’étiquette obligatoire du forum.":"Service de messagerie indisponible : nouvelle tentative automatique.");
  const text=await response.text();
  if(text.length>1_000_000)throw new Error("Réponse du canal trop volumineuse.");
  const value=JSON.parse(text);
  if(telegram && !value.ok)throw new Error("Canal Telegram indisponible.");
  return telegram?value.result:value;
}
export async function receiveHumanReply(c:Channel,messageId:string,userId:string,answer:string) {
  if(c.connection_mode==="webhook")return;
  if(!(JSON.parse(c.allowed_users) as string[]).includes(userId) || !can(roleOf(c.org_id,c.owner_id)??"viewer","project:manage"))return;
  if(!db.prepare("select 1 from human_channels where id=?").get(c.id))return;
  const q=db.prepare("select q.* from human_questions q join human_deliveries d on q.id=d.question_id where d.channel_id=? and d.message_id=? and q.state='pending'").get(c.id,messageId) as Question|undefined;
  if(!q)return;
  try{await answerHuman(q,answer.trim(),{external:`${c.provider}:${userId}`});}catch(e){if(!(e instanceof HttpError))throw e;}
}
async function poll(c:Channel,fetcher:typeof fetch) {
  if(c.connection_mode==="webhook")return;
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
    if(c.cursor===null) {
      const channel=await botApi(c,`/channels/${c.destination}`,undefined,fetcher);
      if(channel.type!==(c.discord_kind==="forum"?15:0))throw new ChannelError("Le type du salon Discord ne correspond pas au choix texte/forum. Vérifie l’identifiant et le type sélectionné.");
    }
    if(c.discord_kind==="forum") {
      const deliveries=db.prepare("select d.message_id,d.thread_id from human_deliveries d join human_questions q on q.id=d.question_id where d.channel_id=? and d.thread_id is not null and q.state='pending' and q.expires_at>? limit 100").all(c.id,Date.now()) as {message_id:string;thread_id:string}[];
      for(const d of deliveries) {
        if(!/^\d{1,22}$/.test(d.thread_id) || !/^\d{1,22}$/.test(d.message_id))continue;
        const messages=await botApi(c,`/channels/${d.thread_id}/messages?limit=100`,undefined,fetcher) as any[];
        for(const m of messages.slice().reverse())if(!m.author?.bot && /^\d{1,22}$/.test(String(m.id)) && BigInt(m.id)>BigInt(d.message_id) && typeof m.content==="string")await receiveHumanReply(c,d.message_id,String(m.author?.id),m.content);
      }
      db.prepare("update human_channels set cursor='ready' where id=?").run(c.id);
      return;
    }
    // shortcut: dedicated technician channels only; use a Gateway consumer for chats exceeding 100 messages between polls.
    const messages=await botApi(c,`/channels/${c.destination}/messages?limit=100`,undefined,fetcher) as any[];
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
        const instruction=c.connection_mode==="webhook"?"Ouvre Atelier pour répondre ; les réponses Discord ne sont pas lues par un webhook.":c.discord_kind==="forum"?"Réponds dans ce fil par le numéro du choix.":"Réponds directement à ce message par le numéro du choix.";
        let text=`Atelier : une décision technique est requise.\n${new URL(`/o/${q.org_id}/tasks/${q.task_id}`,origin).href}\n${instruction}`;
        if(c.share_content) {
          await assertNoSecretText([q.question,...JSON.parse(q.options_json)].join("\n"),q.org_id);
          text=`Atelier — ${q.question}\n${(JSON.parse(q.options_json) as string[]).map((v,i)=>`${i+1}. ${v}`).join("\n")}\n${new URL(`/o/${q.org_id}/tasks/${q.task_id}`,origin).href}\n${instruction}`;
        }
        try {
          const forum=c.provider==="discord" && c.discord_kind==="forum";
          const title=c.share_content?`Atelier · ${q.question}`.replace(/[\r\n@]/g," ").slice(0,100):`Atelier · ${q.kind==="budget"?"Budget":"Décision technique"} · ${q.id.slice(0,8)}`;
          const message={content:text,allowed_mentions:{parse:[]},flags:4};
          const tags=c.forum_tag?{applied_tags:[c.forum_tag]}:{};
          const route=c.provider==="telegram"?"sendMessage":`/channels/${c.destination}/${forum?"threads":"messages"}`;
          const payload=c.provider==="telegram"?{chat_id:c.destination,text:text.replaceAll("@","＠"),link_preview_options:{is_disabled:true},reply_markup:{force_reply:true,selective:true}}:forum?(c.connection_mode==="webhook"?{...message,thread_name:title,...tags}:{name:title,auto_archive_duration:1440,message,...tags}):message;
          const sent=await botApi(c,route,payload,fetcher);
          const id=String(c.provider==="telegram"?sent.message_id:forum&&c.connection_mode==="bot"?sent.message?.id:sent.id);
          const threadId=forum?String(c.connection_mode==="webhook"?sent.channel_id:sent.id):null;
          if(!/^\d+$/.test(id))throw new Error("Réponse du bot invalide.");
          if(threadId && !/^\d{1,22}$/.test(threadId))throw new Error("Réponse du forum invalide.");
          db.prepare("update human_deliveries set message_id=?,thread_id=? where question_id=? and channel_id=?").run(id,threadId,q.id,c.id);
        }catch(error){
          db.prepare("update human_deliveries set attempts=attempts+1,next_attempt=? where question_id=? and channel_id=?").run(now+Math.min(3600_000,30_000*2**Math.min(q.attempts,7)),q.id,c.id);
          throw error instanceof ChannelError?error:new Error("Envoi indisponible : nouvelle tentative prévue.");
        }
      }
      db.prepare("update human_channels set last_error=null where id=?").run(c.id);
    }catch(error){db.prepare("update human_channels set last_error=? where id=?").run(`${error instanceof ChannelError?error.message:"Canal indisponible : vérifie jeton, permissions et configuration."} Les questions restent accessibles dans Atelier.`,c.id);}
  }
}
let polling=false;
export function startHuman() {
  const timer=setInterval(()=>{if(!polling){polling=true;void tickHuman().catch(()=>console.warn("human: traitement indisponible")).finally(()=>{polling=false;});}},10_000);
  timer.unref();return()=>clearInterval(timer);
}
