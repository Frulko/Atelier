# Testing

Three commands. All three must be green before a commit.

| Command | Where | What it does | Needs |
|---|---|---|---|
| `npm run check` | `orchestrator/` | Type-checks the TypeScript (`tsc --noEmit`) | Node |
| `npm test` | `orchestrator/` | Unit and HTTP integration tests (`node --test`), in-memory database | Node |
| `npm run check` · `npm test` · `npm run build` | `web/` | Type-checks, runs the unit tests (formatting, roles, wording) and builds the web application | Node |
| `./scripts/prod-test.sh` | repo root | Starts `docker-compose.prod.yml` with locally built images and checks it becomes healthy, serves the app and accepts the first sign-in | Docker |
| `./scripts/smoke.sh` | repo root | End-to-end test of the whole stack in Docker, **no AI, no API key**. Also drives the web UI in a browser when Playwright is installed | Docker (+ `pip install playwright` and Chrome for the UI part) |

## What is covered

| Area | Covered by |
|---|---|
| Password hashing (correct/wrong, salts, hostile or corrupt hashes, length limits) | `auth.test.ts` |
| First owner account created once, with its organization | `auth.test.ts` |
| Sessions: stored hashed, expiry, sliding renewal, logout, revoking other devices, cookie attributes | `session.test.ts` |
| Login rate limiter | `session.test.ts`, `smoke.sh` (429 after 5 failures) |
| **Isolation between organizations**: 404 on every foreign resource (list, task, stream, cancel, create), forged ids refused | `isolation.test.ts` (real HTTP server, five users, two organizations) |
| Roles: viewer / member / admin permissions, cancel own vs anyone's | `isolation.test.ts` |
| Secrets API: value never returned, ciphertext not in the database, roles, cross-organization references refused | `resources.test.ts` |
| Projects API: hostile repositories refused, duplicate slug, delete rules | `resources.test.ts`, `projects.test.ts` |
| Vault: round trip, tampering, ciphertext moved to another organization or secret, master key file | `vault.test.ts` |
| One-time import of the legacy configuration | `legacy-import.test.ts` |
| Model proxy against a fake provider: missing/wrong/revoked token, each organization's own key, no global fallback, 402 over budget, allowed routes only | `proxy.test.ts` |
| Budget: month boundaries, per-organization spend, cap semantics, API roles, task creation refused when over budget | `budget.test.ts` |
| Organizations, members, invitations: privilege escalation, single-use and expiry, hashed token, address match, last owner, cross-organization isolation | `members.test.ts` |
| Static serving: files, SPA fallback, **no way out of the public folder** (`../`, encoded, null byte), security headers on every response, no-store API | `static.test.ts` |
| **The whole web application in a real browser** (Playwright, `scripts/ui_check.py`): sign-in, a task run to "branch pushed" and retried, filters kept in the URL, project creation, access check and deletion, a secret that never reappears in the page, an invitation opened by a second browser that joins as a member and cannot reach admin pages, role change, removal, budget, audit filters and CSV export, organization rename, profile, theme, a phone-sized menu with no horizontal scroll, sign-out; **a streamed discussion with sources and an attached file, a task turned into a thread with a follow-up that updates the same branch, the dashboard's health and last commit, the welcome tour (keyboard, remembered), the guided first steps with prefilled text** | `smoke.sh` (skipped, with a notice, if Playwright is not installed) |
| Discuss mode with the **fake model**: stream format, persisted answer with sources and tokens, knowledge selection, server-held history, regenerate, **privacy of discussions even from admins**, limits (empty, long, rate, budget), attachments (type, size, count, magic bytes, fence escaping, no remote URL), organization chat settings | `chat-fake.test.ts` |
| The assistant with the **real Anthropic client** against a local fake provider: each organization's own key, the chosen model, the system prompt with that organization's knowledge only, history sent on the next turn, an image attachment sent as an image, token usage taken from the provider, 401 and 429 turned into clear French messages with **no raw provider text or key in the answer or the logs**, no call at all when the key is missing | `chat-provider.test.ts` |
| Knowledge selection and validation: budget, pinning, relevance with accents, project scope, oversized items skipped | `knowledge.test.ts` |
| Follow-up turns: rules (only done tasks, turn cap, author or admin), failure leaves the proposal intact, budget | `followup.test.ts` (the real extra turn on the same branch is in `smoke.sh`) |
| Project AI configuration: validated and clearable settings (admin only), instructions given to the assistant's prompt and the agent's settings, the repository's AI files read from a real git repo through an **allow-list** (traversal, deeper paths, other files refused; viewers and other organizations refused), the editor creating missing parent folders safely | `ai-config.test.ts`; the agent receiving the instructions end to end in `smoke.sh` |
| Project status: health (ok, 5xx, redirect not followed, timeout, refused), **SSRF guards** (metadata and link-local always refused, private only when allowed, literal IPs), last commit read from a real git repository, uptime and retention, isolation, rate limit | `status.test.ts`, `health-private.test.ts` |
| Editor sessions and files: hostile paths (`..`, absolute, `.git`, backslash, NUL), **symlinks never followed** (a planted link to a host file cannot be read, written or traversed), binary and oversized files, workspace quota, privacy (even admins get 404), role, per-organization limit, expiry and orphan cleanup, opening a real task branch, **diff and commit on a real repository** (author is the person, platform is the committer, `main` untouched, protected paths flagged, a branch that moved elsewhere is refused and never forced, task proposals accumulate files), no file content in the audit log, quick open (subsequence match, links and `.git` skipped, capped) | `editor.test.ts`; the sandboxed check and a commit end to end in `smoke.sh`, and the whole editor in a real browser (open a file, type, autosave, diff, check, commit, abandon) in `ui_check.py` |
| Startup with no projects (Compose passes an empty `PROJECTS_JSON`), invalid and valid project lists | `config-env.test.ts` |
| The production stack from built images: healthy, serves the app, first sign-in | `prod-test.sh` (also a CI stage) |
| Task list filters, pagination bounds, literal text search, timing, retry | `tasks-api.test.ts` |
| Audit log: what is recorded, who reads it, filters, CSV, **no secret ever in it** | `audit.test.ts` |
| Dashboard and usage statistics: exact totals, no gaps, windows, roles, isolation | `stats.test.ts` |
| Profile, active sessions and revocation, organization rename, delete cascade | `account-org.test.ts` |
| Project access check against a real git repository, secret usage, rotation | `secrets-ops.test.ts` |
| Invitation flow end to end (create, accept, reuse refused, new member's role and access) | `smoke.sh` |
| 401 without a session, login, CSRF (403), password change revoking other devices, logout | `smoke.sh` |
| Clone → sandbox → check → **fix loop** → commit → push → cleanup, with several projects | `smoke.sh` |

## What is *not* covered yet

- A **real model provider** (Anthropic, OpenAI, OpenRouter) behind the discussion assistant: the request the SDK sends is checked against a local fake, but no real provider has answered, and whether a given model accepts images or PDFs is untested. OpenAI and OpenRouter are wired the same way and not exercised separately.
- That the **real Claude agent** loads the repository's `CLAUDE.md`, rules and skills (it is configured to read project settings, but only the fake agent has run).
- **Deployment information from a real GitLab or GitHub** (the forge calls exist but have never run).

- The **real Claude agent** inside the sandbox (proxy + SDK end to end). Only the fake agent runs in tests.
- A **real GitLab merge request** and a **real GitHub pull request**. Code exists; it has only run against local git repositories.
- Task **cancellation while an agent is running**.
- The UI on **Firefox and Safari**: the browser test runs Chrome only. Dark mode is toggled and a phone-sized layout is exercised, but not compared pixel by pixel.
- Docker-level isolation guarantees (resource limits, dropped capabilities) are configured but not asserted.

## The fake agent and the fake projects

To test without any AI, the sandbox can run a **deterministic fake agent** (`ATELIER_FAKE_AGENT=1`), and `fixtures/projects/` holds three small projects turned into local bare git repositories by `scripts/fixtures.sh`.

| Request contains | The fake agent… | You observe |
|---|---|---|
| anything | appends a line to `NOTES.md` | task finishes, branch `atelier/<id>` pushed |
| **"casse"** | also writes an invalid file | the check fails, the agent is re-run with the error, removes the file, the task finishes (fix loop) |

`./scripts/demo.sh` starts this setup for you to click through. To keep screenshots of the UI during the smoke test, set `UI_SHOTS=/some/dir`.

## Writing tests

- Every new route that touches organization data needs an **isolation test** in the style of `isolation.test.ts`.
- Tests must not need Docker or Internet access; use the in-memory database (`DB_FILE=:memory:`). Anything that needs Docker belongs in `smoke.sh`.
- Set the environment variables *before* dynamically importing the modules: configuration is read at import time.
