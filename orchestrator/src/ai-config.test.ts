// Configuration de l'IA d'un projet : instructions de l'équipe, réglages de l'agent, fichiers d'instructions du dépôt (CLAUDE.md, AGENTS.md,
// règles, skills, sous-agents) lus dans un vrai dépôt git, et création de dossiers par l'éditeur.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "atelier-ai-"));
process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
process.env.ATELIER_FAKE_AGENT = "1";
process.env.ATELIER_WORKDIR = join(tmp, "work");
process.env.ATELIER_ALLOW_LOCAL_REPOS = "1";
const db = await import("./db.ts");
const { hashPassword } = await import("./auth.ts");
const { createApp } = await import("./app.ts");
const { buildSystem } = await import("./chat.ts");
const { rowToProject } = await import("./projects.ts");

const repo = join(tmp, "repo");
execFileSync("git", ["init", "-q", "-b", "main", repo]);
const put = (p: string, c: string) => { mkdirSync(join(repo, p, ".."), { recursive: true }); writeFileSync(join(repo, p), c); };
put("CLAUDE.md", "# Règles\nToujours tutoyer.\n"); put(".claude/rules/style.md", "Pas de jargon.\n"); put(".claude/skills/page-contact/SKILL.md", "---\nname: page-contact\n---\nCréer une page contact.\n");
put(".claude/agents/relecteur.md", "Relis le code.\n"); put("index.html", "<title>x</title>\n"); put("docs/CLAUDE.md", "pas à la racine\n"); put(".claude/rules/sous/dossier.md", "trop profond\n"); put(".claude/settings.json", "{}\n");
execFileSync("git", ["-C", repo, "add", "-A"]); execFileSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@x.fr", "commit", "-q", "-m", "init"]);

const hash = await hashPassword("motdepasse1");
const mk = (e: string) => db.createUser(e, hash);
const alice = mk("alice@a.fr"), max = mk("max@a.fr"), vera = mk("vera@a.fr"), bob = mk("bob@b.fr");
const orgA = db.createOrg("A", alice.id), orgB = db.createOrg("B", bob.id);
db.addMember(orgA, max.id, "member"); db.addMember(orgA, vera.id, "viewer");
const proj = (org: string, slug: string) => db.insertProject({ org_id: org, slug, name: `P ${slug}`, repo, branch: "main", forge: "none", check_cmd: "true", engine: "claude", protected_paths: "[]", git_secret_id: null });
const pA = proj(orgA, "a"), pB = proj(orgB, "b");

const server = createApp().listen(0);
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function login(e: string) { const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e, password: "motdepasse1" }) }); return r.headers.get("set-cookie")!.split(";")[0]; }
const call = (c: string, m: string, p: string, b?: unknown) => fetch(base + p, { method: m, headers: { "content-type": "application/json", cookie: c }, body: b ? JSON.stringify(b) : undefined });
const cA = await login("alice@a.fr"), cM = await login("max@a.fr"), cV = await login("vera@a.fr"), cB = await login("bob@b.fr");
const A = `/api/orgs/${orgA}`;

test("réglages de l'IA du projet : validés, enregistrés, effaçables ; administrateur seulement", async () => {
  const body = { instructions: "  Toujours répondre en français.  ", agentModel: "claude-sonnet-5-5", agentMaxTurns: 12, agentBudgetUsd: 1.5 };
  assert.equal((await call(cM, "PATCH", `${A}/projects/${pA}`, body)).status, 403);
  const r = await call(cA, "PATCH", `${A}/projects/${pA}`, body);
  assert.equal(r.status, 200);
  const p = (await r.json()) as Record<string, unknown>;
  assert.deepEqual([p.instructions, p.agentModel, p.agentMaxTurns, p.agentBudgetUsd], ["Toujours répondre en français.", "claude-sonnet-5-5", 12, 1.5]);
  for (const bad of [{ agentMaxTurns: 0 }, { agentMaxTurns: 101 }, { agentMaxTurns: 2.5 }, { agentMaxTurns: "x" }, { agentBudgetUsd: 0 }, { agentBudgetUsd: 51 }, { agentBudgetUsd: -1 },
    { agentModel: "avec espace" }, { agentModel: "x".repeat(101) }, { agentModel: 5 }, { instructions: "x".repeat(4001) }, { instructions: 5 }, { instructions: "a\0b" }])
    assert.equal((await call(cA, "PATCH", `${A}/projects/${pA}`, bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  const cleared = (await (await call(cA, "PATCH", `${A}/projects/${pA}`, { instructions: "", agentModel: null, agentMaxTurns: null, agentBudgetUsd: "" })).json()) as Record<string, unknown>;
  assert.deepEqual([cleared.instructions, cleared.agentModel, cleared.agentMaxTurns, cleared.agentBudgetUsd], [null, null, null, null]);
});

test("l'agent et l'assistant reçoivent les instructions du projet ; les réglages passent au bac à sable", async () => {
  await call(cA, "PATCH", `${A}/projects/${pA}`, { instructions: "Signe chaque page « Le Fournil ».", agentModel: "claude-test-1", agentMaxTurns: 7, agentBudgetUsd: 0.5 });
  const row = db.getProjectById(pA)!;
  const p = rowToProject(row);
  assert.deepEqual([p.instructions, p.agentModel, p.agentMaxTurns, p.agentBudgetUsd], ["Signe chaque page « Le Fournil ».", "claude-test-1", 7, 0.5]);
  const system = buildSystem(row, "");
  assert.match(system, /# Instructions de l'équipe pour ce projet/);
  assert.match(system, /Signe chaque page/);
  assert.doesNotMatch(buildSystem({ ...row, instructions: null }, ""), /Instructions de l'équipe/);
  await call(cA, "PATCH", `${A}/projects/${pA}`, { instructions: null, agentModel: null, agentMaxTurns: null, agentBudgetUsd: null });
});

test("fichiers d'IA du dépôt : seuls CLAUDE.md, AGENTS.md, règles, skills et sous-agents ; lus dans le dépôt ; membres seulement", async () => {
  const r = await call(cM, "GET", `${A}/projects/${pA}/ai-files`);
  assert.equal(r.status, 200);
  const files = ((await r.json()) as { files: { path: string; size: number }[] }).files;
  assert.deepEqual(files.map((f) => f.path), [".claude/agents/relecteur.md", ".claude/rules/style.md", ".claude/skills/page-contact/SKILL.md", "CLAUDE.md"]);
  assert.ok(files.every((f) => f.size > 0));                                                     // ni index.html, ni docs/CLAUDE.md, ni settings.json, ni règle trop profonde
  const f = await call(cM, "GET", `${A}/projects/${pA}/ai-file?path=CLAUDE.md`);
  assert.equal(((await f.json()) as { content: string }).content, "# Règles\nToujours tutoyer.\n");
  assert.equal((await call(cM, "GET", `${A}/projects/${pA}/ai-file?path=AGENTS.md`)).status, 404);   // absent : on peut le créer
  for (const bad of ["index.html", "../etc/passwd", "docs/CLAUDE.md", ".claude/settings.json", "/CLAUDE.md", "CLAUDE.md%00", ".claude/rules/sous/dossier.md", "", "-p"])
    assert.equal((await call(cM, "GET", `${A}/projects/${pA}/ai-file?path=${encodeURIComponent(bad)}`)).status, 400, bad);
  assert.equal((await call(cV, "GET", `${A}/projects/${pA}/ai-files`)).status, 403);                // le contenu du dépôt n'est pas pour les lecteurs
  assert.equal((await call(cB, "GET", `${A}/projects/${pA}/ai-files`)).status, 404);
  assert.equal((await call(cA, "GET", `${A}/projects/${pB}/ai-files`)).status, 404);                // un projet d'une autre organisation par l'URL de la sienne
});

test("l'éditeur crée les dossiers manquants d'un fichier d'IA (…/.claude/skills/x/SKILL.md), sans sortir de l'arbre", async () => {
  const E = `${A}/editor/sessions`;
  const s = (await (await call(cM, "POST", E, { projectId: pA })).json()) as { id: string };
  const put2 = (path: string, parents?: boolean) => call(cM, "PUT", `${E}/${s.id}/file`, { path, content: "# nouveau\n", parents });
  assert.equal((await put2(".claude/skills/nouvelle/SKILL.md")).status, 404);                       // sans l'option, comme avant
  assert.equal((await put2(".claude/skills/nouvelle/SKILL.md", true)).status, 200);
  assert.equal(((await (await call(cM, "GET", `${E}/${s.id}/file?path=.claude/skills/nouvelle/SKILL.md`)).json()) as { content: string }).content, "# nouveau\n");
  assert.equal((await put2("CLAUDE.md/dedans.md", true)).status, 400);                              // un fichier occupe le nom du dossier
  for (const bad of ["../x/y.md", ".git/hooks/pre-commit", "a/../../b.md"]) assert.ok([400].includes((await put2(bad, true)).status), bad);
  await call(cM, "DELETE", `${E}/${s.id}`);
});
