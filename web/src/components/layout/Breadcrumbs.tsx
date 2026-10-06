import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { projectsQuery } from "../../lib/queries";
import { useOrg } from "../../lib/useOrg";

const SECTION: Record<string, string> = {
  conversations: "Conversations", tasks: "Tâches", projects: "Projets", knowledge: "Connaissances", guide: "Guide", team: "Équipe",
  integrations: "Intégrations", usage: "Usage", audit: "Journal d'audit", settings: "Organisation", account: "Compte",
};
const PROJECT_SECTION: Record<string, string> = { tasks: "Tâches", conversations: "Conversations", knowledge: "Connaissances", editor: "Éditeur", settings: "Configuration" };

type Crumb = { label: string; to?: string; params?: Record<string, string> };

/** Le fil d'Ariane de la barre du haut : organisation › section › (projet › sous-section). Chaque étape sauf la dernière est un lien. */
export function Breadcrumbs() {
  const { orgId, org } = useOrg();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const projects = useQuery(projectsQuery(orgId));
  const seg = path.replace(/^\/o\/[^/]+\/?/, "").split("/").filter(Boolean);
  const crumbs: Crumb[] = [{ label: org?.name ?? "Organisation", to: "/o/$orgId", params: { orgId } }];
  if (seg[0]) {
    crumbs.push({ label: SECTION[seg[0]] ?? seg[0], to: seg[1] ? `/o/$orgId/${seg[0]}` : undefined, params: { orgId } });
    if (seg[0] === "projects" && seg[1]) {
      const name = projects.data?.find((p) => p.id === seg[1])?.name ?? "Projet";
      crumbs.push({ label: name, to: seg[2] ? "/o/$orgId/projects/$projectId" : undefined, params: { orgId, projectId: seg[1] } });
      if (seg[2]) crumbs.push({ label: PROJECT_SECTION[seg[2]] ?? seg[2] });
    } else if (seg[0] === "tasks" && seg[1]) crumbs.push({ label: "Tâche" });
    else if (seg[0] === "conversations" && seg[1]) crumbs.push({ label: "Conversation" });
  } else crumbs.push({ label: "Vue d'ensemble" });
  return (
    <nav aria-label="Fil d'Ariane" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={`${c.label}-${i}`} className={`flex min-w-0 items-center gap-1.5 ${i < crumbs.length - 2 ? "hidden sm:flex" : ""}`}>
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />}
              {c.to && !last
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ? <Link to={c.to as any} params={c.params as any} className="truncate hover:text-ink">{c.label}</Link>
                : <span className={`truncate ${last ? "font-medium text-ink" : ""}`} aria-current={last ? "page" : undefined}>{c.label}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
