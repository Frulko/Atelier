import http from "node:http";
import { Readable } from "node:stream";
import { cfg } from "./config.ts";
import { overBudget } from "./budget.ts";
import { resolveTaskToken } from "./tokens.ts";
import { providerKey } from "./vault.ts";
import { recordProxyCall } from "./db.ts";

/*
 * Le bac à sable n'a ni Internet ni clé d'API : il parle à ce proxy sous /<fournisseur>/… avec son JETON DE TÂCHE.
 * Le proxy retrouve l'organisation de la tâche, vérifie son budget, puis ajoute SA clé de ce fournisseur
 * (jamais une clé d'une autre organisation, jamais une clé globale) et ne laisse passer que les routes de génération.
 * Ajouter un fournisseur = une entrée dans PROVIDERS, plus son nom dans la liste des secrets (app.ts).
 */
type Provider = {
  base: string; auth: (key: string) => Record<string, string>; allow: RegExp; passHeaders: string[];
  /** En-tête où le client envoie le jeton de tâche (le SDK du fournisseur y met la « clé » qu'on lui a donnée). */
  tokenFrom: (h: http.IncomingHttpHeaders) => string | undefined;
};
const bearer = (h: http.IncomingHttpHeaders) => (typeof h.authorization === "string" ? h.authorization.replace(/^Bearer\s+/i, "") : undefined);

export const PROVIDERS: Record<string, Provider> = {
  anthropic: {
    base: process.env.ATELIER_UPSTREAM_ANTHROPIC || "https://api.anthropic.com",
    auth: (k) => ({ "x-api-key": k }),
    allow: /^\/v1\/messages/,
    passHeaders: ["anthropic-version", "anthropic-beta"],
    tokenFrom: (h) => (typeof h["x-api-key"] === "string" ? h["x-api-key"] : bearer(h)),
  },
  openai: {
    base: process.env.ATELIER_UPSTREAM_OPENAI || "https://api.openai.com",
    auth: (k) => ({ authorization: `Bearer ${k}` }),
    allow: /^\/v1\/(chat\/completions|responses|embeddings)/,
    passHeaders: [],
    tokenFrom: bearer,
  },
  openrouter: {
    base: process.env.ATELIER_UPSTREAM_OPENROUTER || "https://openrouter.ai/api",
    auth: (k) => ({ authorization: `Bearer ${k}` }),
    allow: /^\/v1\/(chat\/completions|messages)/,
    passHeaders: ["anthropic-version"],
    tokenFrom: bearer,
  },
};

const deny = (res: http.ServerResponse, code: number, msg: string) => res.writeHead(code, { "content-type": "text/plain" }).end(msg);

export function createProxy() {
  return http.createServer(async (req, res) => {
    const m = /^\/([a-z]+)(\/.*)$/.exec(req.url ?? "");
    const prov = m && PROVIDERS[m[1]];
    if (req.method !== "POST" || !m || !prov || !prov.allow.test(m[2])) return deny(res, 403, "interdit");

    const ctx = resolveTaskToken(prov.tokenFrom(req.headers));
    if (!ctx) return deny(res, 401, "jeton de tâche invalide ou expiré");
    if (overBudget(ctx.orgId)) return deny(res, 402, "budget mensuel de l'organisation épuisé");
    const key = providerKey(ctx.orgId, m[1]);
    if (!key) return deny(res, 403, `aucune clé « ${m[1]} » configurée pour cette organisation`);

    try {
      const headers: Record<string, string> = { ...prov.auth(key), "accept-encoding": "identity" };
      for (const h of ["content-type", ...prov.passHeaders]) {
        const v = req.headers[h];
        if (typeof v === "string") headers[h] = v;
      }
      const up = await fetch(prov.base + m[2], {
        method: "POST", headers, body: Readable.toWeb(req) as ReadableStream, duplex: "half",
      } as RequestInit);
      const out: Record<string, string> = {};
      for (const h of ["content-type", "request-id", "retry-after"]) {
        const v = up.headers.get(h);
        if (v) out[h] = v;
      }
      recordProxyCall(ctx.orgId, ctx.taskId, m[1], up.status);
      res.writeHead(up.status, out);
      if (up.body) Readable.fromWeb(up.body as import("node:stream/web").ReadableStream).pipe(res);
      else res.end();
    } catch (e) {
      deny(res, 502, String(e));
    }
  });
}

export function startProxy() {
  createProxy().listen(cfg.proxyPort, () => console.log(`proxy fournisseurs sur :${cfg.proxyPort}`));
}
