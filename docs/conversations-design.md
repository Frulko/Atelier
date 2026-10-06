# Conversations, knowledge and the guided tour

**Status:** phases 1 to 4 have shipped (knowledge, discussions with attachments, tasks as conversations, tour and guide); phase 5 is this documentation. The assistant's provider and model are set on the Organisation page, and the usage page shows chat tokens.

Until now a *task* was a form: you wrote a request, then watched a log. This design makes the **conversation window** the centre of the product, adds a **knowledge base** that both the assistant and the agent read, and adds a **guided tour** that walks a newcomer through a realistic use case.

## One window, two modes

| | **Discuss** | **Task** |
|---|---|---|
| Who answers | A language model, through the provider and key of the organization | The agent, in a disposable sandbox, on a copy of the project |
| What it can do | Answer, explain, draft, prepare a request. **It cannot change code.** | Change the code, run the project's check, push a branch, open the merge/pull request |
| What it knows | The project's settings and the organization's **knowledge** | The repository itself, plus the same **knowledge** |
| Follow-up messages | Continue the discussion | Ask for adjustments: a new agent turn **on the same branch**, so the open merge request updates |
| Streaming | The AI SDK stream (token by token) | The agent's journal, live (steps, tool calls, check failures, the result) |
| Cost | Tokens, recorded per message | Cost reported by the agent, recorded per task |

Both are the same thing to the person using them: a thread with a composer at the bottom. A discussion can be **promoted to a task** ("Launch this as a task"); a task can be followed up in plain words.

## Decisions

| Topic | Choice | Why |
|---|---|---|
| Chat SDK | **Vercel AI SDK** (`ai` 7 on the server, `@ai-sdk/react` `useChat` in the browser) | Mature, provider-agnostic (Anthropic, OpenAI, OpenRouter behind one API), and `useChat` handles streaming, stopping, retrying and message state. TanStack AI is the other candidate; it is younger, and the AI SDK's stream protocol is documented and stable |
| Server dependency | The orchestrator gains **`ai` and the provider packages** — an explicit, bounded exception to "no runtime dependency" | The user-facing feature needs a provider client; writing and maintaining three streaming protocols by hand would be worse |
| Where the model is called | **From the orchestrator**, not from the sandbox | Discussion needs no sandbox. The key is read from the vault at the moment of use and never leaves the server |
| Provider and model | Per organization (`chat_provider`, `chat_model`), default Anthropic and Claude Sonnet | Multi-provider by configuration; admins change it on the Organization page |
| Message storage | **UI-message shape** (the AI SDK's `parts`) | The browser hydrates `useChat` directly from history |
| Task thread | The user's messages come from `messages`; the agent's side comes from the existing events, grouped by turn | No second copy of the journal; the existing live stream keeps working |
| Knowledge retrieval | Markdown items, organization-wide or per project; **everything enabled is included while it fits a budget, otherwise ranked by relevance** | Predictable and explainable; embeddings can come later if volume demands |
| No AI in tests and demo | With `ATELIER_FAKE_AGENT=1` the assistant is a deterministic fake model | Same principle as the fake agent: tests and demo cost nothing |

## Knowledge

A knowledge item is a short markdown document: *"Brand voice and colours"*, *"How VAT is computed"*, *"Release rules"*.

- **Scope:** the whole organization, or one project.
- **Fields:** title, content (12,000 characters at most), enabled, pinned. 200 items per organization.
- **Who:** admins write; every member can read, so everyone knows what the assistant has been told.
- **Selection:** for a request, take the items of the organization and of the project that are enabled. If they fit in the budget (24,000 characters) all are used. Otherwise pinned items go first, then the others by how many of the request's words they contain, then by recency, until the budget is full.
- **Transparency:** each assistant message records which items were used and the interface shows them as *Sources*. For a task, the agent's journal says which were given.
- **Trust:** knowledge is written by admins and handed to the model as context. It is data, not instructions to the platform; it cannot grant the agent any power (the sandbox has none to give).

## The tour and the guide

A newcomer should never face an empty screen wondering what to do.

1. **Welcome tour** (first sign-in, replayable): a short spotlight tour of the real interface — the organization switcher, the navigation, the conversation composer, the knowledge base, the journal — each step one sentence on what it is for. Skippable, keyboard-friendly, remembered per person.
2. **Guided use case** ("Premiers pas"): a checklist that follows one concrete story — *a bakery wants a contact page on its website* — and takes the person by the hand through it: add a knowledge item (the site's tone and colours), ask the assistant a question and see it use that knowledge, launch the task, read the proposal, ask for an adjustment, open the merge request. Each step explains **why**, offers a button that goes there (and prefills the text), and ticks itself off from real data. It runs end to end in the demo.
3. **Guide page**: the same story in prose, plus how the loop works (diagram), what the agent can and cannot do, roles, a glossary and a short FAQ.

## Phases

1. **Knowledge**: table, API, selection and tests; the Knowledge page.
2. **Conversations (discuss mode)**: tables, streaming endpoint with the AI SDK, organization chat settings, fake model, tests; the chat window.
3. **Tasks as conversations**: a thread per task, user messages, follow-up turns on the same branch; the unified window and the mode choice.
4. **Tour and guide**: the spotlight tour, the guided use case, the guide page.
5. **Checks and documentation**: the browser test covers each new flow; docs and screenshots updated.

## Limits to be honest about

- The discussion assistant cannot read the repository: for questions that need the code, use a task (the agent can read it).
- Chat consumption is tracked in tokens, not dollars, so the monthly budget (in dollars, from task costs) does not count it yet; it does stop new chats when the budget is already spent.
- Retrieval is lexical, not semantic.
- Attachments are limited to images, PDFs and text files (4 files, 4 MB each); they are stored in the database and depend on the provider accepting them.
