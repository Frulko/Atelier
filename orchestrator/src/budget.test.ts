import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
const db = await import("./db.ts");
const { overBudget } = await import("./budget.ts");
const { hashPassword } = await import("./auth.ts");
const { createApp } = await import("./app.ts");

const hash = await hashPassword("motdepasse1");
const mk = (e: string) => db.createUser(e, hash);
const alice = mk("alice@a.fr"), max = mk("max@a.fr"), bob = mk("bob@b.fr");
const orgA = db.createOrg("A", alice.id), orgB = db.createOrg("B", bob.id);
db.addMember(orgA, max.id, "member");
const pA = db.insertProject({ org_id: orgA, slug: "p", name: "P", repo: "https://gitlab.com/g/p.git", branch: "main", forge: "gitlab", check_cmd: "true", engine: "claude", protected_paths: "[]", git_secret_id: null });

const spend = (org: string, id: string, usd: number, userId = alice.id) => { db.createTask(id, org, userId, "p", "x"); db.updateTask(id, { cost: usd }); };

const server = createApp().listen(0);
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function login(email: string) {
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "motdepasse1" }) });
  return r.headers.get("set-cookie")!.split(";")[0];
}
const call = (cookie: string, method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
const cA = await login("alice@a.fr"), cM = await login("max@a.fr"), cB = await login("bob@b.fr");

test("dépense du mois : seulement cette organisation et ce mois", () => {
  spend(orgA, "aaaaaaa1", 1.5);
  spend(orgA, "aaaaaaa2", 0.25);
  spend(orgB, "bbbbbbb1", 9);
  const now = Date.now(), d = new Date(now);
  assert.equal(db.monthSpend(orgA, now), 1.75);
  assert.equal(db.monthSpend(orgB, now), 9);
  const nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 15);
  const lastMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15);
  assert.equal(db.monthSpend(orgA, nextMonth), 0); // le mois suivant repart de zéro
  assert.equal(db.monthSpend(orgA, lastMonth), 0);
});

test("plafond : null = illimité ; atteint = dépassé", () => {
  assert.equal(overBudget(orgA), false);
  db.setOrgBudget(orgA, 2);
  assert.equal(overBudget(orgA), false); // 1,75 < 2
  db.setOrgBudget(orgA, 1.75);
  assert.equal(overBudget(orgA), true); // atteint
  db.setOrgBudget(orgA, 0);
  assert.equal(overBudget(orgA), true);
  db.setOrgBudget(orgA, null);
  assert.equal(overBudget(orgA), false);
});

test("API du budget : l'administrateur lit et fixe ; membre 403 ; autre organisation 404 ; valeurs invalides 400", async () => {
  const r = await (await call(cA, "GET", `/api/orgs/${orgA}`)).json() as { budgetUsdMonth: number | null; monthSpendUsd: number };
  assert.equal(r.budgetUsdMonth, null);
  assert.equal(r.monthSpendUsd, 1.75);

  assert.equal((await call(cM, "GET", `/api/orgs/${orgA}`)).status, 403);
  assert.equal((await call(cM, "PATCH", `/api/orgs/${orgA}`, { budgetUsdMonth: 1000 })).status, 403);
  assert.equal((await call(cB, "GET", `/api/orgs/${orgA}`)).status, 404);
  assert.equal((await call(cB, "PATCH", `/api/orgs/${orgA}`, { budgetUsdMonth: 1000 })).status, 404);

  for (const bad of [-1, "dix", 1e9, {}, [1]]) assert.equal((await call(cA, "PATCH", `/api/orgs/${orgA}`, { budgetUsdMonth: bad })).status, 400, JSON.stringify(bad));
  assert.equal((await call(cA, "PATCH", `/api/orgs/${orgA}`, { budgetUsdMonth: 50 })).status, 200);
  assert.equal(db.getOrg(orgA)!.budget_usd_month, 50);
  assert.equal(db.getOrg(orgB)!.budget_usd_month, null); // l'autre organisation n'a pas bougé
});

test("budget épuisé : lancer une tâche est refusé (402), puis accepté une fois le plafond relevé", async () => {
  db.setOrgBudget(orgA, 1);
  assert.equal((await call(cM, "POST", `/api/orgs/${orgA}/tasks`, { project: pA, prompt: "x" })).status, 402);
});
