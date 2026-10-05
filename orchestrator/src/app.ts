import http from "node:http";
import { readFileSync } from "node:fs";
import { getProject, getProjects } from "./config.ts";
import { addEvent, bus, createTask, getEvents, getTask, getTaskInOrg, getUserByEmail, listTasks, orgsOf, roleOf, updatePassword, updateTask, type Evt, type Role, type User } from "./db.ts";
import { hashPassword, MAX_PASSWORD, passwordProblem, verifyPassword } from "./auth.ts";
import { cookieHeader, endOtherSessions, endSession, startSession, tokenFromCookie, userFromToken } from "./session.ts";
import { FailureLimiter } from "./ratelimit.ts";
import { can, type Action } from "./access.ts";
import { cancel, enqueue, newId } from "./pipeline.ts";

const page = readFileSync(new URL("../public/index.html", import.meta.url));
const json = (res: http.ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(code, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

const body = (req: http.IncomingMessage) => new Promise<any>((ok, ko) => {
  let s = ""; req.on("data", (d) => { s += d; if (s.length > 1e5) req.destroy(); });
  req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch (e) { ko(e); } });
});

// Derrière un reverse proxy (HTTPS), TRUST_PROXY=1 : on lit l'IP et le schéma dans X-Forwarded-*.
const trustProxy = process.env.TRUST_PROXY === "1";
const clientIp = (req: http.IncomingMessage) =>
  (trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "") || req.socket.remoteAddress || "?";
const isSecure = (req: http.IncomingMessage) =>
  process.env.COOKIE_SECURE === "1" || (trustProxy && req.headers["x-forwarded-proto"] === "https");

/** CSRF : un navigateur envoie toujours Origin sur un POST ; s'il ne correspond pas à l'hôte, on refuse.
 *  (SameSite=Strict sur le cookie est la première barrière, ceci est la seconde.) */
function sameOrigin(req: http.IncomingMessage) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

/*
 * CLOISONNEMENT. L'organisation vient du chemin, mais n'est JAMAIS crue sur parole :
 * on retrouve le rôle de l'utilisateur dans CETTE organisation. Pas membre → 404 (on ne révèle
 * même pas que l'organisation existe). Rôle insuffisant pour l'action → 403.
 */
type Access = { role: Role } | "not_found" | "forbidden";
function access(user: User, orgId: string, action: Action): Access {
  const role = roleOf(orgId, user.id);
  if (!role) return "not_found";
  return can(role, action) ? { role } : "forbidden";
}

const limiter = new FailureLimiter();
const DUMMY_HASH = await hashPassword("mot de passe factice pour égaliser le temps de réponse");

export function createApp() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/healthz") return void res.end("ok");
    // La page ne contient aucun secret : elle affiche elle-même le formulaire de connexion.
    if (req.method === "GET" && url.pathname === "/") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);

    try {
      if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return json(res, 403, { error: "origine refusée" });

      // ---- connexion : seule route /api accessible sans session
      if (req.method === "POST" && url.pathname === "/api/auth/login") {
        const { email, password } = await body(req);
        if (typeof email !== "string" || typeof password !== "string" || password.length > MAX_PASSWORD) return json(res, 400, { error: "identifiants invalides" });
        const keys = [`ip:${clientIp(req)}`, `mail:${email.trim().toLowerCase()}`];
        if (keys.some((k) => limiter.blocked(k))) return json(res, 429, { error: "trop de tentatives, réessaie plus tard" });
        const user = getUserByEmail(email);
        // Toujours un calcul de hash, même si le compte n'existe pas : le temps ne révèle pas l'existence du compte.
        const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
        if (!user || !ok) { keys.forEach((k) => limiter.fail(k)); return json(res, 401, { error: "e-mail ou mot de passe incorrect" }); }
        keys.forEach((k) => limiter.reset(k));
        return json(res, 200, { ok: true }, { "set-cookie": cookieHeader(startSession(user.id), isSecure(req)) });
      }

      // ---- tout le reste de l'API exige une session
      const token = tokenFromCookie(req.headers.cookie);
      const user = userFromToken(token);
      if (!user || !token) return json(res, 401, { error: "connexion requise" });

      if (req.method === "POST" && url.pathname === "/api/auth/logout") {
        endSession(token);
        return json(res, 200, { ok: true }, { "set-cookie": cookieHeader("", isSecure(req), 0) });
      }
      if (req.method === "GET" && url.pathname === "/api/me") return json(res, 200, { user: { id: user.id, email: user.email }, orgs: orgsOf(user.id) });
      if (req.method === "POST" && url.pathname === "/api/auth/password") {
        const { current, next } = await body(req);
        if (typeof current !== "string" || typeof next !== "string") return json(res, 400, { error: "requête invalide" });
        if (!(await verifyPassword(current, user.password_hash))) return json(res, 403, { error: "mot de passe actuel incorrect" });
        const problem = passwordProblem(next);
        if (problem) return json(res, 400, { error: problem });
        updatePassword(user.id, await hashPassword(next));
        endOtherSessions(user.id, token); // les autres appareils sont déconnectés
        return json(res, 200, { ok: true });
      }

      // ---- ressources d'une organisation : /api/orgs/:org/...
      const o = /^\/api\/orgs\/([0-9a-f]{16})\/(projects|tasks)(?:\/([0-9a-f]{8})(\/events|\/cancel)?)?$/.exec(url.pathname);
      if (o) {
        const [, orgId, kind, taskId, sub] = o;
        const deny = (a: Access) => a === "not_found" ? json(res, 404, { error: "introuvable" }) : json(res, 403, { error: "droits insuffisants" });

        if (kind === "projects" && req.method === "GET" && !taskId) {
          const a = access(user, orgId, "task:read");
          if (typeof a === "string") return deny(a);
          // ponytail: projets encore communs à toutes les organisations (config) jusqu'à U4.
          return json(res, 200, getProjects().map(({ id, name, engine }) => ({ id, name, engine })));
        }

        if (kind === "tasks" && !taskId) {
          if (req.method === "GET") {
            const a = access(user, orgId, "task:read");
            return typeof a === "string" ? deny(a) : json(res, 200, listTasks(orgId));
          }
          if (req.method === "POST") {
            const a = access(user, orgId, "task:create");
            if (typeof a === "string") return deny(a);
            const { project, prompt } = await body(req);
            const p = typeof project === "string" ? getProject(project) : undefined;
            if (!p || typeof prompt !== "string" || !prompt.trim()) return json(res, 400, { error: "projet ou demande invalide" });
            const id = newId();
            createTask(id, orgId, user.id, p.id, prompt.trim());
            addEvent(id, "step", "Demande reçue, en file d'attente.");
            enqueue(p, id);
            return json(res, 201, getTask(id));
          }
        }

        if (kind === "tasks" && taskId) {
          const a = access(user, orgId, "task:read");
          if (typeof a === "string") return deny(a);
          const task = getTaskInOrg(taskId, orgId); // filtre par l'organisation de la session, pas par l'id seul
          if (!task) return json(res, 404, { error: "introuvable" });

          if (req.method === "POST" && sub === "/cancel") {
            const c = access(user, orgId, task.user_id === user.id ? "task:cancel_own" : "task:cancel_any");
            if (typeof c === "string") return deny(c);
            cancel(task.id);
            if (task.status === "queued") updateTask(task.id, { status: "cancelled" });
            return json(res, 200, { ok: true });
          }
          if (req.method === "GET" && !sub) return json(res, 200, task);
          if (req.method === "GET" && sub === "/events") {
            // SSE : rejoue l'historique puis suit le direct.
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
            res.flushHeaders(); // sans ça, les en-têtes ne partent qu'au premier octet (jusqu'à 25 s si aucun événement)
            let last = 0;
            const send = (e: Evt) => { if (e.id && e.id <= last) return; if (e.id) last = e.id; res.write(`data: ${JSON.stringify(e)}\n\n`); };
            bus.on(task.id, send);
            getEvents(task.id).forEach(send);
            const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
            res.on("close", () => { clearInterval(ping); bus.off(task.id, send); });
            return;
          }
        }
      }
      res.writeHead(404).end();
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
  });
}
