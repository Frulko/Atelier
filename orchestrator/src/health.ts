import { lookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, BlockList } from "node:net";
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
const forbidden = new BlockList();
for (const [network,prefix] of [["0.0.0.0",8],["169.254.0.0",16],["224.0.0.0",4],["240.0.0.0",4]] as const) forbidden.addSubnet(network,prefix,"ipv4");
forbidden.addSubnet("fe80::",10,"ipv6"); forbidden.addAddress("::","ipv6");
const privateAddresses = new BlockList();
for (const [network,prefix] of [["10.0.0.0",8],["127.0.0.0",8],["172.16.0.0",12],["192.168.0.0",16],["100.64.0.0",10],["198.18.0.0",15]] as const) privateAddresses.addSubnet(network,prefix,"ipv4");
privateAddresses.addSubnet("fc00::",7,"ipv6"); privateAddresses.addAddress("::1","ipv6");
export function addressAllowed(address: string, allowPrivate = cfg.healthAllowPrivate): boolean {
  const family=isIP(address); if(!family)return false;
  const type=family===4?"ipv4":"ipv6";
  // BlockList also recognizes hexadecimal IPv4-mapped IPv6 addresses (metadata must never bypass the guard).
  if(forbidden.check(address,type))return false;
  return allowPrivate || !privateAddresses.check(address,type);
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
