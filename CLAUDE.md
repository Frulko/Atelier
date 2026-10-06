# CLAUDE.md

Guidance for AI assistants and contributors working on Atelier. Read [README.md](README.md) first, then [docs/architecture.md](docs/architecture.md).

## What this project is

Atelier lets non-developers change their software by chatting with an AI agent. The agent edits code in a disposable, secret-free Docker sandbox; the orchestrator verifies, pushes a branch and opens a merge/pull request for a human. The orchestrator (`orchestrator/`) is the only trusted component.

## Commands

Run from `orchestrator/` unless noted.

| Command | Purpose |
|---|---|
| `npm run check` | Type-check (`tsc --noEmit`) |
| `npm test` | Unit and HTTP integration tests (`node --test`) |
| `npm run check`, `npm test`, `npm run build` (in `web/`) | Type-check, unit-test and build the web application |
| `./scripts/smoke.sh` (repo root) | End-to-end test in Docker, no AI and no API key. Also drives the UI in a browser if Playwright is installed (`pip install playwright`) |
| `./scripts/demo.sh` (repo root) | Local demo with three fake projects |
| `python3 scripts/screenshots.py` (repo root) | Retake the README screenshots from a running demo, into `docs/img/*.jpg` |
| `./scripts/prod-test.sh` (repo root) | Build the images locally and check that `docker-compose.prod.yml` starts healthy |
| `./scripts/release.sh <repo> <version> [--push]` | Build (and publish, multi-arch) the orchestrator and sandbox images |
| `./scripts/diagrams.sh` (repo root) | Regenerate `docs/img/*.png` and `*.svg` from `docs/diagrams/*.html` |

**Definition of done: `npm run check`, `npm test` and `./scripts/smoke.sh` are all green — and, when `web/` changed, so are its `npm run check`, `npm test` and `npm run build`.** Never commit when one fails, and never skip hooks or checks to get a commit through.

## Commits

- **Language: English.**
- **Format: [Conventional Commits](https://www.conventionalcommits.org/)** — `type(scope): subject`.
  - `type`: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`.
  - `scope` (optional): the area touched, e.g. `auth`, `sessions`, `orgs`, `secrets`, `projects`, `pipeline`, `git`, `sandbox`, `proxy`, `ui`, `docs`, `scripts`.
  - Subject: imperative mood ("add", not "added"), lower case, no trailing period, 72 characters at most.
  - Body (when the change is not obvious): wrap at about 72 columns and explain **why**, not only what.
  - Breaking changes: `feat(scope)!:` and a `BREAKING CHANGE:` footer.
- **One commit per validated step.** Keep unrelated changes (code, docs, tooling) in separate commits.
- No force-push, no history rewriting once a branch is shared.
- **CI/CD** is `.github/workflows/pipeline.yml` (checks, smoke, production stack, multi-arch images on ghcr.io, release on `vX.Y.Z` tags). Keep it in step with the definition of done: anything you add to `smoke.sh` or `prod-test.sh` runs there.

## Documentation

- `README.md` stays **short and in English**: pitch, one diagram, quick start, status, links. Detail belongs in `docs/` (architecture, security, multi-tenancy, configuration, deployment, testing, roadmap).
- Update the docs **in the same change** as the behavior they describe.
- Be honest about status. `docs/testing.md` lists what is *not* covered; do not claim something works if it was not exercised. The real Claude agent and real GitLab/GitHub calls have never been run.
- Diagrams are diagram-design HTML/SVG sources in `docs/diagrams/`, rendered to `docs/img/` by `scripts/diagrams.sh`. Edit the source, regenerate, commit both.
- Existing source comments and some test titles are in French. Leave them unless you are rewriting that code anyway.

## Rules that protect the security model

These are the project's reason to exist. Do not weaken them.

1. **The sandbox never receives a secret.** No git token, no API key, no environment variable that could carry one. The model key reaches it only through the proxy.
2. **Secrets are never returned or logged.** The API exposes a label and a 4-character hint. Queries that list secrets must not select the ciphertext.
3. **Organization data is always scoped.** Read it through `…InOrg(id, orgId)` helpers and authorize with `access()`/`can()` in `access.ts`. Never fetch an organization's resource by id alone. A non-member gets **404**, an insufficient role gets **403**.
4. **Every new route that touches organization data comes with an isolation test** in the style of `isolation.test.ts`.
5. **The orchestrator never executes anything the agent wrote** in its own process. Git runs with explicit `--git-dir/--work-tree`, hooks disabled, `.git` kept outside the mounted directory.
6. **Validate every API input as hostile**, as `projects.ts` does (https-only repositories, no credentials in URLs, branch names that cannot be git options, allowlists for enums).
7. **Do not add a production dependency** to the orchestrator without a strong reason. The one deliberate exception is the Vercel AI SDK family (`ai`, `@ai-sdk/*`, `zod`) behind the discussion assistant; keep it confined to `chat.ts`.
8. **Discussions are private to their author** (even admins get a 404); task conversations are visible to the organization. Never trust a browser-sent history: the server's stored messages are the truth. Treat attachments as hostile (`attachments.ts`).
9. **Anything the server fetches from an address a user typed** (health checks) goes through `health.ts`: link-local always refused, private only with `ATELIER_HEALTH_ALLOW_PRIVATE`, checked at connection time, no redirects, no bodies kept.
12. **The repository's AI files are read only through `AI_FILE` (`git.ts`)**: an allow-list of paths, member-only, never a free path.
11. **The editor never leaves its tree**: every path goes through `safeRel` and `resolveIn` in `editor.ts` (no `..`, no `.git`, symlinks never followed); a session is private to its author; a push is never forced. The entry page carries a per-response CSP nonce for styles (Monaco): never add `unsafe-inline`.
10. **Knowledge is data, not authority**: it is given to the assistant and the agent as context and must never be able to grant a power.

## Web application (`web/`)

- One folder per page in `src/features/<area>/`; shared pieces in `src/components/{ui,layout,charts}` and `src/lib`. Server data goes through TanStack Query (`src/lib/queries.ts`), never ad-hoc `fetch` in a component.
- UI text is French. The server's error messages are already French and are shown as they are.
- Never put a secret in the DOM, a URL or `localStorage`. Role helpers (`src/lib/roles.ts`) only hide or grey out; the server authorizes.
- Colours come from the CSS variables in `src/styles.css`; do not hard-code colours in components, so both themes keep working. Respect `prefers-reduced-motion`.
- Link and redirect targets are typed by the router: a new page means a route in `src/router.tsx` (with an `adminOnly` guard when it is admin-only), a nav entry, and a step in `scripts/ui_check.py`.
- `src/components/ai-elements/` and `src/components/shadcn/` are **vendored** (Vercel AI Elements and shadcn primitives, installed with the shadcn CLI): prefer wrapping them over editing them, and keep their imports on the `@/` alias. Five unused AI Elements files are excluded from type-checking in `tsconfig.json`. Their shadcn colour names are mapped to our variables in `styles.css` (`bg-muted`/`bg-accent` were renamed to `bg-subtle`/`bg-hover` because our `accent` is the brand orange).
- The guided tour targets `data-tour="…"` attributes; when you move or rename a navigation item, keep its attribute. Tests disable the tour with `localStorage atelier.tour.disabled`.
- The orchestrator serves `web/dist`; the Docker image builds it. Nothing from `web/` runs on the server.

## Code conventions

- TypeScript runs directly on Node 24 (type stripping), so **erasable syntax only**: no `enum`, no namespaces, no constructor parameter properties. `tsc` enforces it (`erasableSyntaxOnly`).
- Import local modules with their `.ts` extension.
- Prefer the smallest change that works. Mark deliberate shortcuts with a `ponytail:` comment that names the ceiling and the upgrade path.
- Configuration is read at import time (`config.ts`): in tests, set environment variables **before** dynamically importing modules.
- Tests must not need Docker or the Internet; put anything that does in `scripts/smoke.sh`.
- Shell scripts: build JSON bodies in a variable (`BODY=…; -d "$BODY"`) rather than nesting quotes inside `$(…)`.

## Things to know

- `ATELIER_FAKE_AGENT=1` switches the sandbox to a deterministic fake agent; a request containing "casse" makes the check fail once to exercise the fix loop.
- Docker Desktop on macOS: `ATELIER_WORKDIR` must be a path Docker can share (under the user's home) and identical on the host and in the container.
- A task is also a conversation: `startTask` (`start.ts`) is the single entry point that creates both, and `followUp` runs a new agent turn on the task's branch. The pipeline refuses to run a task that is not `queued`.
- The embedded code editor is designed in `docs/editor-design.md` and not built yet. The roadmap is in `docs/roadmap.md`.
