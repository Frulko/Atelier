# Multi-tenancy

Several **users** grouped in **organizations**. Each organization owns its projects, secrets and history. A person in one organization never sees, launches or costs anything to another.

**Status:** steps U1–U4 are done (accounts, sessions, roles, per-organization tasks, encrypted secrets, projects in the database). U5–U6 are next. There is no API yet to create an organization or invite someone, so in practice only the *Default* organization exists. See the [roadmap](roadmap.md).

## Data model

![Data model](img/datamodel.png)

The **organization is the isolation boundary**. Every task, project and secret carries an `org_id`, and every query filters on the organization taken from the session — see [Security → Authorization](security.md#authorization).

## Decisions

| Decision | Choice | Why / when to revisit |
|---|---|---|
| Authentication | **Local accounts**: e-mail + password (scrypt), cookie session | No dependency. OIDC and "sign in with GitLab/GitHub" come with U6 and later |
| Database | **SQLite kept** | Enough for a self-hosted instance or a small SaaS. PostgreSQL only when several orchestrator instances or volume require it |
| Tenancy model | **Organization → members, projects, secrets, tasks** | Standard; avoids reshaping the schema later |
| Roles | `owner` · `admin` · `member` · `viewer` | See the matrix below |
| Secrets | **Encrypted at rest** (AES-256-GCM), master key in `ATELIER_MASTER_KEY` | No external KMS yet |
| First account | Created on first start (`ATELIER_BOOTSTRAP_EMAIL` + `ATELIER_PASSWORD`) | |
| Sign-up | **Invitation only** | No open sign-up until quotas and stronger isolation exist |

## Roles

| Action | viewer | member | admin | owner |
|---|:-:|:-:|:-:|:-:|
| Read tasks, logs and projects | ✅ | ✅ | ✅ | ✅ |
| Launch tasks, cancel **your own** | | ✅ | ✅ | ✅ |
| Cancel anyone's task | | | ✅ | ✅ |
| Manage projects | | | ✅ | ✅ |
| Manage secrets (git tokens, model keys) | | | ✅ | ✅ |
| Invite / remove members *(U6)* | | | ✅ | ✅ |
| Delete the organization, transfer ownership *(U6)* | | | | ✅ |

Secrets are **never returned** by the API after creation — only a label and a 4-character hint.

## API

All organization routes are under `/api/orgs/:org`. Every route except login requires a session cookie.

```
POST   /api/auth/login            { email, password }            → session cookie
POST   /api/auth/logout
POST   /api/auth/password         { current, next }              → revokes other sessions
GET    /api/me                                                    → user + organizations + roles

GET    /api/orgs/:org/projects                                    viewer+
POST   /api/orgs/:org/projects                                    admin+
PATCH  /api/orgs/:org/projects/:id                                admin+
DELETE /api/orgs/:org/projects/:id                                admin+

GET    /api/orgs/:org/secrets                                     admin+  (never the value)
POST   /api/orgs/:org/secrets     { kind, provider?, label, value }
DELETE /api/orgs/:org/secrets/:id                                 409 if a project uses it

GET    /api/orgs/:org/tasks                                       viewer+
POST   /api/orgs/:org/tasks       { project, prompt }             member+
GET    /api/orgs/:org/tasks/:id
GET    /api/orgs/:org/tasks/:id/events                            live stream (SSE)
POST   /api/orgs/:org/tasks/:id/cancel                            own task, or admin+
```

Planned for U6: members, invitations, organization creation.

## Upgrading from the single-user version

On first start with an empty user table, Atelier creates the *Default* organization and its owner. Existing tasks are attached to it. Then, **once** (a flag in the database), the legacy configuration is imported into the Default organization: `PROJECTS_JSON` / `projects.json` become projects, `GIT_TOKEN*` and `*_API_KEY` become encrypted secrets, and existing tasks are re-pointed at their new project rows. After that, editing `PROJECTS_JSON` has no effect — manage everything through the API.

## Implementation steps

| Step | Content | Status |
|---|---|:-:|
| **U1** | Schema (users, organizations, memberships, sessions), scrypt hashing, owner created at startup | ✅ |
| **U2** | Login/logout, cookie sessions, `Origin` check, rate limiting, password change; replaces Basic auth | ✅ |
| **U3** | Organizations, roles, per-organization tasks, routes under `/api/orgs/:org`, isolation test suite | ✅ |
| **U4** | Encrypted secrets, projects in the database, one-time import of the legacy config | ✅ |
| **U5** | Per-task token and per-organization model keys in the proxy, monthly budget, token metering | next |
| **U6** | Invitations, UI (login, organization picker, members, projects, secrets); then OIDC / GitLab and GitHub OAuth | next |

### U5 in detail

Today the proxy trusts any caller on the internal network and uses one global key. For several organizations each task receives a **one-time task token** instead of the dummy key; the proxy resolves `token → task → organization → encrypted key`, injects *that* key, counts tokens against the organization's budget, and invalidates the token when the task ends.
