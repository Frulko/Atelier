import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
process.env.ANTHROPIC_API_KEY = "x";
process.env.ATELIER_GIT_HOSTS = "gitlab.com, git.mon-domaine.fr";
delete process.env.ATELIER_ALLOW_LOCAL_REPOS;
const { validateProject } = await import("./projects.ts");

const ok = { slug: "regis", name: "MonRégis", repo: "https://gitlab.com/g/regis.git" };
const err = (input: object) => { const r = validateProject({ ...ok, ...input }, false); return r.ok ? null : r.error; };

test("projet valide : valeurs par défaut posées, forge déduite de l'URL", () => {
  const r = validateProject(ok, false);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual([r.value.branch, r.value.check, r.value.engine, r.value.forge], ["main", "true", "claude", "gitlab"]);
});

test("dépôt : seuls les https sans identifiants, sur un hôte autorisé", () => {
  for (const repo of ["file:///etc", "ssh://git@gitlab.com/g/r.git", "/etc", "../x", "ext::sh -c id", "https://u:p@gitlab.com/g/r.git", "https://github.com/o/r.git", "-oProxyCommand=x"])
    assert.ok(err({ repo }), repo);
  assert.equal(err({ repo: "https://git.mon-domaine.fr/g/r.git" }), null);
});

test("branche : pas d'option git déguisée ni de remontée de répertoire", () => {
  for (const branch of ["--upload-pack=x", "-x", "a..b", "a b", "a;rm"]) assert.ok(err({ branch }), branch);
  assert.equal(err({ branch: "release/1.2" }), null);
});

test("slug, moteur, forge, chemins protégés : valeurs hors liste refusées", () => {
  assert.ok(err({ slug: "Majuscule" }));
  assert.ok(err({ slug: "../x" }));
  assert.ok(err({ engine: "inconnu" }));
  assert.ok(err({ forge: "svn" }));
  assert.ok(err({ protectedPaths: "pas un tableau" }));
  assert.ok(err({ check: "x".repeat(501) }));
});

test("mise à jour partielle : seuls les champs fournis sont validés", () => {
  const r = validateProject({ name: "Nouveau nom" }, true);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(Object.keys(r.value), ["name"]);
  assert.equal(validateProject({ repo: "file:///etc" }, true).ok, false);
});
