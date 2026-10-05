import type { Role } from "./db.ts";

// Une seule table de droits : ajouter une action = une ligne ici.
export type Action = "task:read" | "task:create" | "task:cancel_own" | "task:cancel_any" | "project:manage" | "secret:manage" | "org:budget" | "member:manage" | "audit:read";

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const MIN: Record<Action, Role> = {
  "task:read": "viewer",
  "task:create": "member",
  "task:cancel_own": "member",
  "task:cancel_any": "admin",
  "project:manage": "admin",
  "secret:manage": "admin",
  "org:budget": "admin",
  "member:manage": "admin",
  "audit:read": "admin",
};

export const can = (role: Role, action: Action) => RANK[role] >= RANK[MIN[action]];

/**
 * Escalade de privilèges : on ne peut attribuer (invitation, changement de rôle) qu'un rôle inférieur ou égal
 * au sien, et seul un propriétaire touche à un propriétaire. Un administrateur ne peut donc ni se faire
 * propriétaire, ni retirer ou rétrograder le propriétaire.
 */
export const canAssign = (actor: Role, target: Role) => RANK[actor] >= RANK[target] && RANK[actor] >= RANK.admin;
export const canTouch = (actor: Role, existing: Role) => RANK[actor] >= RANK.admin && (existing !== "owner" || actor === "owner");
export const ROLES: Role[] = ["viewer", "member", "admin", "owner"];
