import { cfg, inferForge, type Project } from "./config.ts";
import type { ProjectRow } from "./db.ts";
import { readSecret } from "./vault.ts";

export const ENGINES = ["claude"];
const FORGES = ["gitlab", "github", "none"];

export type ProjectFields = {
  slug: string; name: string; repo: string; branch: string; forge: "gitlab" | "github" | "none";
  check: string; engine: string; protectedPaths: string[]; gitSecretId: string | null;
};
type Result = { ok: true; value: Partial<ProjectFields> } | { ok: false; error: string };

const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;

/** Valide une entrée venue de l'API. `partial` : mise à jour (champs facultatifs). Toute entrée est hostile par défaut. */
export function validateProject(input: any, partial: boolean): Result {
  const v: Partial<ProjectFields> = {};
  const need = (k: string) => !partial && input?.[k] === undefined;
  if (typeof input !== "object" || !input) return { ok: false, error: "requête invalide" };

  if (input.slug !== undefined || need("slug")) {
    if (typeof input.slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(input.slug)) return { ok: false, error: "slug invalide (minuscules, chiffres, tirets)" };
    v.slug = input.slug;
  }
  if (input.name !== undefined || need("name")) {
    if (!str(input.name, 80)) return { ok: false, error: "nom invalide" };
    v.name = input.name.trim();
  }
  if (input.repo !== undefined || need("repo")) {
    const err = repoProblem(input.repo);
    if (err) return { ok: false, error: err };
    v.repo = input.repo;
  }
  if (input.branch !== undefined) {
    // pas de tiret initial : la valeur est passée à git, elle ne doit pas pouvoir y passer pour une option
    if (typeof input.branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(input.branch) || input.branch.includes("..")) return { ok: false, error: "branche invalide" };
    v.branch = input.branch;
  } else if (!partial) v.branch = "main";
  if (input.forge !== undefined) {
    if (!FORGES.includes(input.forge)) return { ok: false, error: "forge invalide" };
    v.forge = input.forge;
  }
  if (input.check !== undefined) {
    if (typeof input.check !== "string" || input.check.length > 500) return { ok: false, error: "commande de vérification invalide" };
    v.check = input.check || "true";
  } else if (!partial) v.check = "true";
  if (input.engine !== undefined) {
    if (!ENGINES.includes(input.engine)) return { ok: false, error: `moteur invalide (${ENGINES.join(", ")})` };
    v.engine = input.engine;
  } else if (!partial) v.engine = "claude";
  if (input.protectedPaths !== undefined) {
    if (!Array.isArray(input.protectedPaths) || input.protectedPaths.length > 50 || !input.protectedPaths.every((p: unknown) => str(p, 200))) return { ok: false, error: "chemins protégés invalides" };
    v.protectedPaths = input.protectedPaths;
  } else if (!partial) v.protectedPaths = [];
  if (input.gitSecretId !== undefined) {
    if (input.gitSecretId !== null && !str(input.gitSecretId, 40)) return { ok: false, error: "secret invalide" };
    v.gitSecretId = input.gitSecretId;
  } else if (!partial) v.gitSecretId = null;
  if (!partial && !v.forge) v.forge = inferForge(v.repo!);
  return { ok: true, value: v };
}

/** https uniquement (un chemin local ou un schéma exotique permettrait de lire des fichiers de l'hôte). */
function repoProblem(repo: unknown): string | null {
  if (typeof repo !== "string" || repo.length > 300) return "dépôt invalide";
  if (cfg.allowLocalRepos && repo.startsWith("/")) return null; // tests / démo seulement
  let u: URL;
  try { u = new URL(repo); } catch { return "le dépôt doit être une URL https"; }
  if (u.protocol !== "https:") return "le dépôt doit être une URL https";
  if (u.username || u.password) return "pas d'identifiants dans l'URL : utilise un secret";
  if (cfg.gitHosts.length && !cfg.gitHosts.includes(u.hostname.toLowerCase())) return "hôte git non autorisé par l'administrateur";
  return null;
}

export const rowToJson = (r: ProjectRow) => ({
  id: r.id, slug: r.slug, name: r.name, repo: r.repo, branch: r.branch, forge: r.forge, check: r.check_cmd,
  engine: r.engine, protectedPaths: JSON.parse(r.protected_paths) as string[], gitSecretId: r.git_secret_id,
});

/** Projet prêt à l'emploi pour le pipeline : le token git est déchiffré ICI, à l'instant de l'usage. */
export function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id, name: r.name, repo: r.repo, branch: r.branch, forge: r.forge, check: r.check_cmd, engine: r.engine,
    protectedPaths: JSON.parse(r.protected_paths), token: readSecret(r.org_id, r.git_secret_id) ?? "",
  };
}
