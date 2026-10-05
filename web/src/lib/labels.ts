import type { AuditItem, Role, Status } from "./types";
import { ROLE_LABEL } from "./roles";

export type Tone = "ok" | "warn" | "bad" | "info" | "muted" | "accent";

export const STATUS_LABEL: Record<Status, string> = {
  queued: "En attente", running: "En cours", done: "Prête à valider", no_changes: "Aucun changement", failed: "Échec", cancelled: "Annulée",
};
export const STATUS_TONE: Record<Status, Tone> = { queued: "muted", running: "accent", done: "ok", no_changes: "info", failed: "bad", cancelled: "muted" };
export const STATUSES = Object.keys(STATUS_LABEL) as Status[];
export const isActive = (s: Status) => s === "queued" || s === "running";

export const PROVIDER_LABEL: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter" };
export const FORGE_LABEL = { gitlab: "GitLab", github: "GitHub", none: "Branche seule" } as const;

/** Familles d'événements du journal, pour le filtre. La valeur se termine par un point : c'est un préfixe. */
export const AUDIT_GROUPS: { value: string; label: string }[] = [
  { value: "", label: "Tout" }, { value: "task.", label: "Tâches" }, { value: "project.", label: "Projets" }, { value: "secret.", label: "Secrets" },
  { value: "member.", label: "Membres" }, { value: "invitation.", label: "Invitations" }, { value: "org.", label: "Organisation" }, { value: "auth.", label: "Connexions" }, { value: "audit.", label: "Journal" },
];

const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const role = (v: unknown) => ROLE_LABEL[v as Role] ?? s(v);

/** Phrase lisible d'un événement du journal (sans le nom de l'auteur, affiché à part). */
export function describeAudit(e: Pick<AuditItem, "action" | "meta">): string {
  const m = e.meta ?? {};
  switch (e.action) {
    case "auth.login": return "s'est connecté(e)";
    case "auth.login_failed": return "tentative de connexion échouée";
    case "auth.logout": return "s'est déconnecté(e)";
    case "auth.password_change": return "a changé son mot de passe";
    case "auth.profile_update": return "a modifié son profil";
    case "auth.session_revoke": return "a révoqué une session";
    case "auth.sessions_revoke_others": return "a révoqué ses autres sessions";
    case "org.create": return `a créé l'organisation « ${s(m.name)} »`;
    case "org.rename": return `a renommé l'organisation « ${s(m.from)} » en « ${s(m.to)} »`;
    case "org.budget_set": return m.budgetUsdMonth == null ? "a supprimé le plafond mensuel" : `a fixé le plafond mensuel à ${s(m.budgetUsdMonth)} $`;
    case "org.delete": return `a supprimé l'organisation « ${s(m.name)} »`;
    case "member.role": return `a changé le rôle de ${s(m.email)} : ${role(m.from)} → ${role(m.to)}`;
    case "member.remove": return `a retiré ${s(m.email)} (${role(m.role)})`;
    case "invitation.create": return `a invité ${s(m.email)} comme ${role(m.role).toLowerCase()}`;
    case "invitation.revoke": return "a révoqué une invitation";
    case "invitation.accept": return `${s(m.email)} a rejoint l'organisation (${role(m.role).toLowerCase()})`;
    case "project.create": return `a créé le projet « ${s(m.name)} »`;
    case "project.update": return `a modifié le projet (${Array.isArray(m.fields) ? m.fields.join(", ") : "—"})`;
    case "project.delete": return `a supprimé le projet « ${s(m.name)} »`;
    case "project.verify": return m.ok ? (m.branchFound ? "a vérifié l'accès : tout répond" : "a vérifié l'accès : branche introuvable") : `a vérifié l'accès : échec (${s(m.error)})`;
    case "secret.create": return `a ajouté le secret « ${s(m.label)} »`;
    case "secret.update": return m.rotated ? `a changé la valeur du secret « ${s(m.label)} »` : `a renommé le secret « ${s(m.label)} »`;
    case "secret.delete": return `a supprimé le secret « ${s(m.label)} »`;
    case "task.create": return `a lancé une tâche sur « ${s(m.project)} »`;
    case "task.cancel": return "a annulé une tâche";
    case "task.retry": return `a relancé une tâche sur « ${s(m.project)} »`;
    case "audit.export": return `a exporté le journal (${s(m.rows)} lignes)`;
    default: return e.action;
  }
}

/** Couleur d'accent d'un événement : ce qui détruit ou échoue ressort, le reste est neutre. */
export function auditTone(action: string): Tone {
  if (/delete|remove|revoke|failed/.test(action)) return "bad";
  if (/create|accept/.test(action)) return "ok";
  if (/update|rename|role|budget|password/.test(action)) return "warn";
  return "muted";
}
