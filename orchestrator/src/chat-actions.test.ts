import {test,after} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
process.env.DB_FILE=":memory:";
process.env.ATELIER_PASSWORD="test";
process.env.ATELIER_FAKE_AGENT="1";
const dir=mkdtempSync(join(tmpdir(),"atelier-chat-actions-"));
process.env.ATELIER_WORKDIR=dir;
const d=await import("./db.ts"),{chatActions}=await import("./chat-actions.ts");
const owner=d.createUser("owner@test.local","hash"),member=d.createUser("member@test.local","hash");
const org=d.createOrg("Chat",owner.id);d.addMember(org,member.id,"member");
const project=d.insertProject({org_id:org,slug:"actions",name:"Actions",repo:"/nonexistent.git",branch:"main",forge:"none",check_cmd:"true",engine:"claude",protected_paths:"[]",git_secret_id:null});
const convId=d.insertConversation({org_id:org,user_id:member.id,project_id:project,mode:"chat"});
const conv=()=>d.getConversationFor(convId,org,member.id)!;
const enabled=(value:boolean)=>d.db.prepare("update conversations set actions_enabled=? where id=?").run(Number(value),convId);
const opts={toolCallId:"call",messages:[],context:{}};
after(async()=>{await new Promise(r=>setTimeout(r,200));rmSync(dir,{recursive:true,force:true});});

test("chat actions require explicit enablement and recheck revocation before every execution",async()=>{
  const message=d.insertMessage(convId,"user",[{type:"text",text:"Améliore le projet"}]);
  const tools=chatActions(conv(),message,new AbortController().signal);
  await assert.rejects(async()=>tools.start_task.execute!({prompt:"Améliore le projet"},opts),/désactivées/);
  enabled(true);
  d.db.prepare("update memberships set role='viewer' where org_id=? and user_id=?").run(org,member.id);
  await assert.rejects(async()=>tools.start_task.execute!({prompt:"Améliore le projet"},opts),/droits/);
  d.db.prepare("update memberships set role='member' where org_id=? and user_id=?").run(org,member.id);
  const ac=new AbortController();ac.abort();
  await assert.rejects(async()=>chatActions(conv(),message,ac.signal).start_task.execute!({prompt:"x"},opts),/Actions/);
});
test("one user message launches one scoped task even after regeneration or concurrent tool calls",async()=>{
  enabled(true);
  const message=d.insertMessage(convId,"user",[{type:"text",text:"Ajoute une page"}]),tools=chatActions(conv(),message,new AbortController().signal);
  const [result,again]=await Promise.all([
    tools.start_task.execute!({prompt:"Ajoute une page"},opts),
    tools.start_task.execute!({prompt:"Reformulation de la même demande"},opts),
  ]) as {taskId:string}[];
  assert.equal(again.taskId,result.taskId);
  const task=d.getTask(result.taskId)!;assert.equal(task.org_id,org);assert.equal(task.project,project);assert.equal(task.user_id,member.id);
  assert.equal(d.getConversationByTask(task.id)!.parent_id,convId);
  const foreign=d.createOrg("Other",owner.id),p=d.insertProject({org_id:foreign,slug:"other",name:"Other",repo:"/nothing.git",branch:"main",forge:"none",check_cmd:"true",engine:"claude",protected_paths:"[]",git_secret_id:null});
  d.createTask("beef1000",foreign,owner.id,p,"Hidden");
  await assert.rejects(async()=>tools.task_status.execute!({taskId:"beef1000"},opts),/introuvable/);
});
test("chat actions refuse secrets and budgets before scheduling work",async()=>{
  const message=d.insertMessage(convId,"user",[{type:"text",text:"Test"}]),tools=chatActions(conv(),message,new AbortController().signal);
  await assert.rejects(async()=>tools.start_task.execute!({prompt:"atl_"+"z".repeat(32)},opts),/secret/i);
  d.setOrgBudget(org,0);
  await assert.rejects(async()=>tools.start_task.execute!({prompt:"Du travail"},opts),/budget/i);
  assert.equal(d.db.prepare("select count(*) as n from chat_task_launches where message_id=?").get(message)!.n,0);
  d.setOrgBudget(org,null);
});
