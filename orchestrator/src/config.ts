import { readFileSync, existsSync } from "node:fs";

export type Project = {
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
  /** Nom de la variable d'environnement qui contient le token git de CE projet (défaut : GIT_TOKEN). */
  tokenEnv: string;
};

const env = (k: string, d?: string) => process.env[k] ?? d;
export const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Variable d'environnement manquante : ${k}`);
  return v;
};

function loadProjects(): Project[] {
  const file = env("PROJECTS_FILE", "/data/projects.json")!;
  const raw = env("PROJECTS_JSON") ?? (existsSync(file) ? readFileSync(file, "utf8") : "[]");
  return (JSON.parse(raw) as Partial<Project>[]).map((p) => ({
    id: p.id!,
    name: p.name ?? p.id!,
    repo: p.repo!,
    branch: p.branch ?? "main",
    forge: p.forge ?? (/^https?:\/\/(www\.)?github\.com\//.test(p.repo!) ? "github" : /^https?:/.test(p.repo!) ? "gitlab" : "none"),
    check: p.check ?? "true",
    engine: p.engine ?? "claude",
    protectedPaths: p.protectedPaths ?? [],
    tokenEnv: p.tokenEnv ?? "GIT_TOKEN",
  }));
}

/** Relu à chaque appel : ajouter un projet ne demande pas de redémarrage. */
export const getProjects = loadProjects;
export const getProject = (id: string) => loadProjects().find((p) => p.id === id);
export const projectToken = (p: Project) => process.env[p.tokenEnv] ?? "";

export const cfg = {
  port: Number(env("PORT", "8080")),
  proxyPort: Number(env("PROXY_PORT", "8081")),
  password: need("ATELIER_PASSWORD"),
  /** Clés des fournisseurs de modèles : elles restent ICI, le bac à sable ne les voit jamais. Au moins une est requise. */
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
  agentTimeoutS: Number(env("AGENT_TIMEOUT_S", "900")),
  maxAttempts: Number(env("MAX_ATTEMPTS", "3")),
  maxBudgetUsd: env("MAX_BUDGET_USD", "2")!,
  fakeAgent: env("ATELIER_FAKE_AGENT") === "1",
  gitAuthorName: env("GIT_AUTHOR_NAME", "Atelier")!,
  gitAuthorEmail: env("GIT_AUTHOR_EMAIL", "atelier@localhost")!,
};

if (!Object.values(cfg.providerKeys).some(Boolean)) throw new Error("Aucune clé de fournisseur (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY…)");
