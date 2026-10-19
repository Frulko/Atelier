import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, verifyPassword, passwordProblem } from "./lib/auth.ts";

export async function createApplication(
  root = process.env.APP_DATA_DIR || "/data",
) {
  await mkdir(root, { recursive: true });
  await mkdir(join(root, "files"), { recursive: true });
  const db = new DatabaseSync(join(root, "app.sqlite"));
  db.exec(`pragma foreign_keys=on; pragma journal_mode=wal;
    create table if not exists users(id text primary key,email text unique not null,password text not null);
    create table if not exists sessions(hash text primary key,user_id text not null references users(id),expires_at integer not null);
    create table if not exists items(id text primary key,user_id text not null references users(id),text text not null);
    create table if not exists files(id text primary key,user_id text not null references users(id),name text not null,size integer not null);
  `);
  const digest = (v) => createHash("sha256").update(v).digest("hex");
  const dummy = await hashPassword("password-for-timing-only");
  const failures = new Map();
  const json = (res, status, value) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(value));
  };
  const read = async (req) => {
    let n = 0;
    const chunks = [];
    for await (const c of req) {
      n += c.length;
      if (n > 1_000_000)
        throw Object.assign(Error("Fichier ou requête trop volumineux"), {
          status: 413,
        });
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "no-store");
    try {
      const path = new URL(req.url, "http://app").pathname;
      if (
        !["GET", "HEAD"].includes(req.method) &&
        req.headers.origin &&
        new URL(req.headers.origin).host !== req.headers.host
      )
        return json(res, 403, { error: "Origine refusée" });
      const token = req.headers.cookie
        ?.split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("app_session="))
        ?.slice(12);
      const session = token
        ? db
            .prepare(
              "select user_id from sessions where hash=? and expires_at>?",
            )
            .get(digest(token), Date.now())
        : null;
      if (path === "/healthz") return json(res, 200, { ok: true });
      if (path === "/" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(
          '<!doctype html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mon application</title><link rel="icon" href="data:,"></head><body><main><h1>Mon application est prête.</h1><p>Base SQLite, comptes et stockage de fichiers disponibles. Décrivez votre interface dans Atelier.</p></main></body></html>',
        );
      }
      if (
        ["/api/auth/register", "/api/auth/login"].includes(path) &&
        req.method === "POST"
      ) {
        const key = `${req.socket.remoteAddress || "unknown"}:${path}`,
          now = Date.now();
        const attempt = failures.get(key);
        if (attempt && attempt.until > now && attempt.n >= 10)
          return json(res, 429, {
            error: "Trop de tentatives, réessaie dans une minute",
          });
        if (!attempt || attempt.until <= now)
          failures.set(key, { n: 0, until: now + 60000 });
        failures.get(key).n++;
        const { email, password } = JSON.parse((await read(req)).toString());
        if (
          typeof email !== "string" ||
          email.length > 254 ||
          !/^\S+@\S+\.\S+$/.test(email) ||
          typeof password !== "string" ||
          passwordProblem(password)
        )
          return json(res, 400, {
            error: "Adresse ou mot de passe invalide (8 caractères minimum)",
          });
        const normalized = email.trim().toLowerCase();
        let user = db
          .prepare("select * from users where email=?")
          .get(normalized);
        if (path.endsWith("register")) {
          if (user)
            return json(res, 409, {
              error: "Création de compte impossible avec cette adresse",
            });
          const id = randomBytes(16).toString("hex"),
            hash = await hashPassword(password);
          try {
            db.prepare("insert into users values (?,?,?)").run(
              id,
              normalized,
              hash,
            );
          } catch {
            return json(res, 409, {
              error: "Création de compte impossible avec cette adresse",
            });
          }
          user = { id, email: normalized };
        } else if (
          !(await verifyPassword(password, user?.password || dummy)) ||
          !user
        )
          return json(res, 401, { error: "Identifiants incorrects" });
        if (path.endsWith("login")) failures.delete(key);
        const value = randomBytes(32).toString("base64url");
        db.prepare("insert into sessions values (?,?,?)").run(
          digest(value),
          user.id,
          now + 7 * 86400000,
        );
        db.prepare("delete from sessions where expires_at<?").run(now);
        res.setHeader(
          "set-cookie",
          `app_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`,
        );
        return json(res, 200, { user: { id: user.id, email: user.email } });
      }
      if (!session) return json(res, 401, { error: "Connexion requise" });
      if (path === "/api/auth/me" && req.method === "GET")
        return json(
          res,
          200,
          db
            .prepare("select id,email from users where id=?")
            .get(session.user_id),
        );
      if (path === "/api/auth/logout" && req.method === "POST") {
        db.prepare("delete from sessions where hash=?").run(digest(token));
        res.setHeader(
          "set-cookie",
          "app_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        );
        return json(res, 200, { ok: true });
      }
      if (path === "/api/items" && req.method === "GET")
        return json(
          res,
          200,
          db
            .prepare(
              "select id,text from items where user_id=? order by rowid desc limit 100",
            )
            .all(session.user_id),
        );
      if (path === "/api/items" && req.method === "POST") {
        const { text } = JSON.parse((await read(req)).toString());
        if (typeof text !== "string" || !text.trim() || text.length > 10000)
          return json(res, 400, { error: "Texte invalide" });
        const count = db
          .prepare("select count(*) as n from items where user_id=?")
          .get(session.user_id).n;
        if (count >= 1000)
          return json(res, 409, { error: "Limite de 1 000 éléments atteinte" });
        const id = randomBytes(16).toString("hex");
        db.prepare("insert into items values (?,?,?)").run(
          id,
          session.user_id,
          text.trim(),
        );
        return json(res, 201, { id, text: text.trim() });
      }
      const item = /^\/api\/items\/([0-9a-f]{32})$/.exec(path);
      if (item && req.method === "DELETE") {
        const result = db
          .prepare("delete from items where id=? and user_id=?")
          .run(item[1], session.user_id);
        return json(res, result.changes ? 200 : 404, { ok: !!result.changes });
      }
      if (path === "/api/files" && req.method === "GET")
        return json(
          res,
          200,
          db
            .prepare(
              "select id,name,size from files where user_id=? order by rowid desc limit 100",
            )
            .all(session.user_id),
        );
      if (path === "/api/files" && req.method === "POST") {
        const size = db
          .prepare(
            "select coalesce(sum(size),0) as n from files where user_id=?",
          )
          .get(session.user_id).n;
        const data = await read(req);
        if (size + data.length > 10_000_000)
          return json(res, 409, { error: "Quota de fichiers atteint (10 Mo)" });
        const id = randomBytes(16).toString("hex"),
          name = String(req.headers["x-file-name"] || "fichier")
            .replace(/[\r\n\0]/g, "")
            .slice(0, 150);
        await writeFile(join(root, "files", id), data, { flag: "wx" });
        try {
          db.prepare("insert into files values (?,?,?,?)").run(
            id,
            session.user_id,
            name,
            data.length,
          );
        } catch (e) {
          await unlink(join(root, "files", id));
          throw e;
        }
        return json(res, 201, { id, name, size: data.length });
      }
      const file = /^\/api\/files\/([0-9a-f]{32})$/.exec(path);
      if (file && req.method === "GET") {
        const row = db
          .prepare("select id,name from files where id=? and user_id=?")
          .get(file[1], session.user_id);
        if (!row) return json(res, 404, { error: "Introuvable" });
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
        });
        return res.end(await readFile(join(root, "files", row.id)));
      }
      return json(res, 404, { error: "Introuvable" });
    } catch (e) {
      return json(res, e.status || 400, {
        error: e.status ? "Requête trop volumineuse" : "Requête invalide",
      });
    }
  });
  server.on("close", () => db.close());
  const sweep = setInterval(() => {
    for (const [key, value] of failures)
      if (value.until < Date.now()) failures.delete(key);
  }, 60000);
  sweep.unref();
  server.on("close", () => clearInterval(sweep));
  return server;
}
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = await createApplication();
  app.listen(Number(process.env.PORT) || 3000, "0.0.0.0");
}
