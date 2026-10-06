import { projectsToMonitor, saveGit, saveHealth, type ProjectRow } from "./db.ts";
import { latestCommit, latestDeployment, scrub } from "./git.ts";
import { checkHealth } from "./health.ts";
import { rowToProject } from "./projects.ts";

const HEALTH_EVERY_MS = 60_000;
const GIT_EVERY_MS = 5 * 60_000;
const running = new Set<string>();

const healthTarget = (p: Pick<ProjectRow, "site_url" | "health_url">) => p.health_url || p.site_url || null;

/** Un projet : contrôle de santé (si une adresse est connue) et/ou état git. Jamais deux à la fois pour le même projet. */
export async function refreshProject(row: ProjectRow, what: { health?: boolean; git?: boolean } = { health: true, git: true }) {
  if (running.has(row.id)) return;
  running.add(row.id);
  try {
    const url = healthTarget(row);
    if (what.health && url) saveHealth(row.id, await checkHealth(url));
    if (what.git) {
      let p: ReturnType<typeof rowToProject> | undefined;
      try {
        p = rowToProject(row); // déchiffre le jeton git le temps de la requête
        const commit = await latestCommit(p, row.id);
        const deploy = await latestDeployment(p).catch(() => null); // le déploiement est un bonus : son échec ne cache pas le commit
        saveGit(row.id, { commit, deploy });
      } catch (e: any) {
        saveGit(row.id, { error: scrub(String(e.message || e), p ? [p.token] : []).slice(0, 200) });
      }
    }
  } finally { running.delete(row.id); }
}

/** Boucle de fond : chaque minute, ce qui est dû (santé chaque minute, git toutes les 5 minutes), un projet après l'autre. */
export function startMonitor(everyMs = 30_000) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      for (const p of projectsToMonitor()) {
        const health = !!healthTarget(p) && now - (p.health_checked_at ?? 0) >= HEALTH_EVERY_MS;
        const git = now - (p.git_checked_at ?? 0) >= GIT_EVERY_MS;
        if (health || git) await refreshProject(p, { health, git }).catch(() => {});
      }
    } finally { busy = false; }
  };
  void tick();
  const t = setInterval(tick, everyMs);
  t.unref();
  return () => clearInterval(t);
}
