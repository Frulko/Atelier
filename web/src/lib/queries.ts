import { QueryClient, queryOptions, keepPreviousData } from "@tanstack/react-query";
import { api, ApiError, qs } from "./api";
import type {
  ConversationDetail, ConversationPage, ProjectStatus, KnowledgeBrief, KnowledgeItem,
  Activity, AuditFilters, AuditPage, Invitation, Me, Member, OrgDetail, Project, Secret, Session, Stats, Task, TaskFilters, TaskPage, Usage,
} from "./types";
import { isActive } from "./labels";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // une erreur « normale » (droits, introuvable…) ne se rejoue pas ; seules les pannes serveur le méritent
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
      refetchOnWindowFocus: true,
    },
  },
});

const org = (id: string) => `/api/orgs/${id}`;

/** Qui suis-je ? `null` quand il n'y a pas de session : les routes s'en servent pour rediriger vers la connexion. */
export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async (): Promise<Me | null> => {
    try { return await api.get<Me>("/api/me"); } catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; }
  },
  staleTime: 60_000,
});

export const orgQuery = (o: string) => queryOptions({ queryKey: ["org", o], queryFn: () => api.get<OrgDetail>(org(o)) });
export const statsQuery = (o: string, days: number) => queryOptions({ queryKey: ["org", o, "stats", days], queryFn: () => api.get<Stats>(`${org(o)}/stats?days=${days}`), refetchInterval: 30_000 });
export const usageQuery = (o: string, days: number) => queryOptions({ queryKey: ["org", o, "usage", days], queryFn: () => api.get<Usage>(`${org(o)}/usage?days=${days}`) });
export const projectsQuery = (o: string) => queryOptions({ queryKey: ["org", o, "projects"], queryFn: () => api.get<Project[]>(`${org(o)}/projects`) });
export const secretsQuery = (o: string) => queryOptions({ queryKey: ["org", o, "secrets"], queryFn: () => api.get<Secret[]>(`${org(o)}/secrets`) });
export const membersQuery = (o: string) => queryOptions({ queryKey: ["org", o, "members"], queryFn: () => api.get<Member[]>(`${org(o)}/members`) });
export const invitationsQuery = (o: string) => queryOptions({ queryKey: ["org", o, "invitations"], queryFn: () => api.get<Invitation[]>(`${org(o)}/invitations`) });

export const PAGE_SIZE = 20;
export const tasksQuery = (o: string, f: TaskFilters, page: number) => queryOptions({
  queryKey: ["org", o, "tasks", f, page],
  queryFn: () => api.get<TaskPage>(`${org(o)}/tasks${qs({ ...f, limit: PAGE_SIZE, offset: page * PAGE_SIZE })}`),
  placeholderData: keepPreviousData,
  // la liste se rafraîchit seule tant qu'une tâche est en file ou en cours
  refetchInterval: (q) => (q.state.data?.items.some((t) => isActive(t.status)) ? 4_000 : 30_000),
});
export const taskQuery = (o: string, id: string) => queryOptions({
  queryKey: ["org", o, "task", id],
  queryFn: () => api.get<Task>(`${org(o)}/tasks/${id}`),
  refetchInterval: (q) => (q.state.data && isActive(q.state.data.status) ? 2_000 : false),
});
export const auditQuery = (o: string, f: AuditFilters, page: number, size: number) => queryOptions({
  queryKey: ["org", o, "audit", f, page, size],
  queryFn: () => api.get<AuditPage>(`${org(o)}/audit${qs({ ...f, limit: size, offset: page * size })}`),
  placeholderData: keepPreviousData,
});

export const knowledgeQuery = (o: string) => queryOptions({ queryKey: ["org", o, "knowledge"], queryFn: () => api.get<KnowledgeBrief[]>(`${org(o)}/knowledge`) });
export const knowledgeItemQuery = (o: string, id: string) => queryOptions({ queryKey: ["org", o, "knowledge", id], queryFn: () => api.get<KnowledgeItem>(`${org(o)}/knowledge/${id}`) });

export const sessionsQuery = queryOptions({ queryKey: ["me", "sessions"], queryFn: () => api.get<Session[]>("/api/me/sessions") });
export const activityQuery = queryOptions({ queryKey: ["me", "activity"], queryFn: () => api.get<Activity[]>("/api/me/activity") });

/** Après une modification : on invalide ce qui peut avoir changé. */
export const invalidateOrg = (o: string, ...parts: string[]) =>
  queryClient.invalidateQueries({ queryKey: parts.length ? ["org", o, ...parts] : ["org", o] });

/** Recharge l'identité de force (et pas seulement « marquer périmée ») : le routeur lit ce cache pour décider où envoyer la personne. */
export const refreshMe = (qc: QueryClient) => qc.fetchQuery({ ...meQuery, staleTime: 0 });

export const conversationsQuery = (o: string, mode?: string, project?: string) => queryOptions({
  queryKey: ["org", o, "conversations", mode ?? "all", project ?? "all"],
  queryFn: () => api.get<ConversationPage>(`${org(o)}/conversations${qs({ mode, project, limit: 100 })}`),
});
export const conversationQuery = (o: string, id: string) => queryOptions({
  queryKey: ["org", o, "conversation", id],
  queryFn: () => api.get<ConversationDetail>(`${org(o)}/conversations/${id}`),
  staleTime: 0,
});

/** Santé, dernier commit et déploiement de chaque projet. Le serveur contrôle en tâche de fond ; la page se met à jour chaque minute. */
export const statusQuery = (o: string) => queryOptions({ queryKey: ["org", o, "status"], queryFn: () => api.get<ProjectStatus[]>(`${org(o)}/status`), refetchInterval: 60_000 });
