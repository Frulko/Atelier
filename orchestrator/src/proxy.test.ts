// Le proxy de modèles : jeton de tâche obligatoire, clé de l'organisation de la tâche (jamais une autre, jamais une
// clé globale), budget, routes autorisées. Un faux « fournisseur » enregistre ce qu'il reçoit.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const calls: { url: string; headers: http.IncomingHttpHeaders }[] = [];
const upstream = http.createServer((req, res) => {
  calls.push({ url: req.url!, headers: req.headers });
  req.resume();
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
