// Message de suite sur une tâche : un nouveau tour de l'agent sur la même branche. Ici le pipeline échoue vite (dépôt
// inexistant) : on vérifie les règles et l'état, pas git (le smoke, lui, fait tourner un vrai tour sur un vrai dépôt).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
process.env.ATELIER_FAKE_AGENT = "1";
process.env.WORK_DIR = "/nonexistent/atelier-work";
const db = await import("./db.ts");
const { hashPassword } = await import("./auth.ts");
const { createApp } = await import("./app.ts");
const { MAX_TURNS } = await import("./start.ts");

const hash = await hashPassword("motdepasse1");
const mk = (e: string) => db.createUser(e, hash);
const alice = mk("alice@a.fr"), max = mk("max@a.fr"), sam = mk("sam@a.fr"), vera = mk("vera@a.fr"), bob = mk("bob@b.fr");
const orgA = db.createOrg("A", alice.id), orgB = db.createOrg("B", bob.id);
db.addMember(orgA, max.id, "member"); db.addMember(orgA, sam.id, "member"); db.addMember(orgA, vera.id, "viewer");
const project = db.insertProject({ org_id: orgA, slug: "a", name: "Projet a", repo: "/nonexistent/repo.git", branch: "main", forge: "none", check_cmd: "true", engine: "claude", protected_paths: "[]", git_secret_id: null });

const server = createApp().listen(0);
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function login(email: string) {
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "motdepasse1" }) });
  return r.headers.get("set-cookie")!.split(";")[0];
}
const call = (cookie: string, method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
const cA = await login("alice@a.fr"), cM = await login("max@a.fr"), cS = await login("sam@a.fr"), cV = await login("vera@a.fr"), cB = await login("bob@b.fr");
const A = `/api/orgs/${orgA}`;

let n = 0;
/** Une tâche TERMINÉE de Max, avec sa conversation, sans passer par le pipeline. */
function doneTask(status = "done") {
  const id = `c0ffee0${n++}`;
  db.createTask(id, orgA, max.id, project, "première demande");
  db.updateTask(id, { status: status as "done", branch: `atelier/${id}`, mr_url: "https://forge.test/mr/1", files_json: JSON.stringify(["NOTES.md"]), cost: 0.5 });
  const conv = db.insertConversation({ org_id: orgA, user_id: max.id, project_id: project, mode: "task", title: "t", task_id: id });
  db.insertMessage(conv, "user", [{ type: "text", text: "première demande" }]);
  return { id, conv };
}
const msg = (c: string, conv: string, text: unknown) => call(c, "POST", `${A}/conversations/${conv}/messages`, { text });

test("un ajustement met la tâche en file pour un 2e tour, enregistre le message et un événement de ce tour", async () => {
  const t = doneTask();
  const r = await msg(cM, t.conv, "  mets le titre en rouge  ");
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { taskId: t.id, turn: 2 });
  const task = db.getTask(t.id)!;
  assert.equal(task.turn, 2);
  assert.ok(task.followup === "mets le titre en rouge" || task.followup === null);   // le pipeline a pu déjà le consommer
  const texts = db.getMessages(t.conv).map((m) => ({ role: m.role, text: (JSON.parse(m.parts) as { text: string }[])[0]!.text }));
  assert.deepEqual(texts, [{ role: "user", text: "première demande" }, { role: "user", text: "mets le titre en rouge" }]);
  const ev = db.getEvents(t.id).find((e) => e.text.startsWith("Demande d'ajustement (tour 2)"));
  assert.equal(ev?.turn, 2);
  assert.equal(db.getEvents(t.id).filter((e) => e.turn === 1).length, 0);
  const log = db.getEvents(t.id).length;
  assert.ok(log >= 1);
});

test("un ajustement qui échoue (dépôt disparu) ne défait pas la proposition : la tâche reste terminée, le coût et l'URL aussi", async () => {
  const t = doneTask();
  await msg(cM, t.conv, "encore un ajustement");
  for (let i = 0; i < 100 && db.getTask(t.id)!.status !== "done"; i++) await new Promise((r) => setTimeout(r, 50));
  const task = db.getTask(t.id)!;
  assert.equal(task.status, "done");
  assert.equal(task.mr_url, "https://forge.test/mr/1");
  assert.equal(task.cost, 0.5);
  assert.deepEqual(JSON.parse(task.files_json!), ["NOTES.md"]);
  assert.ok(db.getEvents(t.id).some((e) => e.type === "error" && e.turn === 2));     // l'erreur est dite, dans le tour concerné
});

test("règles : tâche pas terminée, tour déjà en cours, limite de tours, message invalide", async () => {
  const t = doneTask();
  const r1 = await msg(cM, t.conv, "premier"); assert.equal(r1.status, 201);
  const r2 = await msg(cM, t.conv, "pendant que ça tourne");                           // le 1er tour n'est pas fini (ou a fini : alors c'est un 201 de plus)
  assert.ok([201, 409].includes(r2.status));
  for (const s of ["failed", "cancelled", "no_changes", "queued", "running"]) {
    const u = doneTask(s);
    const r = await msg(cM, u.conv, "x");
    assert.equal(r.status, 409, s);
    assert.equal(db.getTask(u.id)!.turn, 1, s);
  }
  const cap = doneTask(); db.updateTask(cap.id, { turn: MAX_TURNS });
  assert.equal((await msg(cM, cap.conv, "x")).status, 409);
  const ok = doneTask();
  for (const bad of ["", "   ", 5, null, "x".repeat(20_001)]) assert.equal((await msg(cM, ok.conv, bad)).status, 400, String(bad).slice(0, 10));
  assert.equal(db.getTask(ok.id)!.turn, 1);
});

test("droits : auteur ou administrateur ; un autre membre non, un lecteur non, une autre organisation ne voit rien", async () => {
  const t = doneTask();
  assert.equal((await msg(cS, t.conv, "x")).status, 403);       // un autre membre voit la tâche mais ne la modifie pas
  assert.equal((await msg(cV, t.conv, "x")).status, 403);
  assert.equal((await msg(cB, t.conv, "x")).status, 404);
  assert.equal(db.getTask(t.id)!.turn, 1);
  assert.equal((await msg(cA, t.conv, "reprise par l'administrateur")).status, 201);
  assert.equal(db.getTask(t.id)!.turn, 2);
});

test("une discussion ne reçoit pas de message de suite ; budget épuisé : 402", async () => {
  const chat = db.insertConversation({ org_id: orgA, user_id: max.id, project_id: null, mode: "chat" });
  assert.equal((await msg(cM, chat, "x")).status, 400);
  const t = doneTask();
  db.createTask("b1b1b1b1", orgA, max.id, project, "coûteuse"); db.updateTask("b1b1b1b1", { cost: 10 });
  db.setOrgBudget(orgA, 1);
  try { assert.equal((await msg(cM, t.conv, "x")).status, 402); } finally { db.setOrgBudget(orgA, null); }
});
