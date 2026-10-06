import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import clsx from "clsx";
import { BarChart3, BookOpen, CircleHelp, FolderGit2, MessagesSquare, LayoutDashboard, ListChecks, LogOut, Menu, Plug, ScrollText, Settings, Users, X, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { meQuery } from "../../lib/queries";
import { useOrg } from "../../lib/useOrg";
import { Avatar } from "../ui/Avatar";
import { Logo } from "./Logo";
import { Breadcrumbs } from "./Breadcrumbs";
import { OrgSwitcher } from "./OrgSwitcher";
import { TourProvider } from "../../features/guide/Tour";

type Item = { to: string; label: string; icon: LucideIcon; admin?: boolean; exact?: boolean; tour?: string };
const ITEMS: Item[] = [
  { to: "/o/$orgId", label: "Vue d'ensemble", icon: LayoutDashboard, exact: true },
  { to: "/o/$orgId/conversations", label: "Conversations", icon: MessagesSquare, tour: "nav-conversations" },
  { to: "/o/$orgId/tasks", label: "Tâches", icon: ListChecks, tour: "nav-tasks" },
  { to: "/o/$orgId/projects", label: "Projets", icon: FolderGit2, tour: "nav-projects" },
  { to: "/o/$orgId/knowledge", label: "Connaissances", icon: BookOpen, tour: "nav-knowledge" },
  { to: "/o/$orgId/team", label: "Équipe", icon: Users, admin: true },
  { to: "/o/$orgId/integrations", label: "Intégrations", icon: Plug, admin: true },
  { to: "/o/$orgId/usage", label: "Usage", icon: BarChart3, admin: true },
  { to: "/o/$orgId/audit", label: "Journal d'audit", icon: ScrollText, admin: true },
  { to: "/o/$orgId/settings", label: "Organisation", icon: Settings, admin: true },
  { to: "/o/$orgId/guide", label: "Guide", icon: CircleHelp, tour: "nav-guide" },
];

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const { orgId, isAdmin } = useOrg();
  return (
    <nav aria-label="Navigation principale" className="grid gap-0.5">
      {ITEMS.filter((i) => !i.admin || isAdmin).map((i) => (
        <Link key={i.to} to={i.to} params={{ orgId }} data-tour={i.tour} onClick={onNavigate} activeOptions={{ exact: !!i.exact }}
          className="group flex items-center gap-3 rounded-md px-3 py-2 text-[14px] font-medium text-side-muted transition-colors hover:bg-side-hover hover:text-side-ink"
          activeProps={{ className: "!bg-side-active !text-side-ink [&>svg]:!text-accent" }}>
          <i.icon className="size-[18px] transition group-hover:text-side-ink" aria-hidden />
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const { orgId, me } = useOrg();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api.post("/api/auth/logout"),
    onSettled: async () => { qc.clear(); await qc.invalidateQueries({ queryKey: meQuery.queryKey }); navigate({ to: "/login" }); },
  });
  return (
    <div className="flex h-full flex-col gap-6 p-4">
      <div className="flex items-center gap-2.5 px-1 pt-1"><Logo /><span className="font-display text-lg text-side-ink">Atelier</span></div>
      <div data-tour="org-switcher"><OrgSwitcher /></div>
      <div className="min-h-0 flex-1 overflow-y-auto"><Nav onNavigate={onNavigate} /></div>
      <div className="border-t border-side-line pt-4">
        <Link to="/o/$orgId/account" params={{ orgId }} onClick={onNavigate} className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-side-hover">
          <Avatar name={me?.user.name ?? me?.user.email} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-side-ink">{me?.user.name ?? me?.user.email.split("@")[0]}</span>
            <span className="block truncate text-xs text-side-muted">{me?.user.email}</span>
          </span>
        </Link>
        <button type="button" onClick={() => logout.mutate()} className="mt-1 flex w-full items-center gap-3 rounded-md px-3 py-2 text-[13px] text-side-muted transition-colors hover:bg-side-hover hover:text-side-ink">
          <LogOut className="size-4" aria-hidden /> Se déconnecter
        </button>
      </div>
    </div>
  );
}

export function AppShell() {
  const [menu, setMenu] = useState(false);
  return (
    <TourProvider>
    <div className="min-h-screen lg:grid lg:grid-cols-[16.5rem_1fr]">
      <aside className="sticky top-0 hidden h-screen border-r border-side-line bg-side lg:block" aria-label="Barre latérale"><SidebarBody /></aside>

      <div className={clsx("fixed inset-0 z-40 lg:hidden", menu ? "" : "pointer-events-none")} aria-hidden={!menu}>
        <div className={clsx("absolute inset-0 bg-black/50 transition-opacity", menu ? "opacity-100" : "opacity-0")} onClick={() => setMenu(false)} />
        <aside className={clsx("absolute inset-y-0 left-0 w-[18rem] border-r border-side-line bg-side transition-transform", menu ? "translate-x-0" : "-translate-x-full")}>
          <button type="button" onClick={() => setMenu(false)} aria-label="Fermer le menu" className="absolute right-3 top-3 rounded-md p-1.5 text-side-muted hover:text-side-ink"><X className="size-5" /></button>
          <SidebarBody onNavigate={() => setMenu(false)} />
        </aside>
      </div>

      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-paper/90 px-4 backdrop-blur sm:px-8 lg:px-12">
          <button type="button" onClick={() => setMenu(true)} aria-label="Ouvrir le menu" className="rounded-md p-1.5 text-ink hover:bg-line/60 lg:hidden"><Menu className="size-5" /></button>
          <Logo className="size-7 lg:hidden" />
          <Breadcrumbs />
        </header>
        <main className="min-w-0 px-5 py-8 sm:px-8 lg:px-12 lg:py-10"><div className="mx-auto max-w-[72rem]"><Outlet /></div></main>
      </div>
    </div>
    </TourProvider>
  );
}
