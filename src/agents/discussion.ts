import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { createAgent, tool } from "langchain";
import { z } from "zod";
import { createDocument, getDocument, listDocuments, reviseDocument, searchDocuments } from "@/db/queries";
import { CONTENT_TYPES, type ChatMessage } from "@/db/schema";
import { discussionModel } from "./models";
import { textToolCallMiddleware } from "./textToolCalls";
import { reviseContent, writeContent } from "./writer";

const SYSTEM_PROMPT = `You are the account lead for a writing studio. You talk with the user, find their past documents, and hand writing work to a specialist writer. You never write marketing copy yourself — always use create_content or revise_document for that.

How to work:
- Only call create_content when the user asks you to write, draft, or create something.
- If a request to write is missing something essential (what it's for, who it's for), ask one short clarifying question. Otherwise, fill reasonable gaps and call create_content right away.
- Put everything useful into the brief: product, offer, goal, audience, key points, constraints, and anything the user said earlier in the conversation.
- To change, shorten, extend, or rewrite the open document ("make it…", "change…", "add…"), call revise_document with the open document's id. Never create a new document for an edit.
- To find or show past work ("find", "show me", "open", "where is"), call search_documents first. If several match, list their titles or open the clear best match with open_document. Never guess an id, and never write new content when the user asked to find something.
- After a tool creates, revises, or opens a document, reply in one or two sentences. The document is already shown to the user; do not repeat its contents.
- Be concise and direct.`;

const NOT_FOUND = (id: string) =>
  `No document with id "${id}". Call search_documents to find the right id, then try again.`;

// Collects side effects from tool calls that the UI needs to know about.
type TurnState = { documentId: string | null };

function buildTools(state: TurnState) {
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
      const content = await writeContent(req);
      const doc = await createDocument({ title: req.title, content, contentType: req.contentType, brief: req.brief });
      state.documentId = doc.id;
      return `Created "${doc.title}" (id ${doc.id}). It is now shown to the user. Tell them it's ready in one sentence and invite revisions.`;
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
        { contentType: current.contentType, brief: current.brief },
        current.content,
        instructions,
      );
      await reviseDocument(id, content, instructions);
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

  return [searchDocs, listRecent, openDoc, createContent, reviseDoc];
}

export async function runDiscussionTurn(input: {
  message: string;
  history: ChatMessage[];
  activeDocumentId: string | null;
}) {
  const state: TurnState = { documentId: null };

  // Attached to the latest message rather than the system prompt: small models
  // follow context next to the request much more reliably.
  const active = input.activeDocumentId ? await getDocument(input.activeDocumentId) : null;
  const currentMessage = active
    ? `${input.message}\n\n[Open document: "${active.title}" (id ${active.id}, type ${active.contentType})]`
    : input.message;

  const tools = buildTools(state);
  const agent = createAgent({
    model: discussionModel(),
    tools,
    systemPrompt: SYSTEM_PROMPT,
    middleware: [textToolCallMiddleware(tools.map((t) => t.name))],
  });

  const messages: BaseMessage[] = [
    ...input.history.map((m) => (m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content))),
    new HumanMessage(currentMessage),
  ];

  const result = await agent.invoke({ messages }, { recursionLimit: 12 });
  const reply = result.messages.at(-1)?.text?.trim() || "Done.";
  return { reply, documentId: state.documentId };
}
