// Liste des tâches : filtres, pagination, bornes ; durée ; relance. Tout reste cloisonné par organisation.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
const db = await import("./db.ts");
const { hashPassword } = await import("./auth.ts");
const { createApp } = await import("./app.ts");

const hash = await hashPassword("motdepasse1");
const mk = (e: string) => db.createUser(e, hash);
const alice = mk("alice@a.fr"), max = mk("max@a.fr"), vera = mk("vera@a.fr"), bob = mk("bob@b.fr");
const orgA = db.createOrg("A", alice.id), orgB = db.createOrg("B", bob.id);
db.addMember(orgA, max.id, "member");
db.addMember(orgA, vera.id, "viewer");
const proj = (org: string, slug: string, name: string) => db.insertProject({ org_id: org, slug, name, repo: "https://gitlab.com/g/p.git", branch: "main", forge: "gitlab", check_cmd: "true", engine: "claude", protected_paths: "[]", git_secret_id: null });
const pRegis = proj(orgA, "regis", "MonRégis"), pSite = proj(orgA, "site", "Site vitrine"), pB = proj(orgB, "b", "Projet B");

// 7 tâches dans A, réparties sur deux projets, deux demandeurs et plusieurs statuts ; 1 dans B
const t = (id: string, org: string, user: string, project: string, prompt: string, status: string, ageDays: number) => {
  db.createTask(id, org, user, project, prompt);
  db.updateTask(id, { status: status as never });
  db.updateTaskCreatedAtForTest(id, Date.now() - ageDays * 86400_000);
};
t("a0000001", orgA, alice.id, pRegis, "ajoute le tarif dégressif", "done", 1);
t("a0000002", orgA, alice.id, pRegis, "corrige la TVA", "failed", 2);
t("a0000003", orgA, max.id, pRegis, "renomme un onglet", "done", 3);
t("a0000004", orgA, max.id, pSite, "change la couleur du bouton", "done", 5);
t("a0000005", orgA, max.id, pSite, "100% de couverture_test", "cancelled", 10);
t("a0000006", orgA, alice.id, pSite, "ajoute une page contact", "no_changes", 20);
t("a0000007", orgA, alice.id, pRegis, "tâche en cours", "running", 0);
t("b0000001", orgB, bob.id, pB, "tâche de B", "done", 1);

const server = createApp().listen(0);
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function login(email: string) {
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "motdepasse1" }) });
  return r.headers.get("set-cookie")!.split(";")[0];
}
const call = (cookie: string, method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
const cA = await login("alice@a.fr"), cM = await login("max@a.fr"), cV = await login("vera@a.fr"), cB = await login("bob@b.fr");
const A = `/api/orgs/${orgA}`;
type Page = { items: { id: string; project_name: string; user_email: string }[]; total: number; limit: number; offset: number };
const list = async (query = "", cookie = cA) => (await (await call(cookie, "GET", `${A}/tasks${query}`)).json()) as Page;
const ids = (p: Page) => p.items.map((i) => i.id);

test("liste : tâches de l'organisation seulement, la plus récente d'abord, avec demandeur et nom du projet", async () => {
  const p = await list();
  assert.equal(p.total, 7);
  assert.deepEqual(ids(p), ["a0000007", "a0000001", "a0000002", "a0000003", "a0000004", "a0000005", "a0000006"]);
  assert.equal(p.items[1].project_name, "MonRégis");
  assert.equal(p.items[1].user_email, "alice@a.fr");
  assert.ok(!ids(p).includes("b0000001"));
});

test("filtres : statut (un ou plusieurs), projet, demandeur, texte, période", async () => {
  assert.deepEqual(ids(await list("?status=done")), ["a0000001", "a0000003", "a0000004"]);
  assert.deepEqual(ids(await list("?status=failed,cancelled")), ["a0000002", "a0000005"]);
  assert.deepEqual(ids(await list(`?project=${pSite}`)), ["a0000004", "a0000005", "a0000006"]);
  assert.deepEqual(ids(await list(`?user=${max.id}`)), ["a0000003", "a0000004", "a0000005"]);
  assert.deepEqual(ids(await list("?q=TVA")), ["a0000002"]); // insensible à la casse
  assert.deepEqual(ids(await list(`?project=${pRegis}&status=done&user=${alice.id}`)), ["a0000001"]); // cumul
  const from = Date.now() - 4 * 86400_000, to = Date.now() - 0.5 * 86400_000;
  assert.deepEqual(ids(await list(`?from=${from}&to=${to}`)), ["a0000001", "a0000002", "a0000003"]);
});

test("filtres : les caractères spéciaux du texte sont littéraux (pas de joker, pas d'injection)", async () => {
  assert.deepEqual(ids(await list("?q=100%25")), ["a0000005"]); // « 100% » cherché tel quel
  assert.deepEqual(ids(await list("?q=%25")), ["a0000005"]);       // % seul ne correspond pas à tout
  assert.deepEqual(ids(await list("?q=couverture_test")), ["a0000005"]);
  assert.equal((await list("?q=_")).total, 1);                     // _ n'est pas « n'importe quel caractère »
  assert.equal((await list(`?q=${encodeURIComponent("' or 1=1 --")}`)).total, 0);
  assert.equal((await list("?status=drop%20table,done")).total, 3); // statut inconnu ignoré
});

test("pagination : total constant, bornes de limit, offset", async () => {
  const p1 = await list("?limit=3&offset=0"), p2 = await list("?limit=3&offset=3"), p3 = await list("?limit=3&offset=6");
  assert.deepEqual([p1.items.length, p2.items.length, p3.items.length], [3, 3, 1]);
  assert.deepEqual([p1.total, p2.total, p3.total], [7, 7, 7]);
  assert.deepEqual([...ids(p1), ...ids(p2), ...ids(p3)], ids(await list()));
  assert.equal((await list("?limit=100000")).limit, 100); // plafonné
  assert.equal((await list("?limit=0")).limit, 1);
  assert.equal((await list("?offset=-5")).offset, 0);
  assert.equal((await list("?limit=abc&offset=xyz")).limit, 25); // valeurs invalides ignorées
});

test("cloisonnement : l'identifiant d'un projet ou d'un demandeur d'une autre organisation ne fait rien fuiter", async () => {
  assert.equal((await list(`?project=${pB}`)).total, 0);
  assert.equal((await list(`?user=${bob.id}`)).total, 0);
  assert.equal((await call(cB, "GET", `${A}/tasks`)).status, 404);
  const b = (await (await call(cB, "GET", `/api/orgs/${orgB}/tasks`)).json()) as Page;
  assert.deepEqual(ids(b), ["b0000001"]);
});

test("durée : début au passage en « running », fin à l'état terminal", async () => {
  db.createTask("a0000099", orgA, alice.id, pRegis, "durée");
  let task = db.getTask("a0000099")!;
  assert.equal(task.started_at, null);
  db.updateTask("a0000099", { status: "running" });
  task = db.getTask("a0000099")!;
  assert.ok(task.started_at && !task.finished_at);
  db.updateTask("a0000099", { status: "done" });
  task = db.getTask("a0000099")!;
  assert.ok(task.finished_at && task.finished_at >= task.started_at!);
});

test("détail : demandeur, nom du projet, fichiers ; autre organisation : 404", async () => {
  db.updateTask("a0000001", { files_json: JSON.stringify(["app.js", "db/x.sql"]), flagged: 1 });
  const d = await (await call(cA, "GET", `${A}/tasks/a0000001`)).json() as { user_email: string; project_name: string; files_json: string; flagged: number };
  assert.equal(d.user_email, "alice@a.fr");
  assert.equal(d.project_name, "MonRégis");
  assert.deepEqual(JSON.parse(d.files_json), ["app.js", "db/x.sql"]);
  assert.equal(d.flagged, 1);
  assert.equal((await call(cB, "GET", `${A}/tasks/a0000001`)).status, 404);
});

test("relance : crée une NOUVELLE tâche au nom de celui qui relance ; lecteur 403 ; autre organisation 404", async () => {
  assert.equal((await call(cV, "POST", `${A}/tasks/a0000002/retry`)).status, 403);
  assert.equal((await call(cB, "POST", `${A}/tasks/a0000002/retry`)).status, 404);
  const r = await call(cM, "POST", `${A}/tasks/a0000002/retry`);
  assert.equal(r.status, 201);
  const n = await r.json() as { id: string; prompt: string; user_email: string; status: string };
  assert.notEqual(n.id, "a0000002");
  assert.equal(n.prompt, "corrige la TVA");
  assert.equal(n.user_email, "max@a.fr");
  assert.equal(db.getTask("a0000002")!.status, "failed"); // l'originale n'a pas bougé
});

test("relance : refusée si le projet n'existe plus (400) ou si le budget est épuisé (402)", async () => {
  db.createTask("a0000050", orgA, alice.id, "projet-supprime", "orpheline");
  assert.equal((await call(cA, "POST", `${A}/tasks/a0000050/retry`)).status, 400);
  db.setOrgBudget(orgA, 0.01);
  db.updateTask("a0000001", { cost: 5 });
  assert.equal((await call(cA, "POST", `${A}/tasks/a0000001/retry`)).status, 402);
});
