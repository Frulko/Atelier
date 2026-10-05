// Organisations, membres, invitations : escalade de privilèges, dernier propriétaire, invitation à usage unique,
// jeton jamais stocké, et cloisonnement entre organisations.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
const db = await import("./db.ts");
const { hashPassword } = await import("./auth.ts");
const { createApp } = await import("./app.ts");
const { hashInviteToken } = await import("./invites.ts");
const { canAssign, canTouch } = await import("./access.ts");

const hash = await hashPassword("motdepasse1");
const mk = (e: string) => db.createUser(e, hash);
const owner = mk("owner@a.fr"), admin = mk("admin@a.fr"), member = mk("member@a.fr"), viewer = mk("viewer@a.fr"), eve = mk("eve@b.fr");
const orgA = db.createOrg("A", owner.id), orgB = db.createOrg("B", eve.id);
db.addMember(orgA, admin.id, "admin");
db.addMember(orgA, member.id, "member");
db.addMember(orgA, viewer.id, "viewer");

const server = createApp().listen(0);
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function login(email: string, password = "motdepasse1") {
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie")!.split(";")[0];
}
const call = (cookie: string | null, method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });

const cOwner = await login("owner@a.fr"), cAdmin = await login("admin@a.fr"), cMember = await login("member@a.fr"), cViewer = await login("viewer@a.fr"), cEve = await login("eve@b.fr");
const A = `/api/orgs/${orgA}`;
const invite = async (cookie: string, email: string, role: string) => call(cookie, "POST", `${A}/invitations`, { email, role });

test("règles de privilèges : on n'attribue qu'un rôle inférieur ou égal ; seul un propriétaire touche un propriétaire", () => {
  assert.ok(canAssign("owner", "owner") && canAssign("owner", "viewer"));
  assert.ok(canAssign("admin", "admin") && canAssign("admin", "member"));
  assert.ok(!canAssign("admin", "owner"));
  assert.ok(!canAssign("member", "viewer") && !canAssign("viewer", "viewer")); // ni membre ni lecteur n'attribuent
  assert.ok(canTouch("owner", "owner") && canTouch("admin", "member"));
  assert.ok(!canTouch("admin", "owner") && !canTouch("member", "viewer"));
});

test("créer une organisation : l'auteur en est propriétaire ; nom invalide refusé", async () => {
  const r = await call(cMember, "POST", "/api/orgs", { name: "Mon équipe" });
  assert.equal(r.status, 201);
  const o = await r.json() as { id: string; role: string };
  assert.equal(o.role, "owner");
  assert.equal(db.roleOf(o.id, member.id), "owner");
  assert.equal((await call(cMember, "POST", "/api/orgs", { name: "" })).status, 400);
  assert.equal((await call(cMember, "POST", "/api/orgs", { name: "x".repeat(81) })).status, 400);
  assert.equal((await call(null, "POST", "/api/orgs", { name: "x" })).status, 401);
});

test("membres et invitations : réservés aux administrateurs ; autre organisation : 404", async () => {
  for (const c of [cMember, cViewer]) {
    assert.equal((await call(c, "GET", `${A}/members`)).status, 403);
    assert.equal((await call(c, "GET", `${A}/invitations`)).status, 403);
    assert.equal((await invite(c, "x@y.fr", "viewer")).status, 403);
  }
  assert.equal((await call(cEve, "GET", `${A}/members`)).status, 404);
  assert.equal((await call(cEve, "GET", `${A}/invitations`)).status, 404);
  assert.equal((await invite(cEve, "x@y.fr", "viewer")).status, 404);
  const list = await (await call(cAdmin, "GET", `${A}/members`)).json() as { email: string; role: string }[];
  assert.deepEqual(list.map((m) => [m.email, m.role]), [["admin@a.fr", "admin"], ["member@a.fr", "member"], ["owner@a.fr", "owner"], ["viewer@a.fr", "viewer"]]);
});

test("invitation : un administrateur ne peut pas inviter en propriétaire ; entrées invalides refusées ; déjà membre → 409", async () => {
  assert.equal((await invite(cAdmin, "x@y.fr", "owner")).status, 403);
  assert.equal((await invite(cAdmin, "pas-un-mail", "member")).status, 400);
  assert.equal((await invite(cAdmin, "x@y.fr", "superuser")).status, 400);
  assert.equal((await invite(cAdmin, "member@a.fr", "viewer")).status, 409);
  assert.equal((await invite(cOwner, "x@y.fr", "owner")).status, 201); // le propriétaire, lui, le peut
});

test("invitation : le jeton n'est montré qu'à la création, jamais stocké en clair, jamais listé", async () => {
  const r = await invite(cAdmin, "Nouvelle@Personne.fr", "member");
  assert.equal(r.status, 201);
  const inv = await r.json() as { token: string; email: string };
  assert.ok(inv.token.startsWith("inv_"));
  assert.equal(inv.email, "nouvelle@personne.fr"); // normalisé
  const listed = await (await call(cAdmin, "GET", `${A}/invitations`)).text();
  assert.ok(!listed.includes(inv.token));
  assert.ok(!listed.includes(hashInviteToken(inv.token)));
  assert.ok(db.findInvitation(hashInviteToken(inv.token))); // seule l'empreinte permet de la retrouver
});

test("accepter : un nouveau compte est créé avec le bon rôle et une session ; le jeton ne sert qu'une fois", async () => {
  const inv = await (await invite(cOwner, "neuf@c.fr", "viewer")).json() as { token: string };
  assert.equal((await call(null, "POST", "/api/auth/accept-invite", { token: inv.token, password: "court" })).status, 400);
  assert.equal((await call(null, "POST", "/api/auth/accept-invite", { token: inv.token })).status, 400);
  const ok = await call(null, "POST", "/api/auth/accept-invite", { token: inv.token, password: "un-bon-mot-de-passe" });
  assert.equal(ok.status, 201);
  const cookie = ok.headers.get("set-cookie")!.split(";")[0];
  const me = await (await call(cookie, "GET", "/api/me")).json() as { user: { email: string }; orgs: { id: string; role: string }[] };
  assert.equal(me.user.email, "neuf@c.fr");
  assert.deepEqual(me.orgs.map((o) => [o.id, o.role]), [[orgA, "viewer"]]);
  assert.equal((await call(null, "POST", "/api/auth/accept-invite", { token: inv.token, password: "un-bon-mot-de-passe" })).status, 404); // déjà utilisée
  await login("neuf@c.fr", "un-bon-mot-de-passe"); // le mot de passe choisi fonctionne
});

test("accepter : jeton inconnu ou expiré → 404 identique", async () => {
  assert.equal((await call(null, "POST", "/api/auth/accept-invite", { token: "inv_inconnu", password: "un-bon-mot-de-passe" })).status, 404);
  const inv = await (await invite(cOwner, "expire@c.fr", "member")).json() as { token: string; id: string };
  db.insertInvitation(orgA, "expire@c.fr", "member", owner.id, hashInviteToken(inv.token), Date.now() - 1000); // remplace par une version expirée
  assert.equal((await call(null, "POST", "/api/auth/accept-invite", { token: inv.token, password: "un-bon-mot-de-passe" })).status, 404);
});

test("accepter avec un compte existant : connexion exigée (409) ; l'adresse doit correspondre (403) ; puis rôle ajouté", async () => {
  // eve (org B) est invitée dans l'org A sous SON adresse
  const inv = await (await invite(cOwner, "eve@b.fr", "member")).json() as { token: string };
  assert.equal((await call(null, "POST", "/api/auth/accept-invite", { token: inv.token, password: "un-bon-mot-de-passe" })).status, 409);
  // un autre compte connecté, même avec le jeton volé, est refusé
  assert.equal((await call(cMember, "POST", "/api/auth/accept-invite", { token: inv.token })).status, 403);
  assert.equal(db.roleOf(orgA, member.id), "member"); // inchangé
  // eve, connectée, accepte
  assert.equal((await call(cEve, "POST", "/api/auth/accept-invite", { token: inv.token })).status, 200);
  assert.equal(db.roleOf(orgA, eve.id), "member");
  assert.equal(db.roleOf(orgB, eve.id), "owner"); // son autre organisation n'a pas bougé
});

test("invitation : une nouvelle invitation remplace l'ancienne ; on peut la révoquer ; pas depuis une autre organisation", async () => {
  const first = await (await invite(cOwner, "rev@c.fr", "member")).json() as { token: string; id: string };
  const second = await (await invite(cOwner, "rev@c.fr", "viewer")).json() as { token: string; id: string };
  assert.equal(db.findInvitation(hashInviteToken(first.token)), undefined);
  assert.ok(db.findInvitation(hashInviteToken(second.token)));
  assert.equal((await call(cEve, "DELETE", `${A}/invitations/${second.id}`)).status, 403); // eve est membre de A (rôle member) : pas admin
  const cB = cEve;
  assert.equal((await call(cB, "DELETE", `/api/orgs/${orgB}/invitations/${second.id}`)).status, 404); // l'identifiant existe, mais dans une autre organisation
  assert.equal((await call(cAdmin, "DELETE", `${A}/invitations/${second.id}`)).status, 200);
  assert.equal(db.findInvitation(hashInviteToken(second.token)), undefined);
});

test("rôles : un administrateur change un membre mais ne peut ni toucher un propriétaire ni promouvoir en propriétaire", async () => {
  assert.equal((await call(cAdmin, "PATCH", `${A}/members/${viewer.id}`, { role: "member" })).status, 200);
  assert.equal(db.roleOf(orgA, viewer.id), "member");
  assert.equal((await call(cAdmin, "PATCH", `${A}/members/${viewer.id}`, { role: "owner" })).status, 403);
  assert.equal((await call(cAdmin, "PATCH", `${A}/members/${owner.id}`, { role: "member" })).status, 403);
  assert.equal((await call(cAdmin, "DELETE", `${A}/members/${owner.id}`)).status, 403);
  assert.equal((await call(cAdmin, "PATCH", `${A}/members/${viewer.id}`, { role: "dieu" })).status, 400);
  assert.equal(db.roleOf(orgA, owner.id), "owner");
});

test("dernier propriétaire : ni rétrogradé ni retiré ; avec deux propriétaires, c'est possible", async () => {
  assert.equal((await call(cOwner, "PATCH", `${A}/members/${owner.id}`, { role: "admin" })).status, 409);
  assert.equal((await call(cOwner, "DELETE", `${A}/members/${owner.id}`)).status, 409);
  assert.equal((await call(cOwner, "PATCH", `${A}/members/${admin.id}`, { role: "owner" })).status, 200); // un propriétaire peut en nommer un autre
  assert.equal((await call(cOwner, "PATCH", `${A}/members/${owner.id}`, { role: "admin" })).status, 200);
  assert.equal(db.countOwners(orgA), 1);
});

test("retirer un membre : il perd l'accès à l'organisation (404)", async () => {
  assert.equal((await call(cAdmin, "DELETE", `${A}/members/${member.id}`)).status, 200);
  assert.equal((await call(cMember, "GET", `${A}/tasks`)).status, 404);
  assert.equal((await call(cAdmin, "DELETE", `${A}/members/${member.id}`)).status, 404); // déjà retiré
});
