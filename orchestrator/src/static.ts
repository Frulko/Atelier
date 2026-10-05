import type http from "node:http";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

/*
 * Sert l'application web construite (web/dist) : fichiers statiques, repli sur index.html pour les routes de
 * l'application (/o/…/tasks), et en-têtes de sécurité. Aucun fichier hors du dossier public ne peut être lu.
 */
const here = (rel: string) => decodeURIComponent(new URL(rel, import.meta.url).pathname);
export const PUBLIC_DIR = resolve(process.env.PUBLIC_DIR || (existsSync(here("../../web/dist")) ? here("../../web/dist") : here("../public")));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json", ".txt": "text/plain; charset=utf-8",
};

// Tout est servi par nous-mêmes : ni script, ni style, ni police, ni image venus d'ailleurs. Seuls les attributs style=""
// (positions et largeurs calculées) sont tolérés, pas les balises <style> ni les scripts en ligne.
export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "style-src-attr 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
].join("; ");

export function securityHeaders(res: http.ServerResponse, secure: boolean) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

/** Rend true si la requête a été traitée ici (fichier, repli SPA ou refus). */
export async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
  if ((req.method !== "GET" && req.method !== "HEAD") || pathname.startsWith("/api/") || pathname === "/healthz") return false;
  let rel: string;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400).end(); return true; }
  if (rel.includes("\0")) { res.writeHead(400).end(); return true; }

  const file = resolve(PUBLIC_DIR, "." + rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) { res.writeHead(404).end(); return true; } // tentative de sortie du dossier

  let target = file;
  const hasExt = extname(rel) !== "";
  if (!isFile(target)) {
    if (hasExt) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Introuvable"); return true; } // un fichier manquant n'est pas une route de l'application
    target = resolve(PUBLIC_DIR, "index.html");
    if (!isFile(target)) { res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("Interface non construite : lancez « npm run build » dans web/."); return true; }
  }
  const body = await readFile(target);
  const isIndex = target.endsWith(`${sep}index.html`);
  res.writeHead(200, {
    "content-type": MIME[extname(target)] ?? "application/octet-stream",
    "content-length": body.length,
    // les fichiers de /assets/ ont un nom qui change avec leur contenu : on peut les garder un an ; la page d'entrée jamais
    "cache-control": isIndex ? "no-cache" : rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=86400",
  });
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}
