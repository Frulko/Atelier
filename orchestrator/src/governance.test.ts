import type { Question, Channel } from "./human.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type {AddressInfo} from "node:net";
process.env.DB_FILE=":memory:";
process.env.ATELIER_PASSWORD="test";
process.env.ATELIER_FAKE_AGENT="1";
process.env.ATELIER_PUBLIC_URL="https://atelier.example.test";
const d=await import("./db.ts"),h=await import("./human.ts"),b=await import("./budget.ts");
const {createApp}=await import("./app.ts"),{startSession}=await import("./session.ts");
const {assertNoSecretText}=await import("./security.ts");
const owner=d.createUser("owner@one.test","hash"),member=d.createUser("member@one.test","hash"),foreign=d.createUser("owner@two.test","hash");
const org=d.createOrg("One",owner.id),other=d.createOrg("Two",foreign.id);
d.addMember(org,member.id,"member");
const project=d.insertProject({org_id:org,slug:"guard",name:"Guard",repo:"https://github.com/example/test.git",branch:"main",forge:"none",check_cmd:"true",engine:"claude",protected_paths:"[]",git_secret_id:null});
const server=createApp().listen(0),base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(()=>{server.closeAllConnections();server.close();});
const cookies=new Map([owner,member,foreign].map(u=>[u.id,`atelier_session=${startSession(u.id)}`]));
const api=(who:string,method:string,path:string,body?:unknown)=>fetch(base+path,{method,headers:{cookie:cookies.get(who)!,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
let serial=0;
function task(){const id=`caf${String(++serial).padStart(5,"0")}`;d.createTask(id,org,owner.id,project,"Work");d.updateTask(id,{status:"running"});return d.getTask(id)!;}

test("daily boundaries include exact midnight and daylight-saving changes",()=>{
  const march=b.dayBounds("Europe/Paris",Date.parse("2026-03-29T12:00Z"));
  assert.equal(march.end-march.start,23*3600_000);
  const october=b.dayBounds("Europe/Paris",Date.parse("2026-10-25T12:00Z"));
  assert.equal(october.end-october.start,25*3600_000);
  assert.equal(b.dayBounds("Europe/Paris",october.start).start,october.start);
});
test("project and monthly budgets include active reservations without double charging",()=>{
  d.updateProject(project,org,{budget_usd_day:1,budget_timezone:"Europe/Paris"});
  d.setOrgBudget(org,2);
  const t=task(),a=b.reserveBudget(org,project,0.8,t.id),second=b.reserveBudget(org,project,0.8);
  assert.ok(Math.abs(second.amount-0.2)<1e-9);
  assert.throws(()=>b.reserveBudget(org,project,0.1));
  d.updateTask(t.id,{cost:0.3});
  assert.ok(Math.abs(b.projectBudget(org,project).reservedUsd-0.7)<1e-9);
  b.settleBudget(a.id);
  b.settleBudget(second.id,true);
  const usage=b.projectBudget(org,project);
  assert.ok(Math.abs(usage.spentUsd-0.5)<1e-9);
  assert.equal(usage.reservedUsd,0);
  assert.throws(()=>b.reserveBudget(other,project,1),/introuvable/);
  d.updateProject(project,org,{budget_usd_day:null});d.setOrgBudget(org,null);
});
test("daily configuration is scoped, admin-only, numeric and timezone validated",async()=>{
  const path=`/api/orgs/${org}/projects/${project}`;
  assert.equal((await api(member.id,"PATCH",path,{budgetUsdDay:2})).status,403);
  assert.equal((await api(foreign.id,"PATCH",path,{budgetUsdDay:2})).status,404);
  for(const value of [-1,"2",10001])assert.equal((await api(owner.id,"PATCH",path,{budgetUsdDay:value})).status,400);
  assert.equal((await api(owner.id,"PATCH",path,{budgetTimezone:"Bad/zone"})).status,400);
  assert.equal((await api(owner.id,"PATCH",path,{budgetUsdDay:3,budgetTimezone:"Europe/Paris",subagentModel:"haiku"})).status,200);
  assert.equal((await api(owner.id,"GET",path+"/budget")).status,200);
});
test("agent defaults are separate from chat settings and inherited by projects",async()=>{
  const res=await api(owner.id,"PATCH",`/api/orgs/${org}`,{agentModel:"sonnet",subagentModel:"haiku"});assert.equal(res.status,200);
  const {rowToProject}=await import("./projects.ts");
  const p=rowToProject(d.getProjectInOrg(project,org)!);
  assert.equal(p.agentModel,"sonnet");assert.equal(p.subagentModel,"haiku");
  assert.equal(d.getOrg(org)!.chat_model,null);
  assert.equal((await api(member.id,"PATCH",`/api/orgs/${org}`,{agentModel:"opus"})).status,403);
});
let question:Question;
test("questions accept bounded choices, reject secrets, and isolate reads and answers",async()=>{
  const t=task();
  const {storeSecret}=await import("./vault.ts");storeSecret(org,"git_token",null,"private","private-value-that-must-not-leave");
  await assert.rejects(h.askHuman(t,{question:"private-value-that-must-not-leave",options:["A","B"]}),/secret/);
  question=await h.askHuman(t,{question:"Quel stockage utiliser ?",options:["SQLite","JSON"]});
  const path=`/api/orgs/${org}/questions/${question.id}/answer`;
  assert.equal((await api(member.id,"POST",path,{answer:"1"})).status,403);
  assert.equal((await api(foreign.id,"POST",path,{answer:"1"})).status,404);
  assert.equal((await api(owner.id,"POST",path,{answer:"run this command"})).status,400);
  assert.equal((await api(foreign.id,"GET",`/api/orgs/${org}/questions?task=${t.id}`)).status,404);
});
const telegramToken="123456:private-bot-token-for-test-only-0000",discordToken="discord-private-test-token-0000000000";
test("both channels encrypt tokens and send generic content by default",async()=>{
  h.saveChannel(org,owner.id,{provider:"telegram",destination:"-100123456",allowedUsers:["42"],shareContent:false,token:telegramToken});
  h.saveChannel(org,owner.id,{provider:"discord",destination:"900000000000000001",allowedUsers:["43"],shareContent:true,token:discordToken});
  const text=JSON.stringify(h.channelJson(org));assert.ok(!text.includes(telegramToken)&&!text.includes(discordToken));
  await assert.rejects(assertNoSecretText(telegramToken,org),/secret/);
  const bodies:{url:string;body:any}[]=[];
  const fake:typeof fetch=async(input,init)=>{
    const url=String(input),body=init?.body?JSON.parse(String(init.body)):undefined;bodies.push({url,body});
    if(url.includes("getUpdates"))return Response.json({ok:true,result:[]});
    if(url.includes("sendMessage"))return Response.json({ok:true,result:{message_id:101}});
    if(init?.method==="GET")return Response.json([]);
    return Response.json({id:"102"});
  };
  await h.tickHuman(fake);
  const tg=bodies.find(x=>x.url.includes("sendMessage"))!.body;
  assert.ok(!tg.text.includes(question.question));assert.ok(tg.text.includes("https://atelier.example.test/"));
  const dc=bodies.find(x=>x.url.includes("discord.com")&&x.body)?.body;
  assert.ok(dc.content.includes(question.question));assert.deepEqual(dc.allowed_mentions,{parse:[]});
});
test("bot replies require both an allowed technician and the exact delivered message",async()=>{
  const channel=d.db.prepare("select * from human_channels where provider='telegram'").get() as Channel;
  await h.receiveHumanReply(channel,"101","666","1");assert.equal(h.getQuestion(question.id)!.state,"pending");
  await h.receiveHumanReply(channel,"999","42","1");assert.equal(h.getQuestion(question.id)!.state,"pending");
  await h.receiveHumanReply(channel,"101","42","1");assert.equal(h.getQuestion(question.id)!.answer,"1");
  await h.receiveHumanReply(channel,"101","42","2");assert.equal(h.getQuestion(question.id)!.answer,"1");
});
test("a one-dollar extension applies to today only and cannot override the monthly cap",async()=>{
  d.updateProject(project,org,{budget_usd_day:0});
  const q=h.askBudget(task());
  await h.answerHuman(q,"1",{userId:owner.id});
  assert.equal(b.projectBudget(org,project).extraUsd,1);
  assert.equal(b.projectBudget(org,project,b.projectBudget(org,project).resetsAt+1).extraUsd,0);
  await assert.rejects(h.answerHuman(q,"1",{userId:owner.id}),/plus de réponse/);
  d.setOrgBudget(org,0);assert.equal(b.availableBudget(org,project),0);
  d.setOrgBudget(org,null);d.updateProject(project,org,{budget_usd_day:null});
});

test("bot failures never echo credentials and a revoked channel owner suspends delivery",async()=>{
  await h.tickHuman(async()=>{throw new Error(`network failed ${telegramToken} ${discordToken}`);});
  const failed=JSON.stringify(h.channelJson(org));assert.ok(!failed.includes(telegramToken)&&!failed.includes(discordToken));
  assert.ok(failed.includes("indisponible"));
  d.db.prepare("update memberships set role='viewer' where org_id=? and user_id=?").run(org,owner.id);
  let calls=0;await h.tickHuman(async()=>{calls++;return Response.json([]);});
  assert.equal(calls,0);assert.ok(h.channelJson(org).every(c=>c.lastError?.includes("suspendu")));
  d.db.prepare("update memberships set role='owner' where org_id=? and user_id=?").run(org,owner.id);
});
