// Démarrage à vide : Compose passe PROJECTS_JSON="" quand la variable n'est pas renseignée. Cela ne doit PAS faire planter le serveur.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ATELIER_PASSWORD = "x";
process.env.PROJECTS_FILE = "/nonexistent/projects.json";
const { loadLegacyProjects } = await import("./config.ts");

test("PROJECTS_JSON vide, blanc ou absent : aucun projet, pas d'erreur", () => {
  for (const v of ["", "   ", "\n", undefined]) {
    if (v === undefined) delete process.env.PROJECTS_JSON; else process.env.PROJECTS_JSON = v;
    assert.deepEqual(loadLegacyProjects(), [], JSON.stringify(v));
  }
});

test("PROJECTS_JSON invalide : un message clair, pas une trace d'exécution", () => {
  process.env.PROJECTS_JSON = "{pas du json";
  assert.throws(() => loadLegacyProjects(), /n'est pas un JSON valide/);
  process.env.PROJECTS_JSON = '{"id":"x"}';
  assert.throws(() => loadLegacyProjects(), /liste de projets/);
});

test("une liste valide est reprise", () => {
  process.env.PROJECTS_JSON = '[{"id":"a","repo":"https://github.com/o/a.git"}]';
  const [p] = loadLegacyProjects();
  assert.deepEqual([p!.id, p!.forge, p!.branch], ["a", "github", "main"]);
});
