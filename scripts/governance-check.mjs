// Disposable smoke stack only: no real model, bot or SSO credentials.
import assert from "node:assert/strict";
const base="http://localhost:18080";
const login=await fetch(base+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"admin@localhost",password:"smoke"})});
assert.equal(login.status,200);
const cookie=login.headers.get("set-cookie").split(";")[0];
async function api(method,path,body){const r=await fetch(base+path,{method,headers:{cookie,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;}
const org=(await api("GET","/api/me")).orgs[0].id,root=`/api/orgs/${org}`;
async function waitTask(id,test){for(let i=0;i<90;i++){const t=await api("GET",`${root}/tasks/${id}`);if(test(t))return t;if(["failed","cancelled"].includes(t.status))throw Error(t.last_error||t.status);await new Promise(r=>setTimeout(r,1000));}throw Error("Task timeout");}
const created=await api("POST",root+"/projects/scaffold",{name:"Human decisions",slug:"human-"+Date.now(),template:"static"}),project=created.project.id;
const first=await api("POST",root+"/tasks",{project,prompt:"[demande-technicien] Choisis le stockage du projet"});
const waiting=await waitTask(first.id,t=>!!t.waiting_question_id);
assert.equal(waiting.status,"queued");assert.equal(waiting.workspace_saved,1);
const questions=await api("GET",`${root}/questions?task=${first.id}`);
assert.equal(questions.length,1);assert.equal(questions[0].kind,"technical");
await api("POST",`${root}/questions/${waiting.waiting_question_id}/answer`,{answer:"1"});
const done=await waitTask(first.id,t=>t.status==="done"&&t.workspace_saved===0);assert.ok(done.pushed_sha);assert.equal(done.workspace_saved,0);
const answered=await api("GET",`${root}/questions?task=${first.id}`);
assert.equal(answered.length,1);assert.equal(answered[0].state,"answered");
const journal=await fetch(`${base}${root}/tasks/${first.id}/logs`,{headers:{cookie}});
assert.ok(journal.ok);assert.match(await journal.text(),/Décision réutilisée : SQLite/);
await api("PATCH",`${root}/projects/${project}`,{budgetUsdDay:0,budgetTimezone:"Europe/Paris"});
const second=await api("POST",root+"/tasks",{project,prompt:"Un travail en attente de budget"});
const budgetWait=await waitTask(second.id,t=>!!t.waiting_question_id);
const budgetQuestions=await api("GET",`${root}/questions?task=${second.id}`);assert.equal(budgetQuestions[0].kind,"budget");
await api("POST",`${root}/questions/${budgetWait.waiting_question_id}/answer`,{answer:"2"});
await new Promise(r=>setTimeout(r,1000));assert.equal((await api("GET",`${root}/tasks/${second.id}`)).waiting_question_id,budgetWait.waiting_question_id);
const third=await api("POST",root+"/tasks",{project,prompt:"Un travail avec rallonge validée"});
const grantWait=await waitTask(third.id,t=>!!t.waiting_question_id);
await api("POST",`${root}/questions/${grantWait.waiting_question_id}/answer`,{answer:"1"});
await waitTask(third.id,t=>t.status==="done"&&t.workspace_saved===0);assert.equal((await api("GET",`${root}/projects/${project}/budget`)).extraUsd,1);
await api("POST",`${root}/tasks/${second.id}/cancel`,{});
assert.equal((await api("GET",`${root}/tasks/${second.id}`)).status,"cancelled");
console.log("HUMAN WAIT/RESUME, DAILY LIMIT AND EXTENSIONS OK");
