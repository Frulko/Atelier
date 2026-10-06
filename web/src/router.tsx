import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, lazyRouteComponent, Link, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "./components/layout/AppShell";
import { lastOrg } from "./components/layout/OrgSwitcher";
import { Button } from "./components/ui/Button";
import { ToastProvider } from "./components/ui/Toast";
import { AccountPage } from "./features/account/AccountPage";
import { AuditPage } from "./features/audit/AuditPage";
import { InvitePage } from "./features/auth/InvitePage";
import { LoginPage } from "./features/auth/LoginPage";
import { IntegrationsPage } from "./features/integrations/IntegrationsPage";
import { ConversationsPage } from "./features/conversations/ConversationsPage";
import { GuidePage } from "./features/guide/GuidePage";
import { KnowledgePage } from "./features/knowledge/KnowledgePage";
import { OrgSettingsPage } from "./features/org/OrgSettingsPage";
import { OverviewPage } from "./features/overview/OverviewPage";
import { ProjectLayout } from "./features/projects/ProjectLayout";
import { ProjectConversations, ProjectKnowledge, ProjectOverview, ProjectSettings, ProjectTasks } from "./features/projects/ProjectPages";
import { ProjectsPage } from "./features/projects/ProjectsPage";
import { TaskDetailPage } from "./features/tasks/TaskDetailPage";
import { TasksPage } from "./features/tasks/TasksPage";
import { TeamPage } from "./features/team/TeamPage";
import { UsagePage } from "./features/usage/UsagePage";
import { meQuery } from "./lib/queries";
import { atLeast } from "./lib/roles";
import type { Role } from "./lib/types";
import { compact, pageNo, safePath, str } from "./lib/search";
import { NoOrganization } from "./features/auth/NoOrganization";


const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => <ToastProvider><Outlet /></ToastProvider>,
  notFoundComponent: () => (
    <div className="grid min-h-screen place-items-center px-6 text-center">
      <div><p className="label">404</p><h1 className="font-display mt-2 text-5xl">Introuvable.</h1><p className="mt-3 text-muted">Cette page n'existe pas, ou tu n'y as pas accès.</p><Link to="/"><Button variant="primary" className="mt-6">Retour à l'accueil</Button></Link></div>
    </div>
  ),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/login",
  validateSearch: (s: Record<string, unknown>) => compact({ redirect: safePath(s.redirect) }),
  beforeLoad: async ({ context }) => { if (await context.queryClient.ensureQueryData(meQuery)) throw redirect({ to: "/" }); },
  component: LoginPage,
});
const inviteRoute = createRoute({ getParentRoute: () => rootRoute, path: "/invite", validateSearch: (s: Record<string, unknown>) => compact({ token: str(s.token) }), component: InvitePage });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/",
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) throw redirect({ to: "/login" });
    const wanted = lastOrg(), pick = me.orgs.find((o) => o.id === wanted) ?? me.orgs[0];
    if (pick) throw redirect({ to: "/o/$orgId", params: { orgId: pick.id } });
  },
  component: NoOrganization,
});

const orgRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/o/$orgId",
  beforeLoad: async ({ context, params, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) throw redirect({ to: "/login", search: { redirect: location.href } });
    const mine = me.orgs.find((o) => o.id === params.orgId);
    if (!mine) throw redirect({ to: "/" }); // pas membre : même réponse que « n'existe pas »
    return { role: mine.role };
  },
  component: AppShell,
});

// Les pages d'administration renvoient les non-administrateurs vers la vue d'ensemble : le menu les masque déjà,
// ceci couvre un lien tapé à la main. C'est un confort : le serveur refuse de toute façon (403).
const adminOnly = ({ context, params }: { context: { role: Role }; params: { orgId: string } }) => {
  if (!atLeast(context.role, "admin")) throw redirect({ to: "/o/$orgId", params: { orgId: params.orgId } });
};
const child = <P extends string>(path: P, component: () => React.JSX.Element) => createRoute({ getParentRoute: () => orgRoute, path, component });

const overviewRoute = createRoute({ getParentRoute: () => orgRoute, path: "/", component: OverviewPage });
const tasksRoute = createRoute({
  getParentRoute: () => orgRoute, path: "tasks", component: TasksPage,
  validateSearch: (s: Record<string, unknown>) => compact({ status: str(s.status), project: str(s.project), user: str(s.user), q: str(s.q), from: str(s.from), to: str(s.to), page: pageNo(s.page) }),
});
const taskRoute = createRoute({ getParentRoute: () => orgRoute, path: "tasks/$taskId", component: TaskDetailPage });
const conversationsRoute = createRoute({
  getParentRoute: () => orgRoute, path: "conversations", component: ConversationsPage,
  validateSearch: (s: Record<string, unknown>) => compact({ new: s.new === "chat" || s.new === "task" ? s.new : undefined, text: str(s.text) }),
});
const guideRoute = child("guide", GuidePage);
const conversationRoute = createRoute({
  getParentRoute: () => orgRoute, path: "conversations/$conversationId", component: lazyRouteComponent(() => import("./features/conversations/ConversationPage"), "ConversationPage"),
  validateSearch: (s: Record<string, unknown>) => compact({ first: str(s.first) }),
});
const projectsRoute = child("projects", ProjectsPage);
const projectRoute = createRoute({ getParentRoute: () => orgRoute, path: "projects/$projectId", component: ProjectLayout });
const projectOverviewRoute = createRoute({ getParentRoute: () => projectRoute, path: "/", component: ProjectOverview });
const projectTasksRoute = createRoute({ getParentRoute: () => projectRoute, path: "tasks", component: ProjectTasks });
const projectConversationsRoute = createRoute({ getParentRoute: () => projectRoute, path: "conversations", component: ProjectConversations });
const projectKnowledgeRoute = createRoute({ getParentRoute: () => projectRoute, path: "knowledge", component: ProjectKnowledge });
const projectSettingsRoute = createRoute({ getParentRoute: () => projectRoute, path: "settings", component: ProjectSettings });
const projectTaskRoute = createRoute({ getParentRoute: () => projectRoute, path: "tasks/$taskId", component: TaskDetailPage });
const projectConversationRoute = createRoute({
  getParentRoute: () => projectRoute, path: "conversations/$conversationId",
  component: lazyRouteComponent(() => import("./features/conversations/ConversationPage"), "ConversationPage"),
  validateSearch: (s: Record<string, unknown>) => compact({ first: str(s.first) }),
});
const editorRoute = createRoute({
  getParentRoute: () => projectRoute, path: "editor", beforeLoad: ({ context, params }) => { if (!atLeast(context.role, "member")) throw redirect({ to: "/o/$orgId", params: { orgId: params.orgId } }); },
  component: lazyRouteComponent(() => import("./features/editor/EditorPage"), "EditorPage"),
  validateSearch: (s: Record<string, unknown>) => compact({ task: str(s.task) }),
});
const knowledgeRoute = createRoute({ getParentRoute: () => orgRoute, path: "knowledge", component: KnowledgePage, validateSearch: (s: Record<string, unknown>) => compact({ starter: s.starter === "bakery" ? s.starter : undefined, project: str(s.project) }) });
const teamRoute = createRoute({ getParentRoute: () => orgRoute, path: "team", component: TeamPage, beforeLoad: adminOnly });
const integrationsRoute = createRoute({ getParentRoute: () => orgRoute, path: "integrations", component: IntegrationsPage, beforeLoad: adminOnly });
const usageRoute = createRoute({ getParentRoute: () => orgRoute, path: "usage", component: UsagePage, beforeLoad: adminOnly });
const auditRoute = createRoute({
  getParentRoute: () => orgRoute, path: "audit", component: AuditPage, beforeLoad: adminOnly,
  validateSearch: (s: Record<string, unknown>) => compact({ action: str(s.action), user: str(s.user), q: str(s.q), from: str(s.from), to: str(s.to), page: pageNo(s.page) }),
});
const settingsRoute = createRoute({ getParentRoute: () => orgRoute, path: "settings", component: OrgSettingsPage, beforeLoad: adminOnly });
const accountRoute = child("account", AccountPage);

const routeTree = rootRoute.addChildren([
  loginRoute, inviteRoute, indexRoute,
  orgRoute.addChildren([overviewRoute, conversationsRoute, conversationRoute, tasksRoute, taskRoute, projectsRoute, projectRoute.addChildren([projectOverviewRoute, projectTasksRoute, projectConversationsRoute, projectConversationRoute, projectTaskRoute, projectKnowledgeRoute, editorRoute, projectSettingsRoute]), knowledgeRoute, guideRoute, teamRoute, integrationsRoute, usageRoute, auditRoute, settingsRoute, accountRoute]),
]);

export const router = createRouter({ routeTree, context: { queryClient: undefined as unknown as QueryClient }, defaultPreload: "intent", scrollRestoration: true });
declare module "@tanstack/react-router" { interface Register { router: typeof router } }
