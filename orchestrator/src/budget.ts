import { getOrg, monthSpend } from "./db.ts";

/**
 * Plafond mensuel de l'organisation (null = illimité). La dépense est celle que les agents ont DÉCLARÉE
 * (coût de chaque exécution, enregistré sur la tâche) : un plafond par tâche (MAX_BUDGET_USD) borne le dépassement.
 * ponytail: pas de comptage des tokens au fil de l'eau dans le proxy ; à ajouter si ce dépassement est trop gros.
 */
export function overBudget(orgId: string, now = Date.now()): boolean {
  const cap = getOrg(orgId)?.budget_usd_month;
  return cap != null && monthSpend(orgId, now) >= cap;
}
