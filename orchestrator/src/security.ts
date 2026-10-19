import type { LookupFunction } from "node:net";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import { addressAllowed } from "./health.ts";
import { cfg } from "./config.ts";

export async function repositoryAddresses(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Adresse de dépôt refusée.");
  if (
    cfg.gitHosts.length &&
    !cfg.gitHosts.includes(url.hostname.toLowerCase()) &&
    !(url.hostname === "api.github.com" && cfg.gitHosts.includes("github.com"))
  )
    throw new Error("Hôte git non autorisé.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  const allowPrivate =
    process.env.ATELIER_GIT_ALLOW_PRIVATE === "1" &&
    cfg.gitHosts.includes(host.toLowerCase());
  if (
    !addresses.length ||
    addresses.some((a) => !addressAllowed(a.address, allowPrivate))
  )
    throw new Error("Adresse réseau du dépôt refusée.");
  return { url, addresses };
}

/** HTTPS with pinned, checked DNS and no redirects. Used only for forge endpoints. */
export async function forgeFetch(raw: string, options: RequestInit = {}) {
  const { url, addresses } = await repositoryAddresses(raw);
  return new Promise<Response>((resolve, reject) => {
    const pinned = ((_host: unknown, opts: any, cb: any) =>
      opts?.all
        ? cb(null, addresses)
        : cb(
            null,
            addresses[0]!.address,
            addresses[0]!.family,
          )) as LookupFunction;
    const request = https.request(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers as Record<string, string>,
        lookup: pinned,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 2_000_000) {
            response.destroy();
            reject(new Error("Réponse de forge trop volumineuse."));
          } else chunks.push(chunk);
        });
        response.on("end", () => {
          clearTimeout(timer);
          const headers = new Headers();
          for (const [k, v] of Object.entries(response.headers))
            if (typeof v === "string") headers.set(k, v);
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 502,
              headers,
            }),
          );
        });
        response.on("error", reject);
      },
    );
    const timer = setTimeout(
      () => request.destroy(new Error("Forge indisponible.")),
      20_000,
    );
    request.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Forge indisponible."));
    });
    if (options.body) request.write(options.body);
    request.end();
  });
}

export const applicationCsp = (frameOrigin: string) =>
  [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    `frame-ancestors ${frameOrigin || "'none'"}`,
  ].join("; ");

export function sensitivePath(path: string) {
  const name = path.split("/").at(-1)!.toLowerCase();
  return (
    name === ".env" ||
    (name.startsWith(".env.") && !/\.(example|sample|template)$/.test(name)) ||
    /^(id_rsa|id_ed25519|credentials|\.netrc)$/.test(name) ||
    /\.(p12|pfx|key)$/.test(name)
  );
}
export function containsSecret(text: string, known: string[] = []) {
  return (
    known.some((value) => value.length >= 8 && text.includes(value)) ||
    [
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
      /\bAKIA[0-9A-Z]{16}\b/,
      /\batl_[A-Za-z0-9_-]{32}\b/,
      /\b\d{6,15}:[A-Za-z0-9_-]{30,}\b/,
      /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
      /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
      /\bglpat-[A-Za-z0-9_-]{20,}\b/,
      /\bsk-(?:ant-api\d+-|proj-|live_)[A-Za-z0-9_-]{20,}\b/,
      /\bsk_live_[A-Za-z0-9]{20,}\b/,
      /(?:_authToken|api_key|client_secret)\s*[=:]\s*["']?(?!\$|<|process\.|os\.|your[-_]|example|changeme)[A-Za-z0-9_/-]{32,}/i,
    ].some((pattern) => pattern.test(text))
  );
}

export async function assertSafeFiles(
  tree: string,
  paths: string[],
  orgId?: string,
) {
  const { lstat, readFile, realpath } = await import("node:fs/promises");
  const { resolve, sep } = await import("node:path");
  const { listSecrets, db } = await import("./db.ts");
  const { readSecret, decrypt } = await import("./vault.ts");
  const root = await realpath(tree),
    known: string[] = [];
  if (orgId) {
    for (const s of listSecrets(orgId)) {
      const value = readSecret(orgId, s.id);
      if (value) known.push(value);
    }
    if (
      db
        .prepare("select 1 from sqlite_master where name='project_environment'")
        .get()
    ) {
      for (const s of db
        .prepare(
          "select project_id,environment,name,ciphertext from project_environment where org_id=?",
        )
        .all(orgId) as {
        project_id: string;
        environment: string;
        name: string;
        ciphertext: Buffer;
      }[])
        known.push(
          decrypt(
            s.ciphertext,
            orgId,
            `${s.project_id}:${s.environment}:${s.name}`,
          ),
        );
    }
  }
  if(orgId)known.push(...await protectedValues(orgId));
  let bytes = 0;
  if (paths.length > 2000)
    throw new Error("Trop de fichiers à inspecter avant publication.");
  for (const path of paths) {
    if (sensitivePath(path))
      throw new Error(
        "Un fichier sensible est présent dans la proposition. Retire-le et utilise les variables chiffrées.",
      );
    const file = resolve(root, path);
    if (!file.startsWith(root + sep))
      throw new Error("Chemin de fichier refusé.");
    const stat = await lstat(file).catch(() => null);
    if (!stat) continue;
    const target = await realpath(file);
    if (stat.isSymbolicLink() || !target.startsWith(root + sep))
      throw new Error("Lien symbolique refusé dans les fichiers à publier.");
    if (!stat.isFile()) continue;
    bytes += stat.size;
    if (stat.size > 10_000_000 || bytes > 100_000_000)
      throw new Error(
        "Les fichiers dépassent la taille maximale d'inspection.",
      );
    if (containsSecret((await readFile(file)).toString("utf8"), known))
      throw new Error(
        "Un secret potentiel a été détecté. Retire-le du code et utilise les variables chiffrées.",
      );
  }
}

export async function assertNoSecretText(text: string, orgId: string) {
  if (containsSecret(text,await protectedValues(orgId)))
    throw new Error(
      "Un secret potentiel a été détecté dans le contexte. Utilise les variables chiffrées.",
    );
  const { listSecrets, db } = await import("./db.ts");
  const { readSecret, decrypt } = await import("./vault.ts");
  for (const s of listSecrets(orgId)) {
    const value = readSecret(orgId, s.id);
    if (value && value.length >= 8 && text.includes(value))
      throw new Error(
        "Une valeur du coffre a été détectée dans le contexte. Retire-la avant d'appeler l'IA.",
      );
  }
  if (
    db
      .prepare("select 1 from sqlite_master where name='project_environment'")
      .get()
  ) {
    for (const value of db
      .prepare(
        "select project_id,environment,name,ciphertext from project_environment where org_id=?",
      )
      .all(orgId) as {
      project_id: string;
      environment: string;
      name: string;
      ciphertext: Buffer;
    }[]) {
      const secret = decrypt(
        value.ciphertext,
        orgId,
        `${value.project_id}:${value.environment}:${value.name}`,
      );
      if (secret.length >= 8 && text.includes(secret))
        throw new Error(
          "Une variable protégée est présente dans le contexte. Retire-la avant d'appeler l'IA.",
        );
    }
  }
}


async function protectedValues(orgId:string) {
  const {db}=await import("./db.ts"), {decrypt}=await import("./vault.ts");
  const platform=[process.env.ATELIER_OIDC_CLIENT_SECRET,process.env.ATELIER_MASTER_KEY,process.env.ATELIER_PASSWORD,...Object.values(cfg.providerKeys),process.env.GIT_TOKEN].filter((v):v is string=>!!v && v.length>=8);
  if(!db.prepare("select 1 from sqlite_master where name='human_channels'").get())return platform;
  return platform.concat((db.prepare("select id,ciphertext from human_channels where org_id=?").all(orgId) as {id:string;ciphertext:Buffer}[]).map(c=>decrypt(c.ciphertext,orgId,`human:${c.id}`)));
}
