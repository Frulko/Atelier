// Statistiques du tableau de bord et page d'usage : exactes, sans trou, cloisonnées, réservées selon le rôle.
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
db.addMember(orgA, max.id, "member"); db.addMember(orgA, vera.id, "viewer");
const proj = (org: string, slug: string, name: string) => db.insertProject({ org_id: org, slug, name, repo: "https://gitlab.com/g/p.git", branch: "main", forge: "gitlab", check_cmd: "true", engine: "claude", protected_paths: "[]", git_secret_id: null });
const pRegis = proj(orgA, "regis", "MonRégis"), pSite = proj(orgA, "site", "Site"), pB = proj(orgB, "b", "B");

const DAY = 86400_000, now = Date.now();
// (id, org, user, project, statut, âge en jours, coût, durée en secondes)
const t = (id: string, org: string, user: string, project: string, status: string, age: number, cost: number, secs?: number) => {
  db.createTask(id, org, user, project, `tâche ${id}`);
  const created = now - age * DAY;
  db.updateTaskCreatedAtForTest(id, created);
  db.updateTask(id, { status: status as never, cost, ...(secs ? { started_at: created, finished_at: created + secs * 1000 } : {}) });
};
t("a0000001", orgA, alice.id, pRegis, "done", 0, 0.5, 60);
t("a0000002", orgA, alice.id, pRegis, "done", 1, 1.0, 120);
t("a0000003", orgA, max.id, pRegis, "failed", 1, 0.25, 30);
t("a0000004", orgA, max.id, pSite, "done", 3, 2.0, 90);
t("a0000005", orgA, max.id, pSite, "cancelled", 10, 0, undefined);
t("a0000006", orgA, alice.id, "projet-supprime", "no_changes", 20, 0.1, undefined);
t("a0000007", orgA, alice.id, pRegis, "done", 40, 9, 10);   // hors fenêtre de 30 jours
t("b0000001", orgB, bob.id, pB, "done", 0, 50, 5);          // autre organisation

const server = createApp().listen(0);
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function login(email: string) {
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "motdepasse1" }) });
  return r.headers.get("set-cookie")!.split(";")[0];
}
const call = (cookie: string, path: string) => fetch(base + path, { headers: { cookie } });
const cA = await login("alice@a.fr"), cM = await login("max@a.fr"), cV = await login("vera@a.fr"), cB = await login("bob@b.fr");
const A = `/api/orgs/${orgA}`;
type Stats = ReturnType<typeof db.orgStats>;
type Usage = ReturnType<typeof db.orgUsage>;
const stats = async (q = "", c = cA) => (await (await call(c, `${A}/stats${q}`)).json()) as Stats;
const usage = async (q = "", c = cA) => (await (await call(c, `${A}/usage${q}`)).json()) as Usage;

test("totaux sur 30 jours : volume, statuts, taux de réussite, durée moyenne, dépense — sans l'ancienne tâche ni l'autre organisation", async () => {
  const s = await stats();
  assert.equal(s.range.days, 30);
  assert.equal(s.totals.tasks, 6);                       // a0000007 (40 jours) et b0000001 exclus
  assert.deepEqual(s.totals.byStatus, { queued: 0, running: 0, done: 3, no_changes: 1, failed: 1, cancelled: 1 });
  assert.equal(s.totals.successRate, 3 / 4);             // 3 réussies sur 4 terminées (réussie + échec)
  assert.equal(s.totals.avgDurationMs, Math.round((60 + 120 + 30 + 90) / 4) * 1000); // seules les tâches chronométrées
  assert.equal(s.totals.spendUsd, 3.85);                 // 0,5 + 1 + 0,25 + 2 + 0 + 0,1
});

test("série par jour : un point par jour, dans l'ordre, sans trou, et la somme égale le total", async () => {
  const s = await stats();
  assert.equal(s.perDay.length, 30);
  assert.equal(s.perDay.at(-1)!.day, new Date(now).toISOString().slice(0, 10));
  assert.ok(s.perDay.every((p, i) => i === 0 || p.day > s.perDay[i - 1].day));
  assert.equal(s.perDay.reduce((n, p) => n + p.tasks, 0), s.totals.tasks);
  assert.equal(Math.round(s.perDay.reduce((n, p) => n + p.spendUsd, 0) * 100) / 100, s.totals.spendUsd);
  const yesterday = s.perDay.at(-2)!;
  assert.deepEqual([yesterday.tasks, yesterday.done, yesterday.failed, yesterday.spendUsd], [2, 1, 1, 1.25]);
  assert.equal(s.perDay.filter((p) => p.tasks === 0).length, 30 - 5); // 5 jours avec activité
});

test("fenêtre : 7 jours exclut les tâches plus anciennes ; valeurs aberrantes ramenées à des bornes sûres", async () => {
  assert.equal((await stats("?days=7")).totals.tasks, 4);
  assert.equal((await stats("?days=7")).perDay.length, 7);
  assert.equal((await stats("?days=0")).range.days, 30);     // 0 → défaut
  assert.equal((await stats("?days=abc")).range.days, 30);
  assert.equal((await stats("?days=-5")).range.days, 1);
  assert.equal((await stats("?days=99999")).range.days, 365);
  assert.equal((await stats("?days=45")).totals.tasks, 7);   // l'ancienne tâche rentre
});

test("par projet : volume, réussites, dépense ; un projet supprimé reste lisible", async () => {
  const byName = Object.fromEntries((await stats()).byProject.map((p) => [p.name, p]));
  assert.deepEqual([byName["MonRégis"].tasks, byName["MonRégis"].done, byName["MonRégis"].failed, byName["MonRégis"].spendUsd], [3, 2, 1, 1.75]);
  assert.deepEqual([byName["Site"].tasks, byName["Site"].spendUsd], [2, 2]);
  assert.equal(byName["(projet supprimé)"].tasks, 1);
  assert.ok(!("B" in byName));
});

test("cloisonnement et droits : le lecteur voit les statistiques ; une autre organisation reçoit 404", async () => {
  assert.equal((await call(cV, `${A}/stats`)).status, 200);
  assert.equal((await call(cB, `${A}/stats`)).status, 404);
  assert.equal((await call(cB, `${A}/usage`)).status, 404);
  const own = (await (await call(cB, `/api/orgs/${orgB}/stats`)).json()) as Stats;
  assert.equal(own.totals.tasks, 1);
  assert.equal(own.totals.spendUsd, 50);
});

test("usage : réservé aux administrateurs (membre et lecteur 403)", async () => {
  for (const c of [cM, cV]) assert.equal((await call(c, `${A}/usage`)).status, 403);
  assert.equal((await call(cA, `${A}/usage`)).status, 200);
});

test("usage : dépense par membre (la plus élevée d'abord), appels par fournisseur, budget et projection", async () => {
  db.recordProxyCall(orgA, "a0000001", "anthropic", 200);
  db.recordProxyCall(orgA, "a0000001", "anthropic", 200);
  db.recordProxyCall(orgA, "a0000002", "anthropic", 529);
  db.recordProxyCall(orgA, "a0000002", "openai", 200);
  db.recordProxyCall(orgB, "b0000001", "anthropic", 200); // autre organisation : ne doit pas compter
  db.setOrgBudget(orgA, 100);
  const u = await usage();
  assert.deepEqual(u.byMember.map((m) => [m.email, m.spendUsd]), [["max@a.fr", 2.25], ["alice@a.fr", 1.6]]);
  assert.deepEqual(u.byProvider.map((p) => [p.provider, p.calls, p.errors]), [["anthropic", 3, 1], ["openai", 1, 0]]);
  assert.equal(u.perDay.at(-1)!.calls, 4);
  assert.equal(u.budget.capUsd, 100);
  assert.equal(u.budget.monthSpendUsd, Math.round(db.monthSpend(orgA) * 100) / 100);
  assert.ok(u.budget.projectedMonthUsd >= u.budget.monthSpendUsd);
  db.setOrgBudget(orgA, null);
  assert.equal((await usage()).budget.capUsd, null);
});
