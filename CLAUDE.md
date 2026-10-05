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
| `./scripts/smoke.sh` (repo root) | End-to-end test in Docker, no AI and no API key |
| `./scripts/demo.sh` (repo root) | Local demo with three fake projects |
| `./scripts/diagrams.sh` (repo root) | Regenerate `docs/img/*.png` from `docs/diagrams/*.mmd` |

**Definition of done: `npm run check`, `npm test` and `./scripts/smoke.sh` are all green.** Never commit when one fails, and never skip hooks or checks to get a commit through.

## Commits

- **Language: English.**
- **Format: [Conventional Commits](https://www.conventionalcommits.org/)** — `type(scope): subject`.
  - `type`: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`.
  - `scope` (optional): the area touched, e.g. `auth`, `sessions`, `orgs`, `secrets`, `projects`, `pipeline`, `git`, `sandbox`, `proxy`, `ui`, `docs`, `scripts`.
  - Subject: imperative mood ("add", not "added"), lower case, no trailing period, 72 characters at most.
  - Body (when the change is not obvious): wrap at about 72 columns and explain **why**, not only what.
  - Breaking changes: `feat(scope)!:` and a `BREAKING CHANGE:` footer.
- **One commit per validated step.** Keep unrelated changes (code, docs, tooling) in separate commits.
- No force-push, no history rewriting once a branch is shared. The repository has no remote yet.

## Documentation

- `README.md` stays **short and in English**: pitch, one diagram, quick start, status, links. Detail belongs in `docs/` (architecture, security, multi-tenancy, configuration, deployment, testing, roadmap).
- Update the docs **in the same change** as the behavior they describe.
- Be honest about status. `docs/testing.md` lists what is *not* covered; do not claim something works if it was not exercised. The real Claude agent and real GitLab/GitHub calls have never been run.
- Diagrams are Mermaid sources in `docs/diagrams/`, rendered to `docs/img/` by `scripts/diagrams.sh`. Edit the source, regenerate, commit both.
- Existing source comments and some test titles are in French. Leave them unless you are rewriting that code anyway.

## Rules that protect the security model

These are the project's reason to exist. Do not weaken them.

1. **The sandbox never receives a secret.** No git token, no API key, no environment variable that could carry one. The model key reaches it only through the proxy.
2. **Secrets are never returned or logged.** The API exposes a label and a 4-character hint. Queries that list secrets must not select the ciphertext.
3. **Organization data is always scoped.** Read it through `…InOrg(id, orgId)` helpers and authorize with `access()`/`can()` in `access.ts`. Never fetch an organization's resource by id alone. A non-member gets **404**, an insufficient role gets **403**.
4. **Every new route that touches organization data comes with an isolation test** in the style of `isolation.test.ts`.
5. **The orchestrator never executes anything the agent wrote** in its own process. Git runs with explicit `--git-dir/--work-tree`, hooks disabled, `.git` kept outside the mounted directory.
6. **Validate every API input as hostile**, as `projects.ts` does (https-only repositories, no credentials in URLs, branch names that cannot be git options, allowlists for enums).
7. **Do not add a production dependency** to the orchestrator without a strong reason; it currently has none.

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
- The roadmap and the remaining multi-tenancy steps (U5 per-organization model keys, U6 invitations and management UI) are in `docs/roadmap.md` and `docs/multi-tenancy.md`.
