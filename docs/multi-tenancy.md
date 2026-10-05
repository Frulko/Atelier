# Multi-tenancy

Several **users** grouped in **organizations**. Each organization owns its projects, secrets and history. A person in one organization never sees, launches or costs anything to another.

**Status:** steps U1–U5 and the API half of U6 are done: accounts, sessions, roles, per-organization tasks, encrypted secrets, projects, per-organization model keys with task tokens and a monthly budget, and organization creation, members and invitations. What remains is the **web UI** for all of it — until then, organizations, members, invitations, projects and secrets are managed through the API. See the [roadmap](roadmap.md).

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
| Creating organizations | **Any signed-in user**, up to 10 each; they become its owner | Revisit if organizations must be provisioned centrally |
| Invitations | **A single-use link, shown once** to the inviter; nothing is e-mailed | No mail server to run or secure. Add e-mail delivery later if wanted |

## Roles

| Action | viewer | member | admin | owner |
|---|:-:|:-:|:-:|:-:|
| Read tasks, logs and projects | ✅ | ✅ | ✅ | ✅ |
| Launch tasks, cancel **your own** | | ✅ | ✅ | ✅ |
| Cancel anyone's task | | | ✅ | ✅ |
| Manage projects | | | ✅ | ✅ |
| Manage secrets (git tokens, model keys) | | | ✅ | ✅ |
| Read and set the monthly model budget | | | ✅ | ✅ |
| Invite, change roles, remove members | | | ✅ (roles up to their own) | ✅ |
| Touch an owner | | | | ✅ |

Privilege escalation is blocked: you can only grant a role at or below your own, only an owner can modify or remove an owner, and the **last owner can be neither demoted nor removed**.

Secrets are **never returned** by the API after creation — only a label and a 4-character hint.

## API

All organization routes are under `/api/orgs/:org`. Every route except login requires a session cookie.

```
POST   /api/auth/login            { email, password }            → session cookie
POST   /api/auth/logout
POST   /api/auth/password         { current, next }              → revokes other sessions
POST   /api/auth/accept-invite    { token, password? }           public: creates the account, or joins a signed-in user whose e-mail matches
GET    /api/me                                                    → user + organizations + roles

POST   /api/orgs                  { name }                       any signed-in user → becomes owner
GET    /api/orgs/:org                                             admin+  → name, budget, month spend
PATCH  /api/orgs/:org             { budgetUsdMonth }              admin+  (a number ≥ 0, or null for no cap)

GET    /api/orgs/:org/members                                     admin+
PATCH  /api/orgs/:org/members/:userId    { role }                 admin+  (see the privilege rules)
DELETE /api/orgs/:org/members/:userId                             admin+

GET    /api/orgs/:org/invitations                                 admin+  (never the link)
POST   /api/orgs/:org/invitations { email, role }                 admin+  → returns the link token ONCE
DELETE /api/orgs/:org/invitations/:id                             admin+

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


## Upgrading from the single-user version

On first start with an empty user table, Atelier creates the *Default* organization and its owner. Existing tasks are attached to it. Then, **once** (a flag in the database), the legacy configuration is imported into the Default organization: `PROJECTS_JSON` / `projects.json` become projects, `GIT_TOKEN*` and `*_API_KEY` become encrypted secrets, and existing tasks are re-pointed at their new project rows. After that, editing `PROJECTS_JSON` has no effect — manage everything through the API.

## Implementation steps

| Step | Content | Status |
|---|---|:-:|
| **U1** | Schema (users, organizations, memberships, sessions), scrypt hashing, owner created at startup | ✅ |
| **U2** | Login/logout, cookie sessions, `Origin` check, rate limiting, password change; replaces Basic auth | ✅ |
| **U3** | Organizations, roles, per-organization tasks, routes under `/api/orgs/:org`, isolation test suite | ✅ |
| **U4** | Encrypted secrets, projects in the database, one-time import of the legacy config | ✅ |
| **U5** | One-time task token and per-organization model keys in the proxy, monthly budget | ✅ |
| **U6a** | Organization creation, members, invitations: API, privilege rules, tests | ✅ |
| **U6b** | Web UI: members, invitations (copy the link), projects, secrets, budget, accept-invite page | next |
| later | OIDC and GitLab / GitHub OAuth sign-in | planned |

### How U5 works

Each task receives a **one-time task token** in place of an API key. The proxy resolves `token → task → organization`, refuses the call if the organization's monthly budget is spent (402), then injects the organization's **own** key for that provider (the most recent `provider_key` secret). An organization without a key for a provider gets a 403 — there is no fallback to another organization's key or to an environment variable. The token is revoked when the task ends.

The budget is measured on the cost the agents report for each task, summed over the current UTC month. It is a coarse control: a running task can overshoot by up to its own `MAX_BUDGET_USD`. Live token metering in the proxy is not built yet.

### How invitations work

An admin creates an invitation for an e-mail address and a role (at most their own). The API returns a link token **once**; only its SHA-256 is stored, and listing invitations never shows it. The admin hands the link over by whatever channel they like — **nothing is sent by e-mail**.

The recipient opens it and either **creates an account** (the e-mail comes from the invitation, they choose a password) or, if the address already has an account, **signs in first** and accepts. A signed-in user whose e-mail differs from the invitation is refused, so a leaked link alone is not enough. The link works once and expires after 7 days; unknown, expired and used links all answer the same 404. A new invitation for the same organization and address replaces the previous one.
