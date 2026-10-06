# Configuration

Atelier is configured through environment variables (see [`.env.example`](../.env.example)) and, once running, through its API. In Portainer, enter the variables under *Stack → Environment variables*.

## Environment variables

### Required

| Variable | Purpose |
|---|---|
| `ATELIER_PASSWORD` | **Initial** password of the owner account created on first start. Change it in the UI afterwards |

### Accounts and security

| Variable | Default | Purpose |
|---|---|---|
| `ATELIER_BOOTSTRAP_EMAIL` | `admin@localhost` | E-mail of the owner created on first start |
| `ATELIER_MASTER_KEY` | generated in the data volume | Base64 of 32 bytes (`openssl rand -base64 32`). Encrypts all secrets — **back it up separately from the database** |
| `ATELIER_GIT_HOSTS` | empty (any `https` host) | Comma-separated allowlist of git hosts for projects created through the API |
| `ATELIER_HEALTH_ALLOW_PRIVATE` | off | `1` lets the health monitor reach private and local addresses (internal sites, demo). Link-local addresses (cloud metadata) are **always** refused |
| `ATELIER_ALLOW_LOCAL_REPOS` | off | `1` accepts local-path repositories. **Tests and demo only** |
| `TRUST_PROXY` | off | `1` behind an HTTPS reverse proxy: reads the real IP and scheme from `X-Forwarded-*` |
| `COOKIE_SECURE` | off | `1` forces the `Secure` attribute on the session cookie |

### Runtime

| Variable | Default | Purpose |
|---|---|---|
| `ATELIER_WORKDIR` | `/srv/atelier/work` | Temporary working directories. **Must be the same path on the host and in the container**, because the host's Docker daemon mounts it into the sandboxes |
| `ATELIER_PORT` | `8080` | Published port (Compose) |
| `MAX_BUDGET_USD` | `2` | Spend cap per agent run |
| `AGENT_TIMEOUT_S` | `900` | Wall-clock limit per agent run |
| `MAX_ATTEMPTS` | `3` | Agent runs per task (first try + fixes after a failing check) |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | `Atelier`, `atelier@localhost` | Identity of the commits Atelier creates |
| `PORT`, `PROXY_PORT` | `8080`, `8081` | Orchestrator and proxy listening ports |
| `DB_FILE` | `/data/atelier.db` | SQLite file |
| `SANDBOX_IMAGE`, `SANDBOX_NETWORK`, `PROXY_URL` | see `config.ts` | Sandbox image, its internal network, and the proxy address as seen from it |
| `PUBLIC_DIR` | `web/dist` (the image sets `/app/public`) | Where the built web application is served from |
| `ATELIER_FAKE_AGENT` | off | `1` uses the deterministic fake agent (demo and tests) |

### First-start import only

`PROJECTS_JSON` (or `/data/projects.json`), `GIT_TOKEN*` and `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` are read **once**, on the first start, to populate the Default organization; see [Multi-tenancy](multi-tenancy.md#upgrading-from-the-single-user-version). **After that the proxy never reads them**: model keys are per-organization secrets. You can start with none and add them through the API.

## Projects

A project is a repository the agent may change. Fields:

| Field | Meaning |
|---|---|
| `slug` | Short unique name within the organization (`a-z`, `0-9`, `-`) |
| `name` | Display name |
| `repo` | `https://` URL, **no credentials in it** |
| `branch` | Base branch (default `main`) |
| `forge` | `gitlab`, `github` or `none`. Deduced from the URL when omitted |
| `check` | Command run, **without network**, inside the sandbox image to validate a change (default `true`). It receives the working tree at `/work` |
| `engine` | Agent engine; only `claude` exists today |
| `protectedPaths` | Path prefixes that mark an MR/PR as *review required* |
| `gitSecretId` | The organization's git-token secret used to clone, push and open the MR/PR |

Projects, secrets and the budget can be managed from the **Settings** tab (admins and owners), or through the API:

```bash
# store a git token, then create a project that uses it (as an admin, with a session cookie)
curl -b jar -H 'content-type: application/json' $URL/api/orgs/$ORG/secrets \
  -d '{"kind":"git_token","label":"GitLab","value":"glpat-…"}'
curl -b jar -H 'content-type: application/json' $URL/api/orgs/$ORG/projects \
  -d '{"slug":"regis","name":"MonRégis","repo":"https://gitlab.example.com/team/regis.git","gitSecretId":"<id>","check":"node --check app.js","protectedPaths":["db/"]}'
```

## Git forges

| Forge | `repo` | Change request created through |
|---|---|---|
| GitLab.com | `https://gitlab.com/group/project.git` | API v4 |
| **Self-hosted GitLab** | `https://gitlab.my-domain.com/group/project.git` | API v4 on the same host |
| GitHub.com | `https://github.com/org/repo.git` | GitHub REST API |
| GitHub Enterprise | `https://ghe.my-domain.com/org/repo.git` with `"forge":"github"` | `/api/v3` on the same host |
| none | any | the branch is pushed, no MR/PR is opened |

Token scopes: GitLab `api` + `write_repository`; GitHub `repo`.

## Model providers

Each organization stores its own key per provider as a secret (`kind: provider_key`, `provider: anthropic | openai | openrouter`); the most recent one is used.

```bash
curl -b jar -H 'content-type: application/json' $URL/api/orgs/$ORG/secrets \
  -d '{"kind":"provider_key","provider":"anthropic","label":"Team key","value":"sk-ant-…"}'

# monthly budget in USD, or null for no cap
curl -b jar -X PATCH -H 'content-type: application/json' $URL/api/orgs/$ORG -d '{"budgetUsdMonth":50}'
```

The proxy routes by prefix (`/anthropic`, `/openai`, `/openrouter`), identifies the organization from the task token and injects that organization's key. Adding a provider is one entry in `PROVIDERS` in [`orchestrator/src/proxy.ts`](../orchestrator/src/proxy.ts) plus its name in the secret validation in `app.ts` (it reads `PROVIDERS`).

On the agent side, a project's `engine` selects what runs in the sandbox. **Only `claude` (the Claude Agent SDK) is implemented.** To use other models, add an engine to [`sandbox/runner.mjs`](../sandbox/runner.mjs) — for example OpenCode or Codex CLI, which speak to several providers. An engine only has to emit the same JSON-lines events.
