import type { Role } from "./types";

// Mêmes règles que le serveur (access.ts). Elles ne servent qu'à masquer ou griser ce que le serveur refuserait :
// c'est toujours le serveur qui décide.
export const ROLES: Role[] = ["viewer", "member", "admin", "owner"];
export const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
export const ROLE_LABEL: Record<Role, string> = { viewer: "Lecteur", member: "Membre", admin: "Administrateur", owner: "Propriétaire" };
export const ROLE_HELP: Record<Role, string> = {
  viewer: "Consulte les tâches, projets et statistiques.",
  member: "Lance et annule ses tâches, relance celles des autres.",
  admin: "Gère membres, projets, secrets, budget et journal.",
  owner: "Tout, y compris supprimer l'organisation.",
};

export const atLeast = (role: Role | undefined, min: Role) => !!role && RANK[role] >= RANK[min];
export const canAssign = (me: Role, target: Role) => RANK[me] >= RANK.admin && RANK[me] >= RANK[target];
export const canTouch = (me: Role, existing: Role) => RANK[me] >= RANK.admin && (existing !== "owner" || me === "owner");
