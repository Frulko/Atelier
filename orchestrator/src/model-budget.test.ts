import {test} from "node:test";
import assert from "node:assert/strict";
import {Readable} from "node:stream";
process.env.DB_FILE=":memory:";process.env.ATELIER_PASSWORD="test";
const d=await import("./db.ts"),b=await import("./budget.ts"),m=await import("./model-budget.ts");
const user=d.createUser("meter@example.test","hash"),org=d.createOrg("Meter",user.id);
const project=d.insertProject({org_id:org,slug:"meter",name:"Meter",repo:"https://github.com/example/test.git",branch:"main",forge:"none",check_cmd:"true",engine:"claude",protected_paths:"[]",git_secret_id:null});
const payload={model:"claude-haiku-5-5",messages:[{role:"user",content:"Hello"}],max_tokens:4096};
test("per-call reservations refuse concurrent calls that exceed the envelope",()=>{
 const hold=b.reserveBudget(org,project,0.05);
 const a=m.reserveModelCall(hold.id,"anthropic",payload),another=m.reserveModelCall(hold.id,"anthropic",payload);
 assert.ok(a.upper+another.upper<=hold.amount);
 assert.throws(()=>m.reserveModelCall(hold.id,"anthropic",payload),/enveloppe restante/);
 b.settleBudget(hold.id);
 assert.ok(b.projectBudget(org,project).spentUsd>=a.upper+another.upper-1e-9);
});
test("unknown models, server tools and unpriced modifiers fail before forwarding",()=>{
 const hold=b.reserveBudget(org,project,2);
 for(const value of [{...payload,model:"unknown-model"},{...payload,speed:"fast"},{...payload,tools:[{type:"web_search_20250305"}]},{...payload,messages:[{content:[{type:"document",source:{type:"url",url:"https://example.test"}}]}]}])
  assert.throws(()=>m.reserveModelCall(hold.id,"anthropic",value));
 assert.throws(()=>m.reserveModelCall(hold.id,"anthropic",{...payload,model:"claude-opus-5-5"}),/pas autorisé/);
 assert.throws(()=>m.reserveModelCall(hold.id,"openai",payload));
 b.settleBudget(hold.id);
});
test("stream usage releases unused provision only after a complete provider response",async()=>{
 const hold=b.reserveBudget(org,project,1),call=m.reserveModelCall(hold.id,"anthropic",payload);
 const events=[{type:"message_start",message:{usage:{input_tokens:100,output_tokens:1}}},{type:"message_delta",usage:{output_tokens:20}},{type:"message_stop"}].map(e=>`data: ${JSON.stringify(e)}\n\n`).join("");
 let result="";for await(const chunk of Readable.from([...events].map(v=>Buffer.from(v))).pipe(m.meterModelStream(call)))result+=chunk;
 assert.equal(result,events);
 const cost=(d.db.prepare("select usd from model_charges where id=?").get(call.id) as {usd:number}).usd;
 assert.ok(cost>0 && cost<call.upper/10);
 b.settleBudget(hold.id);
 const other=b.reserveBudget(org,project,1),incomplete=m.reserveModelCall(other.id,"anthropic",payload);
 for await(const _ of Readable.from([events.split('data: {"type":"message_stop"}')[0]]).pipe(m.meterModelStream(incomplete))){}
 assert.equal((d.db.prepare("select usd from model_charges where id=?").get(incomplete.id) as {usd:number}).usd,incomplete.upper);
 b.settleBudget(other.id);
});
