// Le test qui compte le plus du multi-utilisateur : une organisation ne voit, ne lance
// et n'annule JAMAIS rien d'une autre, et les rôles sont appliqués. Vrai serveur HTTP, en mémoire.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
process.env.ANTHROPIC_API_KEY = "x";
const db = await import("./db.ts");
const { hashPassword } = await import("./auth.ts");
const { createApp } = await import("./app.ts");

const hash = await hashPassword("motdepasse1");
const mk = (email: string) => db.createUser(email, hash);
const alice = mk("alice@a.fr"), bob = mk("bob@b.fr"), vera = mk("vera@a.fr"), max = mk("max@a.fr"), adam = mk("adam@a.fr");
const orgA = db.createOrg("A", alice.id);
const orgB = db.createOrg("B", bob.id);
db.addMember(orgA, vera.id, "viewer");
db.addMember(orgA, max.id, "member");
db.addMember(orgA, adam.id, "admin");

db.createTask("aaaaaaa1", orgA, alice.id, "p", "tâche de alice (org A)");
db.createTask("aaaaaaa2", orgA, max.id, "p", "tâche de max (org A)");
db.createTask("bbbbbbb1", orgB, bob.id, "p", "tâche de bob (org B)");

const server = createApp().listen(0);
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function login(email: string) {
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "motdepasse1" }) });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie")!.split(";")[0];
}
const call = (cookie: string | null, method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });

const cA = await login("alice@a.fr"), cB = await login("bob@b.fr"), cV = await login("vera@a.fr"), cM = await login("max@a.fr"), cAd = await login("adam@a.fr");

test("sans session : tout est refusé (401)", async () => {
  for (const path of [`/api/orgs/${orgA}/tasks`, `/api/orgs/${orgA}/projects`, "/api/me"]) assert.equal((await call(null, "GET", path)).status, 401);
});

test("autre organisation : TOUT est introuvable (404), jamais 403 — l'existence n'est pas révélée", async () => {
  const t = `/api/orgs/${orgA}/tasks`;
  assert.equal((await call(cB, "GET", t)).status, 404);
  assert.equal((await call(cB, "GET", `${t}/aaaaaaa1`)).status, 404);
  assert.equal((await call(cB, "GET", `${t}/aaaaaaa1/events`)).status, 404);
  assert.equal((await call(cB, "POST", `${t}/aaaaaaa1/cancel`)).status, 404);
  assert.equal((await call(cB, "POST", t, { project: "p", prompt: "intrusion" })).status, 404);
  assert.equal((await call(cB, "GET", `/api/orgs/${orgA}/projects`)).status, 404);
});

test("l'identifiant d'une tâche ne suffit pas : via MON organisation, la tâche d'une autre reste introuvable", async () => {
  assert.equal((await call(cA, "GET", `/api/orgs/${orgA}/tasks/bbbbbbb1`)).status, 404);
  assert.equal((await call(cB, "GET", `/api/orgs/${orgB}/tasks/aaaaaaa1`)).status, 404);
  assert.equal((await call(cA, "POST", `/api/orgs/${orgA}/tasks/bbbbbbb1/cancel`)).status, 404);
  assert.equal(db.getTask("bbbbbbb1")!.status, "queued"); // et elle n'a pas été annulée
});

test("les listes ne contiennent que les tâches de l'organisation", async () => {
  const a = (await (await call(cA, "GET", `/api/orgs/${orgA}/tasks`)).json()) as { items: { id: string }[]; total: number };
  assert.deepEqual(a.items.map((t) => t.id).sort(), ["aaaaaaa1", "aaaaaaa2"]);
  assert.equal(a.total, 2);
  const b = (await (await call(cB, "GET", `/api/orgs/${orgB}/tasks`)).json()) as { items: { id: string }[] };
  assert.deepEqual(b.items.map((t) => t.id), ["bbbbbbb1"]);
});

test("/api/me ne liste que les organisations de la personne, avec son rôle", async () => {
  const me = (await (await call(cB, "GET", "/api/me")).json()) as { orgs: { id: string; role: string }[] };
  assert.deepEqual(me.orgs.map((o) => [o.id, o.role]), [[orgB, "owner"]]);
});

test("lecteur : peut lire, ne peut ni lancer ni annuler (403)", async () => {
  assert.equal((await call(cV, "GET", `/api/orgs/${orgA}/tasks`)).status, 200);
  assert.equal((await call(cV, "POST", `/api/orgs/${orgA}/tasks`, { project: "p", prompt: "x" })).status, 403);
  assert.equal((await call(cV, "POST", `/api/orgs/${orgA}/tasks/aaaaaaa1/cancel`)).status, 403);
});

test("membre : peut lancer (autorisé jusqu'au projet), annule les SIENNES mais pas celles des autres (403)", async () => {
  // 400 = les droits sont passés, c'est le projet « p » (absent de la config de test) qui est refusé
  assert.equal((await call(cM, "POST", `/api/orgs/${orgA}/tasks`, { project: "p", prompt: "x" })).status, 400);
  assert.equal((await call(cM, "POST", `/api/orgs/${orgA}/tasks/aaaaaaa1/cancel`)).status, 403); // tâche d'alice
  assert.equal((await call(cM, "POST", `/api/orgs/${orgA}/tasks/aaaaaaa2/cancel`)).status, 200); // la sienne
  assert.equal(db.getTask("aaaaaaa2")!.status, "cancelled");
});

test("administrateur : annule la tâche de n'importe quel membre de son organisation", async () => {
  assert.equal((await call(cAd, "POST", `/api/orgs/${orgA}/tasks/aaaaaaa1/cancel`)).status, 200);
  assert.equal(db.getTask("aaaaaaa1")!.status, "cancelled");
});

test("flux d'événements : accessible dans son organisation uniquement", async () => {
  // http.get plutôt que fetch : on ferme le socket nous-mêmes dès l'en-tête reçu (le flux ne se termine jamais seul).
  const status = await new Promise<number>((ok, ko) => {
    const rq = http.get(`${base}/api/orgs/${orgB}/tasks/bbbbbbb1/events`, { headers: { cookie: cB } }, (res) => { ok(res.statusCode!); rq.destroy(); });
    rq.on("error", ko);
  });
  assert.equal(status, 200);
  assert.equal((await call(cA, "GET", `/api/orgs/${orgB}/tasks/bbbbbbb1/events`)).status, 404);
});
