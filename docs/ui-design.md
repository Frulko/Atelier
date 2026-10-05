# Web application design

The first UI was a single static page. Atelier now gets a real application: navigation, dashboards, filtering, detail pages, audit and usage tracking, and settings for the organization and the account.

**Status:** phase 1 (backend foundations) is done; the web application itself is next. This page records the decisions and the order of work; each phase is checked off when it ships.

## Decisions

| Topic | Choice | Why |
|---|---|---|
| Framework | **React 19 + TypeScript + Vite**, in `web/` | The orchestrator stays free of runtime dependencies; the app is a separate package built to static files that the orchestrator serves |
| Routing and data | **TanStack Router** (typed routes) and **TanStack Query** (server state, cache, polling) | Typed, file-light, and Query replaces hand-written fetch and refresh code |
| Styling | **Tailwind CSS v4** with a small set of local components | No component-library lock-in; design tokens in one CSS file; light, dark and system themes |
| Charts | Small hand-built SVG components | The charts are simple (bars, lines, donut); avoids a heavy charting dependency |
| Language | French UI, strings kept in one module per area | The users are French-speaking; extracting to a locale file stays cheap |
| Serving | Orchestrator serves `web/dist` with an SPA fallback, strict **Content-Security-Policy** and cache headers | One container, no CORS; the policy is a security gain over the inline-script page |
| Tests | **Vitest** for pure logic; the Playwright browser check drives real flows | Same philosophy as the backend: few, meaningful tests |

## Information architecture

```
Sidebar (organization switcher · navigation · account)
├── Overview            KPIs, activity chart, spend vs budget, live tasks, recent activity
├── Tasks               filterable table, new task, task detail (timeline, files, MR, retry/cancel)
├── Projects            cards, project detail (settings, recent tasks, statistics, access check)
├── Team                members, roles, invitations, per-member activity
├── Integrations        git tokens and model keys, which projects use what, last used
├── Usage               spend and volume by day, project, member and provider; budget
├── Audit log           who did what and when, filters, CSV export
├── Organization        name, defaults, ownership, danger zone
└── Account             profile, password, active sessions, theme
```

## What the backend must add

The current API serves the essentials. The pages above need more:

| Need | Addition |
|---|---|
| Duration, "last activity" | `tasks.started_at`, `tasks.finished_at`, `tasks.files_changed` |
| Filterable, paged task table | `GET /tasks?status=&project=&user=&q=&from=&to=&limit=&offset=` returning the requester and project name, plus a total |
| Task detail | requester, timing, file list; retry (a new task from an old one) |
| Dashboards and usage | `GET /stats` and `GET /usage`: counts by status, per-day series, spend by project, member and provider, success rate, average duration |
| Audit log | an append-only `audit_log` table written by every state-changing route; `GET /audit` with filters and a CSV export |
| Profile and sessions | `users.name`; list and revoke sessions (with user agent and last use) |
| Organization settings | rename, delete (owner, confirmed by name) |
| Project access check | "verify access": `git ls-remote` with the project's token, without cloning |
| Secret usage | which projects use a secret; last-used timestamp |

Every one of these keeps the existing rules: scoped by organization, authorized through `access.ts`, covered by an isolation test.

## Phases

1. **Backend foundations** ✅: timing and files on tasks, task filters and pagination, audit log, statistics and usage endpoints, profile and sessions, organization rename/delete, project access check. Each with tests.
2. **Application scaffold**: `web/` with Vite, React, Tailwind and TanStack; build wired into the Docker image; static serving with CSP; app shell, theme, authentication and invitation pages, organization switcher.
3. **Pages**, one commit each: Overview, Tasks (list, detail, new), Projects, Team, Integrations, Usage, Audit log, Organization, Account.
4. **Polish**: empty, loading and error states, keyboard and screen-reader basics, responsive layout, dark mode review, and the browser test extended to cover each page.

## Out of scope for now

Real-time notifications (e-mail, Slack, webhooks), API tokens for automation, billing and payment, SSO, and an English locale. They are listed on the [roadmap](roadmap.md).
