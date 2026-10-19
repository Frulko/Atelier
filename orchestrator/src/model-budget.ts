import { randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { db } from "./db.ts";
import { HttpError } from "./http.ts";

// Anthropic public API rates checked 2026-10-15: https://platform.claude.com/docs/en/about-claude/pricing
const RATES:Record<string,[number,number]>={
 "claude-haiku-5-5":[0.5,2.5],"claude-haiku-4-5":[1,5],"claude-3-5-haiku":[0.8,4],
 "claude-sonnet-5-5":[2,10],"claude-sonnet-5":[2,10],"claude-sonnet-4-6":[3,15],"claude-sonnet-4-5":[3,15],"claude-sonnet-4":[3,15],
 "claude-opus-5-5":[4,20],"claude-opus-5":[5,25],"claude-opus-4-8":[5,25],"claude-opus-4-7":[5,25],"claude-opus-4-6":[5,25],"claude-opus-4-5":[5,25],"claude-opus-4-1":[15,75],"claude-opus-4":[15,75],
 "claude-fable-5-1":[10,50],"claude-fable-5":[10,50],"claude-mythos-5-1":[10,50],"claude-mythos-5":[10,50],
};
db.exec(`create table if not exists model_charges (id text primary key,hold_id text not null references budget_holds(id) on delete cascade,usd real not null);`);
export function reserveModelCall(holdId:string,provider:string,payload:any) {
  if(provider!=="anthropic")throw new HttpError(403,"Cette enveloppe d'agent est réservée à Claude.");
  const configured=db.prepare(`select coalesce(p.agent_model,o.agent_model,'haiku') as main,
    coalesce(p.subagent_model,o.subagent_model,'haiku') as sub from budget_holds h
    join orgs o on o.id=h.org_id left join projects p on p.id=h.project_id where h.id=?`).get(holdId) as {main:string;sub:string}|undefined;
  const permitted=(chosen:string) => {
    if(chosen==="inherit")chosen=configured!.main;
    return ["haiku","sonnet","opus","fable","mythos"].includes(chosen)
      ? String(payload.model).startsWith(`claude-${chosen}-`) || String(payload.model).startsWith(`claude-3-5-${chosen}`)
      : payload.model===chosen;
  };
  if(!configured || ![configured.main,configured.sub].some(permitted))throw new HttpError(403,"Ce modèle n'est pas autorisé pour les agents de ce projet.");
  const model=String(payload.model??"").replace(/-\d{8}$/,"");
  const rates=RATES[model];
  if(!rates)throw new HttpError(409,"Tarif de ce modèle inconnu : mets à jour le catalogue avant de l'utiliser avec un budget.");
  if(!Number.isInteger(payload.max_tokens) || payload.max_tokens<1 || payload.max_tokens>1_000_000)throw new HttpError(400,"Limite de tokens de sortie requise.");
  if(payload.speed || (payload.service_tier && payload.service_tier!=="auto" && payload.service_tier!=="standard_only") || (payload.inference_geo && payload.inference_geo!=="global"))throw new HttpError(400,"Option tarifaire non prise en charge par le budget.");
  if(payload.mcp_servers?.length || payload.tools?.some((t:any)=>t.type && t.type!=="custom"))throw new HttpError(400,"Les outils serveur facturés ne sont pas autorisés dans cette enveloppe.");
  let images=0;
  JSON.stringify(payload,(_name,value)=>{
    if(value && typeof value==="object") {
      if(value.type==="document" || value.type==="url" || value.type==="file")throw new HttpError(400,"Les documents distants ne sont pas pris en charge par cette enveloppe.");
      if(value.type==="image")images++;
    }
    return value;
  });
  const inputUpper=Buffer.byteLength(JSON.stringify(payload))+1024+images*100_000;
  const upper=(inputUpper*rates[0]*4+payload.max_tokens*rates[1]*2)/1_000_000;
  const remaining=db.prepare("select h.amount-coalesce((select sum(usd) from model_charges where hold_id=h.id),0) as n from budget_holds h where id=?").get(holdId) as {n:number}|undefined;
  if(!remaining || upper>remaining.n+1e-9)throw new HttpError(402,"L'enveloppe restante ne couvre pas le coût maximal de cet appel. Réduis le contexte ou les tokens de sortie.");
  const id=randomBytes(16).toString("hex");
  db.prepare("insert into model_charges values (?,?,?)").run(id,holdId,upper);
  return {id,model,rates,upper};
}
type Call=ReturnType<typeof reserveModelCall>;
export function meterModelStream(call:Call) {
  const decoder=new StringDecoder("utf8");let pending="",seen=false,finished=false;
  const usage:Record<string,number>={};
  const capture=(event:any)=>{
    if(event.type==="message_stop" || (event.type==="message" && event.stop_reason))finished=true;
    const u=event.usage??event.message?.usage;
    if(!u)return;
    seen=true;
    for(const key of ["input_tokens","output_tokens","cache_creation_input_tokens","cache_read_input_tokens"])
      if(typeof u[key]==="number" && Number.isFinite(u[key]) && u[key]>=0)usage[key]=Math.max(usage[key]??0,u[key]);
  };
  return new Transform({transform(chunk,_encoding,done){
    this.push(chunk);pending+=decoder.write(chunk);
    while(pending.includes("\n")){
      const at=pending.indexOf("\n"),line=pending.slice(0,at).trim();pending=pending.slice(at+1);
      try{capture(JSON.parse(line.startsWith("data:")?line.slice(5):line));}catch{}
    }
    if(pending.length>2_000_000){pending="";seen=false;}
    done();
  },flush(done){
    pending+=decoder.end();try{capture(JSON.parse(pending));}catch{}
    if(seen && finished && "input_tokens" in usage && "output_tokens" in usage) {
      const input=(usage.input_tokens??0)+(usage.cache_creation_input_tokens??0)+(usage.cache_read_input_tokens??0);
      const [inPrice,outPrice]=call.model==="claude-haiku-5-5" && input<=100000?[0.1,0.5]:call.rates;
      const contextFactor=input>200000?2:1, outputFactor=input>200000?1.5:1;
      const cost=((usage.input_tokens??0)*inPrice*contextFactor+(usage.cache_creation_input_tokens??0)*inPrice*2*contextFactor+(usage.cache_read_input_tokens??0)*inPrice*0.1*contextFactor+(usage.output_tokens??0)*outPrice*outputFactor)/1_000_000;
      db.prepare("update model_charges set usd=? where id=?").run(cost,call.id);
    }
    done();
  }});
}
