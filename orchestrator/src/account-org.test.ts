// Compte (profil, sessions actives) et réglages d'organisation (renommer, supprimer).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
const db = await import("./db.ts");
const { hashPassword } = await import("./auth.ts");
const { createApp } = await import("./app.ts");
const S = await import("./session.ts");

const hash = await hashPassword("motdepasse1");
const mk = (e: string) => db.createUser(e, hash);
const owner = mk("owner@a.fr"), adam = mk("adam@a.fr"), max = mk("max@a.fr"), bob = mk("bob@b.fr"), sam = mk("sam@a.fr");
const orgA = db.createOrg("Équipe A", owner.id), orgB = db.createOrg("Équipe B", bob.id);
db.addMember(orgA, adam.id, "admin"); db.addMember(orgA, max.id, "member");

const server = createApp().listen(0);
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function login(email: string, ua = "TestBrowser/1.0") {
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", "user-agent": ua }, body: JSON.stringify({ email, password: "motdepasse1" }) });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie")!.split(";")[0];
}
const call = (cookie: string, method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });

const cOwner = await login("owner@a.fr"), cAdam = await login("adam@a.fr"), cMax = await login("max@a.fr"), cBob = await login("bob@b.fr");
const A = `/api/orgs/${orgA}`;

/* ------------------------------------ profil ------------------------------------ */

test("profil : le nom s'enregistre, se retrouve dans /api/me, se vide ; valeurs invalides refusées", async () => {
  assert.equal(((await (await call(cMax, "GET", "/api/me")).json()) as { user: { name: string | null } }).user.name, null);
  assert.equal((await call(cMax, "PATCH", "/api/me", { name: "  Max Martin " })).status, 200);
  assert.equal(((await (await call(cMax, "GET", "/api/me")).json()) as { user: { name: string } }).user.name, "Max Martin");
  assert.equal((await call(cMax, "PATCH", "/api/me", { name: "x".repeat(81) })).status, 400);
  assert.equal((await call(cMax, "PATCH", "/api/me", { name: 42 })).status, 400);
  assert.equal((await call(cMax, "PATCH", "/api/me", { name: null })).status, 200);
  assert.equal(db.getUserById(max.id)!.name, null);
  assert.equal((await call("", "PATCH", "/api/me", { name: "x" })).status, 401);
});

/* ----------------------------------- sessions ----------------------------------- */

test("sessions : la liste montre navigateur, adresse et session courante ; jamais le jeton", async () => {
  const phone = await login("max@a.fr", "PhoneBrowser/2.0");
  const list = (await (await call(cMax, "GET", "/api/me/sessions")).json()) as { id: string; userAgent: string; ip: string; current: boolean; lastUsedAt: number }[];
  assert.equal(list.length, 2);
  assert.equal(list.filter((x) => x.current).length, 1);
  assert.deepEqual(list.map((x) => x.userAgent).sort(), ["PhoneBrowser/2.0", "TestBrowser/1.0"]);
  assert.ok(list.every((x) => x.ip && x.lastUsedAt > 0));
  const token = cMax.split("=")[1];
  assert.ok(!JSON.stringify(list).includes(token), "le jeton est exposé");
  assert.ok(list.every((x) => /^[0-9a-f]{16}$/.test(x.id)));
  // ce que voit l'autre appareil : la même liste, mais SA session est la courante
  const fromPhone = (await (await call(phone, "GET", "/api/me/sessions")).json()) as { userAgent: string; current: boolean }[];
  assert.equal(fromPhone.find((x) => x.current)!.userAgent, "PhoneBrowser/2.0");
});

test("sessions : révoquer une autre session la déconnecte ; on ne peut pas révoquer celle d'un autre compte", async () => {
  const phone = await login("max@a.fr", "PhoneBrowser/3.0");
  const mine = (await (await call(cMax, "GET", "/api/me/sessions")).json()) as { id: string; userAgent: string }[];
  const phoneId = mine.find((x) => x.userAgent === "PhoneBrowser/3.0")!.id;
  const adamSession = ((await (await call(cAdam, "GET", "/api/me/sessions")).json()) as { id: string }[])[0].id;

  assert.equal((await call(cMax, "DELETE", `/api/me/sessions/${adamSession}`)).status, 404); // la session d'adam
  assert.equal((await call(cAdam, "GET", "/api/me")).status, 200);                            // intacte
  assert.equal((await call(cMax, "DELETE", `/api/me/sessions/${phoneId}`)).status, 200);
  assert.equal((await call(phone, "GET", "/api/me")).status, 401);                            // déconnecté
  assert.equal((await call(cMax, "GET", "/api/me")).status, 200);                             // la mienne continue
  assert.equal((await call(cMax, "DELETE", `/api/me/sessions/${phoneId}`)).status, 404);      // déjà révoquée
  assert.equal((await call(cMax, "DELETE", "/api/me/sessions/court")).status, 404);
});

test("sessions : révoquer la session courante déconnecte ; « révoquer les autres » garde la courante", async () => {
  // un compte dédié : cet essai révoque toutes les autres sessions de la personne
  const a = await login("sam@a.fr", "A/1"), b = await login("sam@a.fr", "B/1"), c = await login("sam@a.fr", "C/1");
  assert.equal((await call(a, "POST", "/api/me/sessions/revoke-others")).status, 200);
  assert.equal((await call(a, "GET", "/api/me")).status, 200);
  for (const gone of [b, c]) assert.equal((await call(gone, "GET", "/api/me")).status, 401);
  const mine = ((await (await call(a, "GET", "/api/me/sessions")).json()) as { id: string; current: boolean }[]);
  assert.equal(mine.length, 1);
  const r = await call(a, "DELETE", `/api/me/sessions/${mine[0].id}`);
  assert.equal(((await r.json()) as { current: boolean }).current, true);
  assert.equal((await call(a, "GET", "/api/me")).status, 401);
});

test("sessions : dernière utilisation mise à jour au plus une fois par minute", () => {
  const t0 = Date.now() - 3600_000; // dans le passé, mais la session reste valide (elle dure 7 jours)
  const token = S.startSession(bob.id, t0, { userAgent: "UA", ip: "1.2.3.4" });
  const last = () => db.listSessions(bob.id).find((x) => x.user_agent === "UA")!.last_used_at;
  assert.equal(last(), t0);
  S.userFromToken(token, t0 + 30_000);
  assert.equal(last(), t0);               // trop tôt : pas d'écriture
  S.userFromToken(token, t0 + 120_000);
  assert.equal(last(), t0 + 120_000);
});

/* ------------------------------------ organisation ------------------------------------ */

test("renommer : un administrateur le peut ; membre 403 ; autre organisation 404 ; noms invalides 400 ; l'ancien nom est journalisé", async () => {
  assert.equal((await call(cMax, "PATCH", A, { name: "Pirate" })).status, 403);
  assert.equal((await call(cBob, "PATCH", A, { name: "Pirate" })).status, 404);
  for (const bad of ["", "   ", "x".repeat(81), 42, null]) assert.equal((await call(cAdam, "PATCH", A, { name: bad })).status, 400, JSON.stringify(bad));
  assert.equal((await call(cAdam, "PATCH", A, {})).status, 400);
  const r = await call(cAdam, "PATCH", A, { name: "  Équipe Alpha " });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { name: string }).name, "Équipe Alpha");
  assert.equal(db.getOrg(orgB)!.name, "Équipe B");
  const ev = db.queryAudit(orgA, { action: "org.rename" }).items[0];
  assert.deepEqual(JSON.parse(ev.meta!), { from: "Équipe A", to: "Équipe Alpha" });
});

test("supprimer : propriétaire seulement, confirmation par le nom exact, refusé si des tâches tournent", async () => {
  const name = "Équipe Alpha";
  assert.equal((await call(cAdam, "DELETE", A, { confirm: name })).status, 403);   // administrateur : non
  assert.equal((await call(cMax, "DELETE", A, { confirm: name })).status, 403);
  assert.equal((await call(cBob, "DELETE", A, { confirm: name })).status, 404);    // autre organisation
  assert.equal((await call(cOwner, "DELETE", A, {})).status, 400);                 // pas de confirmation
  assert.equal((await call(cOwner, "DELETE", A, { confirm: "équipe alpha" })).status, 400); // casse différente
  assert.equal((await call(cOwner, "DELETE", A, { confirm: "Équipe A" })).status, 400);     // ancien nom
  assert.ok(db.getOrg(orgA));
  db.createTask("a0000001", orgA, max.id, "p", "en cours");
  db.updateTask("a0000001", { status: "running" });
  assert.equal((await call(cOwner, "DELETE", A, { confirm: name })).status, 409);
  assert.ok(db.getOrg(orgA));
  db.updateTask("a0000001", { status: "done" });
});

test("supprimer : tout ce qui appartient à l'organisation disparaît, rien d'autre ; les comptes restent", async () => {
  // de la matière dans les deux organisations
  db.addEvent("a0000001", "step", "x");
  db.recordProxyCall(orgA, "a0000001", "anthropic", 200);
  const pA = db.insertProject({ org_id: orgA, slug: "p", name: "P", repo: "https://gitlab.com/g/p.git", branch: "main", forge: "gitlab", check_cmd: "true", engine: "claude", protected_paths: "[]", git_secret_id: null });
  const V = await import("./vault.ts");
  const sA = V.storeSecret(orgA, "git_token", null, "tok", "glpat-aaaaaaaaaaaaaaaa");
  db.insertInvitation(orgA, "z@x.fr", "member", owner.id, "hash-a", Date.now() + 1e6);
  db.createTask("b0000001", orgB, bob.id, "p", "tâche de B");
  db.addEvent("b0000001", "step", "y");
  const sB = V.storeSecret(orgB, "git_token", null, "tokB", "glpat-bbbbbbbbbbbbbbbb");

  const r = await call(cOwner, "DELETE", A, { confirm: "Équipe Alpha" });
  assert.equal(r.status, 200);

  assert.equal(db.getOrg(orgA), undefined);
  assert.equal(db.getProjectInOrg(pA, orgA), undefined);
  assert.equal(db.getSecretRow(sA.id, orgA), undefined);
  assert.equal(db.getTask("a0000001"), undefined);
  assert.deepEqual(db.getEvents("a0000001"), []);
  assert.equal(db.queryAudit(orgA).total, 0);
  assert.equal(db.orgUsage(orgA, 30).byProvider.length, 0);
  assert.equal(db.listMembers(orgA).length, 0);
  assert.equal(db.findInvitation("hash-a"), undefined);
  // l'autre organisation est intacte
  assert.ok(db.getOrg(orgB) && db.getTask("b0000001") && db.getEvents("b0000001").length === 1 && db.getSecretRow(sB.id, orgB));
  // les comptes existent toujours, mais n'ont plus l'organisation
  assert.ok(db.getUserById(max.id));
  assert.deepEqual(((await (await call(cMax, "GET", "/api/me")).json()) as { orgs: unknown[] }).orgs, []);
  assert.equal((await call(cMax, "GET", `${A}/tasks`)).status, 404);
  // la suppression est tracée hors de l'organisation, avec son nom
  const mine = db.userActivity(owner.id).find((a) => a.action === "org.delete")!;
  assert.deepEqual(JSON.parse(mine.meta!), { name: "Équipe Alpha" });
});
