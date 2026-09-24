# Writer Agent

A private writing studio for marketing content: blog posts, landing pages, website copy, emails, ads, social posts, and campaign briefs. Everything runs locally: the models run on [Ollama](https://ollama.com), and every document is saved in Postgres.

## How it works

Three agents split the work:

- **Discussion agent.** Talks with you in the chat panel. It finds past documents, opens them, asks clarifying questions, and turns your request into a brief. It never writes copy itself.
- **Writer agent.** Writes first drafts from the brief and your sources (PRDs, Google Docs), following the house style in `src/agents/writer.ts`.
- **Editor agent.** Reviews every draft and makes every revision. It checks facts against your sources, voice, the request, and clean output (`EDITOR_CRITERIA` in `src/agents/editor.ts`). It fixes what fails before you see it. Only work that passes review reaches the reader.

Ask for something new and the discussion agent sends it through the writer and then the editor. With a document open, ask for changes ("make it shorter", "add a P.S.") and the editor revises it in place. Quoted text ("replace X with Y", "drop this") is changed exactly and instantly. Every earlier version is saved.

The interface has three columns:

| Documents (25%) | Reader (50%) | Chat (25%) |
|---|---|---|
| History and search of everything written | The open document, typeset for reading | Conversation with the discussion agent |

## Stack

- Next.js (App Router) + TypeScript + Tailwind CSS
- LangChain.js (`langchain` `createAgent`, `@langchain/ollama`)
- Postgres + Drizzle ORM
- Default model: `qwen3:8b` for both agents

## Setup

Requirements: Node 20+, Postgres, and Ollama.

```bash
ollama pull qwen3:8b
npm install
cp .env.example .env.local   # set DATABASE_URL for your Postgres user
createdb writer_agent
npm run db:migrate
npm run dev                  # http://localhost:3000
```

## Configuration

Set these in `.env.local`:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection string |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server |
| `DISCUSSION_MODEL` | `qwen3:8b` | Chat and routing. Must support tool calling. |
| `WRITER_MODEL` | `qwen3:8b` | Writes first drafts |
| `EDITOR_MODEL` | `qwen3:8b` | Reviews drafts and makes revisions |
| `WRITER_THINK` | `false` | Let the writer reason before drafting. Slower. |

Pick models that fit in your GPU memory. On a 16 GB Mac, 8B-class models run well. Larger ones such as `gemma4:26b` fall back to the CPU and take minutes per piece.

## Customizing the writer

The writer's voice, craft rules, and per-format guidance live in `src/agents/writer.ts` (`SYSTEM_PROMPT` and `FORMAT_GUIDANCE`). The editor also uses `SYSTEM_PROMPT` when it rewrites. What the editor holds work to lives in `EDITOR_CRITERIA` (`src/agents/editor.ts`). Its automatic checks (sentence length, reading level, banned words, unsupported numbers, PRD goals and out-of-scope items) and their limits live in `src/agents/editorChecks.ts`.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run typecheck` | Generate route types and type-check |
| `npm run lint` | Lint |
| `npm run db:generate` | Create a migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations |
| `npm run db:studio` | Browse the database |

## Known limitations

- Replies aren't streamed. A new piece takes 1–2 minutes (draft plus editor review); exact edits take seconds.
- Small local models sometimes invent specific details (days, numbers, process claims). The editor removes the ones it catches; anything it can't verify is marked `[confirm: …]`. Still check facts before publishing.
