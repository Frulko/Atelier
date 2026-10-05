# Architecture

Atelier is one small service, the **orchestrator**, plus a **sandbox image** that it launches on demand.

![Architecture](img/architecture.png)

## Components

| Component | Where | Responsibility |
|---|---|---|
| **Orchestrator** | `orchestrator/` — Node 24, TypeScript run directly (no build step), SQLite, no runtime dependency | HTTP API and chat UI, accounts and sessions, organizations and roles, task queue, git operations, sandbox lifecycle |
| **Vault** | `orchestrator/src/vault.ts` | Encrypts git tokens and model API keys at rest (AES-256-GCM) |
| **Model proxy** | `orchestrator/src/proxy.ts` | The only route out of the sandbox. Identifies the organization from a one-time task token, enforces its budget, allows generation endpoints only and injects that organization's API key |
| **Sandbox** | `sandbox/` — Node 24 slim + the Claude Agent SDK | One disposable container per task. Runs the agent on a copy of the project |
| **Chat UI** | `orchestrator/public/index.html` | One static page: login, project picker, live task log |

## The life of a task

![Task lifecycle](img/lifecycle.png)

1. The request goes through authentication and authorization (see [Security](security.md#authorization)).
2. The orchestrator **clones** the project using the organization's git token, held in memory only.
3. It moves `.git` **out of the directory the agent will see**, so the agent cannot plant a hook or config that the orchestrator's git would later execute.
4. It starts the **sandbox** with the working tree mounted and no secret.
5. The agent works; its events (text, tool calls) stream back to the browser live.
6. The orchestrator itself runs the project's **check command** in a network-less container. If it fails, the agent is re-run with the error output (3 attempts by default).
7. It commits, pushes a branch `atelier/<id>` and **opens the MR/PR**. If a *protected path* changed, the title is prefixed `[REVIEW REQUIRED]`.
8. The working directory is deleted.

Only one task runs at a time (a simple in-process queue).

## Request routing

Everything an organization owns lives under `/api/orgs/:org/…` (`projects`, `tasks`, `secrets`). Authentication routes live under `/api/auth/…`. The full list is in [Multi-tenancy](multi-tenancy.md#api).

## Repository layout

```
atelier/
├── CLAUDE.md                       conventions for contributors and AI assistants
├── docker-compose.yml              Portainer / Docker stack (orchestrator + sandbox image)
├── docker-compose.fixtures.yml     adds the fake local git repos used by the demo and tests
├── .env.example · projects.example.json
├── orchestrator/
│   ├── src/index.ts                startup
│   ├── src/app.ts                  HTTP routes and per-organization isolation
│   ├── src/access.ts               role → permission table
│   ├── src/auth.ts                 password hashing (scrypt)
│   ├── src/session.ts              cookie sessions (hashed token, sliding expiry)
│   ├── src/ratelimit.ts            login failure limiter
│   ├── src/vault.ts                secret encryption and master key
│   ├── src/projects.ts             project validation, row → pipeline project
│   ├── src/pipeline.ts             clone → agent → check → push → MR/PR
│   ├── src/git.ts                  hardened git, MR (GitLab) and PR (GitHub) creation
│   ├── src/sandbox.ts              runs the agent and the check in Docker
│   ├── src/proxy.ts                model-provider proxy (task token → organization → key)
│   ├── src/tokens.ts               one-time task tokens
│   ├── src/budget.ts               monthly budget check
│   ├── src/db.ts                   SQLite schema and queries
│   ├── src/bootstrap.ts            first owner account, one-time import of the legacy config
│   ├── src/config.ts               environment variables
│   ├── src/*.test.ts               tests (node --test)
│   └── public/index.html           chat UI
├── sandbox/
│   ├── Dockerfile                  non-root user, no secret
│   └── runner.mjs                  runs the Claude Agent SDK (or the fake agent)
├── fixtures/                       fake projects for the demo and tests
├── docs/                           this documentation, diagram sources and images
└── scripts/
    ├── smoke.sh                    end-to-end test, no AI, no API key
    ├── demo.sh                     local demo with three fake projects
    ├── fixtures.sh                 builds the fake local git repositories
    └── diagrams.sh                 regenerates docs/img from docs/diagrams
```

## Diagrams

The images in `docs/img/` are generated (PNG and SVG) from the diagram-design HTML/SVG sources in `docs/diagrams/` with `scripts/diagrams.sh` (needs `pip install playwright` and Chrome). Edit the source, regenerate, commit both.
