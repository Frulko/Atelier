import http from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
const root = await realpath(
  resolve("/work", process.env.ATELIER_OUTPUT_DIR || "dist"),
);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
};
http
  .createServer(async (req, res) => {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405).end();
      return;
    }
    try {
      const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (path.includes("\0") || path.split("/").some((p) => p.startsWith(".")))
        throw Error();
      let file = resolve(root, "." + path);
      if (file !== root && !file.startsWith(root + sep)) throw Error();
      try {
        if ((await stat(file)).isDirectory())
          file = resolve(file, "index.html");
      } catch {
        if (extname(path)) throw Error();
        file = resolve(root, "index.html");
      }
      file = await realpath(file);
      if (!file.startsWith(root + sep)) throw Error();
      const value = await readFile(file);
      res.writeHead(200, {
        "content-type": types[extname(file)] || "application/octet-stream",
        "x-content-type-options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : value);
    } catch {
      res.writeHead(404).end("Introuvable");
    }
  })
  .listen(3000, "0.0.0.0");
