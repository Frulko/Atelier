// Le proxy de modèles : jeton de tâche obligatoire, clé de l'organisation de la tâche (jamais une autre, jamais une
// clé globale), budget, routes autorisées. Un faux « fournisseur » enregistre ce qu'il reçoit.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

const calls: { url: string; headers: http.IncomingHttpHeaders }[] = [];
let streamClosed: Promise<unknown> | undefined;
const upstream = http.createServer((req, res) => {
  calls.push({ url: req.url!, headers: req.headers });
  req.resume();
  if (req.headers["anthropic-beta"] === "test-cancellation") {
    streamClosed = once(res, "close", { signal: AbortSignal.timeout(2000) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"message_start"}\n\n');
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
}).listen(0);
const up = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
process.env.ANTHROPIC_API_KEY = "sk-GLOBAL-ENV-KEY"; // ne doit JAMAIS atteindre un fournisseur
process.env.ATELIER_UPSTREAM_ANTHROPIC = up;
process.env.ATELIER_UPSTREAM_OPENAI = up;
const db = await import("./db.ts");
const V = await import("./vault.ts");
const T = await import("./tokens.ts");
const { createProxy } = await import("./proxy.ts");

const owner = db.createUser("o@x.fr", "h");
const orgA = db.createOrg("A", owner.id), orgB = db.createOrg("B", owner.id), orgC = db.createOrg("C", owner.id);
V.storeSecret(orgA, "provider_key", "anthropic", "a", "sk-ant-KEY-OF-A-0000");
V.storeSecret(orgA, "provider_key", "openai", "a", "sk-oa-KEY-OF-A-0000");
V.storeSecret(orgB, "provider_key", "anthropic", "b", "sk-ant-KEY-OF-B-0000");
// orgC : aucune clé

const proxy = createProxy().listen(0);
after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); });
const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

const send = (path: string, headers: Record<string, string> = {}, method = "POST") =>
  fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: method === "POST" ? "{}" : undefined });
const payload = (token: string, body: string, path = "/anthropic/v1/messages", headers = {}) =>
  fetch(base + path, { method: "POST", headers: { "x-api-key": token, ...headers }, body });
const anthropic = (token?: string) => send("/anthropic/v1/messages", token ? { "x-api-key": token } : {});
const before = () => calls.length;

test("sans jeton ou avec un faux jeton : 401, le fournisseur n'est pas appelé", async () => {
  const n = before();
  assert.equal((await anthropic()).status, 401);
  assert.equal((await anthropic("sk-ant-une-vraie-cle-volee")).status, 401);
  assert.equal((await anthropic("atl_inconnu")).status, 401);
  assert.equal(calls.length, n);
});

test("le fournisseur reçoit la clé de l'organisation de la tâche — pas celle d'une autre, pas la clé globale, pas le jeton", async () => {
  const tA = T.issueTaskToken("t1", orgA), tB = T.issueTaskToken("t2", orgB);

  assert.equal((await anthropic(tA)).status, 200);
  assert.equal(calls.at(-1)!.headers["x-api-key"], "sk-ant-KEY-OF-A-0000");

  assert.equal((await anthropic(tB)).status, 200);
  assert.equal(calls.at(-1)!.headers["x-api-key"], "sk-ant-KEY-OF-B-0000");

  for (const c of calls) {
    const all = JSON.stringify(c.headers);
    assert.ok(!all.includes("GLOBAL-ENV"), "clé globale divulguée");
    assert.ok(!all.includes("atl_"), "jeton de tâche transmis au fournisseur");
  }
});

test("organisation sans clé pour ce fournisseur : 403, pas de repli sur une autre clé", async () => {
  const n = before();
  assert.equal((await anthropic(T.issueTaskToken("t3", orgC))).status, 403);
  assert.equal((await send("/openai/v1/chat/completions", { authorization: `Bearer ${T.issueTaskToken("t4", orgB)}` })).status, 403); // B n'a pas de clé OpenAI (A en a une)
  assert.equal(calls.length, n);
});

test("chaque appel transmis est compté par organisation et par fournisseur (page d'usage)", async () => {
  const before = db.orgUsage(orgA, 1).byProvider.find((p) => p.provider === "anthropic")?.calls ?? 0;
  assert.equal((await anthropic(T.issueTaskToken("t0", orgA))).status, 200);
  assert.equal(db.orgUsage(orgA, 1).byProvider.find((p) => p.provider === "anthropic")!.calls, before + 1);
  const n = before;
  assert.equal((await anthropic("atl_inconnu")).status, 401); // un appel refusé ne compte pas
  assert.equal(db.orgUsage(orgA, 1).byProvider.find((p) => p.provider === "anthropic")!.calls, n + 1);
});

test("OpenAI : en-tête Authorization remplacé par la clé de l'organisation", async () => {
  const tA = T.issueTaskToken("t5", orgA);
  assert.equal((await send("/openai/v1/chat/completions", { authorization: `Bearer ${tA}` })).status, 200);
  assert.equal(calls.at(-1)!.headers.authorization, "Bearer sk-oa-KEY-OF-A-0000");
});

test("jeton révoqué (fin de tâche) : refusé", async () => {
  const t = T.issueTaskToken("t6", orgA);
  assert.equal((await anthropic(t)).status, 200);
  T.revokeTaskTokens("t6");
  assert.equal((await anthropic(t)).status, 401);
});

test("revoking a task token closes its already-running provider stream", async () => {
  const token = T.issueTaskToken("streaming-cancel", orgA);
  const response = await payload(token, "{}", undefined, { "anthropic-beta": "test-cancellation" });
  assert.equal(response.status, 200);
  assert.ok(streamClosed);
  T.revokeTaskTokens("streaming-cancel");
  await streamClosed;
  await response.body?.cancel();
});

test("a running task loses model access as soon as its requester's rights are removed", async () => {
  const user = db.createUser("agent-user@example.test", "hash");
  db.addMember(orgA, user.id, "member");
  const project=db.insertProject({org_id:orgA,slug:"guard",name:"Guard",repo:"https://github.com/example/test.git",branch:"main",forge:"none",check_cmd:"true",engine:"claude",protected_paths:"[]",git_secret_id:null});
  db.createTask("role-guard", orgA, user.id, project, "task");
  db.updateTask("role-guard", { status: "running" });
  const token = T.issueTaskToken("role-guard", orgA);
  assert.equal((await anthropic(token)).status, 200);
  db.db.prepare("update memberships set role='viewer' where org_id=? and user_id=?").run(orgA, user.id);
  const n = before();
  assert.equal((await anthropic(token)).status, 403);
  assert.equal(calls.length, n);
  T.revokeTaskTokens("role-guard");
});

test("budget mensuel épuisé : 402 ; sans plafond ou sous le plafond : accepté", async () => {
  const t = T.issueTaskToken("t7", orgA);
  db.createTask("aaaaaaa1", orgA, owner.id, "p", "x");
  db.updateTask("aaaaaaa1", { cost: 2 });
  db.setOrgBudget(orgA, 1);
  const n = before();
  assert.equal((await anthropic(t)).status, 402);
  assert.equal(calls.length, n);
  db.setOrgBudget(orgA, 5);
  assert.equal((await anthropic(t)).status, 200);
  db.setOrgBudget(orgA, null);
  assert.equal((await anthropic(t)).status, 200);
});

test("routes non autorisées : seulement la génération, en POST, vers les fournisseurs connus", async () => {
  const t = T.issueTaskToken("t8", orgA);
  const n = before();
  assert.equal((await send("/anthropic/v1/models", { "x-api-key": t })).status, 403);
  assert.equal((await send("/anthropic/v1/messages", { "x-api-key": t }, "GET")).status, 403);
  assert.equal((await send("/inconnu/v1/messages", { "x-api-key": t })).status, 403);
  assert.equal((await send("/", { "x-api-key": t })).status, 403);
  assert.equal(calls.length, n);
});

test("capabilities: model tokens cannot install packages, npm tokens cannot call models", async () => {
  const model = T.issueTaskToken("isolated-model", orgA);
  const npm = T.issueTaskToken("isolated-npm", orgA, "npm");
  assert.equal((await send("/npm/react", { authorization: `Bearer ${model}` })).status, 401);
  assert.equal((await anthropic(npm)).status, 401);
  assert.equal((await send("/anthropic/v1/messages/batches", { "x-api-key": model })).status, 403);
});

test("guarded dependency installation requires a running, authorized task in the token organization", async()=>{
  const route="/dependencies/install";
  assert.equal((await send(route)).status,403);
  assert.equal((await send(route,{authorization:`Bearer ${T.issueTaskToken("missing",orgA)}`})).status,403);
  const project=db.insertProject({org_id:orgA,slug:"npm-tools",name:"Npm tools",repo:"/nonexistent.git",branch:"main",forge:"none",check_cmd:"true",engine:"claude",protected_paths:"[]",git_secret_id:null});
  db.createTask("deed0011",orgA,owner.id,project,"Install dependencies");
  const token=T.issueTaskToken("deed0011",orgA);
  assert.equal((await send(route,{authorization:`Bearer ${token}`})).status,403);
  db.updateTask("deed0011",{status:"running"});
  assert.equal((await send(route,{authorization:`Bearer ${T.issueTaskToken("deed0011",orgA,"npm")}`})).status,403);
  assert.equal((await send(route,{authorization:`Bearer ${T.issueTaskToken("deed0011",orgB)}`})).status,403);
  const malformed=await fetch(base+route,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:"{broken"});
  assert.equal(malformed.status,400);
  db.db.prepare("update memberships set role='viewer' where org_id=? and user_id=?").run(orgA,owner.id);
  assert.equal((await send(route,{authorization:`Bearer ${token}`})).status,403);
  db.db.prepare("update memberships set role='owner' where org_id=? and user_id=?").run(orgA,owner.id);
  T.revokeTaskTokens("deed0011");db.updateTask("deed0011",{status:"cancelled"});
});

test("model request firewall rejects known secrets, Unicode escapes, headers and URLs before upstream", async () => {
  const t = T.issueTaskToken("firewall", orgA), n = before();
  const secret = "sk-ant-KEY-OF-A-0000";
  const escaped = [...secret].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  for (const body of [JSON.stringify({ messages: [{ content: secret }] }), `{"messages":[{"content":"${escaped}"}]}`, JSON.stringify({ [secret]: "hidden in a key" })]) {
    const res = await payload(t, body);
    assert.equal(res.status, 422);
    assert.ok(!(await res.text()).includes(secret));
  }
  assert.equal((await payload(t, "{}", `/anthropic/v1/messages?value=${secret}`)).status, 422);
  assert.equal((await payload(t, "{}", `/anthropic/v1/messages?value=${[...secret].map(c => `%${c.charCodeAt(0).toString(16)}`).join("")}`)).status, 422);
  assert.equal((await payload(t, "{}", undefined, { "anthropic-beta": secret })).status, 422);
  assert.equal(calls.length, n);
  assert.equal((await payload(t, JSON.stringify({ messages: [{ content: "Hello" }] }))).status, 200);
});

test("model request firewall bounds and validates JSON before contacting upstream", async () => {
  const t = T.issueTaskToken("malformed", orgA), n = before();
  for (const invalid of ["{broken", "[]", "null"])
    assert.equal((await payload(t, invalid)).status, 400);
  assert.equal((await payload(t, JSON.stringify({ text: "x".repeat(10_000_000) }))).status, 413);
  assert.equal(calls.length, n);
});

test("a provider key echoed across streaming chunks is redacted",async()=>{
  const {redactStream}=await import("./proxy.ts");
  const {Readable}=await import("node:stream");
  const key="sk-a-provider-key-that-must-stay-private";
  const stream=Readable.from([`avant ${key.slice(0,12)}`,`${key.slice(12)} après ${key}`]).pipe(redactStream(key));
  let out="";for await(const chunk of stream)out+=chunk.toString();
  assert.equal(out,"avant [redacted] après [redacted]");
});

test("stream redaction handles repeated keys at every chunk boundary",async()=>{
  const {redactStream}=await import("./proxy.ts");const {Readable}=await import("node:stream");
  const key="a-private-provider-value",text=`${key} some text ${key} tail ${key}`,expected=text.split(key).join("[redacted]");
  for(let index=1;index<text.length;index++){
    let out="";for await(const part of Readable.from([text.slice(0,index),text.slice(index)]).pipe(redactStream(key)))out+=part.toString();
    assert.equal(out,expected,`boundary ${index}`);
  }
});

test("a budgeted task cannot bypass its envelope through repeated direct proxy calls",async()=>{
  const b=await import("./budget.ts");
  const project=db.insertProject({org_id:orgA,slug:"meter-http",name:"Meter HTTP",repo:"https://github.com/example/test.git",branch:"main",forge:"none",check_cmd:"true",engine:"claude",protected_paths:"[]",git_secret_id:null});
  db.createTask("meter-http",orgA,owner.id,project,"Metering");db.updateTask("meter-http",{status:"running"});
  const hold=b.reserveBudget(orgA,project,0.03,"meter-http"),token=T.issueTaskToken("meter-http",orgA,"model",hold.id);
  const input=JSON.stringify({model:"claude-haiku-5-5",max_tokens:4096,messages:[{role:"user",content:"Hello"}]});
  const n=before();assert.equal((await payload(token,input)).status,200);
  assert.equal((await payload(token,input)).status,402);
  assert.equal(calls.length,n+1);
  T.revokeTaskTokens("meter-http");b.settleBudget(hold.id);
});
