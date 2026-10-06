# Web application design

The first UI was a single static page. Atelier now gets a real application: navigation, dashboards, filtering, detail pages, audit and usage tracking, and settings for the organization and the account.

**Status:** phases 1 to 3 are done and the application is served by the orchestrator; phase 4 (polish) continues. Since then: conversations, knowledge, the guide, the dashboard's project status and the welcome tour were added (see [conversations design](conversations-design.md)). This page records the decisions and the order of work.

## Decisions

| Topic | Choice | Why |
|---|---|---|
| Framework | **React 19 + TypeScript + Vite**, in `web/` | The orchestrator stays free of runtime dependencies; the app is a separate package built to static files that the orchestrator serves |
| Routing and data | **TanStack Router** (typed routes, code-based) and **TanStack Query** (server state, cache, polling) | Typed, and Query replaces hand-written fetch and refresh code |
| Styling | **Tailwind CSS v4** with a small set of local components, shadcn-style tokens | No component-library lock-in; design tokens in one CSS file; light, dark and system themes |
| Chat | **Vercel AI Elements** (vendored in `components/ai-elements`, on shadcn primitives in `components/shadcn`) and the AI SDK `useChat` hook | Streaming, stop, regenerate, attachments and Markdown streaming are solved problems; vendored means no lock-in |
| Charts | Small hand-built SVG components | The charts are simple (stacked bars, a cumulative line, a donut, horizontal bars); avoids a heavy charting dependency |
| Language | French UI, strings kept in one module per area | The users are French-speaking; extracting to a locale file stays cheap |
| Serving | Orchestrator serves `web/dist` with an SPA fallback, strict **Content-Security-Policy** and cache headers | One container, no CORS; the policy is a security gain over the inline-script page |
| Tests | **Vitest** for pure logic; the Playwright browser check drives real flows | Same philosophy as the backend: few, meaningful tests |

## Information architecture

```
Sidebar (organization switcher · navigation · account)
├── Overview            project health and last commit, first steps, KPIs, activity, spend vs budget, live tasks
├── Conversations       discuss with the assistant, or run a task as a thread with follow-ups
├── Knowledge           what the assistant and the agent are told
├── Guide               how it works, first steps, tour
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
2. **Application scaffold** ✅: `web/` with Vite, React, Tailwind and TanStack; build wired into the Docker image; static serving with CSP; app shell, theme, authentication and invitation pages, organization switcher.
3. **Pages** ✅, one commit each: Overview, Tasks (list, detail, new), Projects, Team, Integrations, Usage, Audit log, Organization, Account.
4. **Polish** (ongoing): empty, loading and error states, keyboard and screen-reader basics, responsive layout, dark mode review, and the browser test extended to cover each page.

## Out of scope for now

Real-time notifications (e-mail, Slack, webhooks), API tokens for automation, billing and payment, SSO, and an English locale. They are listed on the [roadmap](roadmap.md).

## Design

Light, clean and neutral, in the spirit of shadcn/ui: a white page, hairline borders, small radii, subtle shadows, a near-black primary button, a light sidebar. Typography is Geist (text) and Geist Mono (identifiers), bundled and served by the application itself. The one colour that carries the brand is a signal orange: the logo, progress and chart lines, the active navigation icon, focus rings and running states — never a filled button. Status colours (green, amber, red, blue) are used as soft badges.

Light and dark themes come from CSS variables (`web/src/styles.css`), so no component needs a dark variant. The system preference is the default; the account page lets a person force one. One short staggered entrance per page, disabled for people who ask for reduced motion.

## What the interface checks for you

Nothing it displays is the source of truth: the role helpers in `web/src/lib/roles.ts` mirror the server's rules only to hide or grey out what would be refused. Secrets are never put in the page (only a label and a four-character hint), invitation links are shown once, and destructive actions need a second click or, for deleting an organization, its exact name.
