# Embedded code editor

**Status:** phases 1 and 2 (workspaces, files, diff, check, commit, merge request — API only) have shipped; the interface and the integration with tasks are still to build.

Atelier lets people change software by talking to an agent. Some people — and some changes — want the opposite: open a file, fix a sentence or a colour by hand, and propose it for review without installing anything. This page designs an **editor in the browser** (a small VS Code) that edits a project's code and commits it, under the same review rules as the agent.

## What it is, and what it is not

| It is | It is not |
|---|---|
| A file tree, tabs, a Monaco editor (the engine of VS Code), a diff view, a commit box | A terminal, or a place to run arbitrary commands |
| Editing on a **branch**, committing and opening a merge/pull request | Editing production, or pushing to the base branch |
| Able to run the project's **check** (the same sandboxed, network-less command the agent uses) | A live preview server (possible later; it needs its own isolation story) |

The rule that does not change: **a human or an agent proposes, a human reviews and merges.** The editor never merges.

## Decisions

| Topic | Choice | Why |
|---|---|---|
| Editor component | **Monaco**, bundled with the app (workers included), no CDN | It is the VS Code editor: syntax highlighting, search, multi-cursor, a diff editor. Self-hosted keeps the strict CSP (`worker-src 'self' blob:` is the one addition) and works offline |
| Where files live | A **server-side workspace per editing session**: a clone of the project in a directory the browser never sees directly | The git token must stay on the server; the browser edits through an API |
| Unit of work | A **session** = one branch (`atelier/edit-<id>` from the base branch, or an existing task branch) | Maps to a merge request; easy to discard |
| Saving | Each save writes to the workspace (a *draft*, nothing leaves the server). **Commit** stages the changes, commits and pushes the branch | People can save often without making noise in git |
| Who | `member` and above (same as launching a task); viewers read nothing here | An edit is as powerful as a task, so it needs the same role |
| Protected paths | Touching one is allowed but flagged: the merge request is titled `[REVUE REQUISE]` exactly as for the agent | One policy for humans and agents |
| Authorship | Commit author is the person (profile name and account address); the committer is the platform | Git history says who changed what |
| Editing an agent proposal | Open a session **on a task's branch**, refused while that task is running | Lets a person polish the agent's work; a later follow-up turn clones the updated branch |

## Threat model

The browser sends paths and contents. Everything is hostile until checked.

| Risk | Control |
|---|---|
| **Path traversal** (`../`, absolute paths, encoded separators) | Every path is resolved against the workspace root and must stay inside it; `.git` is never reachable; names with NUL, backslashes or `..` segments are refused |
| **Symlinks** pointing outside the workspace | Symlinks are never followed for reading or writing; they are shown as files that cannot be opened |
| **Hooks and git config in the workspace** | Same as the agent pipeline: the git directory lives outside the tree, hooks disabled, `fsmonitor` off, config only through environment variables |
| **Token exposure** | The git token is used by the orchestrator for fetch and push only, via environment, and scrubbed from errors. It is never in the workspace or any response |
| **Disk and memory abuse** | One open session per person and project, 3 per organization, 50 MB per workspace, 1 MB per file opened in the editor, 5,000 entries listed, sessions expire after 2 hours without activity and are deleted |
| **Binary and huge files** | Detected and not opened as text; the tree shows them as read-only |
| **Concurrent edits** (two people, or a person and the agent) | A session is private to its author; a task branch cannot be opened while the task runs; a push that would not fast-forward is refused with a clear message |
| **CSRF and cross-origin** | Same protections as every other `POST`: JSON body, same-origin check |
| **Audit** | `editor.open`, `editor.commit` (branch, files count, flagged), `editor.discard` are written to the audit log; file contents never are |

## API (all under `/api/orgs/:org`, all scoped by organization)

| Route | Purpose |
|---|---|
| `POST /editor/sessions` `{projectId, taskId?}` | Open (or resume) a session; clones the branch |
| `GET /editor/sessions/:id` | State: branch, base, changed files, check result, expiry |
| `GET /editor/sessions/:id/tree` | Directory listing (paged) |
| `GET /editor/sessions/:id/file?path=` | File contents (text only, 1 MB) |
| `PUT /editor/sessions/:id/file` `{path, content}` | Save a draft |
| `POST /editor/sessions/:id/files` `{op: create \| rename \| delete, …}` | File operations |
| `GET /editor/sessions/:id/diff` | Unified diff against the branch point |
| `POST /editor/sessions/:id/check` | Run the project check in the sandbox |
| `POST /editor/sessions/:id/commit` `{message}` | Commit and push; opens the merge request if none |
| `DELETE /editor/sessions/:id` | Discard the workspace |

## The interface

A full-width page `/o/:org/projects/:id/editor`: file tree on the left (with a filter), tabs and the editor in the middle, a bottom panel with **Changes** (diff per file), **Check** (output) and the commit box. Dirty tabs show a dot; `Cmd/Ctrl+S` saves, `Cmd/Ctrl+P` jumps to a file, `Cmd/Ctrl+Shift+F` searches the open workspace. A banner always says which branch you are on and that nothing is merged until someone reviews.

## Phases

1. ✅ **Workspaces and files**: session lifecycle, path safety, file API, limits, expiry, tests (traversal, symlinks, quotas, isolation between organizations).
2. ✅ **Commit, check, merge request**: diff, commit and push, the check in the sandbox, merge request creation, audit, tests on a real local repository.
3. **The editor**: Monaco bundled with workers and the CSP change, tree, tabs, diff panel, commit dialog, keyboard shortcuts, browser test.
4. **Integration**: edit a task's proposal, "open in editor" from a task and from the dashboard, documentation and screenshots.

## Limits to be honest about

- No terminal and no language server: highlighting yes, completions and type errors no (Monaco's built-in TypeScript/JSON help works only for those).
- The check runs the project's single command, like the agent's; there is no general "run" button.
- Isolation of the *editing* path is the orchestrator's code, not a container: it never executes the project's files, only reads and writes them. Executing them (check, later preview) always goes through the sandbox.
- Two people cannot edit the same session; they edit separate branches and the forge merges them.
