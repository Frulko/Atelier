import { cfg } from "./config.ts";
import { hashPassword } from "./auth.ts";
import { adoptOrphanTasks, countUsers, createOrg, createUser, firstOrgId } from "./db.ts";

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
