import { insertAudit, type AuditRow } from "./db.ts";

/*
 * Journal d'audit : qui a fait quoi, dans quelle organisation, quand, depuis quelle adresse.
 * Ajout seul : aucune route ne modifie ni ne supprime une ligne.
 * RÈGLE : `meta` ne contient JAMAIS de secret (valeur d'un jeton, mot de passe, lien d'invitation) : des noms,
 * des rôles, des adresses e-mail, des identifiants. Un test parcourt le journal à la recherche de ces valeurs.
 */
/** `ts` : date de l'événement, pour amorcer une démo avec un historique ; par défaut, maintenant. */
export type AuditCtx = { orgId?: string | null; userId?: string | null; ip?: string; ts?: number };
type Meta = Record<string, string | number | boolean | null | undefined | string[]>;

export function audit(ctx: AuditCtx, action: string, target?: { type: string; id: string }, meta?: Meta) {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (v === undefined) continue;
    clean[k] = typeof v === "string" ? v.slice(0, 200) : Array.isArray(v) ? v.slice(0, 20).map((x) => String(x).slice(0, 200)) : v;
  }
  const json = Object.keys(clean).length ? JSON.stringify(clean).slice(0, 1000) : null;
  insertAudit({
    ts: ctx.ts ?? Date.now(), org_id: ctx.orgId ?? null, user_id: ctx.userId ?? null, action,
    target_type: target?.type ?? null, target_id: target?.id ?? null, meta: json, ip: ctx.ip ?? null,
  });
}

// Une cellule qui commence par = + - @ serait interprétée comme une formule par un tableur (injection CSV) : on la neutralise.
const cell = (v: unknown) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

export function auditToCsv(rows: AuditRow[]): string {
  const head = ["date", "utilisateur", "action", "cible", "identifiant", "détails", "adresse IP"];
  const lines = rows.map((r) => [new Date(r.ts).toISOString(), r.user_email, r.action, r.target_type, r.target_id, r.meta, r.ip].map(cell).join(","));
  return [head.map(cell).join(","), ...lines].join("\r\n") + "\r\n";
}
