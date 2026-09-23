import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { createAgent, tool } from "langchain";
import { z } from "zod";
import {
  createDocument,
  fillDocument,
  getDocument,
  isBlank,
  listDocuments,
  renameDocument,
  reviseDocument,
  saveChatMessage,
  searchDocuments,
} from "@/db/queries";
import { CONTENT_TYPES, type ChatMessage, type Document } from "@/db/schema";
import { discussionModel } from "./models";
import { textToolCallMiddleware } from "./textToolCalls";
import { reviseContent, writeContent } from "./writer";

const SYSTEM_PROMPT = `You are the account lead for a writing studio. You talk with the user, find their past documents, and hand writing work to a specialist writer. You never write marketing copy yourself — always use create_content or revise_document for that.

How to work:
- Do only what the latest message asks. "Rename…", "call it…", or "change the title…" means rename_document, never create_content.
- Only call create_content when the user asks you to write, draft, or create something.
- If a request to write is missing something essential (what it's for, who it's for), ask one short clarifying question. Otherwise, fill reasonable gaps and call create_content right away.
- Put everything useful into the brief: product, offer, goal, audience, key points, constraints, and anything the user said earlier in the conversation.
- Documents the user pastes or links (PRDs, user stories, notes, Google Docs) are saved as this document's source material and passed to the writer word for word. Don't copy them into the brief; the brief says what to write, for whom, and what to emphasize.
- If the user shares a document without saying what to write, confirm you have it and ask what they want made from it.
- If a note says a Google Doc couldn't be read, tell the user why and don't write anything from it.
- Never say you did something unless a tool did it.
- If this conversation's document is empty, create_content writes into it. Otherwise create_content makes a new document.
- To change, shorten, extend, or rewrite the open document ("make it…", "change…", "add…"), call revise_document with the open document's id. Never create a new document for an edit.
- To find or show past work ("find", "show me", "open", "where is"), call search_documents first. If several match, list their titles or open the clear best match with open_document. Never guess an id, and never write new content when the user asked to find something.
- After a tool creates, revises, or opens a document, reply in one or two sentences. The document is already shown to the user; do not repeat its contents.
- Be concise and direct.`;

const NOT_FOUND = (id: string) =>
  `No document with id "${id}". Call search_documents to find the right id, then try again.`;

// Collects side effects from tool calls that the UI needs to know about.
type TurnState = { documentId: string | null };

// Long messages are truncated in the chat history the discussion model sees;
// the full text reaches the writer as source material instead.
const HISTORY_MAX_CHARS = 1500;

function truncateForHistory(text: string) {
  return text.length > HISTORY_MAX_CHARS
    ? `${text.slice(0, HISTORY_MAX_CHARS)}\n[…truncated here; the full text is passed to the writer]`
    : text;
}

function buildTools(state: TurnState, thread: { doc: Document }) {
  // Everything the user pasted or linked in this thread (see src/lib/sources.ts).
  const sourceMaterial = thread.doc.sourceMaterial;

  const searchDocs = tool(
    async ({ query }) => {
      const results = await searchDocuments(query);
      if (results.length === 0) return "No matching documents. Tell the user nothing matched; do not write new content.";
      // Small models tend to ask "should I open it?" — with a single match, just open it.
      if (results.length === 1) {
        state.documentId = results[0].id;
        return `One match: "${results[0].title}" (id ${results[0].id}). It is now open for the user.`;
      }
      return JSON.stringify(results);
    },
    {
      name: "search_documents",
      description: "Search the user's saved documents by keyword or topic. Returns id, title, type, and last updated date.",
      schema: z.object({ query: z.string().describe("Keywords to search for") }),
    },
  );

  const listRecent = tool(async ({ limit }) => JSON.stringify(await listDocuments(limit ?? 10)), {
    name: "list_recent_documents",
    description: "List the user's most recently updated documents.",
    schema: z.object({ limit: z.coerce.number().int().min(1).max(50).optional() }),
  });

  const openDoc = tool(
    async ({ id }) => {
      const doc = await getDocument(id);
      if (!doc) return NOT_FOUND(id);
      state.documentId = doc.id;
      return `Opened "${doc.title}" for the user. Brief: ${doc.brief}\n\nContent:\n${doc.content}`;
    },
    {
      name: "open_document",
      description: "Show a document to the user in the reading pane and read its contents.",
      schema: z.object({ id: z.string().describe("Document id from search_documents or list_recent_documents") }),
    },
  );

  const createContent = tool(
    async ({ keywords, ...rest }) => {
      const req = { ...rest, keywords: keywords?.split(",").map((k) => k.trim()).filter(Boolean) };
      const content = await writeContent({ ...req, sourceMaterial });
      const fields = { title: req.title, content, contentType: req.contentType, brief: req.brief, sourceMaterial };

      // A blank document (from the "+" button) is filled in place: it's what this thread is for.
      if (isBlank(thread.doc)) {
        const doc = await fillDocument(thread.doc.id, fields);
        thread.doc = doc;
        state.documentId = doc.id;
        return `Wrote "${doc.title}" into this conversation's document. It is now shown to the user. Tell them it's ready in one sentence and invite revisions.`;
      }

      // Anything else becomes a new document with its own thread. Seed that thread so it
      // doesn't open empty; the source material travels with the document itself.
      const doc = await createDocument(fields);
      const origin = `"${thread.doc.title}"`;
      await saveChatMessage(
        doc.id,
        "assistant",
        `Created from ${origin}${sourceMaterial ? ", with its source material" : ""}. Ask here for any revisions.`,
        doc.id,
      );
      state.documentId = doc.id;
      return `Created a new document "${doc.title}" (id ${doc.id}). It is now shown to the user. Tell them it's ready in one sentence and invite revisions.`;
    },
    {
      name: "create_content",
      description: "Have the specialist writer produce a new piece of content and save it.",
      schema: z.object({
        title: z.string().describe('Short descriptive name for the document, e.g. "Spring Sale Launch Email"'),
        contentType: z.enum(CONTENT_TYPES),
        brief: z.string().describe("Complete brief: product/offer, goal, key points, constraints, and relevant context"),
        audience: z.string().optional(),
        tone: z.string().optional(),
        // A comma-separated string rather than an array: small local models often send a string anyway.
        keywords: z.string().optional().describe("Comma-separated keywords"),
      }),
    },
  );

  const reviseDoc = tool(
    async ({ id, instructions }) => {
      const current = await getDocument(id);
      if (!current) return NOT_FOUND(id);
      const content = await reviseContent(
        { contentType: current.contentType, brief: current.brief, sourceMaterial: current.sourceMaterial },
        current.content,
        instructions,
      );
      await reviseDocument(id, { content }, instructions);
      state.documentId = id;
      return `Revised "${current.title}". The updated version is shown to the user. Tell them in one sentence what changed.`;
    },
    {
      name: "revise_document",
      description: "Have the specialist writer revise an existing document according to instructions.",
      schema: z.object({
        id: z.string(),
        instructions: z.string().describe("Specific changes the user wants"),
      }),
    },
  );

  const renameDoc = tool(
    async ({ title }) => {
      const doc = await renameDocument(thread.doc.id, title.trim());
      if (!doc) return "Rename failed.";
      thread.doc = doc;
      state.documentId = doc.id;
      return `Renamed this conversation's document to "${doc.title}".`;
    },
    {
      name: "rename_document",
      description: 'Rename the document this conversation belongs to. Use for "rename", "call it", "change the title".',
      schema: z.object({ title: z.string().min(1).describe("The new title") }),
    },
  );

  return [searchDocs, listRecent, openDoc, createContent, reviseDoc, renameDoc];
}

export async function runDiscussionTurn(input: {
  message: string;
  history: ChatMessage[];
  // The document this conversation belongs to, with any new sources already attached.
  threadDoc: Document;
  // Notes about this turn for the model, e.g. that a Google Doc was read or couldn't be.
  notes: string[];
}) {
  const state: TurnState = { documentId: null };
  const { threadDoc } = input;

  // Attached to the latest message rather than the system prompt: small models
  // follow context next to the request much more reliably.
  const notes = [
    isBlank(threadDoc)
      ? `[This conversation's document is empty (id ${threadDoc.id}). Only write into it if the user asks you to write something now.]`
      : `[Open document: "${threadDoc.title}" (id ${threadDoc.id}, type ${threadDoc.contentType})]`,
    ...input.notes,
  ];
  const currentMessage = `${input.message}\n\n${notes.join("\n")}`;

  const tools = buildTools(state, { doc: threadDoc });
  const agent = createAgent({
    model: discussionModel(),
    tools,
    systemPrompt: SYSTEM_PROMPT,
    middleware: [textToolCallMiddleware(tools.map((t) => t.name))],
  });

  const messages: BaseMessage[] = [
    ...input.history.flatMap((m): BaseMessage[] => {
      if (m.role === "user") return [new HumanMessage(truncateForHistory(m.content))];
      if (m.role === "assistant") return [new AIMessage(m.content)];
      return []; // events are for the user, not the model
    }),
    new HumanMessage(currentMessage),
  ];

  const result = await agent.invoke({ messages }, { recursionLimit: 12 });
  const reply = result.messages.at(-1)?.text?.trim() || "Done.";
  return { reply, documentId: state.documentId };
}
