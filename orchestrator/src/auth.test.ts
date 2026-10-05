// Lancer : npm test  (node --test, aucune dépendance)
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "motdepasse-initial";
process.env.ANTHROPIC_API_KEY = "x";
const { hashPassword, verifyPassword, passwordProblem } = await import("./auth.ts");
const db = await import("./db.ts");
const { bootstrapOwner } = await import("./bootstrap.ts");

test("hash : bon mot de passe accepté, mauvais refusé, sel différent à chaque fois", async () => {
  const h1 = await hashPassword("correct horse");
  const h2 = await hashPassword("correct horse");
  assert.notEqual(h1, h2);
  assert.ok(await verifyPassword("correct horse", h1));
  assert.ok(!(await verifyPassword("correct horsE", h1)));
});

test("hash : un hash corrompu ou aux paramètres hostiles est refusé sans planter", async () => {
  assert.ok(!(await verifyPassword("x", "n'importe quoi")));
  assert.ok(!(await verifyPassword("x", "scrypt$1073741824$8$1$AAAA$AAAA"))); // N énorme : refus avant tout calcul
});

test("politique : trop court / trop long", () => {
  assert.ok(passwordProblem("court"));
  assert.ok(passwordProblem("x".repeat(2000)));
  assert.equal(passwordProblem("assez long"), null);
});

test("démarrage : le propriétaire est créé une seule fois, avec son organisation", async () => {
  assert.equal(await bootstrapOwner(), true);
  assert.equal(await bootstrapOwner(), false);
  assert.equal(db.countUsers(), 1);
  const u = db.getUserByEmail("ADMIN@localhost "); // e-mail normalisé
  assert.ok(u && (await verifyPassword("motdepasse-initial", u.password_hash)));
  const orgs = db.orgsOf(u.id);
  assert.equal(orgs.length, 1);
  assert.equal(orgs[0].role, "owner");
  assert.equal(db.roleOf(orgs[0].id, u.id), "owner");
});
