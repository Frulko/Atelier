// Connaissances : sélection sous budget (unitaire) et API (droits, cloisonnement, validation, cascades, audit).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
const db = await import("./db.ts");
const { selectKnowledge, renderKnowledge, terms, MAX_ITEMS, MAX_ITEM_CHARS } = await import("./knowledge.ts");
const { hashPassword } = await import("./auth.ts");
const { createApp } = await import("./app.ts");

type K = import("./db.ts").KnowledgeRow;
let n = 0;
const k = (title: string, content: string, o: Partial<K> = {}): K => ({ id: `k${++n}`, org_id: "o", project_id: null, title, content, enabled: 1, pinned: 0, created_by: null, created_at: 1000 + n, updated_at: 1000 + n, ...o });

/* ------------------------------------ sélection ------------------------------------ */

test("tout ce qui est activé est inclus tant que ça tient : épinglées d'abord, puis les plus récentes", () => {
  const a = k("Ancienne", "x"), b = k("Épinglée", "y", { pinned: 1 }), c = k("Récente", "z");
  const r = selectKnowledge([a, b, c], null, "peu importe");
  assert.deepEqual(r.chosen.map((x) => x.title), ["Épinglée", "Récente", "Ancienne"]);
  assert.equal(r.omitted.length, 0);
});

test("désactivées exclues ; connaissances d'un AUTRE projet exclues ; celles de l'organisation toujours incluses", () => {
  const off = k("Off", "x", { enabled: 0 }), orgWide = k("Orga", "x"), mine = k("Mon projet", "x", { project_id: "p1" }), other = k("Autre projet", "x", { project_id: "p2" });
  const r = selectKnowledge([off, orgWide, mine, other], "p1", "");
  assert.deepEqual(r.chosen.map((x) => x.title).sort(), ["Mon projet", "Orga"]);
  assert.deepEqual(selectKnowledge([mine, other, orgWide], null, "").chosen.map((x) => x.title), ["Orga"]); // sans projet : seulement l'organisation
});

test("au-delà du budget : classement par pertinence (accents ignorés), le budget n'est jamais dépassé", () => {
  const filler = "a".repeat(400);
  const tarif = k("Tarif dégressif", `Règle : ${filler}`), tva = k("TVA", `Taux ${filler}`), voyage = k("Voyage", `Trajets ${filler}`);
  const r = selectKnowledge([tva, tarif, voyage], null, "comment calculer le tarif degressif ?", 900);
  assert.equal(r.chosen[0]!.title, "Tarif dégressif");           // « degressif » trouve « dégressif »
  assert.ok(r.chars <= 900);
  assert.equal(r.chosen.length + r.omitted.length, 3);
  assert.ok(r.omitted.length >= 1);
});

test("au-delà du budget : une épinglée passe avant une plus pertinente ; un élément trop gros est sauté, pas tronqué", () => {
  const big = k("Énorme", "b".repeat(5000)), pinned = k("Toujours là", "c".repeat(300), { pinned: 1 }), match = k("Pertinent", "d".repeat(300));
  const r = selectKnowledge([big, match, pinned], null, "pertinent", 700);
  assert.deepEqual(r.chosen.map((x) => x.title), ["Toujours là", "Pertinent"]);
  assert.deepEqual(r.omitted.map((x) => x.title), ["Énorme"]);
  assert.ok(r.chosen.every((x) => x.content.length === 300)); // aucun contenu tronqué
});

test("question vide : on retombe sur les plus récentes ; terms ignore mots vides et mots courts", () => {
  const old = k("Vieux", "x".repeat(500), { updated_at: 1 }), fresh = k("Frais", "y".repeat(500), { updated_at: 99 });
  assert.equal(selectKnowledge([old, fresh], null, "", 600).chosen[0]!.title, "Frais");
  assert.deepEqual([...terms("Comment faire le calcul de la TVA ?")].sort(), ["calcul", "tva"]);
});

test("renderKnowledge : chaque élément est nommé et délimité ; rien si aucune connaissance", () => {
  assert.equal(renderKnowledge([]), "");
  const t = renderKnowledge([k("Charte", "Ton chaleureux")]);
  assert.match(t, /# Connaissances de l'organisation/);
  assert.match(t, /## Charte\nTon chaleureux/);
  assert.match(t, /pas des instructions/); // les connaissances sont des informations, pas des ordres
});

/* ---------------------------------------- API ---------------------------------------- */

const hash = await hashPassword("motdepasse1");
const mk = (e: string) => db.createUser(e, hash);
const alice = mk("alice@a.fr"), max = mk("max@a.fr"), vera = mk("vera@a.fr"), bob = mk("bob@b.fr");
const orgA = db.createOrg("A", alice.id), orgB = db.createOrg("B", bob.id);
db.addMember(orgA, max.id, "member"); db.addMember(orgA, vera.id, "viewer");
const proj = (org: string, slug: string) => db.insertProject({ org_id: org, slug, name: `Projet ${slug}`, repo: "https://gitlab.com/g/p.git", branch: "main", forge: "gitlab", check_cmd: "true", engine: "claude", protected_paths: "[]", git_secret_id: null });
const pA = proj(orgA, "a"), pB = proj(orgB, "b");

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
type Item = { id: string; title: string; content?: string; excerpt?: string; projectId: string | null; enabled: boolean; pinned: boolean; chars?: number };

test("un administrateur crée, modifie et supprime ; la réponse porte le contenu complet", async () => {
  const r = await call(cA, "POST", `${A}/knowledge`, { title: "  Charte du site ", content: "Ton chaleureux.\nCouleurs : crème et brun.", pinned: true });
  assert.equal(r.status, 201);
  const it = (await r.json()) as Item;
  assert.equal(it.title, "Charte du site");                 // espaces retirés
  assert.deepEqual([it.enabled, it.pinned, it.projectId], [true, true, null]);
  assert.match(it.content!, /crème et brun/);
  const p = await call(cA, "PATCH", `${A}/knowledge/${it.id}`, { enabled: false, title: "Charte graphique" });
  assert.equal(p.status, 200);
  assert.deepEqual([((await p.json()) as Item).title, ((await db.getKnowledge(it.id, orgA)))!.enabled], ["Charte graphique", 0]);
  assert.equal((await call(cA, "DELETE", `${A}/knowledge/${it.id}`)).status, 200);
  assert.equal((await call(cA, "GET", `${A}/knowledge/${it.id}`)).status, 404);
});

test("lecture ouverte à tous les rôles (liste sans contenu, détail avec) ; écriture réservée aux administrateurs", async () => {
  const id = ((await (await call(cA, "POST", `${A}/knowledge`, { title: "Glossaire", content: "TVA = taxe." })).json()) as Item).id;
  for (const c of [cM, cV]) {
    const list = (await (await call(c, "GET", `${A}/knowledge`)).json()) as Item[];
    assert.ok(list.some((x) => x.id === id));
    assert.ok(list.every((x) => !("content" in x) && x.excerpt !== undefined)); // la liste ne renvoie pas les contenus complets
    assert.match(((await (await call(c, "GET", `${A}/knowledge/${id}`)).json()) as Item).content!, /taxe/);
    assert.equal((await call(c, "POST", `${A}/knowledge`, { title: "x", content: "y" })).status, 403);
    assert.equal((await call(c, "PATCH", `${A}/knowledge/${id}`, { title: "z" })).status, 403);
    assert.equal((await call(c, "DELETE", `${A}/knowledge/${id}`)).status, 403);
  }
});

test("cloisonnement : une autre organisation ne voit, ne modifie, ne supprime rien — même avec l'identifiant exact", async () => {
  const id = ((await (await call(cA, "POST", `${A}/knowledge`, { title: "Secret métier", content: "confidentiel" })).json()) as Item).id;
  for (const [m, path] of [["GET", `${A}/knowledge`], ["GET", `${A}/knowledge/${id}`], ["PATCH", `${A}/knowledge/${id}`], ["DELETE", `${A}/knowledge/${id}`], ["POST", `${A}/knowledge/preview`]] as const)
    assert.equal((await call(cB, m, path, m === "GET" || m === "DELETE" ? undefined : { title: "pirate", query: "x" })).status, 404, `${m} ${path}`);
  assert.equal((await call(cB, "GET", `/api/orgs/${orgB}/knowledge/${id}`)).status, 404);   // via MON organisation : introuvable
  assert.equal((await call(cB, "PATCH", `/api/orgs/${orgB}/knowledge/${id}`, { title: "pirate" })).status, 404);
  assert.equal(db.getKnowledge(id, orgA)!.title, "Secret métier");
  assert.ok(!(JSON.stringify(await (await call(cB, "GET", `/api/orgs/${orgB}/knowledge`)).json())).includes("Secret métier"));
});

test("validation : titre, contenu, taille, projet d'une autre organisation, types", async () => {
  for (const bad of [{}, { title: "", content: "x" }, { title: "x".repeat(121), content: "x" }, { title: "ok", content: "   " }, { title: "ok", content: "x".repeat(MAX_ITEM_CHARS + 1) }, { title: 5, content: "x" }, { title: "ok", content: "x", pinned: "oui" }, { title: "ok", content: "x", projectId: pB }, { title: "ok", content: "x", projectId: 7 }])
    assert.equal((await call(cA, "POST", `${A}/knowledge`, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  assert.equal((await call(cA, "POST", `${A}/knowledge`, { title: "limite", content: "x".repeat(MAX_ITEM_CHARS) })).status, 201); // exactement la taille maximale
  const id = ((await (await call(cA, "POST", `${A}/knowledge`, { title: "pour modif", content: "x" })).json()) as Item).id;
  assert.equal((await call(cA, "PATCH", `${A}/knowledge/${id}`, {})).status, 400);                 // rien à modifier
  assert.equal((await call(cA, "PATCH", `${A}/knowledge/${id}`, { projectId: pB })).status, 400); // projet étranger
  assert.equal((await call(cA, "PATCH", `${A}/knowledge/${id}`, { projectId: pA })).status, 200);
});

test("limite de 200 éléments par organisation → 409", async () => {
  const org = db.createOrg("Pleine", alice.id);
  for (let i = 0; i < MAX_ITEMS; i++) db.insertKnowledge({ org_id: org, project_id: null, title: `t${i}`, content: "c", enabled: true, pinned: false, created_by: alice.id });
  assert.equal((await call(cA, "POST", `/api/orgs/${org}/knowledge`, { title: "de trop", content: "x" })).status, 409);
});

test("aperçu : la même sélection que celle qui sert vraiment, bornée au projet demandé", async () => {
  const org = db.createOrg("Aperçu", alice.id), pr = proj(org, "ap"), other = proj(org, "autre");
  db.insertKnowledge({ org_id: org, project_id: null, title: "Pour tous", content: "général", enabled: true, pinned: false, created_by: alice.id });
  db.insertKnowledge({ org_id: org, project_id: pr, title: "Pour ce projet", content: "précis", enabled: true, pinned: false, created_by: alice.id });
  db.insertKnowledge({ org_id: org, project_id: other, title: "Pour l'autre", content: "ailleurs", enabled: true, pinned: false, created_by: alice.id });
  db.insertKnowledge({ org_id: org, project_id: null, title: "Désactivée", content: "non", enabled: false, pinned: false, created_by: alice.id });
  const r = (await (await call(cA, "POST", `/api/orgs/${org}/knowledge/preview`, { projectId: pr, query: "peu importe" })).json()) as { chosen: { title: string }[]; budget: number; chars: number };
  assert.deepEqual(r.chosen.map((x) => x.title).sort(), ["Pour ce projet", "Pour tous"]);
  assert.equal(r.budget, 24000);
  assert.equal((await call(cA, "POST", `/api/orgs/${org}/knowledge/preview`, { projectId: pB })).status, 400); // projet d'une autre organisation
});

test("cascades : supprimer un projet supprime ses connaissances ; supprimer l'organisation supprime tout", async () => {
  const org = db.createOrg("Cascade", alice.id), pr = proj(org, "casc");
  const own = db.insertKnowledge({ org_id: org, project_id: pr, title: "Du projet", content: "x", enabled: true, pinned: false, created_by: alice.id });
  const wide = db.insertKnowledge({ org_id: org, project_id: null, title: "De l'organisation", content: "x", enabled: true, pinned: false, created_by: alice.id });
  db.deleteProject(pr, org);
  assert.equal(db.getKnowledge(own, org), undefined);
  assert.ok(db.getKnowledge(wide, org));
  db.deleteOrgCascade(org);
  assert.equal(db.getKnowledge(wide, org), undefined);
});

test("audit : création, modification et suppression sont journalisées, SANS le contenu", async () => {
  const SECRETISH = "contenu-tres-sensible-xyz";
  const id = ((await (await call(cA, "POST", `${A}/knowledge`, { title: "Journalisée", content: SECRETISH })).json()) as Item).id;
  await call(cA, "PATCH", `${A}/knowledge/${id}`, { content: SECRETISH + "2", pinned: true });
  await call(cA, "DELETE", `${A}/knowledge/${id}`);
  const all = db.queryAudit(orgA, { action: "knowledge." }, 1000);
  const mine = all.items.filter((e) => e.target_id === id).map((e) => e.action).sort();
  assert.deepEqual(mine, ["knowledge.create", "knowledge.delete", "knowledge.update"]);
  assert.ok(!JSON.stringify(all).includes(SECRETISH), "le contenu est dans le journal");
});
