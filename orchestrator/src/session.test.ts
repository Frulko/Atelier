import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
process.env.ANTHROPIC_API_KEY = "x";
const db = await import("./db.ts");
const S = await import("./session.ts");
const { FailureLimiter } = await import("./ratelimit.ts");

const user = db.createUser("a@b.fr", "h");

test("session : valide, inconnue, jeton jamais stocké en clair", () => {
  const t = S.startSession(user.id);
  assert.equal(S.userFromToken(t)?.id, user.id);
  assert.equal(S.userFromToken("n-importe-quoi"), undefined);
  assert.equal(S.userFromToken(undefined), undefined);
  assert.equal(db.findSession(t), undefined); // la base ne contient que l'empreinte
});

test("session : expirée = refusée et supprimée ; expiration glissante", () => {
  const t0 = 1_000_000;
  const t = S.startSession(user.id, t0);
  assert.equal(S.userFromToken(t, t0 + S.SESSION_TTL_MS + 1), undefined);
  assert.equal(S.userFromToken(t, t0 + 1), undefined); // déjà supprimée

  const t2 = S.startSession(user.id, t0);
  const late = t0 + S.SESSION_TTL_MS * 0.6; // plus de la moitié écoulée → prolongée
  assert.ok(S.userFromToken(t2, late));
  assert.ok(S.userFromToken(t2, late + S.SESSION_TTL_MS * 0.9)); // survit grâce à la prolongation
});

test("session : déconnexion et révocation des autres appareils", () => {
  const a = S.startSession(user.id), b = S.startSession(user.id), c = S.startSession(user.id);
  S.endSession(a);
  assert.equal(S.userFromToken(a), undefined);
  S.endOtherSessions(user.id, b);
  assert.ok(S.userFromToken(b));
  assert.equal(S.userFromToken(c), undefined);
});

test("cookie : lecture robuste et attributs de sécurité", () => {
  assert.equal(S.tokenFromCookie("x=1; atelier_session=abc=; y=2"), "abc=");
  assert.equal(S.tokenFromCookie("x=1"), undefined);
  const h = S.cookieHeader("tok", true);
  for (const a of ["HttpOnly", "SameSite=Strict", "Secure", "Path=/"]) assert.ok(h.includes(a), a);
  assert.ok(!S.cookieHeader("tok", false).includes("Secure"));
});

test("limiteur : bloque après 5 échecs, se libère avec le temps et à la réussite", () => {
  const l = new FailureLimiter(5, 1000);
  for (let i = 0; i < 5; i++) { assert.ok(!l.blocked("k", i)); l.fail("k", i); }
  assert.ok(l.blocked("k", 10));
  assert.ok(!l.blocked("k", 2000)); // fenêtre écoulée
  for (let i = 0; i < 5; i++) l.fail("j", i);
  l.reset("j");
  assert.ok(!l.blocked("j", 10));
});
