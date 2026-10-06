// Configuration par DÉFAUT : l'orchestrateur ne va pas voir les réseaux locaux et privés (anti-SSRF), même par un nom de domaine.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
delete process.env.ATELIER_HEALTH_ALLOW_PRIVATE;
const { checkHealth } = await import("./health.ts");

let hits = 0;
const site = http.createServer((_, res) => { hits++; res.end("ok"); }).listen(0);
after(() => site.close());
const port = () => (site.address() as AddressInfo).port;

test("localhost et adresses littérales locales : refusés, et le serveur local n'est jamais contacté", async () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]", "10.0.0.5", "192.168.1.10", "169.254.169.254"]) {
    const r = await checkHealth(`http://${host}:${port()}/`, 1000);
    assert.equal(r.ok, false, host);
    assert.match(String(r.error), /non autorisée|injoignable|refusée|délai/, host);
  }
  assert.equal((await checkHealth(`http://localhost:${port()}/`)).error, "adresse non autorisée (réseau privé ou lien local)");
  assert.equal(hits, 0);
});
