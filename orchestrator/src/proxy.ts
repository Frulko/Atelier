import http from "node:http";
import { Readable } from "node:stream";
import { cfg } from "./config.ts";

/*
 * Le bac à sable n'a ni Internet ni clé API : il parle à ce proxy sous /<fournisseur>/…,
 * qui ne laisse passer que les routes de génération vers l'amont et ajoute la vraie clé ici.
 * Ajouter un fournisseur = une entrée dans PROVIDERS + sa clé dans config.ts.
 * ponytail: pas de comptage de budget par tâche ; plafonner les clés côté console du fournisseur.
 */
type Provider = { base: string; auth: (key: string) => Record<string, string>; allow: RegExp; passHeaders: string[] };

const PROVIDERS: Record<string, Provider> = {
  anthropic: {
    base: "https://api.anthropic.com",
    auth: (k) => ({ "x-api-key": k }),
    allow: /^\/v1\/messages/,
    passHeaders: ["anthropic-version", "anthropic-beta"],
  },
  openai: {
    base: "https://api.openai.com",
    auth: (k) => ({ authorization: `Bearer ${k}` }),
    allow: /^\/v1\/(chat\/completions|responses|embeddings)/,
    passHeaders: [],
  },
  openrouter: {
    base: "https://openrouter.ai/api",
    auth: (k) => ({ authorization: `Bearer ${k}` }),
    allow: /^\/v1\/(chat\/completions|messages)/,
    passHeaders: ["anthropic-version"],
  },
};

export function startProxy() {
  const server = http.createServer(async (req, res) => {
    const m = /^\/([a-z]+)(\/.*)$/.exec(req.url ?? "");
    const prov = m && PROVIDERS[m[1]];
    const key = m && cfg.providerKeys[m[1]];
    if (req.method !== "POST" || !m || !prov || !key || !prov.allow.test(m[2])) {
      res.writeHead(403).end("interdit");
      return;
    }
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
      res.writeHead(up.status, out);
      if (up.body) Readable.fromWeb(up.body as import("node:stream/web").ReadableStream).pipe(res);
      else res.end();
    } catch (e) {
      res.writeHead(502).end(String(e));
    }
  });
  server.listen(cfg.proxyPort, () => console.log(`proxy fournisseurs sur :${cfg.proxyPort} (${Object.keys(PROVIDERS).filter((k) => cfg.providerKeys[k]).join(", ")})`));
}
