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

**Two-agent split.** The *discussion agent* (`src/agents/discussion.ts`) is a `createAgent` tool-calling loop from the `langchain` package. It talks to the user and routes every request through tools: `search_documents`, `list_recent_documents`, `open_document`, `create_content`, `revise_document`. It never writes copy itself. The *writer agent* (`src/agents/writer.ts`) is not a tool loop. It is a single prompted call to `WRITER_MODEL` with craft rules and per-content-type format guidance, and it returns Markdown. `create_content` and `revise_document` call the writer and persist the result.

**Tool → UI side channel.** Tools record which document the UI should display in a per-request `TurnState` object (closure in `buildTools`), not in the model's reply. `/api/chat` returns `{ reply, documentId }`, and the page opens `documentId` and refreshes the history list. Any new tool that produces or selects a document must set `state.documentId`.

**Active document.** The client sends `activeDocumentId` with each chat message. The server appends it to the *current user message* (not the system prompt) so that "make it shorter" resolves to `revise_document` on the open document.

**Designed for small local models.** Both agents default to `qwen3:8b`, one model loaded once, so a writer handoff doesn't trigger a model swap. The discussion agent sets `think: false` (thinking made routing turns take ~40s instead of ~4s). The writer also defaults to thinking off (`WRITER_THINK`): in side-by-side tests thinking was 2–3x slower with no fewer invented facts. Compared with `llama3.1`, Qwen3 routes better and follows the writer's style rules (sentence length, reading level, placeholders instead of invented testimonials) far more closely. Several choices exist because 8B models misbehave:
- `textToolCalls.ts` middleware converts tool calls that Llama writes as JSON text into real tool calls. This matters only if the discussion model is switched back to Llama.
- Tool schemas are lenient: `keywords` is a comma-separated string, numbers use `z.coerce`, and ids are plain strings. `getDocument` returns null for non-UUIDs instead of letting Postgres throw.
- Tool return strings tell the model what to do next ("Tell the user…", "Call search_documents…").
- `search_documents` auto-opens a single match instead of letting the model ask for confirmation.
- The discussion agent supplies the document `title`; the writer's output is not parsed for a title.
- Both models share one `numCtx` (`models.ts`). If they run the same model with different context sizes, Ollama reloads it on every handoff, which crashed Ollama on a 16 GB machine.

Before changing prompts, tool schemas, or `DISCUSSION_MODEL`, re-run the curl flows above (find with one match, find with none, revise with `activeDocumentId`, create, list, vague request), because routing regressions are easy to introduce.

**Writer prompt.** The owner edits the writer's `SYSTEM_PROMPT` directly. Keep their wording, and show the prompt when proposing changes to it. It includes an example passage that sets the voice.

**Data** (`src/db/schema.ts`): `documents` (content stored as Markdown, plus the original `brief` so revisions stay on-brief), `document_revisions` (snapshot of prior content taken before each revise), and `chat_messages` (a single global thread; the last 20 messages are fed back as history). Search is Postgres full-text (`websearch_to_tsquery`) with an `ilike` fallback. pgvector is available locally if semantic search is added later (`nomic-embed-text` is pulled in Ollama).

**Performance.** Model calls are non-streaming, so a request blocks until the writer finishes (~25s for create/revise; about 4s for find/open). Larger writer models such as `gemma4:26b` fall back to CPU on 16 GB of RAM and take many minutes.
