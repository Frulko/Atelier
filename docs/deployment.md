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

## Run it from published images (recommended)

No build on the server: it pulls two images, the **orchestrator** (with the web application) and the **sandbox**.

```bash
cp .env.example .env                 # set ATELIER_PASSWORD, the images, ATELIER_WORKDIR… (every variable is commented)
sudo mkdir -p /srv/atelier/work      # same path on the host and in the container
docker compose -f docker-compose.prod.yml up -d
```

[`docker-compose.prod.yml`](../docker-compose.prod.yml) uses `ghcr.io/frulko/atelier` and `ghcr.io/frulko/atelier-sandbox` by default; set `ATELIER_IMAGE` and `ATELIER_SANDBOX_IMAGE` to use your own. **Pin a version** (`:1.0.0`) rather than `:latest`, and upgrade by changing the tag. The `sandbox-image` service only pulls the sandbox image onto the host and exits — that is expected.

## Build and publish your own images

The pipeline does it for you (below). By hand, for any registry:

```bash
docker login ghcr.io
./scripts/release.sh ghcr.io/your-account/atelier 1.0.0 --push   # amd64 + arm64, tags 1.0.0 and latest
./scripts/release.sh ghcr.io/your-account/atelier 1.0.0          # without --push: builds for this machine only
```

It builds `…/atelier` (the web application is compiled in the first stage of the image) and `…/atelier-sandbox`, and prints the two variables to give the stack. Images carry OCI labels (version, source, licence) and the orchestrator has a Docker `HEALTHCHECK` on `/healthz`, so Portainer shows whether it is healthy.

## The CI/CD pipeline

[`.github/workflows/pipeline.yml`](../.github/workflows/pipeline.yml) runs everything, in order, on GitHub Actions — no secret to create (`GITHUB_TOKEN` is enough):

| Stage | What it does | When |
|---|---|---|
| **orchestrator**, **web** | Type-check, tests, build the interface | every push and pull request |
| **smoke** | The whole stack in Docker and the interface in a browser, without any AI (`scripts/smoke.sh`) | after the checks |
| **stack** | `scripts/prod-test.sh`: `docker-compose.prod.yml` starts with the freshly built images, becomes healthy, serves the app and accepts the first sign-in | after the checks |
| **images** | Builds both images for amd64 and arm64; **publishes** them to `ghcr.io/<owner>/atelier` and `…-sandbox` outside pull requests: `main` → `:edge`, tag `v1.2.3` → `:1.2.3`, `:1.2`, `:latest` | after smoke and stack |
| **release** | A `vX.Y.Z` tag creates the GitHub release with generated notes and attaches `docker-compose.prod.yml` and `.env.example` | on tags |

To ship a version: `git tag v1.0.0 && git push --tags`. The first time, make the two packages public (GitHub → Packages → *Package settings* → *Change visibility*) so a server can pull them without logging in.

## Building from the repository instead

The orchestrator image is built in two stages from the **repository root** (`docker-compose.yml` sets the build context to `.`): the first stage compiles the web application with Node, the second keeps only the compiled static files next to the server. Nothing else is needed on the host — and a Portainer *Repository* stack builds it the same way.

To work on the interface itself:

```bash
cd web && npm install
ATELIER_API=http://localhost:8080 npm run dev    # http://localhost:5173, proxies /api to a running orchestrator
```

## Run it for real, building on the server

```bash
cp .env.example .env     # set the password, a model key, ATELIER_MASTER_KEY, your projects…
mkdir -p /srv/atelier/work
docker compose up -d --build
```

Then sign in with `ATELIER_BOOTSTRAP_EMAIL` / `ATELIER_PASSWORD` and change the password. Create your git-token secret and projects in the **Settings** tab (or through the API, see [Configuration → Projects](configuration.md#projects)), or give `PROJECTS_JSON` and `GIT_TOKEN` on the **first** start to have them imported.

## Portainer

1. *Stacks → Add stack → Repository*: this repository, compose file **`docker-compose.prod.yml`** (published images) — or `docker-compose.yml` to build on the server. A *Web editor* stack with the contents of `docker-compose.prod.yml` works too.
2. *Environment variables*: those of [`.env.example`](../.env.example) — at least `ATELIER_PASSWORD` and `ATELIER_WORKDIR`; pin `ATELIER_IMAGE` and `ATELIER_SANDBOX_IMAGE` to a version.
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
# published images: change ATELIER_IMAGE / ATELIER_SANDBOX_IMAGE to the new tag, then
docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d
# building on the server:
git pull && docker compose up -d --build
```

Database changes are applied automatically at start (additive migrations). Take a backup first.
