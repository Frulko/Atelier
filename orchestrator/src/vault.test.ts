import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "atelier-vault-"));
process.env.DB_FILE = join(dir, "t.db"); // fichier réel : la clé maître doit être générée à côté
delete process.env.ATELIER_MASTER_KEY;
process.env.ATELIER_PASSWORD = "x";
process.env.ANTHROPIC_API_KEY = "x";
const db = await import("./db.ts");
const V = await import("./vault.ts");

const owner = db.createUser("o@x.fr", "h");
const orgA = db.createOrg("A", owner.id);
const orgB = db.createOrg("B", owner.id);

test("clé maître : générée au premier usage, 32 octets, lisible par le seul propriétaire du fichier", () => {
  V.masterKey();
  const f = join(dir, "master.key");
  assert.equal(Buffer.from(readFileSync(f, "utf8").trim(), "base64").length, 32);
  assert.equal(statSync(f).mode & 0o777, 0o600);
});

test("chiffrement : aller-retour, nonce différent à chaque fois, clair absent du chiffré", () => {
  const a = V.encrypt("glpat-secret-1234", orgA, "s1");
  const b = V.encrypt("glpat-secret-1234", orgA, "s1");
  assert.notDeepEqual(a, b);
  assert.equal(V.decrypt(a, orgA, "s1"), "glpat-secret-1234");
  assert.ok(!a.includes(Buffer.from("secret")));
});

test("chiffrement : un chiffré copié vers une autre organisation ou un autre secret ne se déchiffre pas", () => {
  const blob = V.encrypt("valeur", orgA, "s1");
  assert.throws(() => V.decrypt(blob, orgB, "s1"));
  assert.throws(() => V.decrypt(blob, orgA, "s2"));
});

test("chiffrement : un chiffré falsifié est refusé (intégrité)", () => {
  const blob = V.encrypt("valeur", orgA, "s1");
  blob[blob.length - 1] ^= 1;
  assert.throws(() => V.decrypt(blob, orgA, "s1"));
});

test("secrets d'organisation : indice seulement, jamais le clair ; illisible depuis une autre organisation", () => {
  const s = V.storeSecret(orgA, "git_token", null, "mon token", "glpat-abcdefghij1234");
  assert.equal(s.hint, "…1234");
  assert.ok(!JSON.stringify(s).includes("abcdefghij"));
  const listed = db.listSecrets(orgA);
  assert.equal(listed.length, 1);
  assert.ok(!("ciphertext" in listed[0]));
  assert.equal(V.readSecret(orgA, s.id), "glpat-abcdefghij1234");
  assert.equal(V.readSecret(orgB, s.id), undefined); // même identifiant exact, autre organisation
  assert.equal(V.readSecret(orgA, null), undefined);
  assert.ok(!db.getSecretRow(s.id, orgA)!.ciphertext.includes(Buffer.from("abcdefghij"))); // rien en clair en base
});
