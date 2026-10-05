import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// scrypt (inclus dans Node) : pas de dépendance. Les paramètres sont stockés AVEC le hash,
// donc on pourra les durcir plus tard sans casser les anciens mots de passe.
type Params = { N: number; r: number; p: number };
const DEFAULT: Params = { N: 2 ** 15, r: 8, p: 1 };
const kdf = promisify(scrypt) as (pw: string, salt: Buffer, len: number, o: Params & { maxmem: number }) => Promise<Buffer>;
const derive = (pw: string, salt: Buffer, prm: Params) => kdf(pw, salt, 32, { ...prm, maxmem: 128 * prm.N * prm.r + 1024 * 1024 });

export const MAX_PASSWORD = 1024; // évite qu'un mot de passe géant serve à saturer le serveur

export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return "8 caractères minimum";
  if (pw.length > MAX_PASSWORD) return "trop long";
  return null;
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(pw, salt, DEFAULT);
  return ["scrypt", DEFAULT.N, DEFAULT.r, DEFAULT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  if (pw.length > MAX_PASSWORD) return false;
  const [alg, N, r, p, salt, key] = stored.split("$");
  if (alg !== "scrypt" || !key) return false;
  const prm = { N: Number(N), r: Number(r), p: Number(p) };
  if (!(prm.N >= 2 ** 14 && prm.N <= 2 ** 20 && prm.r >= 1 && prm.r <= 16 && prm.p >= 1 && prm.p <= 4)) return false; // hash corrompu ou hostile
  const expected = Buffer.from(key, "base64");
  const actual = await derive(pw, Buffer.from(salt, "base64"), prm);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
