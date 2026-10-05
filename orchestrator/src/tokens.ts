import { randomBytes } from "node:crypto";

/*
 * Jeton de tâche : remplace la clé d'API dans le bac à sable. Il ne vaut que pour UNE tâche, désigne son
 * organisation, et meurt avec elle. Le proxy s'en sert pour savoir pour qui il travaille (clé, budget).
 * ponytail: en mémoire, donc un seul orchestrateur ; une table partagée si on en lance plusieurs.
 */
type Ctx = { taskId: string; orgId: string };
const live = new Map<string, Ctx>();

export function issueTaskToken(taskId: string, orgId: string): string {
  const t = `atl_${randomBytes(24).toString("base64url")}`;
  live.set(t, { taskId, orgId });
  return t;
}

export const resolveTaskToken = (token: string | undefined) => (token ? live.get(token) : undefined);

export function revokeTaskTokens(taskId: string) {
  for (const [t, c] of live) if (c.taskId === taskId) live.delete(t);
}
