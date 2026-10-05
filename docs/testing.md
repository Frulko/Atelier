# Testing

Three commands. All three must be green before a commit.

| Command | Where | What it does | Needs |
|---|---|---|---|
| `npm run check` | `orchestrator/` | Type-checks the TypeScript (`tsc --noEmit`) | Node |
| `npm test` | `orchestrator/` | Unit and HTTP integration tests (`node --test`), in-memory database | Node |
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
| **The web UI in a real browser** (Playwright, `scripts/ui_check.py`): login with a wrong then right password, one screen at a time, a task run to "branch pushed", a secret that never reappears in the page, an invitation link opened by a second browser that joins as a member, single-use link, role change, two-click removal, logout, no console error | `smoke.sh` (skipped, with a notice, if Playwright is not installed) |
| Task list filters, pagination bounds, literal text search, timing, retry | `tasks-api.test.ts` |
| Audit log: what is recorded, who reads it, filters, CSV, **no secret ever in it** | `audit.test.ts` |
| Dashboard and usage statistics: exact totals, no gaps, windows, roles, isolation | `stats.test.ts` |
| Profile, active sessions and revocation, organization rename, delete cascade | `account-org.test.ts` |
| Project access check against a real git repository, secret usage, rotation | `secrets-ops.test.ts` |
| Invitation flow end to end (create, accept, reuse refused, new member's role and access) | `smoke.sh` |
| 401 without a session, login, CSRF (403), password change revoking other devices, logout | `smoke.sh` |
| Clone → sandbox → check → **fix loop** → commit → push → cleanup, with several projects | `smoke.sh` |

## What is *not* covered yet

- The **real Claude agent** inside the sandbox (proxy + SDK end to end). Only the fake agent runs in tests.
- A **real GitLab merge request** and a **real GitHub pull request**. Code exists; it has only run against local git repositories.
- Task **cancellation while an agent is running**.
- The UI only on **Chrome**, in light mode, at desktop width. Dark mode and phone width have not been looked at.
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
