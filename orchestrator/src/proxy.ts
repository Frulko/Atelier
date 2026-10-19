import { reserveModelCall, meterModelStream } from "./model-budget.ts";
import { askHuman } from "./human.ts";
import http from "node:http";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { Readable } from "node:stream";
import { cfg } from "./config.ts";
import { assertBudget, overBudget } from "./budget.ts";
import { resolveTaskToken } from "./tokens.ts";
import { providerKey } from "./vault.ts";
import { db, getTask, recordProxyCall, roleOf } from "./db.ts";
import { can } from "./access.ts";
import { body, HttpError } from "./http.ts";
import { assertNoSecretText } from "./security.ts";

/*
 * Le bac à sable n'a ni Internet ni clé d'API : il parle à ce proxy sous /<fournisseur>/… avec son JETON DE TÂCHE.
 * Le proxy retrouve l'organisation de la tâche, vérifie son budget, puis ajoute SA clé de ce fournisseur
 * (jamais une clé d'une autre organisation, jamais une clé globale) et ne laisse passer que les routes de génération.
 * Ajouter un fournisseur = une entrée dans PROVIDERS, plus son nom dans la liste des secrets (app.ts).
 */
type Provider = {
  base: string;
  auth: (key: string) => Record<string, string>;
  allow: RegExp;
  passHeaders: string[];
  /** En-tête où le client envoie le jeton de tâche (le SDK du fournisseur y met la « clé » qu'on lui a donnée). */
  tokenFrom: (h: http.IncomingHttpHeaders) => string | undefined;
};
const bearer = (h: http.IncomingHttpHeaders) =>
  typeof h.authorization === "string"
    ? h.authorization.replace(/^Bearer\s+/i, "")
    : undefined;

export const PROVIDERS: Record<string, Provider> = {
  anthropic: {
    base: process.env.ATELIER_UPSTREAM_ANTHROPIC || "https://api.anthropic.com",
    auth: (k) => ({ "x-api-key": k }),
    allow: /^\/v1\/messages(?:\?.*)?$/,
    passHeaders: ["anthropic-version", "anthropic-beta"],
    tokenFrom: (h) =>
      typeof h["x-api-key"] === "string" ? h["x-api-key"] : bearer(h),
  },
  openai: {
    base: process.env.ATELIER_UPSTREAM_OPENAI || "https://api.openai.com",
    auth: (k) => ({ authorization: `Bearer ${k}` }),
    allow: /^\/v1\/(chat\/completions|responses|embeddings)(?:\?.*)?$/,
    passHeaders: [],
    tokenFrom: bearer,
  },
  openrouter: {
    base:
      process.env.ATELIER_UPSTREAM_OPENROUTER || "https://openrouter.ai/api",
    auth: (k) => ({ authorization: `Bearer ${k}` }),
    allow: /^\/v1\/(chat\/completions|messages)(?:\?.*)?$/,
    passHeaders: ["anthropic-version"],
    tokenFrom: bearer,
  },
};

const deny = (res: http.ServerResponse, code: number, msg: string) =>
  res.writeHead(code, { "content-type": "text/plain" }).end(msg);

export function redactStream(secret: string) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const clean = (text: string) =>
    secret.length >= 4 ? text.split(secret).join("[redacted]") : text;
  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += decoder.write(chunk);
      let end = Math.max(0, buffer.length - secret.length);
      let at = secret.length >= 4 ? buffer.indexOf(secret) : -1;
      while (at >= 0 && at < end) {
        if (at + secret.length > end) {
          end = at;
          break;
        }
        at = buffer.indexOf(secret, at + secret.length);
      }
      if (end > 0) {
        this.push(clean(buffer.slice(0, end)));
        buffer = buffer.slice(end);
      }
      callback();
    },
    flush(callback) {
      buffer += decoder.end();
      this.push(clean(buffer));
      callback();
    },
  });
}

export function createProxy() {
  return http.createServer(async (req, res) => {
    if(req.url==="/human/questions" && req.method==="POST") {
      const ctx=resolveTaskToken(bearer(req.headers)),task=ctx?getTask(ctx.taskId):undefined;
      if(!ctx || ctx.scope!=="model" || !task || task.org_id!==ctx.orgId)return deny(res,401,"Jeton de tâche invalide.");
      try {
        const q=await askHuman(task,await body(req,3000));
        res.writeHead(201,{"content-type":"application/json"}).end(JSON.stringify({id:q.id}));
      }catch(e){deny(res,e instanceof HttpError?e.status:422,e instanceof HttpError?e.message:"Question refusée.");}
      return;
    }
    if (req.url?.startsWith("/npm/")) {
      const ctx = resolveTaskToken(bearer(req.headers));
      if (!ctx || ctx.scope !== "npm") return deny(res, 401, "jeton invalide");
      if (req.method !== "GET") return deny(res, 403, "interdit");
      try {
        const path = req.url.slice(5);
        if (!path || path.length > 2000 || /[\\\x00-\x20]/.test(path))
          return deny(res, 400, "paquet invalide");
        const target = new URL(path, "https://registry.npmjs.org/");
        if (target.origin !== "https://registry.npmjs.org")
          return deny(res, 403, "registre interdit");
        const up = await fetch(target, {
          redirect: "error",
          signal: AbortSignal.any([ctx.controller.signal, AbortSignal.timeout(30_000)]),
          headers: { accept: String(req.headers.accept ?? "application/json") },
        });
        const type =
          up.headers.get("content-type") ?? "application/octet-stream";
        res.writeHead(up.status, { "content-type": type });
        if (type.includes("json")) {
          const text = await up.text();
          // Tarball URLs also go through us; npm never receives general Internet access.
          const proxy = `${cfg.proxyUrl}/npm/`;
          res.end(text.replaceAll("https://registry.npmjs.org/", proxy));
        } else if (up.body)
          Readable.fromWeb(up.body as import("node:stream/web").ReadableStream)
            .on("error", () => res.destroy())
            .pipe(res);
        else res.end();
      } catch {
        if (!res.headersSent) deny(res, 502, "registre indisponible");
        else res.destroy();
      }
      return;
    }
    const m = /^\/([a-z]+)(\/.*)$/.exec(req.url ?? "");
    const prov = m && PROVIDERS[m[1]];
    if (req.method !== "POST" || !m || !prov || !prov.allow.test(m[2]))
      return deny(res, 403, "interdit");

    const ctx = resolveTaskToken(prov.tokenFrom(req.headers));
    if (!ctx || ctx.scope !== "model")
      return deny(res, 401, "jeton de tâche invalide ou expiré");
    if (overBudget(ctx.orgId))
      return deny(res, 402, "budget mensuel de l'organisation épuisé");
    let key = providerKey(ctx.orgId, m[1]);
    if (!key)
      return deny(
        res,
        403,
        `aucune clé « ${m[1]} » configurée pour cette organisation`,
      );

    try {
      const payload = await body(req, 10_000_000);
      // Inspect decoded JSON strings too: Unicode escapes must not hide a vault value.
      const strings: string[] = [];
      new URL(m[2], prov.base).searchParams.forEach((value, name) => strings.push(name, value));
      JSON.stringify(payload, (name, value) => {
        strings.push(name);
        if (typeof value === "string") strings.push(value);
        return value;
      });
      try {
        await assertNoSecretText([m[2], ...prov.passHeaders.map(h => String(req.headers[h] ?? "")), ...strings].join("\n"), ctx.orgId);
      } catch {
        return deny(res, 422, "secret potentiel détecté dans la requête IA");
      }
      if (resolveTaskToken(prov.tokenFrom(req.headers)) !== ctx)
        return deny(res, 401, "jeton de tâche révoqué");
      if (overBudget(ctx.orgId))
        return deny(res, 402, "budget mensuel de l'organisation épuisé");
      const task = getTask(ctx.taskId);
      if(task) assertBudget(ctx.orgId,task.project,ctx.holdId);
      const role = task?.user_id ? roleOf(ctx.orgId, task.user_id) : undefined;
      if (task && (task.org_id !== ctx.orgId || task.status !== "running" || !role || !can(role, "task:create")))
        return deny(res, 403, "droits d'exécution retirés");
      key = providerKey(ctx.orgId, m[1]);
      if (!key) return deny(res, 403, "clé du fournisseur retirée");
      const headers: Record<string, string> = {
        ...prov.auth(key),
        "accept-encoding": "identity",
        "content-type": "application/json",
      };
      for (const h of prov.passHeaders) {
        const v = req.headers[h];
        if (typeof v === "string") headers[h] = v;
      }
      if(ctx.holdId && /fast|priority/i.test(String(req.headers["anthropic-beta"]??"")))throw new HttpError(400,"Option tarifaire non prise en charge par le budget.");
      const metered=ctx.holdId?reserveModelCall(ctx.holdId,m[1],payload):undefined;
      const up = await fetch(prov.base + m[2], {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.any([ctx.controller.signal, AbortSignal.timeout(180_000)]),
      } as RequestInit);
      const out: Record<string, string> = {};
      for (const h of ["content-type", "request-id", "retry-after"]) {
        const v = up.headers.get(h);
        if (v) out[h] = v;
      }
      recordProxyCall(ctx.orgId, ctx.taskId, m[1], up.status);
      if (!up.ok) {
        await up.body?.cancel();
        if(metered && [400,401,403,404,413,429].includes(up.status)) db.prepare("update model_charges set usd=0 where id=?").run(metered.id);
        res
          .writeHead(up.status, { "content-type": "application/json" })
          .end(
            JSON.stringify({
              type: "error",
              error: {
                type: "upstream_error",
                message: "Le fournisseur a refusé la requête.",
              },
            }),
          );
        return;
      }
      res.writeHead(up.status, out);
      if (up.body)
        Readable.fromWeb(up.body as import("node:stream/web").ReadableStream)
          .on("error", () => res.destroy())
          .pipe(metered?meterModelStream(metered):new Transform({transform(chunk,_encoding,done){done(null,chunk);}}))
          .on("error", () => res.destroy())
          .pipe(redactStream(key))
          .on("error", () => res.destroy())
          .pipe(res);
      else res.end();
    } catch (e) {
      if (!res.headersSent) deny(res, e instanceof HttpError ? e.status : 502, e instanceof HttpError ? e.message : "fournisseur indisponible");
      else res.destroy();
    }
  });
}

export function startProxy() {
  createProxy().listen(cfg.proxyPort, () =>
    console.log(`proxy fournisseurs sur :${cfg.proxyPort}`),
  );
}
