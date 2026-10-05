import { cfg, loadLegacyProjects } from "./config.ts";
import { hashPassword } from "./auth.ts";
import { adoptOrphanTasks, countUsers, createOrg, createUser, firstOrgId, getMeta, insertProject, remapTaskProject, setMeta } from "./db.ts";
import { storeSecret } from "./vault.ts";

/** Première mise en route : crée le propriétaire et l'organisation « Défaut ». Sans effet ensuite. */
export async function bootstrapOwner(): Promise<boolean> {
  if (countUsers() > 0) { adoptOrphans(); return false; }
  const email = process.env.ATELIER_BOOTSTRAP_EMAIL || "admin@localhost";
  const user = createUser(email, await hashPassword(cfg.password));
  createOrg("Défaut", user.id);
  adoptOrphans();
  console.log(`Compte propriétaire créé : ${email} (mot de passe initial : ATELIER_PASSWORD — à changer)`);
  return true;
}

function adoptOrphans() {
  const org = firstOrgId();
  if (org) adoptOrphanTasks(org);
}

/**
 * Reprise de la configuration M1 (PROJECTS_JSON, GIT_TOKEN, *_API_KEY) dans l'organisation « Défaut » :
 * les projets deviennent des lignes de base, les tokens et clés des secrets chiffrés. Une seule fois
 * (drapeau en base) : modifier PROJECTS_JSON ensuite n'a plus d'effet, tout se gère via l'API.
 */
export function importLegacyConfig() {
  if (getMeta("m1_import_done")) return;
  const org = firstOrgId();
  if (!org) return;
  for (const [provider, key] of Object.entries(cfg.providerKeys))
    if (key) storeSecret(org, "provider_key", provider, `${provider} (importée de l'environnement)`, key);

  const tokens = new Map<string, string | null>(); // nom de variable → id du secret
  for (const lp of loadLegacyProjects()) {
    if (!tokens.has(lp.tokenEnv)) {
      const t = process.env[lp.tokenEnv];
      tokens.set(lp.tokenEnv, t ? storeSecret(org, "git_token", null, lp.tokenEnv, t).id : null);
    }
    try {
      const pid = insertProject({
        org_id: org, slug: lp.id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 40) || "projet",
        name: lp.name, repo: lp.repo, branch: lp.branch, forge: lp.forge, check_cmd: lp.check, engine: lp.engine,
        protected_paths: JSON.stringify(lp.protectedPaths), git_secret_id: tokens.get(lp.tokenEnv) ?? null,
      });
      remapTaskProject(org, lp.id, pid);
      console.log(`Projet importé : ${lp.id}`);
    } catch (e) {
      console.warn(`Projet « ${lp.id} » non importé : ${e}`);
    }
  }
  setMeta("m1_import_done", "1");
}
