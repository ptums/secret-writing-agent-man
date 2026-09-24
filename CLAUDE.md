# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## What this is

A local writing studio for marketing content (blog posts, landing pages, emails, ads, social). Two LangChain agents run against local Ollama models; documents and chat history live in Postgres. The UI is a single page with three columns: document history (25%), reading pane (50%), and chat with the discussion agent (25%).

## Commands

```bash
npm run dev          # Next.js dev server on :3000 (requires Ollama + Postgres running)
npm run typecheck    # next typegen && tsc --noEmit — typegen is required for RouteContext/LayoutProps types
npm run lint
npx prettier --write <files>  # .prettierrc: printWidth 120
npm run db:generate  # generate a SQL migration in drizzle/ after editing src/db/schema.ts
npm run db:migrate   # apply migrations
npm run db:studio    # browse the database
```

There is no test suite. To exercise the agents without the UI, POST to the chat route:

```bash
curl -s -X POST localhost:3000/api/chat -H 'content-type: application/json' \
  -d '{"message":"Write a launch email for ...","activeDocumentId":null}'
```

Config comes from `.env.local` (see `.env.example`): `DATABASE_URL`, `OLLAMA_BASE_URL`, `DISCUSSION_MODEL`, `WRITER_MODEL`.

## Architecture

**Three agents.** The *discussion agent* (`src/agents/discussion.ts`) is a `createAgent` tool-calling loop from the `langchain` package. It talks to the user and routes every request through tools. It never writes copy. The *writer* (`src/agents/writer.ts`) only writes first drafts: one prompted call with the user's house-style `SYSTEM_PROMPT` and per-type `FORMAT_GUIDANCE`. The *editor* (`src/agents/editor.ts`) reviews every draft (`editDraft`) and makes every rewrite (`reviseAndEdit`, which rewrites with the writer's `SYSTEM_PROMPT` and then runs `editDraft`). Exact edits (`edit_text`) skip the editor, because the user's own words are final. The user chose silent review: editor findings are never shown, only the resulting document (and the usual "What changed" diff for revisions).

**Editor loop** (`editDraft`). Round 1 runs the full review; round 2 only runs if the code checks still flag something. An open-ended second review mostly restyled copy that had already passed, and in one test it deleted a correct feature line. The code checks (`editorChecks.ts`) look for: long sentences, reading grade ≥ 10, banned filler, specifics (prices, %, counts with units, weekdays) missing from brief/sources/instructions, goal numbers from the PRD stated as results, mentions of out-of-scope items, removed text returning, kept lines missing, preambles, and literal "Hero"-style headings. Then a structured-output model review (`EDITOR_CRITERIA`) returns `{quote, problem, replacement}` fixes, applied with `applyEdit`, never a full rewrite. Code rejects fixes that contain HTML, introduce unsupported specifics, or delete a real heading; in testing the model did all three. Any unsupported specific, or PRD goal stated as a result, that survives becomes a visible `[confirm: …]` placeholder. `readSourceRules` pulls goal numbers and out-of-scope items from the PRD's section headings, including numbered ones like "4. Success Metric" and non-goals written as a sentence. Change it carefully and re-run it on a real PRD.
**Tool → UI side channel.** Tools record which document the UI should display in a per-request `TurnState` object (closure in `buildTools`), not in the model's reply. `/api/chat` returns `{ reply, documentId }`, and the page opens `documentId` and refreshes the history list. Any new tool that produces or selects a document must set `state.documentId`.

**Every chat belongs to a document.** `chat_messages.thread_id` (NOT NULL) is the document the conversation belongs to. The open document *is* the thread: the client sends it as `activeDocumentId`, and the agent sees only that thread's history (last 20 messages; long ones truncated) and that document's source material, so PRDs from different documents never mix. On load, the UI opens the most recently updated document. Typing with no document open, or pressing "+", creates a blank one (`createBlankDocument`). The first `create_content` in a thread fills the blank document in place (`fillDocument`). Later ones create a new document, copy the source material onto it, and seed its thread with a "Created from …" message. The server appends a note about the thread's document to the *current user message* (not the system prompt). Messages with role `event` are notices for the user (e.g. "Read Google Doc …") and are not sent to the model.

**Source material** (`src/lib/sources.ts`, attached in `/api/chat` before the agent runs) is stored on `documents.source_material` as labeled `===== SOURCE key | label =====` sections. Google Doc links in a message are fetched in code via the public export endpoint (`/export?format=md`, falling back to `txt`), which works only for docs shared as "Anyone with the link". Private docs come back as an HTML sign-in page and are reported to the user. A re-fetched doc replaces its old section. Whatever remains of the message after removing links, if 400+ characters, is saved as a "pasted" section. Fetching happens in code rather than through a tool because small models are unreliable at deciding to call one. Each source is capped at 40k characters to fit the writer's 16k-token context.

**Three ways a document changes**, each recorded in `document_revisions` with a `kind`:
- `edit`: the `edit_text` tool does an exact find/replace **in code** (`src/lib/textEdit.ts`). It's used whenever the user quotes text. Matching tolerates what copying from the rendered reader changes: curly vs straight quotes, dashes, line breaks, and Markdown markers. It refuses to guess when a quote matches twice. It's instant and touches nothing else, so prefer it over rewrites.
- `revise`: the editor rewrites, with `scope` `whole` (tone/length/focus) or `part`, inferred by `inferScope` if the model omits it. Each rewrite gets **standing guidance** from earlier revisions: past feedback, text the user wrote via exact edits (keep verbatim), and text they removed (don't bring back).
- `manual`: the user's own edit in the reader.

After every change the server diffs the before and after versions (`src/lib/changes.ts`) and posts a "What changed:" event (red/green in the chat). The reader flashes the added lines. The agent's own description of a change isn't trusted.

**Rewrite echo problem.** When `qwen3:8b` is asked to rewrite a document, it often returns it unchanged. Measured causes: the writer's house-style `SYSTEM_PROMPT` as the system prompt (8/8 echoed, since the text already matches it and reads as done), a long source such as an 11k-character PRD in the prompt (4/4), and "keep every other sentence exactly" on whole-document requests. So `reviseAndEdit` uses a plain prompt with no system message, the document first and the instruction last, and sends the source only for `part` rewrites. It retries once, then for `whole` rewrites falls back to `rewriteBySection`. `isMalformed` rejects rewrites that duplicate sections (seen: 10 headings from 5). After this, 6/6 test rewrites changed the document. Re-measure before changing any of it.

**Turn guards** in `discussion.ts`: after any change, a further `revise_document` in the same turn is refused (the model used to invent extra rewrites from the brief right after an exact edit). Two failed `edit_text` attempts make it stop and ask the user. Graph recursion errors get a friendly reply.

Pasted text that is mostly a quote of the document (`isQuoteOf`, e.g. "drop this: <passage>") is **not** saved as source material.

**Designed for small local models.** Both agents default to `qwen3:8b`, one model loaded once, so a writer handoff doesn't trigger a model swap. The discussion agent sets `think: false` (thinking made routing turns take ~40s instead of ~4s). The writer also defaults to thinking off (`WRITER_THINK`): in side-by-side tests thinking was 2–3x slower with no fewer invented facts. Compared with `llama3.1`, Qwen3 routes better and follows the writer's style rules (sentence length, reading level, placeholders instead of invented testimonials) far more closely. Several choices exist because 8B models misbehave:
- `textToolCalls.ts` middleware converts tool calls that Llama writes as JSON text into real tool calls. This matters only if the discussion model is switched back to Llama.
- Tool schemas are lenient: `keywords` is a comma-separated string, numbers use `z.coerce`, and ids are plain strings. `getDocument` returns null for non-UUIDs instead of letting Postgres throw.
- Tool return strings tell the model what to do next ("Tell the user…", "Call search_documents…").
- `search_documents` auto-opens a single match instead of letting the model ask for confirmation.
- The discussion agent supplies the document `title`; the writer's output is not parsed for a title.
- Both models share one `numCtx` (`models.ts`). If they run the same model with different context sizes, Ollama reloads it on every handoff, which crashed Ollama on a 16 GB machine.

**Never run write tests against the `writer_agent` database.** It holds the owner's real work, and they use the app while you're working. Only one `next dev` can run per project folder, so for tests clone the project (`cp -c -R`, excluding `.next`/`.git`) to a scratch folder, point its `.env.local` at `writer_agent_test` (run `DATABASE_URL=… npx drizzle-kit migrate` there first), and run `next dev -p 3001`. After adding a migration, apply it to the real DB promptly with `npm run db:migrate`: the running dev server hot-reloads code that expects the new schema.

Before changing prompts, tool schemas, or `DISCUSSION_MODEL`, re-run the curl flows above (find with one match, find with none, revise with `activeDocumentId`, create, list, vague request), because routing regressions are easy to introduce.

**Writer prompt.** The owner edits the writer's `SYSTEM_PROMPT` directly. Keep their wording, and show the prompt when proposing changes to it. It includes an example passage that sets the voice.

**Data** (`src/db/schema.ts`): `documents` (content stored as Markdown, plus the original `brief` so revisions stay on-brief), `document_revisions` (snapshot of prior content taken before each revise), and `chat_messages` (a single global thread; the last 20 messages are fed back as history). Search is Postgres full-text (`websearch_to_tsquery`) with an `ilike` fallback. pgvector is available locally if semantic search is added later (`nomic-embed-text` is pulled in Ollama).

**Performance.** Model calls are non-streaming, so a request blocks until the writer finishes (~25s for create/revise; about 4s for find/open). Larger writer models such as `gemma4:26b` fall back to CPU on 16 GB of RAM and take many minutes.
