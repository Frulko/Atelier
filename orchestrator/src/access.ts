import type { Role } from "./db.ts";

// Une seule table de droits : ajouter une action = une ligne ici.
export type Action = "task:read" | "task:create" | "task:cancel_own" | "task:cancel_any";

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const MIN: Record<Action, Role> = {
  "task:read": "viewer",
  "task:create": "member",
  "task:cancel_own": "member",
  "task:cancel_any": "admin",
};

export const can = (role: Role, action: Action) => RANK[role] >= RANK[MIN[action]];
