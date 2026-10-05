// Vérification d'accès d'un projet (git ls-remote), usage et rotation des secrets.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
process.env.ATELIER_ALLOW_LOCAL_REPOS = "1"; // des dépôts locaux tiennent lieu de forge dans ce test
const db = await import("./db.ts");
const V = await import("./vault.ts");
const { hashPassword } = await import("./auth.ts");
const { createApp } = await import("./app.ts");
const { scrub, verifyAccess } = await import("./git.ts");
const { rowToProject } = await import("./projects.ts");

// un vrai dépôt git local avec une branche « main »
const dir = mkdtempSync(join(tmpdir(), "atelier-verify-"));
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe" });
git(dir, "init", "-q", "-b", "main", "seed");
execFileSync("sh", ["-c", `echo x > ${join(dir, "seed", "f")}`]);
git(join(dir, "seed"), "add", "-A"); git(join(dir, "seed"), "commit", "-qm", "init");
git(dir, "clone", "-q", "--bare", "seed", "remote.git");
const REPO = join(dir, "remote.git");

const hash = await hashPassword("motdepasse1");
const mk = (e: string) => db.createUser(e, hash);
const alice = mk("alice@a.fr"), max = mk("max@a.fr"), bob = mk("bob@b.fr");
const orgA = db.createOrg("A", alice.id), orgB = db.createOrg("B", bob.id);
db.addMember(orgA, max.id, "member");
const proj = (org: string, slug: string, repo: string, branch = "main", secret: string | null = null) =>
  db.insertProject({ org_id: org, slug, name: `Projet ${slug}`, repo, branch, forge: "none", check_cmd: "true", engine: "claude", protected_paths: "[]", git_secret_id: secret });

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
const A = `/api/orgs/${orgA}`;

/* ------------------------------- vérification d'accès ------------------------------- */

test("vérifier l'accès : dépôt joignable et branche trouvée", async () => {
  const p = proj(orgA, "ok", REPO);
  const r = (await (await call(cA, "POST", `${A}/projects/${p}/verify`)).json()) as { ok: boolean; branchFound: boolean; ms: number };
  assert.equal(r.ok, true);
  assert.equal(r.branchFound, true);
  assert.ok(r.ms >= 0);
});

test("vérifier l'accès : dépôt joignable mais branche absente ; dépôt inexistant", async () => {
  const noBranch = proj(orgA, "nobranch", REPO, "branche-qui-n-existe-pas");
  const r1 = (await (await call(cA, "POST", `${A}/projects/${noBranch}/verify`)).json()) as { ok: boolean; branchFound: boolean };
  assert.deepEqual([r1.ok, r1.branchFound], [true, false]);
  const missing = proj(orgA, "missing", join(dir, "nulle-part.git"));
  const r2 = (await (await call(cA, "POST", `${A}/projects/${missing}/verify`)).json()) as { ok: boolean; error: string };
  assert.equal(r2.ok, false);
  assert.equal(r2.error, "not_found");
});

test("vérifier l'accès : le jeton n'apparaît jamais dans l'erreur affichée", () => {
  assert.equal(scrub("fatal: bad https://oauth2:glpat-SECRETVALUE@host/x", ["glpat-SECRETVALUE"]), "fatal: bad https://oauth2:***@host/x");
  assert.equal(scrub("rien", [""]), "rien");        // un secret vide ne casse pas le texte
  assert.equal(scrub("a abc b", ["abc"]), "a abc b"); // trop court (< 4) : ignoré plutôt que de masquer n'importe quoi
});

test("vérifier l'accès : administrateur seulement ; autre organisation 404 ; l'essai est journalisé", async () => {
  const p = proj(orgA, "roles", REPO);
  assert.equal((await call(cM, "POST", `${A}/projects/${p}/verify`)).status, 403);
  assert.equal((await call(cB, "POST", `${A}/projects/${p}/verify`)).status, 404);
  assert.equal((await call(cA, "POST", `${A}/projects/0000000000000000/verify`)).status, 404);
  await call(cA, "POST", `${A}/projects/${p}/verify`);
  const ev = db.queryAudit(orgA, { action: "project.verify" }).items[0];
  assert.equal(JSON.parse(ev.meta!).ok, true);
});

/* -------------------------------- usage et rotation -------------------------------- */

test("secrets : la liste dit quels projets les utilisent et quand ils ont servi pour la dernière fois", async () => {
  const s = V.storeSecret(orgA, "git_token", null, "GitLab", "glpat-abcdefghij1111");
  const used = proj(orgA, "uses-token", REPO, "main", s.id);
  type Item = { id: string; usedBy: { id: string; name: string }[]; last_used_at: number | null };
  let list = (await (await call(cA, "GET", `${A}/secrets`)).json()) as Item[];
  const row = () => list.find((x) => x.id === s.id)!;
  assert.deepEqual(row().usedBy, [{ id: used, name: "Projet uses-token" }]);
  assert.equal(row().last_used_at, null);
  rowToProject(db.getProjectById(used)!); // l'usage réel : le pipeline déchiffre le jeton
  list = (await (await call(cA, "GET", `${A}/secrets`)).json()) as Item[];
  assert.ok(row().last_used_at! > 0);
  // au plus une écriture par minute
  const t = row().last_used_at!;
  db.touchSecret(s.id, t + 30_000);
  assert.equal(db.listSecrets(orgA).find((x) => x.id === s.id)!.last_used_at, t);
  db.touchSecret(s.id, t + 120_000);
  assert.equal(db.listSecrets(orgA).find((x) => x.id === s.id)!.last_used_at, t + 120_000);
});

test("rotation : même identifiant, nouvelle valeur, nouvel indice ; les projets continuent de fonctionner ; la valeur ne ressort jamais", async () => {
  const s = V.storeSecret(orgA, "git_token", null, "Ancien libellé", "glpat-ancienne-valeur-0001");
  const p = proj(orgA, "rotated", REPO, "main", s.id);
  const NEW = "glpat-NOUVELLE-valeur-secrete-9999";
  const r = await call(cA, "PATCH", `${A}/secrets/${s.id}`, { value: NEW, label: "Nouveau libellé" });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(!text.includes("NOUVELLE") && !text.includes("ancienne"), "une valeur est renvoyée");
  const body = JSON.parse(text) as { id: string; hint: string; label: string; usedBy: unknown[] };
  assert.deepEqual([body.id, body.hint, body.label, body.usedBy.length], [s.id, "…9999", "Nouveau libellé", 1]);
  assert.equal(V.readSecret(orgA, s.id), NEW);
  assert.equal(rowToProject(db.getProjectById(p)!).token, NEW);   // le projet voit la nouvelle valeur sans rien changer
  assert.ok(!db.getSecretRow(s.id, orgA)!.ciphertext.includes(Buffer.from("NOUVELLE")));
  const ev = db.queryAudit(orgA, { action: "secret.update" }).items[0];
  assert.deepEqual(JSON.parse(ev.meta!), { kind: "git_token", provider: null, label: "Nouveau libellé", rotated: true });
  assert.ok(!JSON.stringify(db.queryAudit(orgA, {}, 1000)).includes("NOUVELLE"));
});

test("rotation : libellé seul sans toucher la valeur ; entrées invalides ; droits ; autre organisation", async () => {
  const s = V.storeSecret(orgA, "git_token", null, "L", "glpat-valeur-stable-00001");
  assert.equal((await call(cA, "PATCH", `${A}/secrets/${s.id}`, { label: "Renommé" })).status, 200);
  assert.equal(V.readSecret(orgA, s.id), "glpat-valeur-stable-00001");
  assert.equal(db.queryAudit(orgA, { action: "secret.update" }).items[0].meta!.includes('"rotated":false'), true);
  for (const bad of [{}, { label: "" }, { label: 5 }, { value: "" }, { value: "x".repeat(501) }, { value: 7 }])
    assert.equal((await call(cA, "PATCH", `${A}/secrets/${s.id}`, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await call(cM, "PATCH", `${A}/secrets/${s.id}`, { label: "x" })).status, 403);
  assert.equal((await call(cB, "PATCH", `${A}/secrets/${s.id}`, { label: "x" })).status, 404);
  const sB = V.storeSecret(orgB, "git_token", null, "B", "glpat-secret-de-b-000001");
  assert.equal((await call(cA, "PATCH", `${A}/secrets/${sB.id}`, { value: "piratage-piratage" })).status, 404); // via MON organisation
  assert.equal(V.readSecret(orgB, sB.id), "glpat-secret-de-b-000001");
});

test("verifyAccess direct : le dépôt local répond (même chemin de code que l'API)", async () => {
  const r = await verifyAccess({ id: "x", name: "x", repo: REPO, branch: "main", forge: "none", check: "true", engine: "claude", protectedPaths: [], token: "" });
  assert.deepEqual([r.ok, r.branchFound], [true, true]);
});
