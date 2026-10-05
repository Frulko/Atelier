import { createHash, randomBytes } from "node:crypto";
import * as db from "./db.ts";

// Le jeton (256 bits aléatoires) n'est jamais stocké : seulement son empreinte SHA-256.
// Une fuite de la base ne permet donc pas de se faire passer pour quelqu'un.
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
export const COOKIE = "atelier_session";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export function startSession(userId: string, now = Date.now()): string {
  const token = randomBytes(32).toString("base64url");
  db.insertSession(hash(token), userId, now, now + SESSION_TTL_MS);
  return token;
}

/** Rend l'utilisateur de la session, ou undefined (inconnue, expirée). Expiration glissante. */
export function userFromToken(token: string | undefined, now = Date.now()) {
  if (!token) return undefined;
  const h = hash(token);
  const s = db.findSession(h);
  if (!s) return undefined;
  if (s.expires_at < now) { db.deleteSession(h); return undefined; }
  if (s.expires_at - now < SESSION_TTL_MS / 2) db.extendSession(h, now + SESSION_TTL_MS);
  return db.getUserById(s.user_id);
}

export const endSession = (token: string) => db.deleteSession(hash(token));
export const endOtherSessions = (userId: string, keepToken: string) => db.deleteSessionsOf(userId, hash(keepToken));

export function tokenFromCookie(header: string | undefined): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
}

export function cookieHeader(token: string, secure: boolean, maxAgeS = SESSION_TTL_MS / 1000) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
}
