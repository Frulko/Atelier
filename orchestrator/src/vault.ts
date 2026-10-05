import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cfg } from "./config.ts";
import * as db from "./db.ts";

/*
 * Secrets au repos : AES-256-GCM. Le nonce est aléatoire par secret ; l'identifiant de l'organisation ET du
 * secret sont des « données associées authentifiées » : un chiffré copié vers une autre organisation (ou
 * un autre secret) ne se déchiffre plus. Format stocké : nonce(12) | tag(16) | chiffré.
 */
const aad = (orgId: string, secretId: string) => Buffer.from(`${orgId}:${secretId}`);

export function encrypt(plain: string, orgId: string, secretId: string, key = masterKey()): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(aad(orgId, secretId));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([nonce, c.getAuthTag(), ct]);
}

export function decrypt(blob: Buffer, orgId: string, secretId: string, key = masterKey()): string {
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  d.setAAD(aad(orgId, secretId));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString("utf8"); // lève une erreur si falsifié / mauvaise organisation
}

/*
 * Clé maître : ATELIER_MASTER_KEY (base64, 32 octets) si fournie ; sinon générée au premier démarrage
 * et gardée à côté de la base (mode 600). ⚠ La perdre = perdre tous les secrets : la sauvegarder AILLEURS que la base.
 */
let cached: Buffer | undefined;
export function masterKey(): Buffer {
  if (cached) return cached;
  const fromEnv = process.env.ATELIER_MASTER_KEY;
  if (fromEnv) {
    const k = Buffer.from(fromEnv, "base64");
    if (k.length !== 32) throw new Error("ATELIER_MASTER_KEY doit être 32 octets en base64 (ex. : openssl rand -base64 32)");
    return (cached = k);
  }
  if (cfg.dbFile === ":memory:") return (cached = randomBytes(32)); // tests : clé éphémère
  const file = join(dirname(cfg.dbFile), "master.key");
  if (existsSync(file)) return (cached = Buffer.from(readFileSync(file, "utf8").trim(), "base64"));
  const k = randomBytes(32);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, k.toString("base64") + "\n", { mode: 0o600 });
  console.log(`Clé maître générée : ${file} — à sauvegarder séparément de la base.`);
  return (cached = k);
}

/* ------------------------------ secrets d'organisation ------------------------------ */

export type SecretKind = "git_token" | "provider_key";

/** Enregistre un secret chiffré. Le clair n'est ni stocké ni renvoyé ; seuls 4 caractères d'indice le sont. */
export function storeSecret(orgId: string, kind: SecretKind, provider: string | null, label: string, value: string) {
  const id = db.newSecretId();
  const hint = value.length >= 12 ? `…${value.slice(-4)}` : "…";
  db.insertSecret({ id, org_id: orgId, kind, provider, label, hint, ciphertext: encrypt(value, orgId, id) });
  return { id, kind, provider, label, hint };
}

/** Déchiffre un secret de CETTE organisation (undefined si absent ou d'une autre organisation). */
export function readSecret(orgId: string, secretId: string | null): string | undefined {
  if (!secretId) return undefined;
  const row = db.getSecretRow(secretId, orgId);
  return row ? decrypt(row.ciphertext, orgId, secretId) : undefined;
}
