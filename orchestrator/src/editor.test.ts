// Éditeur de code, phase 1 : espaces de travail et fichiers. Un navigateur envoie des chemins et des contenus : tout est hostile.
// Les tests utilisent un VRAI dépôt git local (avec un lien symbolique piégé) et un vrai serveur HTTP.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "atelier-editor-"));
process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
process.env.ATELIER_WORKDIR = join(tmp, "work");
process.env.ATELIER_ALLOW_LOCAL_REPOS = "1";
const db = await import("./db.ts");
const { hashPassword } = await import("./auth.ts");
const { createApp } = await import("./app.ts");
const ed = await import("./editor.ts");

// --- un dépôt avec un secret HORS de l'espace de travail, et des liens qui essaient d'y mener
const secretFile = join(tmp, "hors-du-projet.txt");
writeFileSync(secretFile, "SECRET-DE-L-HOTE");
const repo = join(tmp, "repo");
execFileSync("git", ["init", "-q", "-b", "main", repo]);
mkdirSync(join(repo, "src")); mkdirSync(join(repo, "data"));
writeFileSync(join(repo, "index.html"), "<title>Boulangerie</title>\n");
writeFileSync(join(repo, "src", "app.js"), "console.log('ok');\n");
writeFileSync(join(repo, "logo.bin"), Buffer.from([1, 2, 0, 3]));
writeFileSync(join(repo, "gros.txt"), "x".repeat(1_000_001));
symlinkSync(secretFile, join(repo, "lien-fichier"));
symlinkSync(tmp, join(repo, "lien-dossier"));
const g = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@x.fr", ...a], { encoding: "utf8" });
g("add", "-A"); g("commit", "-q", "-m", "init");

const hash = await hashPassword("motdepasse1");
const mk = (e: string) => db.createUser(e, hash);
const alice = mk("alice@a.fr"), max = mk("max@a.fr"), sam = mk("sam@a.fr"), vera = mk("vera@a.fr"), bob = mk("bob@b.fr");
const orgA = db.createOrg("A", alice.id), orgB = db.createOrg("B", bob.id);
db.addMember(orgA, max.id, "member"); db.addMember(orgA, sam.id, "member"); db.addMember(orgA, vera.id, "viewer");
const proj = (org: string, slug: string) => db.insertProject({ org_id: org, slug, name: `P ${slug}`, repo, branch: "main", forge: "none", check_cmd: "true", engine: "claude", protected_paths: "[]", git_secret_id: null });
const pA = proj(orgA, "a"), pA2 = proj(orgA, "a2"), pA3 = proj(orgA, "a3"), pA4 = proj(orgA, "a4"), pB = proj(orgB, "b");

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
const A = `/api/orgs/${orgA}/editor/sessions`;
const open = async (c: string, projectId: string, taskId?: string) => (await call(c, "POST", A, { projectId, taskId })).json() as Promise<{ id: string; branch: string; error?: string }>;
const file = (c: string, id: string, p: string) => call(c, "GET", `${A}/${id}/file?path=${encodeURIComponent(p)}`);
const put = (c: string, id: string, path: string, content: unknown) => call(c, "PUT", `${A}/${id}/file`, { path, content });
const ops = (c: string, id: string, body: unknown) => call(c, "POST", `${A}/${id}/files`, body);

let s1: { id: string; branch: string };
test("ouvrir une session : clone la branche dans un espace privé ; rouvrir reprend la même ; le dépôt (.git) n'est ni dans l'arbre ni listé", async () => {
  const r = await call(cM, "POST", A, { projectId: pA });
  assert.equal(r.status, 201);
  s1 = (await r.json()) as typeof s1;
  assert.match(s1.branch, /^atelier\/edit-[0-9a-f]{16}$/);
  assert.equal((await open(cM, pA)).id, s1.id);                              // reprise, pas un deuxième clone
  const tree = (await (await call(cM, "GET", `${A}/${s1.id}/tree`)).json()) as { entries: { name: string; type: string }[] };
  const names = tree.entries.map((e) => e.name);
  assert.equal(tree.entries[0]!.name, "src");                                // les dossiers d'abord
  assert.ok(names.includes("index.html") && !names.includes(".git"));
  assert.equal(tree.entries.find((e) => e.name === "lien-dossier")!.type, "link");
  const sub = (await (await call(cM, "GET", `${A}/${s1.id}/tree?path=src`)).json()) as { entries: { path: string }[] };
  assert.deepEqual(sub.entries.map((e) => e.path), ["src/app.js"]);
  assert.ok(existsSync(join(tmp, "work", `edit-${s1.id}`, "git")));          // le dépôt est HORS du dossier d'édition
  assert.ok(!existsSync(join(tmp, "work", `edit-${s1.id}`, "tree", ".git")));
});

test("lire et enregistrer un brouillon ; créer, renommer, supprimer", async () => {
  const f = (await (await file(cM, s1.id, "index.html")).json()) as { content: string };
  assert.equal(f.content, "<title>Boulangerie</title>\n");
  assert.equal((await put(cM, s1.id, "index.html", "<title>Fournil</title>\n")).status, 200);
  assert.equal(((await (await file(cM, s1.id, "index.html")).json()) as { content: string }).content, "<title>Fournil</title>\n");
  assert.equal((await put(cM, s1.id, "src/nouveau.js", "1;")).status, 200);                       // création par enregistrement
  assert.equal((await ops(cM, s1.id, { op: "create", path: "docs", type: "dir" })).status, 200);
  assert.equal((await ops(cM, s1.id, { op: "create", path: "docs/a.md", type: "file" })).status, 200);
  assert.equal((await ops(cM, s1.id, { op: "create", path: "docs/a.md", type: "file" })).status, 409);   // existe déjà
  assert.equal((await ops(cM, s1.id, { op: "rename", from: "docs/a.md", to: "docs/b.md" })).status, 200);
  assert.equal((await file(cM, s1.id, "docs/b.md")).status, 200);
  assert.equal((await file(cM, s1.id, "docs/a.md")).status, 404);
  assert.equal((await ops(cM, s1.id, { op: "rename", from: "docs", to: "docs/dedans" })).status, 400);  // dans soi-même
  assert.equal((await ops(cM, s1.id, { op: "rename", from: "docs/b.md", to: "index.html" })).status, 409);  // n'écrase rien
  assert.equal((await ops(cM, s1.id, { op: "delete", path: "docs" })).status, 200);
  assert.equal((await file(cM, s1.id, "docs/b.md")).status, 404);
  assert.equal((await ops(cM, s1.id, { op: "delete", path: "absent" })).status, 404);
  assert.equal((await ops(cM, s1.id, { op: "mkfifo", path: "x" })).status, 400);
});

test("chemins hostiles : sortie de l'arbre, absolus, .git, antislash, octet nul, encodages : tous refusés, rien écrit hors de l'espace", async () => {
  const bad = ["../hors-du-projet.txt", "src/../../hors-du-projet.txt", "/etc/passwd", "..", ".", "src//app.js", ".git/config", "src/.git/x", ".GIT/config", "a\\b", "a\0b", "%2e%2e/x", "src/./app.js", "x".repeat(501), "", "ligne\nbreak"];
  for (const p of bad) {
    for (const [name, r] of [["lire", await file(cM, s1.id, p)], ["écrire", await put(cM, s1.id, p, "pwn")]] as const) assert.ok([400, 404].includes(r.status), `${name} ${JSON.stringify(p)} → ${r.status}`);
    assert.ok([400, 404].includes((await ops(cM, s1.id, { op: "delete", path: p })).status), `supprimer ${JSON.stringify(p)}`);
    assert.ok([400, 404].includes((await ops(cM, s1.id, { op: "rename", from: "index.html", to: p })).status), `renommer vers ${JSON.stringify(p)}`);
  }
  assert.equal((await call(cM, "GET", `${A}/${s1.id}/tree?path=..`)).status, 400);
  assert.equal(Buffer.from(execFileSync("cat", [secretFile])).toString(), "SECRET-DE-L-HOTE");   // intact
  assert.ok(!existsSync(join(tmp, "work", "hors-du-projet.txt")));
});

test("liens symboliques : ni lus, ni écrits, ni traversés — le secret de l'hôte reste hors de portée", async () => {
  assert.equal((await file(cM, s1.id, "lien-fichier")).status, 415);                              // lire
  assert.equal((await put(cM, s1.id, "lien-fichier", "ÉCRASÉ")).status, 415);                     // écrire À TRAVERS le lien
  assert.equal((await file(cM, s1.id, "lien-dossier/hors-du-projet.txt")).status, 400);           // traverser un dossier lien
  assert.equal((await put(cM, s1.id, "lien-dossier/nouveau.txt", "x")).status, 400);
  assert.equal((await call(cM, "GET", `${A}/${s1.id}/tree?path=lien-dossier`)).status, 415);       // un lien n'est pas ouvert comme un dossier
  assert.equal((await ops(cM, s1.id, { op: "create", path: "lien-dossier/x", type: "file" })).status, 400);
  assert.equal(execFileSync("cat", [secretFile], { encoding: "utf8" }), "SECRET-DE-L-HOTE");
  assert.ok(!existsSync(join(tmp, "nouveau.txt")) && !existsSync(join(tmp, "x")));
  // supprimer le LIEN lui-même est permis (il ne touche pas à sa cible)
  assert.equal((await ops(cM, s1.id, { op: "delete", path: "lien-fichier" })).status, 200);
  assert.equal(execFileSync("cat", [secretFile], { encoding: "utf8" }), "SECRET-DE-L-HOTE");
});

test("fichiers binaires, trop gros, contenu invalide, quota de l'espace de travail", async () => {
  assert.equal((await file(cM, s1.id, "logo.bin")).status, 415);
  assert.equal((await put(cM, s1.id, "logo.bin", "texte")).status, 415);                         // n'écrase pas un binaire
  assert.equal((await file(cM, s1.id, "gros.txt")).status, 413);
  assert.equal((await put(cM, s1.id, "nouveau-gros.txt", "x".repeat(1_000_001))).status, 413);
  for (const bad of [5, null, { a: 1 }, "a\0b"]) assert.equal((await put(cM, s1.id, "x.txt", bad)).status, 400, String(bad));
  assert.equal((await ops(cM, s1.id, { op: "create", path: "sous-dossier-absent/x", type: "file" })).status, 404);
  // quota : 50 Mo au total — on remplit par morceaux de 900 Ko
  let refused = 0;
  for (let i = 0; i < 60 && !refused; i++) { const r = await put(cM, s1.id, `rempli-${i}.txt`, "y".repeat(900_000)); if (r.status === 413) refused = i; else assert.equal(r.status, 200); }
  assert.ok(refused > 30 && refused < 60, `quota atteint au fichier ${refused}`);
});

test("confidentialité : une session est PRIVÉE — même un administrateur, un autre membre ou une autre organisation la trouvent introuvable", async () => {
  for (const [who, c] of [["autre membre", cS], ["administrateur", cA], ["autre organisation", cB]] as const) {
    assert.equal((await call(c, "GET", `${A}/${s1.id}`)).status, 404, who);
    assert.equal((await file(c, s1.id, "index.html")).status, 404, who);
    assert.equal((await put(c, s1.id, "index.html", "x")).status, 404, who);
    assert.equal((await call(c, "DELETE", `${A}/${s1.id}`)).status, 404, who);
  }
  assert.equal((await call(cM, "GET", `${A}/${s1.id}`)).status, 200);
  assert.equal((await call(cV, "POST", A, { projectId: pA })).status, 403);                       // un lecteur n'édite pas
  assert.equal((await call(cB, "POST", A, { projectId: pA })).status, 404);                       // ni un étranger
  assert.equal((await call(cM, "POST", A, { projectId: pB })).status, 400);                       // projet d'une autre organisation
  assert.equal((await call(cM, "POST", A, {})).status, 400);
  assert.equal((await call(await login("max@a.fr"), "POST", `/api/orgs/${orgB}/editor/sessions`, { projectId: pB })).status, 404);
});

test("limites : 3 éditions ouvertes par organisation ; abandonner libère de la place et efface le dossier", async () => {
  const a = await open(cA, pA2), b = await open(cS, pA3);
  assert.ok(a.id && b.id);                                                                         // s1 (Max), a (Alice), b (Sam) : 3
  const r = await call(cA, "POST", A, { projectId: pA4 });
  assert.equal(r.status, 409);
  assert.equal((await call(cA, "DELETE", `${A}/${a.id}`)).status, 200);
  assert.ok(!existsSync(join(tmp, "work", `edit-${a.id}`)));
  assert.equal((await call(cA, "GET", `${A}/${a.id}`)).status, 404);
  assert.equal((await call(cA, "POST", A, { projectId: pA4 })).status, 201);
});

test("expiration : une session inactive est effacée (base et disque), les dossiers orphelins aussi", async () => {
  const tree = join(tmp, "work", `edit-${s1.id}`);
  assert.ok(existsSync(tree));
  const orphan = join(tmp, "work", "edit-0123456789abcdef"); mkdirSync(orphan, { recursive: true });
  const keep = join(tmp, "work", "_status"); mkdirSync(keep, { recursive: true });
  await ed.sweepEditor(Date.now() + ed.IDLE_MS + 1000);
  assert.ok(!existsSync(tree) && !existsSync(orphan));
  assert.ok(existsSync(keep));                                                                     // le reste de workDir n'est pas touché
  assert.equal((await call(cM, "GET", `${A}/${s1.id}`)).status, 404);
  assert.equal((await file(cM, s1.id, "index.html")).status, 404);
});

test("session sur la branche d'une tâche : refusée si la tâche travaille, n'a pas de branche, ou n'est pas du projet", async () => {
  db.createTask("e1e1e1e1", orgA, max.id, pA, "x"); db.updateTask("e1e1e1e1", { status: "running", branch: "atelier/e1e1e1e1" });
  assert.equal((await call(cM, "POST", A, { projectId: pA, taskId: "e1e1e1e1" })).status, 409);
  db.updateTask("e1e1e1e1", { status: "failed" });
  assert.equal((await call(cM, "POST", A, { projectId: pA, taskId: "e1e1e1e1" })).status, 409);
  assert.equal((await call(cM, "POST", A, { projectId: pA, taskId: "inconnue0" })).status, 404);
  db.createTask("e2e2e2e2", orgA, max.id, pA2, "x"); db.updateTask("e2e2e2e2", { status: "done", branch: "atelier/e2e2e2e2" });
  assert.equal((await call(cM, "POST", A, { projectId: pA, taskId: "e2e2e2e2" })).status, 404);    // tâche d'un autre projet
  db.updateTask("e1e1e1e1", { status: "done", branch: "atelier/inexistante" });
  assert.equal((await call(cM, "POST", A, { projectId: pA, taskId: "e1e1e1e1" })).status, 502);    // branche absente du dépôt : dit, sans fuite
  assert.ok(!existsSync(join(tmp, "work")) || !(await import("node:fs")).readdirSync(join(tmp, "work")).some((d) => d.startsWith("edit-") && !db.allEditorSessionIds().map((i) => `edit-${i}`).includes(d)));  // pas de dossier laissé derrière
});

test("sur une vraie branche de tâche : on l'ouvre quand la tâche est terminée", async () => {
  g("checkout", "-q", "-b", "atelier/f1f1f1f1"); writeFileSync(join(repo, "NOTES.md"), "- note de l'agent\n"); g("add", "-A"); g("commit", "-q", "-m", "agent"); g("checkout", "-q", "main");
  db.createTask("f1f1f1f1", orgA, sam.id, pA4, "x"); db.updateTask("f1f1f1f1", { status: "done", branch: "atelier/f1f1f1f1" });
  const c = await call(cS, "POST", A, { projectId: pA4, taskId: "f1f1f1f1" });
  assert.equal(c.status, 201);
  const s = (await c.json()) as { id: string; branch: string; taskId: string };
  assert.deepEqual([s.branch, s.taskId], ["atelier/f1f1f1f1", "f1f1f1f1"]);
  assert.equal(((await (await file(cS, s.id, "NOTES.md")).json()) as { content: string }).content, "- note de l'agent\n");   // le travail de l'agent est là
});
