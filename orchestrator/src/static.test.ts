// Service de l'application web : fichiers, repli sur la page d'entrée, en-têtes de sécurité, et surtout
// AUCUN moyen de lire un fichier hors du dossier public.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const root = mkdtempSync(join(tmpdir(), "atelier-static-"));
const pub = join(root, "public");
mkdirSync(join(pub, "assets"), { recursive: true });
writeFileSync(join(pub, "index.html"), "<!doctype html><title>Atelier</title><div id=root></div>");
writeFileSync(join(pub, "assets", "app.abc123.js"), "console.log('app')");
writeFileSync(join(pub, "assets", "style.def456.css"), "body{margin:0}");
writeFileSync(join(pub, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
writeFileSync(join(root, "secret.txt"), "TOP-SECRET-OUTSIDE-PUBLIC");

process.env.PUBLIC_DIR = pub;
process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
const { createApp } = await import("./app.ts");

const server = createApp().listen(0);
after(() => { server.closeAllConnections(); server.close(); });
const port = (server.address() as AddressInfo).port;

// http.request et non fetch : fetch « nettoie » les chemins (../), ce qui masquerait justement ce qu'on veut tester.
const raw = (path: string, method = "GET") => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((ok, ko) => {
  const r = http.request({ host: "127.0.0.1", port, path, method }, (res) => {
    let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, body: b }));
  });
  r.on("error", ko); r.end();
});

test("la page d'entrée est servie sur /, sans cache", async () => {
  const r = await raw("/");
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"]!, /text\/html/);
  assert.match(r.body, /<title>Atelier<\/title>/);
  assert.equal(r.headers["cache-control"], "no-cache");
});

test("une route de l'application (sans extension) retombe sur la page d'entrée", async () => {
  for (const p of ["/o/abc123/tasks", "/login", "/invite?token=inv_x", "/o/x/projects/y"]) {
    const r = await raw(p);
    assert.equal(r.status, 200, p);
    assert.match(r.body, /<div id=root>/, p);
  }
});

test("les fichiers sont servis avec le bon type ; ceux de /assets/ se gardent un an", async () => {
  const js = await raw("/assets/app.abc123.js");
  assert.equal(js.status, 200);
  assert.match(js.headers["content-type"]!, /text\/javascript/);
  assert.match(js.headers["cache-control"]!, /immutable/);
  assert.match((await raw("/assets/style.def456.css")).headers["content-type"]!, /text\/css/);
  assert.match((await raw("/favicon.svg")).headers["content-type"]!, /image\/svg\+xml/);
  assert.equal((await raw("/favicon.svg")).headers["cache-control"], "public, max-age=86400");
});

test("un fichier manquant est un 404, pas la page d'entrée (sinon un script absent s'afficherait comme du HTML)", async () => {
  assert.equal((await raw("/assets/absent.js")).status, 404);
  assert.equal((await raw("/missing.css")).status, 404);
});

test("AUCUNE sortie du dossier public : ../, %2e%2e, séparateurs encodés, octet nul", async () => {
  const attempts = ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/%2e%2e%2fsecret.txt", "/assets/../../secret.txt", "/assets/%2e%2e/%2e%2e/secret.txt", "/....//secret.txt", "//secret.txt", "/%00", "/assets/app.abc123.js%00.html", "/..\\secret.txt"];
  for (const p of attempts) {
    const r = await raw(p);
    assert.ok(!r.body.includes("TOP-SECRET"), `fuite via ${p}`);
    assert.ok([200, 400, 404].includes(r.status), `${p} → ${r.status}`);
    if (r.status === 200) assert.match(r.body, /<div id=root>|^$/, `${p} a servi autre chose que la page d'entrée`);
  }
  assert.equal((await raw("/%00")).status, 400);
  assert.equal((await raw("/%E0%A4%A")).status, 400); // pourcentage invalide
});

test("l'API n'est jamais masquée par le repli : sans session elle répond 401, jamais la page d'entrée", async () => {
  for (const p of ["/api/n-existe-pas", "/api/me", "/api/auth/login", "/api/orgs/0000000000000000/tasks"]) {
    const r = await raw(p);
    assert.equal(r.status, 401, p);
    assert.ok(!r.body.includes("<div id=root>"), `${p} a servi la page d'entrée`);
  }
});

test("HEAD sans corps ; un POST sur une page n'est pas servi comme une page", async () => {
  const h = await raw("/", "HEAD");
  assert.equal(h.status, 200);
  assert.equal(h.body, "");
  const p = await raw("/", "POST");
  assert.notEqual(p.status, 200);
  assert.ok(!p.body.includes("<div id=root>"));
});

test("en-têtes de sécurité sur chaque réponse, y compris l'API et les erreurs", async () => {
  for (const p of ["/", "/assets/app.abc123.js", "/api/me", "/assets/absent.js", "/healthz"]) {
    const h = (await raw(p)).headers;
    assert.match(String(h["content-security-policy"]), /default-src 'self'/, p);
    assert.match(String(h["content-security-policy"]), /frame-ancestors 'none'/, p);
    assert.match(String(h["content-security-policy"]), /script-src 'self'(;|$)/, p); // pas de 'unsafe-inline' sur les scripts
    assert.equal(h["x-content-type-options"], "nosniff", p);
    assert.equal(h["x-frame-options"], "DENY", p);
    assert.equal(h["referrer-policy"], "no-referrer", p);
  }
  assert.ok(!String((await raw("/")).headers["content-security-policy"]).includes("unsafe-eval"));
});

test("les réponses d'API ne sont jamais mises en cache ; HSTS seulement en HTTPS", async () => {
  assert.equal((await raw("/api/me")).headers["cache-control"], "no-store");
  assert.equal((await raw("/")).headers["strict-transport-security"], undefined);
  process.env.COOKIE_SECURE = "1";
  try { assert.match(String((await raw("/")).headers["strict-transport-security"]), /max-age=31536000/); } finally { delete process.env.COOKIE_SECURE; }
});
