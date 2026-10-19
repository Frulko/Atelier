# Deployment

**GitLab auto-hébergé et Portainer :** [tutoriel complet en français](gitlab-portainer.md), du registre privé au déploiement, HTTPS, Keycloak et CI/CD.

Atelier runs as a Docker Compose stack: the orchestrator, plus a one-shot service that pulls the sandbox image in production (or builds it with the development Compose file). It needs access to the host's Docker daemon to start sandboxes.

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
4. *Deploy the stack*. With the production Compose file, the `sandbox-image` service pulls the sandbox image and exits — that is expected.
5. Put an **HTTPS reverse proxy** in front of port 8080 and set `TRUST_PROXY=1`. Session cookies must never travel in clear text.

## Networks

The stack defines `atelier-sandbox` with `internal: true`: sandboxes can reach only the orchestrator's proxy on that network, not the Internet. The orchestrator is attached to both the default network (Internet for git and models) and the sandbox network.

## Backups

The `data` volume holds `atelier.db`. If you did not set `ATELIER_MASTER_KEY`, it also holds a generated `master.key`.

- Back up the database regularly.
- **Keep the master key somewhere else** (a password manager, a secret store). A database backup without the key is useless for secrets, and a backup stored *with* the key defeats the encryption.
- Back up **the whole `ATELIER_WORKDIR`** too: it contains managed repositories, retained application artifacts, application databases/uploads and workspaces paused for a human decision. Stop writers or use coherent database snapshots; copying live SQLite files without their state is unsafe.

## Upgrading

```bash
# published images: change ATELIER_IMAGE / ATELIER_SANDBOX_IMAGE to the new tag, then
docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d
# building on the server:
git pull && docker compose up -d --build
```

Database changes are applied automatically at start (additive migrations). Take a backup first.

## User applications on Docker / Portainer

Atelier can create a managed git repository from an HTML, React or Node.js template, build an isolated preview, take desktop/mobile screenshots and publish the same artifact. This is separate from publishing Atelier's own container images.

Set these stack variables:

```dotenv
ATELIER_PUBLIC_URL=https://atelier.example.com
ATELIER_APPS_DOMAIN=apps.example.net
ATELIER_APPS_SCHEME=https
ATELIER_PUSH_SUBJECT=mailto:admin@example.com
```

1. Point a wildcard DNS record `*.apps.example.net` to the server. Use a separate domain for user applications.
2. Add a wildcard HTTPS reverse-proxy host for that domain, preserving the incoming `Host` header, forwarding to the orchestrator's port **8082**. Obtain a wildcard certificate with your proxy's DNS challenge.
3. The Compose files expose that gateway on `127.0.0.1:8082` by default. A host proxy can use it directly. A proxy container must join a network shared with the orchestrator and use `atelier-orchestrator:8082`, or use an explicitly chosen `ATELIER_APPS_BIND` address.
4. In a project, open **Publications**, configure its build, output directory or server command, and a real verification command in project settings. A Node server must listen on `0.0.0.0:3000` (or `PORT`).
5. Build a preview, inspect its screenshots, then publish. `p-<project-id>.apps.example.net` is the stable production address; each preview has its own random address. Preview addresses require an authorized Atelier session. They expire after seven days. Published versions are retained for rollback.

For local development, use `ATELIER_APPS_DOMAIN=apps.localhost`, `ATELIER_APPS_SCHEME=http`, `ATELIER_APPS_PUBLIC_PORT=8082` and `ATELIER_PUBLIC_URL=http://localhost:8080`.

Reserve `ATELIER_APPS_SUBNET_POOL` (default `10.240.0.0/16`) outside your LAN, VPN and existing Docker ranges. Atelier allocates a small /29 per application environment and skips Docker subnet collisions. If the pool is occupied, choose another private IPv4 /16. This avoids exhausting Docker’s default address pools after a few previews.

Applications run on separate internal networks for each version and preview/production environment, as uid 1000 with a read-only root and source tree, a temporary `/tmp`, no Linux capabilities, resource limits and a separate internal Docker network. Runtime environment variables are encrypted, scoped per project and preview/production, and injected only when the application starts. Frontend build-time secrets are deliberately not supported: a compiled frontend would expose them to visitors.

Dependency installation uses a token-authenticated proxy restricted to the public npm registry. Lifecycle scripts are disabled; packages that require install scripts or external registries need a prepared sandbox image. Builds and checks run without network access. Chromium checks the root page in desktop/mobile sizes, records JavaScript/log errors and takes screenshots; this is a smoke check, not full business-journey coverage.

Managed projects advance their base branch with a fast-forward when published. A divergent branch blocks publication. External repositories keep their existing PR review workflow; the proposal must be merged and its source tree must match the base branch before publication. Atelier does not bypass forge branch protection. Rollback switches the application artifact; it does not undo database migrations or external repository history.

The Node template includes local accounts, hashed sessions, SQLite tables scoped per user and private file uploads (1 MB per file, 10 MB per account). Its data lives in `_appdata/<project>/<preview|production>`, separately from code and preserved across releases. It is a starter: no email verification, password reset or database migration management is included.

Back up **the whole persistent work directory** now: `_repos` holds managed source repositories and `_releases` holds published artifacts and `_appdata` holds application databases/uploads. The database and master key are still required. They are no longer the only persistent data.

## Background and scheduled agents

Tasks execute on the server even when every browser is closed. Queued work is reloaded after a restart. Interrupted runs are marked explicitly and can be retried; a previous proposal survives an interrupted follow-up. A failed PR creation can be resumed after the push without rerunning the agent.

**Agents** (admin-only) supports five-field cron with an IANA timezone, including daylight-saving changes, and autonomous missions that continue the same branch. The scheduler is server-side. It checks the owner's current role, the organization's budget, a daily UTC execution cap, and prevents overlap on a project. Autonomous agents pause after failure, no more changes or ten turns. Missed cron slots are coalesced into one run rather than replayed in a burst. Pausing stops future triggers; a running task can be cancelled from its task page.

The notification inbox is persistent and private to its recipient. **Activate push notifications** asks for browser permission and registers a service worker; HTTPS is required outside localhost. Push delivery uses a durable outbox, retries temporary failures and removes expired browser subscriptions. Lock-screen messages are generic and contain no project name or prompt. Log out to unregister that browser's subscription. Delivery depends on the browser/OS allowing background push.

This remains a single-orchestrator deployment for a trusted team. Do not run two orchestrators on one database: the scheduler and task-token proxy are not distributed workers.


## Project daily budgets and model selection

In **Organisation → Agents et plafond global**, set the organization's monthly ceiling (for example **200 USD**, matching the API credits you want to allocate) and its agent/subagent defaults. The discussion model remains configured separately. Workers default to `haiku`; a project may override either worker model under **IA**. Subagents are forced to their configured model where supported by Claude Code; forks and skills explicitly inheriting the parent retain its model. Spawn depth is one and at most two subagents run concurrently.

Under **Projet → IA**, set the daily USD ceiling and IANA timezone (default `Europe/Paris`). Zero pauses new agent work pending a budget decision; empty means unlimited. The panel shows accounted spend, active reservations and remaining funds. Project-scoped discussions count toward that project; organization-only discussions count toward the organization monthly budget.

An agent reserves its full turn envelope before it starts. Checks/correction attempts share that envelope. Before each Claude request, the proxy reserves a conservative upper estimate from the remaining envelope, then adjusts it using complete provider usage. Calls whose maximum estimate cannot fit are refused. The proxy also refuses model families outside the project's approved main/subagent selection, so repository settings cannot silently switch to an expensive model. A dated tariff catalogue lives in `orchestrator/src/model-budget.ts`; unknown models, paid server tools, fast/priority/regional pricing modifiers and unbounded documents fail closed for budgeted agents. Images receive a conservative token provision. This can refuse a call whose eventual actual cost would have fit. Update the catalogue when changing models or provider prices. Usage not reported after an interruption/restart retains a conservative provision instead of silently freeing potentially spent funds. Keep a provider-side spending ceiling as the final billing control; this local ledger is not a reading of your Anthropic credit balance and cannot govern use outside Atelier.

When an agent reaches the daily limit, it asks for a **1 USD extension for that day** and releases the worker slot. An authorized technician may grant it or select **Attendre demain**. Without approval, the task remains pending until the next local day, when the daily budget is checked again. Extensions never lift the organization monthly ceiling. Changing a cap never cancels an external request already processed by the provider.

## Technician questions over Telegram and Discord

Configure either or both channels under **Organisation → Décisions du technicien**. These connectors are disabled until configured. Bot tokens are encrypted and never returned through the API. Specify the exact chat/channel and a list of numeric technician user IDs. Those IDs are delegated authority to answer questions and grant the fixed daily extension; protect that list like an administrative permission.

- **Telegram:** create a dedicated bot through BotFather, add it to the destination chat, and configure its token, chat ID and authorized user IDs. Atelier uses `getUpdates`; the bot must not have an existing webhook or another update consumer. One Telegram bot belongs to one Atelier organization. Reply directly to the bot's message with `1`, `2`, etc.
- **Discord bot:** choose **Bot — réponses dans Discord**, enable **Message Content Intent**, and grant **View Channel**, **Read Message History** and **Send Messages** on a dedicated private technician channel. Configure the bot token (Developer Portal → Bot), the **numeric** channel ID and authorized Discord user IDs. Enable Discord Developer Mode, then right-click the channel → Copy Channel ID; its name, such as `atelier`, is not an ID. Select **Salon texte** to reply directly to the bot’s specific message with the option number.
- **Discord forum:** select **Forum — un fil par question** and enter the numeric ID of the **parent forum**, rather than an existing topic. Atelier creates a new topic for each pending decision and reads the authorized technician’s numbered answer inside that topic. Also grant **Send Messages in Threads**. If the forum requires tags, provide an available tag’s numeric ID in the optional tag field. With content sharing enabled, the topic title uses the question; otherwise it stays generic. Polling reads the latest 100 messages per pending topic (up to 100 pending topics per channel per pass); use dedicated low-volume forums/channels.
- **Discord webhook:** choose **Webhook — réponses dans Atelier** and provide the full `https://discord.com/api/webhooks/…` URL. The destination is fixed by that webhook, so no channel ID or external technician list is needed. Text and forum destinations are supported; a forum notification creates a topic. Webhooks only send notifications: follow the authenticated Atelier link to answer. A webhook URL is a secret, is encrypted and is never returned by the settings API. Only official HTTPS Discord webhook URLs are accepted, without redirects or query parameters.

By default only a generic notice and an authenticated Atelier link are sent. Enable **Transmettre la question et ses choix** explicitly to send question text to the messaging provider. No source code, logs or files are attached. Known secrets are refused even when sharing is enabled. Sharing still discloses the question to that provider; the scanner cannot detect every secret or confidential business detail.

The agent has an `ask_technician` tool. A question saves its workspace on the server and releases the running container. The response is audited and the task resumes from its saved workspace with the chosen decision in its context, under freshly checked roles and budgets. A question expires after 24 hours; an unanswered technical choice fails closed. Budget requests expire at the project's next local midnight and may resume then. Cancellation invalidates pending questions. Bot delivery errors retry with backoff and leave the question accessible in Atelier; replies from other users, channels or messages are ignored. A decision never grants a bot an API key, shell access or the ability to publish directly.

Replaying an answered question in the same task turn returns its recorded choice to the tool; it does not suspend the agent or open another forum topic. Matching normalizes case, spacing and punctuation and accepts reordered options; semantically different rephrasings are not classified automatically. The resume brief explicitly tells the agent to apply recorded decisions. Deploy the orchestrator **and** sandbox image together for this protocol change.

## Actions from a discussion and task Kanban

In a project discussion, enable **Autoriser les actions de l’agent**. The assistant can delegate a request to a background task, request an adjustment on a completed task’s existing branch, and query a task’s real status. One mutation is allowed per stored user message, including regeneration. Results link to the task’s commands and downloadable logs. Actions require member rights and retain project budgets and publication review. Organisation-only discussions need a project before they can enable actions. The chat uses a single model step per response; the result card is shown directly without an additional model call. Use a model/provider that supports tools.

In **Tâches → Kanban**, filters still apply and the URL preserves the chosen view. The board shows up to 100 tasks per page. Move a card by dragging it or using its selector, or choose **Suivi automatique** to derive its column from execution. Finished proposals initially enter **À valider**; decisions awaiting a technician always appear under **Bloqué**. Column changes organize work without starting, stopping or completing an agent. Members can move their own cards; admins can move any card in their organization.

## Keycloak SSO alongside passwords

The classic login stays enabled. Keycloak only authenticates identities; Atelier continues to own organization membership and roles. Invite technicians through **Équipe** and assign **admin** when they need to manage projects, budgets, integrations, agents and publications. Only an owner can delete the organization.

1. In Keycloak, create an **OpenID Connect confidential client** named `atelier`. Enable **Client authentication** and **Standard flow**; require **PKCE S256**. Keep ID tokens signed with **RS256**.
2. Set the single valid redirect URI to `https://atelier.example.com/api/auth/sso/callback`. Avoid wildcard redirect URIs. The realm issuer, discovery, authorization, token and JWKS endpoints must use HTTPS on the same origin. Trust your Keycloak certificate through the normal server CA configuration.
3. Configure the stack environment:

   ```dotenv
   ATELIER_PUBLIC_URL=https://atelier.example.com
   TRUST_PROXY=1
   COOKIE_SECURE=1
   ATELIER_OIDC_ISSUER=https://sso.example.com/realms/atelier
   ATELIER_OIDC_CLIENT_ID=atelier
   ATELIER_OIDC_CLIENT_SECRET=<confidential client secret>
   ```

4. Ensure the realm emits `email` and boolean `email_verified` claims and that the technician's e-mail is verified and matches their Atelier account.
5. The technician accepts their Atelier invitation and signs in with their password once, then opens **Mon compte → Connexion SSO → Associer Keycloak**. Association requires the original Atelier session still to be valid and an explicit Keycloak login. Future logins can use **Se connecter avec Keycloak**. Matching e-mail alone never creates or links an account; realm roles never grant Atelier administrator rights.

The flow validates state, browser binding, nonce, PKCE, issuer, audience, expiration and ID-token signatures against Keycloak's JWKS. Pending verifiers are encrypted, expire after ten minutes and are single-use. Tokens are discarded after authentication; no refresh token is stored. Dissociation requires the local password. Logging out ends the Atelier session; it does not end the user's Keycloak realm session. Keycloak account suspension stops future SSO logins; remove Atelier membership or revoke Atelier sessions to terminate existing application access immediately.
