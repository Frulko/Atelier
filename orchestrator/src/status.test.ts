// Page d'état des projets : contrôle de santé (sans jamais aller où l'on ne doit pas), dernier commit lu dans un vrai dépôt git,
// historique et uptime, cloisonnement par organisation, droits.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "atelier-status-"));
process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
process.env.ATELIER_WORKDIR = join(tmp, "work");
process.env.ATELIER_ALLOW_LOCAL_REPOS = "1";
process.env.ATELIER_HEALTH_ALLOW_PRIVATE = "1";          // les sites de test écoutent sur 127.0.0.1
const db = await import("./db.ts");
const { hashPassword } = await import("./auth.ts");
const { createApp } = await import("./app.ts");
const { checkHealth, addressAllowed, urlProblem } = await import("./health.ts");

// --- un faux site : /ok, /boom (500), /moved (302), /slow (ne répond pas)
const site = http.createServer((req, res) => {
  if (req.url === "/ok") return void res.end("ok");
  if (req.url === "/boom") return void res.writeHead(500).end("secret-stack-trace");
  if (req.url === "/moved") return void res.writeHead(302, { location: "http://169.254.169.254/latest" }).end();
  /* /slow : pas de réponse */
}).listen(0);
const siteUrl = (p: string) => `http://127.0.0.1:${(site.address() as AddressInfo).port}${p}`;

// --- un vrai dépôt git avec un commit
const repo = join(tmp, "repo");
const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=Léa", "-c", "user.email=l@x.fr", ...a], { encoding: "utf8" });
execFileSync("git", ["init", "-q", "-b", "main", repo]);
git("commit", "-q", "--allow-empty", "-m", "Ajoute la page contact");

const hash = await hashPassword("motdepasse1");
const mk = (e: string) => db.createUser(e, hash);
const alice = mk("alice@a.fr"), vera = mk("vera@a.fr"), bob = mk("bob@b.fr"), max = mk("max@a.fr");
const orgA = db.createOrg("A", alice.id), orgB = db.createOrg("B", bob.id);
db.addMember(orgA, vera.id, "viewer"); db.addMember(orgA, max.id, "member");
const proj = (org: string, slug: string, o: Record<string, unknown> = {}) => db.insertProject({ org_id: org, slug, name: `Projet ${slug}`, repo, branch: "main", forge: "none", check_cmd: "true", engine: "claude", protected_paths: "[]", git_secret_id: null, ...o });
const pA = proj(orgA, "a", { site_url: siteUrl("/ok") }), pB = proj(orgB, "b", { site_url: siteUrl("/ok") });

const server = createApp().listen(0);
after(() => { server.closeAllConnections(); server.close(); site.closeAllConnections(); site.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function login(email: string) {
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "motdepasse1" }) });
  return r.headers.get("set-cookie")!.split(";")[0];
}
const call = (cookie: string, method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
const cA = await login("alice@a.fr"), cV = await login("vera@a.fr"), cB = await login("bob@b.fr"), cM = await login("max@a.fr");
const A = `/api/orgs/${orgA}`;

test("santé : en ligne, erreur serveur, redirection (non suivie), délai dépassé, refus — sans jamais exposer le corps de la réponse", async () => {
  const ok = await checkHealth(siteUrl("/ok"));
  assert.deepEqual([ok.ok, ok.status, ok.error], [true, 200, null]);
  assert.ok(ok.ms !== null && ok.ms >= 0);
  const boom = await checkHealth(siteUrl("/boom"));
  assert.deepEqual([boom.ok, boom.status, boom.error], [false, 500, "réponse HTTP 500"]);
  assert.ok(!JSON.stringify(boom).includes("secret-stack-trace"));
  const moved = await checkHealth(siteUrl("/moved"));                  // une redirection vers les métadonnées cloud n'est PAS suivie
  assert.deepEqual([moved.ok, moved.status], [true, 302]);
  const slow = await checkHealth(siteUrl("/slow"), 300);
  assert.deepEqual([slow.ok, slow.status, slow.error], [false, null, "délai dépassé"]);
  const refused = await checkHealth("http://127.0.0.1:9/");
  assert.deepEqual([refused.ok, refused.error], [false, "connexion refusée"]);
});

test("garde-fous : lien local (métadonnées cloud) refusé MÊME en réseau privé autorisé ; adresses invalides refusées", async () => {
  for (const a of ["169.254.169.254", "169.254.1.1", "fe80::1", "0.0.0.0", "::"]) assert.equal(addressAllowed(a), false, a);
  for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "::1", "fd00::1", "::ffff:127.0.0.1"]) assert.equal(addressAllowed(a), true, `${a} (privé autorisé dans ce test)`);
  assert.equal(addressAllowed("93.184.216.34"), true);
  const meta = await checkHealth("http://169.254.169.254/latest/meta-data/");
  assert.deepEqual([meta.ok, meta.error], [false, "adresse non autorisée (réseau privé ou lien local)"]);
  for (const bad of ["ftp://x.fr", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@x.fr", "pas une url", "http://" + "x".repeat(300) + ".fr", 5, null])
    assert.notEqual(urlProblem(bad), null, String(bad).slice(0, 30));
  assert.equal(urlProblem("https://monsite.fr/health"), null);
  assert.equal((await checkHealth("file:///etc/passwd")).error, "adresse invalide");
});

test("actualiser : contrôle de santé et dernier commit lu dans le dépôt ; état renvoyé sans aucun secret", async () => {
  const r = await call(cM, "POST", `${A}/projects/${pA}/refresh`);
  assert.equal(r.status, 200);
  const s = (await r.json()) as any;
  assert.deepEqual([s.name, s.siteUrl, s.health.ok, s.health.status, s.uptime24h, s.checks24h], ["Projet a", siteUrl("/ok"), true, 200, 1, 1]);
  assert.equal(s.git.commit.subject, "Ajoute la page contact");
  assert.equal(s.git.commit.author, "Léa");
  assert.match(s.git.commit.sha, /^[0-9a-f]{40}$/);
  assert.equal(s.git.error, null);
  assert.ok(Math.abs(s.git.commit.at - Date.now()) < 60_000);
  const list = (await (await call(cV, "GET", `${A}/status`)).json()) as any[];     // un lecteur peut voir l'état
  assert.deepEqual(list.map((x) => x.projectId), [pA]);
  const raw = JSON.stringify(list);
  assert.ok(!/token|secret|password/i.test(raw));
});

test("un nouveau commit est vu à l'actualisation suivante ; un dépôt injoignable est dit, sans casser le reste", async () => {
  git("commit", "-q", "--allow-empty", "-m", "Corrige les horaires");
  const s = (await (await call(cM, "POST", `${A}/projects/${pA}/refresh`)).json()) as any;
  assert.equal(s.git.commit.subject, "Corrige les horaires");
  assert.equal(s.checks24h, 2);
  const broken = proj(orgA, "casse", { repo: join(tmp, "absent.git"), site_url: siteUrl("/boom") });
  const b = (await (await call(cM, "POST", `${A}/projects/${broken}/refresh`)).json()) as any;
  assert.equal(b.health.ok, false);
  assert.equal(b.git.commit, null);
  assert.ok(typeof b.git.error === "string" && b.git.error.length > 0 && b.git.error.length <= 200);
});

test("uptime : 24 h glissantes, historique plafonné à 30 points, purge au-delà de 7 jours", async () => {
  const id = proj(orgA, "uptime");
  const now = Date.now();
  db.saveHealth(id, { ok: false, status: 500, ms: 10, error: "x" }, now - 8 * 24 * 3600_000);   // trop vieux : purgé au prochain enregistrement
  db.saveHealth(id, { ok: true, status: 200, ms: 10, error: null }, now - 25 * 3600_000);       // hors des 24 h
  for (let i = 0; i < 3; i++) db.saveHealth(id, { ok: true, status: 200, ms: 10, error: null }, now - 3600_000 + i);
  db.saveHealth(id, { ok: false, status: 500, ms: 10, error: "x" }, now - 1000);
  const s = db.projectStatuses(orgA).find((x) => x.row.id === id)!;
  assert.equal(s.checks24h, 4);
  assert.equal(s.uptime24h, 0.75);
  assert.equal(s.history.length, 5);                                                              // le contrôle de 8 jours a été purgé
  for (let i = 0; i < 40; i++) db.saveHealth(id, { ok: true, status: 200, ms: 1, error: null }, now + i);
  assert.equal(db.projectStatuses(orgA).find((x) => x.row.id === id)!.history.length, 30);
});

test("adresses d'un projet : saisie validée (admin), modifiable, effaçable ; membre refusé", async () => {
  assert.equal((await call(cM, "PATCH", `${A}/projects/${pA}`, { siteUrl: "https://x.fr" })).status, 403);
  for (const bad of ["ftp://x.fr", "https://u:p@x.fr", "n'importe quoi"]) assert.equal((await call(cA, "PATCH", `${A}/projects/${pA}`, { siteUrl: bad })).status, 400, bad);
  const r = await call(cA, "PATCH", `${A}/projects/${pA}`, { siteUrl: "https://boulangerie.fr", healthUrl: "https://boulangerie.fr/health" });
  assert.equal(r.status, 200);
  assert.deepEqual([((await r.json()) as any).siteUrl, ((await (await call(cA, "GET", `${A}/projects`)).json()) as any[]).find((p) => p.id === pA).healthUrl], ["https://boulangerie.fr", "https://boulangerie.fr/health"]);
  const cleared = (await (await call(cA, "PATCH", `${A}/projects/${pA}`, { siteUrl: null, healthUrl: "" })).json()) as any;
  assert.deepEqual([cleared.siteUrl, cleared.healthUrl], [null, null]);
});

test("cloisonnement et droits : une autre organisation ne voit ni n'actualise rien ; le lecteur ne peut pas actualiser ; limite de débit", async () => {
  assert.equal((await call(cB, "GET", `${A}/status`)).status, 404);
  assert.equal((await call(cB, "POST", `${A}/projects/${pA}/refresh`)).status, 404);
  assert.equal((await call(cA, "POST", `/api/orgs/${orgB}/projects/${pA}/refresh`)).status, 404);   // un projet d'une autre organisation par l'URL de la sienne
  assert.equal((await call(cA, "POST", `${A}/projects/${pB}/refresh`)).status, 404);
  assert.equal((await call(cV, "POST", `${A}/projects/${pA}/refresh`)).status, 403);
  assert.ok(!JSON.stringify(await (await call(cA, "GET", `${A}/status`)).json()).includes(pB));
  const codes: number[] = [];
  for (let i = 0; i < 25; i++) codes.push((await call(cM, "POST", `${A}/projects/${pA}/refresh`)).status);
  assert.ok(codes.includes(429));
});

test("supprimer un projet efface son état et son historique", async () => {
  const id = proj(orgA, "ephemere", { site_url: siteUrl("/ok") });
  db.saveHealth(id, { ok: true, status: 200, ms: 1, error: null });
  assert.equal((await call(cA, "DELETE", `${A}/projects/${id}`)).status, 200);
  assert.equal(db.projectStatuses(orgA).some((x) => x.row.id === id), false);
});
