import { readFileSync, existsSync } from "node:fs";

export type Project = {
  /** Réglages de l'agent propres au projet (voir projects.ts) : instructions de l'équipe, modèle, nombre de tours, budget par exécution. */
  instructions?: string; agentModel?: string; agentMaxTurns?: number; agentBudgetUsd?: number;
  id: string;
  name: string;
  /** URL https (ou chemin local, pour les tests) du dépôt git. */
  repo: string;
  /** Branche de base des modifications. */
  branch: string;
  /** "gitlab" (cloud ou auto-hébergé) ou "github" : ouvre une MR/PR. "none" : pousse seulement la branche.
   *  Par défaut déduit de l'URL du dépôt (github.com → github, sinon gitlab). */
  forge: "gitlab" | "github" | "none";
  /** Commande de vérification, exécutée SANS réseau dans l'image bac à sable. */
  check: string;
  /** Moteur d'agent lancé dans le bac à sable : "claude" (M1). Autres : voir README, "Multi-fournisseur". */
  engine: string;
  /** Si le diff touche un de ces préfixes, la MR est marquée "revue humaine requise". */
  protectedPaths: string[];
  /** Token git DÉCHIFFRÉ, résolu à l'exécution d'une tâche (jamais stocké en clair). */
  token: string;
};

/** Projet tel qu'il était décrit dans la configuration M1 ; importé une fois en base (voir bootstrap.ts). */
export type LegacyProject = Omit<Project, "token"> & { tokenEnv: string };

const env = (k: string, d?: string) => process.env[k] ?? d;
export const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Variable d'environnement manquante : ${k}`);
  return v;
};

export const inferForge = (repo: string): Project["forge"] =>
  /^https?:\/\/(www\.)?github\.com\//.test(repo) ? "github" : /^https?:/.test(repo) ? "gitlab" : "none";

export function loadLegacyProjects(): LegacyProject[] {
  const file = env("PROJECTS_FILE", "/data/projects.json")!;
  const raw = env("PROJECTS_JSON") ?? (existsSync(file) ? readFileSync(file, "utf8") : "[]");
  return (JSON.parse(raw) as Partial<LegacyProject>[]).map((p) => ({
    id: p.id!,
    name: p.name ?? p.id!,
    repo: p.repo!,
    branch: p.branch ?? "main",
    forge: p.forge ?? inferForge(p.repo!),
    check: p.check ?? "true",
    engine: p.engine ?? "claude",
    protectedPaths: p.protectedPaths ?? [],
    tokenEnv: p.tokenEnv ?? "GIT_TOKEN",
  }));
}

export const cfg = {
  port: Number(env("PORT", "8080")),
  proxyPort: Number(env("PROXY_PORT", "8081")),
  password: need("ATELIER_PASSWORD"),
  /** Clés des fournisseurs lues dans l'environnement : servent UNIQUEMENT à l'import initial dans l'organisation « Défaut ».
   *  Ensuite les clés sont des secrets par organisation (voir vault.ts) ; le proxy n'utilise jamais ces variables. */
  providerKeys: {
    anthropic: env("ANTHROPIC_API_KEY", ""),
    openai: env("OPENAI_API_KEY", ""),
    openrouter: env("OPENROUTER_API_KEY", ""),
  } as Record<string, string | undefined>,
  /** Doit être le MÊME chemin sur l'hôte et dans le conteneur (les bacs à sable sont lancés par le démon Docker de l'hôte). */
  workDir: env("ATELIER_WORKDIR", "/srv/atelier/work")!,
  dbFile: env("DB_FILE", "/data/atelier.db")!,
  sandboxImage: env("SANDBOX_IMAGE", "atelier-sandbox:latest")!,
  sandboxNetwork: env("SANDBOX_NETWORK", "atelier-sandbox")!,
  /** Adresse du proxy Anthropic vue depuis le réseau interne des bacs à sable. */
  proxyUrl: env("PROXY_URL", "http://atelier-orchestrator:8081")!,
  /** Dépôts locaux (chemins) : réservés aux tests/démo. En production, seuls les dépôts https sont acceptés. */
  allowLocalRepos: env("ATELIER_ALLOW_LOCAL_REPOS") === "1",
  /** Liste blanche optionnelle des hôtes git (ex. "gitlab.com,github.com,git.mon-domaine.fr"). Vide = tous. */
  gitHosts: (env("ATELIER_GIT_HOSTS", "") ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  /** Surveillance : autorise les adresses privées/locales (réseau interne, démo). Les adresses « lien local » (métadonnées cloud) restent TOUJOURS refusées. */
  healthAllowPrivate: env("ATELIER_HEALTH_ALLOW_PRIVATE") === "1",
  agentTimeoutS: Number(env("AGENT_TIMEOUT_S", "900")),
  maxAttempts: Number(env("MAX_ATTEMPTS", "3")),
  maxBudgetUsd: env("MAX_BUDGET_USD", "2")!,
  fakeAgent: env("ATELIER_FAKE_AGENT") === "1",
  gitAuthorName: env("GIT_AUTHOR_NAME", "Atelier")!,
  gitAuthorEmail: env("GIT_AUTHOR_EMAIL", "atelier@localhost")!,
};
