import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Link, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "./components/layout/AppShell";
import { lastOrg } from "./components/layout/OrgSwitcher";
import { Button } from "./components/ui/Button";
import { ToastProvider } from "./components/ui/Toast";
import { AccountPage } from "./features/account/AccountPage";
import { AuditPage } from "./features/audit/AuditPage";
import { InvitePage } from "./features/auth/InvitePage";
import { LoginPage } from "./features/auth/LoginPage";
import { IntegrationsPage } from "./features/integrations/IntegrationsPage";
import { OrgSettingsPage } from "./features/org/OrgSettingsPage";
import { OverviewPage } from "./features/overview/OverviewPage";
import { ProjectDetailPage } from "./features/projects/ProjectDetailPage";
import { ProjectsPage } from "./features/projects/ProjectsPage";
import { TaskDetailPage } from "./features/tasks/TaskDetailPage";
import { TasksPage } from "./features/tasks/TasksPage";
import { TeamPage } from "./features/team/TeamPage";
import { UsagePage } from "./features/usage/UsagePage";
import { meQuery } from "./lib/queries";
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
    if (!me.orgs.some((o) => o.id === params.orgId)) throw redirect({ to: "/" }); // pas membre : même réponse que « n'existe pas »
  },
  component: AppShell,
});

const child = <P extends string>(path: P, component: () => React.JSX.Element, extra: object = {}) => createRoute({ getParentRoute: () => orgRoute, path, component, ...extra });

const overviewRoute = createRoute({ getParentRoute: () => orgRoute, path: "/", component: OverviewPage });
const tasksRoute = createRoute({
  getParentRoute: () => orgRoute, path: "tasks", component: TasksPage,
  validateSearch: (s: Record<string, unknown>) => compact({ status: str(s.status), project: str(s.project), user: str(s.user), q: str(s.q), from: str(s.from), to: str(s.to), page: pageNo(s.page) }),
});
const taskRoute = createRoute({ getParentRoute: () => orgRoute, path: "tasks/$taskId", component: TaskDetailPage });
const projectsRoute = child("projects", ProjectsPage);
const projectRoute = createRoute({ getParentRoute: () => orgRoute, path: "projects/$projectId", component: ProjectDetailPage });
const teamRoute = child("team", TeamPage);
const integrationsRoute = child("integrations", IntegrationsPage);
const usageRoute = child("usage", UsagePage);
const auditRoute = createRoute({
  getParentRoute: () => orgRoute, path: "audit", component: AuditPage,
  validateSearch: (s: Record<string, unknown>) => compact({ action: str(s.action), user: str(s.user), q: str(s.q), from: str(s.from), to: str(s.to), page: pageNo(s.page) }),
});
const settingsRoute = child("settings", OrgSettingsPage);
const accountRoute = child("account", AccountPage);

const routeTree = rootRoute.addChildren([
  loginRoute, inviteRoute, indexRoute,
  orgRoute.addChildren([overviewRoute, tasksRoute, taskRoute, projectsRoute, projectRoute, teamRoute, integrationsRoute, usageRoute, auditRoute, settingsRoute, accountRoute]),
]);

export const router = createRouter({ routeTree, context: { queryClient: undefined as unknown as QueryClient }, defaultPreload: "intent", scrollRestoration: true });
declare module "@tanstack/react-router" { interface Register { router: typeof router } }
