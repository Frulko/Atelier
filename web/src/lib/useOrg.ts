import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { meQuery } from "./queries";
import { atLeast } from "./roles";
import type { Role } from "./types";

/** L'organisation affichée (celle de l'URL) et mon rôle dedans. Les routes garantissent que je suis membre. */
export function useOrg() {
  const { orgId } = useParams({ strict: false }) as { orgId: string };
  const { data: me } = useQuery(meQuery);
  const org = me?.orgs.find((o) => o.id === orgId);
  const role = org?.role as Role | undefined;
  return { orgId, org, role, me: me ?? null, isAdmin: atLeast(role, "admin"), isMember: atLeast(role, "member"), isOwner: role === "owner" };
}
