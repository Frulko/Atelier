# Deployment

Atelier runs as a Docker Compose stack: the orchestrator, plus a one-shot service that builds the sandbox image. It needs access to the host's Docker daemon to start sandboxes.

> **Read [Security → known limitations](security.md#known-limitations) first.** Mounting the Docker socket gives the orchestrator root-equivalent power on the host: deploy on a dedicated machine, for a team you trust.

## Try it locally (no AI, no API key, no forge)

```bash
./scripts/demo.sh        # http://localhost:8080 — admin@localhost / demo
```

It starts the stack with three fake projects (a static site, a small Node API, a calculation module with a test) and a deterministic fake agent. The "forges" are local git repositories under `.demo/fixtures/`:

```bash
git --git-dir=.demo/fixtures/mini-regie.git branch     # branches created by the tasks
```

A request containing **"casse"** makes the check fail once, so you can watch the fix loop. Stop it with the `down -v` command that `demo.sh` prints.

## Building the image

The orchestrator image is built in two stages from the **repository root** (`docker-compose.yml` sets the build context to `.`): the first stage compiles the web application with Node, the second keeps only the compiled static files next to the server. Nothing else is needed on the host — and a Portainer *Repository* stack builds it the same way.

To work on the interface itself:

```bash
cd web && npm install
ATELIER_API=http://localhost:8080 npm run dev    # http://localhost:5173, proxies /api to a running orchestrator
```

## Run it for real

```bash
cp .env.example .env     # set the password, a model key, ATELIER_MASTER_KEY, your projects…
mkdir -p /srv/atelier/work
docker compose up -d --build
```

Then sign in with `ATELIER_BOOTSTRAP_EMAIL` / `ATELIER_PASSWORD` and change the password. Create your git-token secret and projects in the **Settings** tab (or through the API, see [Configuration → Projects](configuration.md#projects)), or give `PROJECTS_JSON` and `GIT_TOKEN` on the **first** start to have them imported.

## Portainer

1. *Stacks → Add stack → Repository*: this repository, compose file `docker-compose.yml`.
2. *Environment variables*: those of [`.env.example`](../.env.example).
3. Create the directory used as `ATELIER_WORKDIR` on the host (default `/srv/atelier/work`).
4. *Deploy the stack*. The `sandbox-image` service builds the sandbox image and exits — that is expected.
5. Put an **HTTPS reverse proxy** in front of port 8080 and set `TRUST_PROXY=1`. Session cookies must never travel in clear text.

## Networks

The stack defines `atelier-sandbox` with `internal: true`: sandboxes can reach only the orchestrator's proxy on that network, not the Internet. The orchestrator is attached to both the default network (Internet for git and models) and the sandbox network.

## Backups

The `data` volume holds `atelier.db`. If you did not set `ATELIER_MASTER_KEY`, it also holds a generated `master.key`.

- Back up the database regularly.
- **Keep the master key somewhere else** (a password manager, a secret store). A database backup without the key is useless for secrets, and a backup stored *with* the key defeats the encryption.
- Task working directories under `ATELIER_WORKDIR` are temporary and deleted after each task; there is nothing to back up there.

## Upgrading

```bash
git pull && docker compose up -d --build
```

Database changes are applied automatically at start (additive migrations). Take a backup first.
