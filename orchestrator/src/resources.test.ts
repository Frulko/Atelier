// API des projets et des secrets : droits par rôle, cloisonnement entre organisations, secrets jamais divulgués.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
process.env.ANTHROPIC_API_KEY = "x";
const db = await import("./db.ts");
const { hashPassword } = await import("./auth.ts");
const { createApp } = await import("./app.ts");

const hash = await hashPassword("motdepasse1");
const mk = (email: string) => db.createUser(email, hash);
const alice = mk("alice@a.fr"), bob = mk("bob@b.fr"), max = mk("max@a.fr"), vera = mk("vera@a.fr");
const orgA = db.createOrg("A", alice.id);
const orgB = db.createOrg("B", bob.id);
db.addMember(orgA, max.id, "member");
db.addMember(orgA, vera.id, "viewer");

const server = createApp().listen(0);
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function login(email: string) {
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "motdepasse1" }) });
  return r.headers.get("set-cookie")!.split(";")[0];
}
const call = (cookie: string, method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });

const cA = await login("alice@a.fr"), cB = await login("bob@b.fr"), cM = await login("max@a.fr"), cV = await login("vera@a.fr");
const A = `/api/orgs/${orgA}`, B = `/api/orgs/${orgB}`;
const TOKEN = "glpat-super-secret-token-9876";
const repo = "https://gitlab.com/g/regis.git";

let secretA = "", projectA = "";

test("secret : l'administrateur le crée, la réponse ne contient jamais la valeur", async () => {
  const r = await call(cA, "POST", `${A}/secrets`, { kind: "git_token", label: "GitLab", value: TOKEN });
  assert.equal(r.status, 201);
  const text = await r.text();
  assert.ok(!text.includes("super-secret"));
  secretA = JSON.parse(text).id;
  const list = await (await call(cA, "GET", `${A}/secrets`)).text();
  assert.ok(!list.includes("super-secret"));
  assert.ok(list.includes("…9876"));
  assert.ok(!db.getSecretRow(secretA, orgA)!.ciphertext.includes(Buffer.from("super-secret"))); // chiffré au repos
});

test("secrets : membre et lecteur n'y ont pas accès (403), autre organisation : introuvable (404)", async () => {
  for (const c of [cM, cV]) {
    assert.equal((await call(c, "GET", `${A}/secrets`)).status, 403);
    assert.equal((await call(c, "POST", `${A}/secrets`, { kind: "git_token", label: "x", value: "y" })).status, 403);
  }
  assert.equal((await call(cB, "GET", `${A}/secrets`)).status, 404);
  assert.equal((await call(cB, "DELETE", `${A}/secrets/${secretA}`)).status, 404);
});

test("secret : entrées invalides refusées", async () => {
  assert.equal((await call(cA, "POST", `${A}/secrets`, { kind: "autre", label: "x", value: "y" })).status, 400);
  assert.equal((await call(cA, "POST", `${A}/secrets`, { kind: "provider_key", provider: "inconnu", label: "x", value: "y" })).status, 400);
  assert.equal((await call(cA, "POST", `${A}/secrets`, { kind: "git_token", label: "x", value: "" })).status, 400);
});

test("projet : l'administrateur le crée avec son secret ; un dépôt hostile est refusé", async () => {
  const r = await call(cA, "POST", `${A}/projects`, { slug: "regis", name: "MonRégis", repo, gitSecretId: secretA, protectedPaths: ["db/"] });
  assert.equal(r.status, 201);
  const p = await r.json() as { id: string; forge: string; gitSecretId: string };
  projectA = p.id;
  assert.equal(p.forge, "gitlab");
  assert.equal(p.gitSecretId, secretA);
  for (const bad of ["file:///etc", "/etc/passwd", "https://u:p@gitlab.com/g/r.git", "ssh://git@x/y"])
    assert.equal((await call(cA, "POST", `${A}/projects`, { slug: "x", name: "x", repo: bad })).status, 400, bad);
  assert.equal((await call(cA, "POST", `${A}/projects`, { slug: "y", name: "y", repo, branch: "--upload-pack=x" })).status, 400);
});

test("projet : slug déjà pris → 409 ; membre et lecteur ne gèrent pas (403) mais voient la liste", async () => {
  assert.equal((await call(cA, "POST", `${A}/projects`, { slug: "regis", name: "Bis", repo })).status, 409);
  for (const c of [cM, cV]) {
    assert.equal((await call(c, "POST", `${A}/projects`, { slug: "z", name: "z", repo })).status, 403);
    assert.equal((await call(c, "DELETE", `${A}/projects/${projectA}`)).status, 403);
    assert.equal((await call(c, "GET", `${A}/projects`)).status, 200);
  }
});

test("projet : un secret d'une autre organisation est inutilisable (400), mon propre secret passe", async () => {
  const sB = (await (await call(cB, "POST", `${B}/secrets`, { kind: "git_token", label: "B", value: "ghp_secret_de_b_00001111" })).json()) as { id: string };
  // Alice ne peut pas rattacher le secret de B à son projet, même en connaissant son identifiant exact
  assert.equal((await call(cA, "PATCH", `${A}/projects/${projectA}`, { gitSecretId: sB.id })).status, 400);
  // Bob ne peut pas utiliser le secret d'Alice pour son projet
  assert.equal((await call(cB, "POST", `${B}/projects`, { slug: "b1", name: "B1", repo, gitSecretId: secretA })).status, 400);
  assert.equal((await call(cB, "POST", `${B}/projects`, { slug: "b1", name: "B1", repo, gitSecretId: sB.id })).status, 201);
});

test("listes cloisonnées : chaque organisation ne voit que ses projets et ses secrets", async () => {
  const pa = (await (await call(cA, "GET", `${A}/projects`)).json()) as { slug: string }[];
  const pb = (await (await call(cB, "GET", `${B}/projects`)).json()) as { slug: string }[];
  assert.deepEqual(pa.map((p) => p.slug), ["regis"]);
  assert.deepEqual(pb.map((p) => p.slug), ["b1"]);
  assert.equal((await call(cB, "GET", `${A}/projects`)).status, 404);
  assert.equal((await call(cB, "PATCH", `${A}/projects/${projectA}`, { name: "piraté" })).status, 404);
  assert.equal((await call(cB, "DELETE", `${A}/projects/${projectA}`)).status, 404);
  assert.equal(db.getProjectInOrg(projectA, orgA)!.name, "MonRégis");
});

test("tâche : un projet d'une autre organisation ne peut pas être lancé (400)", async () => {
  const pB = db.listProjects(orgB)[0].id;
  assert.equal((await call(cA, "POST", `${A}/tasks`, { project: pB, prompt: "x" })).status, 400);
});

test("suppression : un secret utilisé par un projet ne peut pas être supprimé (409), puis oui une fois libéré", async () => {
  assert.equal((await call(cA, "DELETE", `${A}/secrets/${secretA}`)).status, 409);
  assert.equal((await call(cA, "DELETE", `${A}/projects/${projectA}`)).status, 200);
  assert.equal((await call(cA, "DELETE", `${A}/secrets/${secretA}`)).status, 200);
  assert.deepEqual(db.listSecrets(orgA), []);
});
