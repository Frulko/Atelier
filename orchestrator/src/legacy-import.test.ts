import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "motdepasse-initial";
process.env.ANTHROPIC_API_KEY = "sk-ant-cle-d-environnement";
process.env.GIT_TOKEN = "glpat-token-par-defaut-1111";
process.env.GIT_TOKEN_AUTRE = "ghp_token-autre-2222";
process.env.PROJECTS_JSON = JSON.stringify([
  { id: "Regis", name: "MonRégis", repo: "https://gitlab.com/g/regis.git", check: "node --check app.js", protectedPaths: ["db/"] },
  { id: "autre", repo: "https://github.com/o/autre.git", tokenEnv: "GIT_TOKEN_AUTRE" },
  { id: "sans-token", repo: "https://gitlab.com/g/x.git", tokenEnv: "ABSENT" },
]);
const db = await import("./db.ts");
const { bootstrapOwner, importLegacyConfig } = await import("./bootstrap.ts");
const V = await import("./vault.ts");
const { rowToProject } = await import("./projects.ts");

test("la configuration M1 est reprise une fois : projets en base, tokens et clés chiffrés", async () => {
  // Tâche d'avant les organisations : org_id NULL, et le champ « project » contient l'ancien identifiant de la config.
  db.createTask("aaaaaaa1", null as unknown as string, "u", "Regis", "ancienne tâche");
  await bootstrapOwner(); // rattache les tâches orphelines à l'organisation « Défaut »
  importLegacyConfig();

  const org = db.firstOrgId()!;
  const projects = db.listProjects(org);
  assert.deepEqual(projects.map((p) => p.slug).sort(), ["autre", "regis", "sans-token"]);

  const regis = projects.find((p) => p.slug === "regis")!;
  assert.equal(rowToProject(regis).token, "glpat-token-par-defaut-1111"); // déchiffré à l'usage
  assert.equal(rowToProject(projects.find((p) => p.slug === "autre")!).token, "ghp_token-autre-2222");
  assert.equal(rowToProject(projects.find((p) => p.slug === "sans-token")!).token, "");
  assert.equal(projects.find((p) => p.slug === "autre")!.forge, "github"); // forge déduite
  assert.deepEqual(JSON.parse(regis.protected_paths), ["db/"]);

  const secrets = db.listSecrets(org);
  assert.equal(secrets.filter((s) => s.kind === "git_token").length, 2); // un par variable distincte
  const prov = secrets.find((s) => s.kind === "provider_key")!;
  assert.equal(prov.provider, "anthropic");
  assert.equal(V.readSecret(org, prov.id), "sk-ant-cle-d-environnement");

  assert.equal(db.getTask("aaaaaaa1")!.project, regis.id); // l'ancienne tâche suit son projet
});

test("l'import n'a lieu qu'une fois : relancer ne duplique rien", () => {
  const org = db.firstOrgId()!;
  const before = [db.listProjects(org).length, db.listSecrets(org).length];
  importLegacyConfig();
  assert.deepEqual([db.listProjects(org).length, db.listSecrets(org).length], before);
});
