import http from "node:http";
import { readFileSync } from "node:fs";
import { secretUsers, updateSecret, listSessions, deleteSessionByPrefix, setUserName, renameOrg, activeTaskCount, deleteOrgCascade, orgStats, orgUsage, queryAudit, userActivity, getUserById, STATUSES, queryTasks, getTaskDetail, type Status, addEvent, addMember, bus, consumeInvitation, countOrgsOf, countOwners, createOrg, createUser, deleteInvitation, findInvitation, insertInvitation, listInvitations, listMembers, removeMember, setMemberRole, createTask, getOrg, monthSpend, setOrgBudget, deleteProject, deleteSecret, getEvents, getProjectInOrg, getSecretRow, getTask, getTaskInOrg, getUserByEmail, insertProject, listProjects, listSecrets, listTasks, orgsOf, roleOf, secretInUse, updatePassword, updateProject, updateTask, type Evt, type Role, type User } from "./db.ts";
import { rotateSecret, storeSecret } from "./vault.ts";
import { verifyAccess } from "./git.ts";
import { rowToProject } from "./projects.ts";
import { audit, auditToCsv } from "./audit.ts";
import { overBudget } from "./budget.ts";
import { PROVIDERS } from "./proxy.ts";
import { rowToJson, validateProject } from "./projects.ts";
import { hashPassword, MAX_PASSWORD, passwordProblem, verifyPassword } from "./auth.ts";
import { cookieHeader, currentSessionId, endOtherSessions, endSession, sessionId, startSession, tokenFromCookie, userFromToken } from "./session.ts";
import { FailureLimiter } from "./ratelimit.ts";
import { can, canAssign, canTouch, ROLES, type Action } from "./access.ts";
import { hashInviteToken, INVITE_TTL_MS, newInviteToken } from "./invites.ts";
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

const denyAccess = (res: http.ServerResponse, a: "not_found" | "forbidden") =>
  a === "not_found" ? json(res, 404, { error: "introuvable" }) : json(res, 403, { error: "droits insuffisants" });

const orgJson = (orgId: string) => {
  const o = getOrg(orgId)!;
  return { id: o.id, name: o.name, budgetUsdMonth: o.budget_usd_month, monthSpendUsd: Math.round(monthSpend(orgId) * 100) / 100 };
};

const device = (req: http.IncomingMessage) => ({ userAgent: String(req.headers["user-agent"] ?? ""), ip: clientIp(req) });

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
        if (!user || !ok) { keys.forEach((k) => limiter.fail(k)); if (user) audit({ userId: user.id, ip: clientIp(req) }, "auth.login_failed"); return json(res, 401, { error: "e-mail ou mot de passe incorrect" }); }
        keys.forEach((k) => limiter.reset(k));
        audit({ userId: user.id, ip: clientIp(req) }, "auth.login");
        return json(res, 200, { ok: true }, { "set-cookie": cookieHeader(startSession(user.id, Date.now(), device(req)), isSecure(req)) });
      }

      // ---- accepter une invitation : ouverte à qui détient le jeton (nouveau compte) ou à l'invité connecté
      if (req.method === "POST" && url.pathname === "/api/auth/accept-invite") {
        const { token: invToken, password } = await body(req);
        const inv = typeof invToken === "string" ? findInvitation(hashInviteToken(invToken)) : undefined;
        if (!inv) return json(res, 404, { error: "invitation invalide ou expirée" }); // même réponse : inconnue, expirée ou déjà utilisée
        const current = userFromToken(tokenFromCookie(req.headers.cookie));
        if (current) {
          // un jeton volé ne suffit pas : l'adresse du compte connecté doit être celle de l'invitation
          if (current.email !== inv.email) return json(res, 403, { error: "cette invitation est destinée à une autre adresse e-mail" });
          if (!roleOf(inv.org_id, current.id)) addMember(inv.org_id, current.id, inv.role);
          consumeInvitation(inv.token_hash);
          audit({ orgId: inv.org_id, userId: current.id, ip: clientIp(req) }, "invitation.accept", { type: "invitation", id: inv.id }, { email: inv.email, role: inv.role });
          return json(res, 200, { ok: true, orgId: inv.org_id });
        }
        if (getUserByEmail(inv.email)) return json(res, 409, { error: "un compte existe déjà pour cette adresse : connecte-toi, puis rouvre le lien" });
        if (typeof password !== "string") return json(res, 400, { error: "mot de passe requis" });
        const problem = passwordProblem(password);
        if (problem) return json(res, 400, { error: problem });
        const hash = await hashPassword(password);
        if (!findInvitation(inv.token_hash)) return json(res, 404, { error: "invitation invalide ou expirée" }); // acceptée entre-temps
        try {
          const u = createUser(inv.email, hash);
          addMember(inv.org_id, u.id, inv.role);
          consumeInvitation(inv.token_hash);
          audit({ orgId: inv.org_id, userId: u.id, ip: clientIp(req) }, "invitation.accept", { type: "invitation", id: inv.id }, { email: inv.email, role: inv.role, newAccount: true });
          return json(res, 201, { ok: true, orgId: inv.org_id }, { "set-cookie": cookieHeader(startSession(u.id, Date.now(), device(req)), isSecure(req)) });
        } catch (e) {
          if (!/UNIQUE/.test(String(e))) throw e;
          return json(res, 409, { error: "un compte existe déjà pour cette adresse : connecte-toi, puis rouvre le lien" });
        }
      }

      // ---- tout le reste de l'API exige une session
      const token = tokenFromCookie(req.headers.cookie);
      const user = userFromToken(token);
      if (!user || !token) return json(res, 401, { error: "connexion requise" });

      if (req.method === "POST" && url.pathname === "/api/auth/logout") {
        endSession(token);
        audit({ userId: user.id, ip: clientIp(req) }, "auth.logout");
        return json(res, 200, { ok: true }, { "set-cookie": cookieHeader("", isSecure(req), 0) });
      }
      if (req.method === "GET" && url.pathname === "/api/me/activity") return json(res, 200, userActivity(user.id).map((a) => ({ id: a.id, ts: a.ts, action: a.action, orgId: a.org_id, orgName: a.org_name, targetType: a.target_type, targetId: a.target_id, meta: a.meta ? JSON.parse(a.meta) : null, ip: a.ip })));
      if (req.method === "GET" && url.pathname === "/api/me") return json(res, 200, { user: { id: user.id, email: user.email, name: user.name }, orgs: orgsOf(user.id) });
      if (req.method === "PATCH" && url.pathname === "/api/me") {
        const { name } = await body(req);
        if (name !== null && (typeof name !== "string" || name.trim().length > 80)) return json(res, 400, { error: "nom invalide (80 caractères au plus)" });
        setUserName(user.id, name === null || !name.trim() ? null : name.trim());
        audit({ userId: user.id, ip: clientIp(req) }, "auth.profile_update");
        return json(res, 200, { id: user.id, email: user.email, name: name === null || !name.trim() ? null : name.trim() });
      }
      if (url.pathname === "/api/me/sessions" && req.method === "GET") {
        const here = currentSessionId(token);
        return json(res, 200, listSessions(user.id).map((x) => ({ id: sessionId(x.token_hash), createdAt: x.created_at, lastUsedAt: x.last_used_at ?? x.created_at, expiresAt: x.expires_at, userAgent: x.user_agent, ip: x.ip, current: sessionId(x.token_hash) === here })));
      }
      if (url.pathname === "/api/me/sessions/revoke-others" && req.method === "POST") {
        endOtherSessions(user.id, token);
        audit({ userId: user.id, ip: clientIp(req) }, "auth.sessions_revoke_others");
        return json(res, 200, { ok: true });
      }
      const sm = /^\/api\/me\/sessions\/([0-9a-f]{16})$/.exec(url.pathname);
      if (sm && req.method === "DELETE") {
        if (!deleteSessionByPrefix(user.id, sm[1])) return json(res, 404, { error: "introuvable" }); // pas la vôtre, ou déjà révoquée
        audit({ userId: user.id, ip: clientIp(req) }, "auth.session_revoke");
        const wasCurrent = sm[1] === currentSessionId(token);
        return json(res, 200, { ok: true, current: wasCurrent }, wasCurrent ? { "set-cookie": cookieHeader("", isSecure(req), 0) } : {});
      }
      if (req.method === "POST" && url.pathname === "/api/orgs") {
        const { name } = await body(req);
        if (typeof name !== "string" || !name.trim() || name.length > 80) return json(res, 400, { error: "nom invalide" });
        if (countOrgsOf(user.id) >= 10) return json(res, 409, { error: "limite de 10 organisations atteinte" });
        const newOrg = createOrg(name.trim(), user.id);
        audit({ orgId: newOrg, userId: user.id, ip: clientIp(req) }, "org.create", { type: "org", id: newOrg }, { name: name.trim() });
        return json(res, 201, { id: newOrg, name: name.trim(), role: "owner" });
      }
      if (req.method === "POST" && url.pathname === "/api/auth/password") {
        const { current, next } = await body(req);
        if (typeof current !== "string" || typeof next !== "string") return json(res, 400, { error: "requête invalide" });
        if (!(await verifyPassword(current, user.password_hash))) return json(res, 403, { error: "mot de passe actuel incorrect" });
        const problem = passwordProblem(next);
        if (problem) return json(res, 400, { error: problem });
        updatePassword(user.id, await hashPassword(next));
        endOtherSessions(user.id, token); // les autres appareils sont déconnectés
        audit({ userId: user.id, ip: clientIp(req) }, "auth.password_change");
        return json(res, 200, { ok: true });
      }

      // ---- l'organisation elle-même : nom, budget mensuel des modèles, suppression
      const og = /^\/api\/orgs\/([0-9a-f]{16})$/.exec(url.pathname);
      if (og && req.method === "GET") {
        const a = access(user, og[1], "org:budget");
        return typeof a === "string" ? denyAccess(res, a) : json(res, 200, orgJson(og[1]));
      }
      if (og && req.method === "PATCH") {
        const b = await body(req);
        const wantsName = b.name !== undefined, wantsBudget = b.budgetUsdMonth !== undefined;
        if (!wantsName && !wantsBudget) return json(res, 400, { error: "rien à modifier" });
        const a = access(user, og[1], wantsName ? "org:rename" : "org:budget");
        if (typeof a === "string") return denyAccess(res, a);
        const ctx = { orgId: og[1], userId: user.id, ip: clientIp(req) };
        if (wantsName) {
          if (typeof b.name !== "string" || !b.name.trim() || b.name.trim().length > 80) return json(res, 400, { error: "nom invalide" });
        }
        if (wantsBudget) {
          const v = b.budgetUsdMonth;
          if (!(v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e6))) return json(res, 400, { error: "budget invalide (nombre ≥ 0, ou null pour illimité)" });
        }
        if (wantsName) { const from = getOrg(og[1])!.name; renameOrg(og[1], b.name.trim()); audit(ctx, "org.rename", { type: "org", id: og[1] }, { from, to: b.name.trim() }); }
        if (wantsBudget) { setOrgBudget(og[1], b.budgetUsdMonth); audit(ctx, "org.budget_set", { type: "org", id: og[1] }, { budgetUsdMonth: b.budgetUsdMonth }); }
        return json(res, 200, orgJson(og[1]));
      }
      if (og && req.method === "DELETE") {
        const a = access(user, og[1], "org:delete");
        if (typeof a === "string") return denyAccess(res, a);
        const org = getOrg(og[1])!;
        const { confirm } = await body(req);
        if (confirm !== org.name) return json(res, 400, { error: "confirmation incorrecte : tape le nom exact de l'organisation" });
        if (activeTaskCount(og[1]) > 0) return json(res, 409, { error: "des tâches sont en cours : annule-les ou attends leur fin" });
        deleteOrgCascade(og[1]);
        audit({ userId: user.id, ip: clientIp(req) }, "org.delete", { type: "org", id: og[1] }, { name: org.name }); // hors organisation : le journal de l'organisation disparaît avec elle
        return json(res, 200, { ok: true });
      }

      // ---- ressources d'une organisation : /api/orgs/:org/...
      const o = /^\/api\/orgs\/([0-9a-f]{16})\/(projects|tasks|secrets|members|invitations|audit|stats|usage)(?:\/([0-9a-f]{8,16}))?(\/events|\/cancel|\/retry|\/verify)?$/.exec(url.pathname);
      if (o) {
        const [, orgId, kind, itemId, sub] = o;
        const deny = (a: Access) => a === "not_found" ? json(res, 404, { error: "introuvable" }) : json(res, 403, { error: "droits insuffisants" });
        const gate = (action: Action) => access(user, orgId, action);
        const log = (action: string, target?: { type: string; id: string }, meta?: Parameters<typeof audit>[3]) => audit({ orgId, userId: user.id, ip: clientIp(req) }, action, target, meta);

        // ---------------- statistiques (tableau de bord) et usage (administrateurs)
        if ((kind === "stats" || kind === "usage") && req.method === "GET" && !itemId) {
          const a = gate(kind === "stats" ? "task:read" : "org:budget");
          if (typeof a === "string") return deny(a);
          const days = Number(url.searchParams.get("days"));
          return json(res, 200, kind === "stats" ? orgStats(orgId, days) : orgUsage(orgId, days));
        }

        // ---------------- journal d'audit (lecture seule, administrateurs)
        if (kind === "audit" && req.method === "GET" && !itemId) {
          const a = gate("audit:read");
          if (typeof a === "string") return deny(a);
          const sp = url.searchParams;
          const num = (k: string) => { const v = sp.get(k); return v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined; };
          const csv = sp.get("format") === "csv";
          const page = queryAudit(orgId, {
            action: (sp.get("action") ?? "").slice(0, 50) || undefined, user: sp.get("user") || undefined, q: (sp.get("q") ?? "").slice(0, 100).trim() || undefined,
            from: num("from"), to: num("to"), limit: csv ? 10000 : num("limit"), offset: csv ? 0 : num("offset"),
          }, csv ? 10000 : 100);
          if (csv) {
            log("audit.export", undefined, { rows: page.items.length });
            return void res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="audit-${orgId}.csv"` }).end(auditToCsv(page.items));
          }
          return json(res, 200, { ...page, items: page.items.map((r) => ({ id: r.id, ts: r.ts, action: r.action, userId: r.user_id, userEmail: r.user_email, targetType: r.target_type, targetId: r.target_id, meta: r.meta ? JSON.parse(r.meta) : null, ip: r.ip })) });
        }

        // ---------------- membres
        if (kind === "members") {
          const a = gate("member:manage");
          if (typeof a === "string") return deny(a);
          if (req.method === "GET" && !itemId) return json(res, 200, listMembers(orgId).map((m) => ({ userId: m.user_id, email: m.email, role: m.role })));
          if (itemId && !sub) {
            const current = roleOf(orgId, itemId);
            if (!current) return json(res, 404, { error: "introuvable" });
            const lastOwner = current === "owner" && countOwners(orgId) === 1;
            if (req.method === "PATCH") {
              const { role } = await body(req);
              if (!ROLES.includes(role)) return json(res, 400, { error: "rôle invalide" });
              if (!canTouch(a.role, current) || !canAssign(a.role, role)) return json(res, 403, { error: "droits insuffisants pour ce rôle" });
              if (lastOwner && role !== "owner") return json(res, 409, { error: "l'organisation doit garder au moins un propriétaire" });
              setMemberRole(orgId, itemId, role);
              log("member.role", { type: "user", id: itemId }, { email: getUserById(itemId)?.email, from: current, to: role });
              return json(res, 200, { userId: itemId, role });
            }
            if (req.method === "DELETE") {
              if (!canTouch(a.role, current)) return json(res, 403, { error: "droits insuffisants pour ce rôle" });
              if (lastOwner) return json(res, 409, { error: "l'organisation doit garder au moins un propriétaire" });
              removeMember(orgId, itemId);
              log("member.remove", { type: "user", id: itemId }, { email: getUserById(itemId)?.email, role: current });
              return json(res, 200, { ok: true });
            }
          }
        }

        // ---------------- invitations (le lien n'est montré qu'à la création ; rien n'est envoyé par e-mail)
        if (kind === "invitations") {
          const a = gate("member:manage");
          if (typeof a === "string") return deny(a);
          if (req.method === "GET" && !itemId) return json(res, 200, listInvitations(orgId));
          if (req.method === "POST" && !itemId) {
            const { email, role } = await body(req);
            if (typeof email !== "string" || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: "adresse e-mail invalide" });
            if (!ROLES.includes(role)) return json(res, 400, { error: "rôle invalide" });
            if (!canAssign(a.role, role)) return json(res, 403, { error: "on ne peut inviter qu'avec un rôle inférieur ou égal au sien" });
            const existing = getUserByEmail(email);
            if (existing && roleOf(orgId, existing.id)) return json(res, 409, { error: "cette personne est déjà membre" });
            const token = newInviteToken();
            const expiresAt = Date.now() + INVITE_TTL_MS;
            const id = insertInvitation(orgId, email, role, user.id, hashInviteToken(token), expiresAt);
            log("invitation.create", { type: "invitation", id }, { email: email.trim().toLowerCase(), role }); // jamais le jeton
            return json(res, 201, { id, email: email.trim().toLowerCase(), role, expiresAt, token });
          }
          if (req.method === "DELETE" && itemId && !sub) {
            if (!deleteInvitation(itemId, orgId)) return json(res, 404, { error: "introuvable" });
            log("invitation.revoke", { type: "invitation", id: itemId });
            return json(res, 200, { ok: true });
          }
        }

        // ---------------- projets
        if (kind === "projects") {
          if (req.method === "GET" && !itemId) {
            const a = gate("task:read");
            return typeof a === "string" ? deny(a) : json(res, 200, listProjects(orgId).map(rowToJson));
          }
          const a = gate("project:manage");
          if (typeof a === "string") return deny(a);

          if (req.method === "POST" && !itemId) {
            const v = validateProject(await body(req), false);
            if (!v.ok) return json(res, 400, { error: v.error });
            const f = v.value as Required<typeof v.value>;
            if (f.gitSecretId && getSecretRow(f.gitSecretId, orgId)?.kind !== "git_token") return json(res, 400, { error: "secret git introuvable" });
            try {
              const id = insertProject({ org_id: orgId, slug: f.slug, name: f.name, repo: f.repo, branch: f.branch, forge: f.forge, check_cmd: f.check, engine: f.engine, protected_paths: JSON.stringify(f.protectedPaths), git_secret_id: f.gitSecretId });
              log("project.create", { type: "project", id }, { slug: f.slug, name: f.name });
              return json(res, 201, rowToJson(getProjectInOrg(id, orgId)!));
            } catch (e) {
              if (!/UNIQUE/.test(String(e))) throw e;
              return json(res, 409, { error: "ce slug existe déjà" });
            }
          }
          if (itemId && sub === "/verify" && req.method === "POST") {
            const row = getProjectInOrg(itemId, orgId);
            if (!row) return json(res, 404, { error: "introuvable" });
            const result = await verifyAccess(rowToProject(row));
            log("project.verify", { type: "project", id: itemId }, { ok: result.ok, branchFound: result.branchFound, error: result.error });
            return json(res, 200, result);
          }
          if (itemId && !sub) {
            if (!getProjectInOrg(itemId, orgId)) return json(res, 404, { error: "introuvable" });
            if (req.method === "PATCH") {
              const v = validateProject(await body(req), true);
              if (!v.ok) return json(res, 400, { error: v.error });
              const f = v.value;
              if (f.gitSecretId && getSecretRow(f.gitSecretId, orgId)?.kind !== "git_token") return json(res, 400, { error: "secret git introuvable" });
              const patch: Record<string, string | null> = {};
              if (f.slug !== undefined) patch.slug = f.slug;
              if (f.name !== undefined) patch.name = f.name;
              if (f.repo !== undefined) patch.repo = f.repo;
              if (f.branch !== undefined) patch.branch = f.branch;
              if (f.forge !== undefined) patch.forge = f.forge;
              if (f.check !== undefined) patch.check_cmd = f.check;
              if (f.engine !== undefined) patch.engine = f.engine;
              if (f.protectedPaths !== undefined) patch.protected_paths = JSON.stringify(f.protectedPaths);
              if (f.gitSecretId !== undefined) patch.git_secret_id = f.gitSecretId;
              try { updateProject(itemId, orgId, patch); } catch (e) {
                if (!/UNIQUE/.test(String(e))) throw e;
                return json(res, 409, { error: "ce slug existe déjà" });
              }
              log("project.update", { type: "project", id: itemId }, { fields: Object.keys(f) }); // noms de l'API, pas ceux des colonnes
              return json(res, 200, rowToJson(getProjectInOrg(itemId, orgId)!));
            }
            if (req.method === "DELETE") {
              const gone = getProjectInOrg(itemId, orgId)!;
              deleteProject(itemId, orgId);
              log("project.delete", { type: "project", id: itemId }, { slug: gone.slug, name: gone.name });
              return json(res, 200, { ok: true });
            }
          }
        }

        // ---------------- secrets (jamais renvoyés en clair, ni après création)
        if (kind === "secrets") {
          const a = gate("secret:manage");
          if (typeof a === "string") return deny(a);
          if (req.method === "GET" && !itemId) {
            const users = secretUsers(orgId);
            return json(res, 200, listSecrets(orgId).map((x) => ({ ...x, usedBy: users[x.id] ?? [] })));
          }
          if (req.method === "PATCH" && itemId && !sub) {
            const cur = getSecretRow(itemId, orgId);
            if (!cur) return json(res, 404, { error: "introuvable" });
            const { label, value } = await body(req);
            if (label === undefined && value === undefined) return json(res, 400, { error: "rien à modifier" });
            if (label !== undefined && (typeof label !== "string" || !label.trim() || label.length > 80)) return json(res, 400, { error: "libellé invalide" });
            if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 500)) return json(res, 400, { error: "valeur invalide" });
            if (label !== undefined) updateSecret(itemId, orgId, { label: label.trim() });
            if (value !== undefined) rotateSecret(orgId, itemId, value.trim());
            log("secret.update", { type: "secret", id: itemId }, { kind: cur.kind, provider: cur.provider, label: label !== undefined ? label.trim() : cur.label, rotated: value !== undefined }); // jamais la valeur
            const now = listSecrets(orgId).find((x) => x.id === itemId)!;
            return json(res, 200, { ...now, usedBy: secretUsers(orgId)[itemId] ?? [] });
          }
          if (req.method === "POST" && !itemId) {
            const { kind: k, provider, label, value } = await body(req);
            if (k !== "git_token" && k !== "provider_key") return json(res, 400, { error: "type de secret invalide" });
            if (k === "provider_key" && !Object.keys(PROVIDERS).includes(provider)) return json(res, 400, { error: "fournisseur invalide" });
            if (typeof label !== "string" || !label.trim() || label.length > 80) return json(res, 400, { error: "libellé invalide" });
            if (typeof value !== "string" || !value.trim() || value.length > 500) return json(res, 400, { error: "valeur invalide" });
            const stored = storeSecret(orgId, k, k === "provider_key" ? provider : null, label.trim(), value.trim());
            log("secret.create", { type: "secret", id: stored.id }, { kind: k, provider: stored.provider, label: stored.label }); // jamais la valeur
            return json(res, 201, stored);
          }
          if (req.method === "DELETE" && itemId && !sub) {
            if (!getSecretRow(itemId, orgId)) return json(res, 404, { error: "introuvable" });
            if (secretInUse(itemId)) return json(res, 409, { error: "secret utilisé par un projet" });
            const gone = getSecretRow(itemId, orgId)!;
            deleteSecret(itemId, orgId);
            log("secret.delete", { type: "secret", id: itemId }, { kind: gone.kind, provider: gone.provider, label: gone.label });
            return json(res, 200, { ok: true });
          }
        }

        // ---------------- tâches
        if (kind === "tasks" && !itemId) {
          if (req.method === "GET") {
            const a = gate("task:read");
            if (typeof a === "string") return deny(a);
            const sp = url.searchParams;
            const num = (k: string) => { const v = sp.get(k); return v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined; };
            const status = (sp.get("status") ?? "").split(",").filter((x): x is Status => (STATUSES as readonly string[]).includes(x));
            const q = (sp.get("q") ?? "").slice(0, 100).trim();
            return json(res, 200, queryTasks(orgId, {
              status, project: sp.get("project") || undefined, user: sp.get("user") || undefined, q: q || undefined,
              from: num("from"), to: num("to"), limit: num("limit"), offset: num("offset"),
            }));
          }
          if (req.method === "POST") {
            const a = gate("task:create");
            if (typeof a === "string") return deny(a);
            const { project, prompt } = await body(req);
            const row = typeof project === "string" ? getProjectInOrg(project, orgId) : undefined; // le projet doit être CELUI de l'organisation
            if (!row || typeof prompt !== "string" || !prompt.trim()) return json(res, 400, { error: "projet ou demande invalide" });
            if (overBudget(orgId)) return json(res, 402, { error: "budget mensuel de l'organisation épuisé" });
            const id = newId();
            createTask(id, orgId, user.id, row.id, prompt.trim());
            addEvent(id, "step", "Demande reçue, en file d'attente.");
            log("task.create", { type: "task", id }, { project: row.name });
            enqueue(id);
            return json(res, 201, getTaskDetail(id, orgId));
          }
        }

        if (kind === "tasks" && itemId) {
          const a = gate("task:read");
          if (typeof a === "string") return deny(a);
          const task = getTaskInOrg(itemId, orgId); // filtre par l'organisation de la session, pas par l'id seul
          if (!task) return json(res, 404, { error: "introuvable" });

          if (req.method === "POST" && sub === "/cancel") {
            const c = gate(task.user_id === user.id ? "task:cancel_own" : "task:cancel_any");
            if (typeof c === "string") return deny(c);
            cancel(task.id);
            log("task.cancel", { type: "task", id: task.id });
            if (task.status === "queued") updateTask(task.id, { status: "cancelled" });
            return json(res, 200, { ok: true });
          }
          if (req.method === "POST" && sub === "/retry") {
            // Relance : une NOUVELLE tâche avec la même demande, au nom de la personne qui relance
            const c = gate("task:create");
            if (typeof c === "string") return deny(c);
            const row = getProjectInOrg(task.project, orgId);
            if (!row) return json(res, 400, { error: "le projet de cette tâche n'existe plus" });
            if (overBudget(orgId)) return json(res, 402, { error: "budget mensuel de l'organisation épuisé" });
            const nid = newId();
            createTask(nid, orgId, user.id, row.id, task.prompt);
            addEvent(nid, "step", `Relance de la tâche ${task.id}. En file d'attente.`);
            log("task.retry", { type: "task", id: nid }, { from: task.id, project: row.name });
            enqueue(nid);
            return json(res, 201, getTaskDetail(nid, orgId));
          }
          if (req.method === "GET" && !sub) return json(res, 200, getTaskDetail(task.id, orgId));
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
