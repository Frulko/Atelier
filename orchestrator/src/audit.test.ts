// Journal d'audit : ce qui est enregistré, qui peut le lire, les filtres, l'export CSV — et surtout ce qui n'y entre JAMAIS.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
const db = await import("./db.ts");
const { hashPassword } = await import("./auth.ts");
const { createApp } = await import("./app.ts");
const { auditToCsv } = await import("./audit.ts");

const hash = await hashPassword("motdepasse1");
const mk = (e: string) => db.createUser(e, hash);
const owner = mk("owner@a.fr"), adam = mk("adam@a.fr"), max = mk("max@a.fr"), vera = mk("vera@a.fr"), bob = mk("bob@b.fr");
const orgA = db.createOrg("A", owner.id), orgB = db.createOrg("B", bob.id);
db.addMember(orgA, adam.id, "admin"); db.addMember(orgA, max.id, "member"); db.addMember(orgA, vera.id, "viewer");

const server = createApp().listen(0);
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const loginRaw = (email: string, password = "motdepasse1") =>
  fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
async function login(email: string) { return (await loginRaw(email)).headers.get("set-cookie")!.split(";")[0]; }
const call = (cookie: string, method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });

const cOwner = await login("owner@a.fr"), cAdam = await login("adam@a.fr"), cMax = await login("max@a.fr"), cVera = await login("vera@a.fr"), cBob = await login("bob@b.fr");
const A = `/api/orgs/${orgA}`, B = `/api/orgs/${orgB}`;
type Item = { id: number; ts: number; action: string; userEmail: string | null; userId: string; targetType: string | null; targetId: string | null; meta: Record<string, unknown> | null; ip: string | null };
type Page = { items: Item[]; total: number };
const audit = async (q = "", c = cAdam) => (await (await call(c, "GET", `${A}/audit${q}`)).json()) as Page;
const actions = (p: Page) => p.items.map((i) => i.action);

const SECRET = "glpat-VERY-SECRET-TOKEN-9999";
let secretId = "", projectId = "", inviteToken = "", inviteId = "", taskId = "";

test("les actions sensibles sont enregistrées avec leur auteur, leur cible et leur adresse", async () => {
  secretId = ((await (await call(cAdam, "POST", `${A}/secrets`, { kind: "git_token", label: "GitLab", value: SECRET })).json()) as { id: string }).id;
  projectId = ((await (await call(cAdam, "POST", `${A}/projects`, { slug: "regis", name: "MonRégis", repo: "https://gitlab.com/g/r.git", gitSecretId: secretId })).json()) as { id: string }).id;
  await call(cAdam, "PATCH", `${A}/projects/${projectId}`, { name: "MonRégis 2", check: "true" });
  const inv = (await (await call(cAdam, "POST", `${A}/invitations`, { email: "new@x.fr", role: "member" })).json()) as { id: string; token: string };
  inviteId = inv.id; inviteToken = inv.token;
  await call(cAdam, "PATCH", `${A}/members/${max.id}`, { role: "viewer" });
  await call(cAdam, "PATCH", `${A}/members/${max.id}`, { role: "member" });
  await call(cOwner, "PATCH", `${A}`, { budgetUsdMonth: 25 });
  await call(cAdam, "DELETE", `${A}/invitations/${inviteId}`);
  taskId = ((await (await call(cMax, "POST", `${A}/tasks`, { project: projectId, prompt: "fais quelque chose" })).json()) as { id: string }).id;
  await call(cMax, "POST", `${A}/tasks/${taskId}/cancel`);

  const p = await audit();
  for (const a of ["secret.create", "project.create", "project.update", "invitation.create", "member.role", "org.budget_set", "invitation.revoke", "task.create", "task.cancel"])
    assert.ok(actions(p).includes(a), `manque ${a}`);
  const sec = p.items.find((i) => i.action === "secret.create")!;
  assert.equal(sec.userEmail, "adam@a.fr");
  assert.equal(sec.targetId, secretId);
  assert.deepEqual(sec.meta, { kind: "git_token", provider: null, label: "GitLab" });
  assert.ok(sec.ip, "adresse IP absente");
  const role = p.items.find((i) => i.action === "member.role")!;
  assert.deepEqual([role.meta!.email, role.meta!.from, role.meta!.to].length, 3);
  assert.equal(p.items.find((i) => i.action === "task.create")!.userEmail, "max@a.fr");
  assert.deepEqual(p.items.find((i) => i.action === "project.update")!.meta!.fields, ["name", "check"]);
});

test("JAMAIS de secret dans le journal : ni valeur de jeton, ni lien d'invitation, ni mot de passe", async () => {
  await call(cAdam, "DELETE", `${A}/projects/${projectId}`);
  await call(cAdam, "DELETE", `${A}/secrets/${secretId}`);
  await call(cOwner, "POST", "/api/auth/password", { current: "motdepasse1", next: "NouveauMdp-12345" });
  const everything = JSON.stringify(db.queryAudit(orgA, {}, 100000)) + JSON.stringify(db.userActivity(owner.id, 200));
  for (const forbidden of [SECRET, "VERY-SECRET", inviteToken, "inv_", "motdepasse1", "NouveauMdp-12345"])
    assert.ok(!everything.includes(forbidden), `le journal contient « ${forbidden} »`);
  assert.ok(everything.includes("secret.delete") && everything.includes("GitLab")); // en revanche le libellé y est
});

test("lecture réservée aux administrateurs : membre et lecteur 403, autre organisation 404", async () => {
  for (const c of [cMax, cVera]) {
    assert.equal((await call(c, "GET", `${A}/audit`)).status, 403);
    assert.equal((await call(c, "GET", `${A}/audit?format=csv`)).status, 403);
  }
  assert.equal((await call(cBob, "GET", `${A}/audit`)).status, 404);
  assert.equal((await call(cBob, "GET", `${A}/audit?format=csv`)).status, 404);
});

test("cloisonnement : le journal de B ne contient rien de A, et inversement", async () => {
  await call(cBob, "POST", `${B}/secrets`, { kind: "git_token", label: "Secret de B", value: "ghp_token_de_b_000000" });
  const a = await audit(), b = (await (await call(cBob, "GET", `${B}/audit`)).json()) as Page;
  assert.ok(!JSON.stringify(a).includes("Secret de B"));
  assert.ok(JSON.stringify(b).includes("Secret de B") && !JSON.stringify(b).includes("GitLab"));
  assert.ok(b.items.every((i) => i.userEmail === "bob@b.fr"));
});

test("filtres : préfixe d'action, action exacte, auteur, texte, période", async () => {
  assert.ok(actions(await audit("?action=member.")).every((a) => a.startsWith("member.")));
  assert.deepEqual(actions(await audit("?action=secret.create")), ["secret.create"]);
  const byMax = await audit(`?user=${max.id}`);
  assert.ok(byMax.total >= 2 && byMax.items.every((i) => i.userEmail === "max@a.fr"));
  assert.ok(actions(await audit("?q=new%40x.fr")).includes("invitation.create")); // texte dans les détails
  assert.ok((await audit("?q=adam")).total > 0); // …ou dans l'e-mail de l'auteur
  assert.equal((await audit("?q=%25")).total, 0);  // « % » est littéral, pas un joker
  assert.equal((await audit(`?from=${Date.now() + 60_000}`)).total, 0);
  assert.equal((await audit(`?to=${Date.now() - 86400_000}`)).total, 0);
  assert.equal((await audit("?action=nope.")).total, 0);
});

test("pagination : total constant, limite plafonnée, ordre du plus récent au plus ancien", async () => {
  const all = await audit("?limit=100");
  assert.ok(all.total >= 10);
  const p1 = await audit("?limit=4&offset=0"), p2 = await audit("?limit=4&offset=4");
  assert.equal(p1.total, all.total);
  assert.deepEqual([...p1.items, ...p2.items].map((i) => i.id), all.items.slice(0, 8).map((i) => i.id));
  assert.ok(all.items.every((it, i) => i === 0 || all.items[i - 1].ts >= it.ts));
  assert.ok((await audit("?limit=999999")).items.length <= 100);
});

test("export CSV : en-têtes, une ligne par événement, et l'export lui-même est journalisé", async () => {
  const n = (await audit("?limit=100")).total;
  const r = await call(cAdam, "GET", `${A}/audit?format=csv`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /text\/csv/);
  assert.match(r.headers.get("content-disposition")!, /attachment/);
  const lines = (await r.text()).trim().split("\r\n");
  assert.equal(lines.length, n + 1);
  assert.ok(lines[0].includes("utilisateur") && lines[0].includes("action"));
  assert.ok(actions(await audit()).includes("audit.export"));
});

test("CSV : une cellule qui ressemble à une formule est neutralisée (injection CSV) et les guillemets sont échappés", () => {
  const csv = auditToCsv([{ id: 1, ts: 0, org_id: "o", user_id: "u", user_email: "=cmd|' /C calc'!A0", action: "x.y", target_type: "+SUM(A1)", target_id: "@a", meta: '{"a":"b \\"c\\""}', ip: "1.2.3.4" }]);
  const row = csv.split("\r\n")[1];
  assert.ok(row.includes(`"'=cmd`), row);
  assert.ok(row.includes(`"'+SUM`) && row.includes(`"'@a"`));
  assert.ok(!/(^|,)"[=+\-@]/.test(row), "une cellule commence par un caractère de formule");
  assert.ok(row.includes('""c'), "guillemets non échappés");
});

test("connexion : une réussite et un échec (compte existant) sont tracés ; un compte inconnu ne laisse aucune trace", async () => {
  const before = db.userActivity(vera.id).length;
  assert.equal((await loginRaw("vera@a.fr", "mauvais-mot-de-passe")).status, 401);
  assert.equal((await loginRaw("inconnu@nulle-part.fr", "mauvais-mot-de-passe")).status, 401);
  const mine = (await (await call(cVera, "GET", "/api/me/activity")).json()) as { action: string }[];
  assert.equal(mine.length, before + 1);
  assert.equal(mine[0].action, "auth.login_failed");
  assert.ok(mine.some((m) => m.action === "auth.login"));
  assert.equal(JSON.stringify(db.userActivity(vera.id)).includes("inconnu@nulle-part.fr"), false);
});

test("mon activité : seulement la mienne, avec le nom de l'organisation", async () => {
  const mine = (await (await call(cMax, "GET", "/api/me/activity")).json()) as { action: string; orgName: string | null }[];
  assert.ok(mine.length > 0);
  assert.ok(mine.some((m) => m.action === "task.create" && m.orgName === "A"));
  assert.ok(!mine.some((m) => m.action === "secret.create")); // c'est adam qui l'a fait
  assert.equal((await call("", "GET", "/api/me/activity")).status, 401);
});
