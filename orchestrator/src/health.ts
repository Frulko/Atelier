import { lookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { cfg } from "./config.ts";
import type { HealthResult } from "./db.ts";

export const HEALTH_TIMEOUT_MS = 5_000;

/** Adresse saisie pour le site ou la santé : http(s), sans identifiants, de taille raisonnable. */
export function urlProblem(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 300) return "adresse invalide";
  let u: URL;
  try { u = new URL(v); } catch { return "l'adresse doit commencer par http:// ou https://"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "l'adresse doit commencer par http:// ou https://";
  if (u.username || u.password) return "pas d'identifiants dans l'adresse";
  return null;
}

/**
 * Où a-t-on le droit d'aller voir ? L'orchestrateur est dans un réseau : une adresse saisie par un administrateur ne doit pas
 * le faire parler aux métadonnées du cloud (lien local) — jamais. Les adresses locales et privées (127/8, 10/8, 172.16/12,
 * 192.168/16, fc00::/7…) ne sont permises que si l'hôte l'a explicitement décidé (ATELIER_HEALTH_ALLOW_PRIVATE=1).
 */
export function addressAllowed(address: string): boolean {
  const a = address.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(a) === 4) {
    const [x = 0, y = 0] = a.split(".").map(Number);
    if (x === 169 && y === 254) return false;                         // lien local, dont 169.254.169.254
    if (x === 0) return false;
    const priv = x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127);
    return !priv || cfg.healthAllowPrivate;
  }
  if (isIP(a) === 6) {
    if (/^fe[89ab]/.test(a) || a === "::") return false;               // lien local
    const priv = a === "::1" || /^f[cd]/.test(a);
    return !priv || cfg.healthAllowPrivate;
  }
  return false;
}

/** La vérification est faite au moment de la CONNEXION (pas avant) : pas de fenêtre pour changer l'adresse entre-temps. */
const guardedLookup: typeof lookup = ((host: string, opts: unknown, cb: (...a: unknown[]) => void) => {
  const options = (typeof opts === "object" && opts ? opts : {}) as { all?: boolean };
  lookup(host, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = (addrs as { address: string; family: number }[]);
    if (!list.length || list.some((x) => !addressAllowed(x.address))) return cb(Object.assign(new Error("adresse non autorisée"), { code: "EBLOCKED" }));
    return options.all ? cb(null, list) : cb(null, list[0]!.address, list[0]!.family);
  });
}) as typeof lookup;

const explain = (e: NodeJS.ErrnoException): string =>
  e.code === "EBLOCKED" ? "adresse non autorisée (réseau privé ou lien local)"
  : e.code === "ENOTFOUND" || e.code === "EAI_AGAIN" ? "nom de domaine introuvable"
  : e.code === "ECONNREFUSED" ? "connexion refusée"
  : e.code === "ETIMEDOUT" || e.code === "TIMEOUT" ? "délai dépassé"
  : /CERT|SSL|TLS|self.signed|altnames/i.test(String(e.code) + e.message) ? "certificat invalide"
  : "site injoignable";

/** GET sur l'adresse, sans suivre les redirections ; 2xx et 3xx = en ligne. Le corps n'est jamais lu, ni gardé. */
export function checkHealth(url: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<HealthResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const done = (r: Omit<HealthResult, "ms"> & { ms?: number }) => resolve({ ms: Date.now() - t0, ...r });
    if (urlProblem(url)) return done({ ok: false, status: null, error: "adresse invalide" });
    const u = new URL(url);
    // Une adresse IP écrite telle quelle ne passe PAS par la résolution de noms (donc pas par guardedLookup) : on la contrôle ici.
    const literal = u.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) && !addressAllowed(literal)) return done({ ok: false, status: null, error: explain(Object.assign(new Error("blocked"), { code: "EBLOCKED" })) });
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method: "GET", lookup: guardedLookup, timeout: timeoutMs, headers: { "user-agent": "atelier-health/1", accept: "*/*" } }, (res) => {
      const status = res.statusCode ?? 0;
      res.destroy();
      done({ ok: status >= 200 && status < 400, status, error: status >= 400 ? `réponse HTTP ${status}` : null });
    });
    req.on("timeout", () => { req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })); });
    req.on("error", (e) => done({ ok: false, status: null, error: explain(e as NodeJS.ErrnoException) }));
    req.end();
  });
}
