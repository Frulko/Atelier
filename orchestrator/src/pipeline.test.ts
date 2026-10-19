// Real git plus a controlled Docker process: cancellation can race with a successful check.
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "atelier-pipeline-"));
process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "test";
process.env.ATELIER_WORKDIR = join(dir, "work");
process.env.ATELIER_FAKE_AGENT = "1";
const bin = join(dir, "bin"), marker = join(dir, "checking");
mkdirSync(bin);
writeFileSync(join(bin, "docker"), `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args[0]!=='run')process.exit(0);
const name=args[args.indexOf('--name')+1],tree=args[args.indexOf('-v')+1].replace(/:\\/work$/,'');
if(name.includes('-agent')) {
  fs.appendFileSync(tree+'/NOTES.md','A useful change\\n');
  console.log(JSON.stringify({type:'command_start',commandId:'tool1',command:'printf safe'}));
  console.log(JSON.stringify({type:'command_result',commandId:'tool1',state:'completed',output:'token=atl_'+'a'.repeat(32)}));
  console.log(JSON.stringify({type:'result',ok:true,cost:0.01}));
} else {
  fs.writeFileSync(${JSON.stringify(marker)},name);
  setTimeout(()=>process.exit(0),200);
}
`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
const d = await import("./db.ts");
const { enqueue, cancel } = await import("./pipeline.ts");
const { scaffold } = await import("./scaffold.ts");
const { issueTaskToken, resolveTaskToken } = await import("./tokens.ts");
const owner = d.createUser("owner@example.test", "hash"), member = d.createUser("member@example.test", "hash");
const org = d.createOrg("Pipeline", owner.id);
d.addMember(org, member.id, "member");
const p = await scaffold(org, { name: "Race", slug: "race", template: "static" });
const remote = join(dir, "work", "_repos", `${p.id}.git`);
after(() => rmSync(dir, { recursive: true, force: true }));

async function execute(id: string, duringCheck?: () => void) {
  rmSync(marker, { force: true });
  d.createTask(id, org, member.id, p.id, "Make a change");
  const finished = once(d.bus, "task:finished", { signal: AbortSignal.timeout(10000) });
  enqueue(id);
  if (duringCheck) {
    const deadline = Date.now() + 5000;
    while (!existsSync(marker)) {
      assert.ok(Date.now() < deadline, "The check must start");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    duringCheck();
  }
  await finished;
  return d.getTask(id)!;
}
const hasBranch = (id: string) => {
  try { execFileSync("git", ["--git-dir", remote, "show-ref", "--verify", `refs/heads/atelier/${id}`], { stdio: "ignore" }); return true; }
  catch { return false; }
};

test("successful checks still produce a proposal", async () => {
  const task = await execute("a0000001");
  assert.equal(task.status, "done");
  assert.equal(hasBranch(task.id), true);
  const commands = d.getEvents(task.id).filter(e => e.type.startsWith("command_")).map(e => ({ type: e.type, ...JSON.parse(e.text) }));
  assert.equal(commands.length, 4);
  assert.equal(commands[0].command, "printf safe");
  assert.match(commands[1].output, /masqué/);
  assert.equal(commands[2].source, "Vérification");
  assert.equal(commands[3].state, "completed");
});
test("cancellation during a successful check revokes capabilities and prevents push", async () => {
  const token = issueTaskToken("a0000002", org);
  const installer = issueTaskToken("atelier-a0000002-check1", org, "npm");
  const task = await execute("a0000002", () => cancel("a0000002"));
  assert.equal(resolveTaskToken(token), undefined);
  assert.equal(resolveTaskToken(installer), undefined);
  assert.equal(task.status, "cancelled");
  assert.equal(hasBranch(task.id), false);
});
test("cancelling a follow-up preserves the previous remote proposal", async () => {
  const id = "a0000001", before = d.getTask(id)!.pushed_sha;
  rmSync(marker, { force: true });
  d.updateTask(id, { status: "queued", turn: 2, followup: "An adjustment" });
  const finished = once(d.bus, "task:finished", { signal: AbortSignal.timeout(10000) });
  enqueue(id);
  const deadline = Date.now() + 5000;
  while (!existsSync(marker)) {
    assert.ok(Date.now() < deadline);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  cancel(id);
  await finished;
  const task = d.getTask(id)!;
  assert.equal(task.status, "done");
  assert.match(task.last_error!, /annulée/);
  const actual = execFileSync("git", ["--git-dir", remote, "rev-parse", `refs/heads/atelier/${id}`], { encoding: "utf8" }).trim();
  assert.equal(actual, before);
});
test("rights removed during a successful check prevent push", async () => {
  const task = await execute("a0000003", () => d.db.prepare("update memberships set role='viewer' where org_id=? and user_id=?").run(org, member.id));
  assert.equal(task.status, "failed");
  assert.match(task.last_error!, /droits/);
  assert.equal(hasBranch(task.id), false);
});


test("a refused daily extension waits and automatically resumes on the next local day",async()=>{
  const {askBudget,answerHuman,tickHuman,getQuestion}=await import("./human.ts");
  const {projectBudget}=await import("./budget.ts");
  d.db.prepare("update memberships set role='member' where org_id=? and user_id=?").run(org,member.id);
  d.updateProject(p.id,org,{budget_usd_day:1,budget_timezone:"Europe/Paris"});
  d.db.prepare("insert into expenses (org_id,project_id,ts,usd) values (?,?,?,1)").run(org,p.id,Date.now());
  const waiting=await execute("a0000004");
  assert.equal(waiting.status,"queued");assert.ok(waiting.waiting_question_id);
  const question=getQuestion(waiting.waiting_question_id)!;
  await answerHuman(question,"2",{userId:owner.id});
  assert.equal(d.getTask(waiting.id)!.waiting_question_id,question.id);
  const next=projectBudget(org,p.id).resetsAt+1;
  mock.timers.enable({apis:["Date"],now:next});
  try {
    const finished=once(d.bus,"task:finished",{signal:AbortSignal.timeout(10000)});
    await tickHuman();await finished;
    assert.equal(d.getTask(waiting.id)!.status,"done");
    assert.equal(getQuestion(question.id)!.state,"expired");
  }finally{mock.timers.reset();}
});
