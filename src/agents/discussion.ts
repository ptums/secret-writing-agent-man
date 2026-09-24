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
  revisionHistory,
  saveChatMessage,
  searchDocuments,
} from "@/db/queries";
import { CONTENT_TYPES, type ChatMessage, type Document } from "@/db/schema";
import { CHANGES_HEADER, summarizeChanges } from "@/lib/changes";
import type { LineOptions } from "@/lib/options";
import { applyEdit, findSpan, normalizeText } from "@/lib/textEdit";
import { discussionModel } from "./models";
import { textToolCallMiddleware } from "./textToolCalls";
import { NO_GUIDANCE, editDraft, reviseAndEdit, rewordText, type StandingGuidance } from "./editor";
import { writeContent } from "./writer";

const SYSTEM_PROMPT = `You are the account lead for a writing studio. You talk with the user, find their past documents, and hand work to specialists: a writer for new pieces (create_content) and an editor for changes (reword_text, revise_document). You never write marketing copy yourself, not even one line.

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
- Choose the tool for a change to the document:
  - edit_text: the user gives the exact new text ("replace X with Y", "change X to Y", "drop X", "add Y after X"). The new text must be their words, copied from their message. To remove, use an empty "replace". To add a line, find the text it goes after and replace it with that text plus the new line.
  - reword_text: the user wants a line or sentence reworded or improved without giving the exact new words. This includes "reword this", "suggest another", "I don't like the rest", "keep X", and a part marked with <angle brackets>. Put the phrases they want kept in "keep" and the ones they want gone in "drop", copied from their message. Put what the new wording should convey, in their words, in "direction". The editor writes the wording.
  - revise_document: broad changes to the whole document or a whole section, like tone, length, or focus.
- Feedback like "getting closer", "not quite", "I like X", "keep X", or "I don't like the rest" asks for another change, not approval. Call reword_text again, with keep/drop taken from their words.
- "This", "it", "this bullet", or "this line" usually means the line from the most recent change (see the note under the message). If you can't tell which text they mean, ask one short question.
- One call per change. Never create a new document for an edit.
- To find or show past work ("find", "show me", "open", "where is"), call search_documents first. If several match, list their titles or open the clear best match with open_document. Never guess an id, and never write new content when the user asked to find something.
- After a tool creates, revises, or opens a document, reply in one sentence. The document and an exact list of changes are already shown to the user; don't describe or repeat them.
- Be concise and direct.`;

const NOT_FOUND = (id: string) =>
  `No document with id "${id}". Call search_documents to find the right id, then try again.`;

// Collects side effects from tool calls that the UI needs to know about.
type TurnState = {
  documentId: string | null;
  // One "What changed" summary per change, computed from the actual before/after text.
  changes: string[];
  // Lines added this turn, highlighted in the reader.
  highlights: string[];
  // Guards against a small model piling extra rewrites onto a request (e.g. rewriting
  // the whole page right after an exact edit) or retrying a failed edit in a loop.
  changedThisTurn: boolean;
  revisedThisTurn: boolean;
  failedEdits: number;
  // Other wordings from reword_text, offered in the chat with a "Use" button.
  options: LineOptions[];
};

const ALREADY_CHANGED =
  "The document was already changed this turn, and the user didn't ask for more. Don't change it again; reply to the user in one short sentence.";

// Recent "What changed" events for this thread, newest last: [removed lines, added lines].
function recentChanges(history: ChatMessage[]) {
  return history
    .filter((m) => m.role === "event" && m.content.startsWith(CHANGES_HEADER))
    .map((m) => {
      const lines = m.content.split("\n").slice(1);
      const pick = (sign: string) => lines.filter((l) => l.startsWith(sign)).map((l) => l.slice(2).trim());
      return { removed: pick("−"), added: pick("+") };
    });
}

// A replacement is the user's wording if every word in it comes from their message or
// from the text being replaced: trims and recombinations of their phrases pass; words the
// router made up ("tailored to", "make sure it works") don't.
export function isUsersWording(find: string, replace: string, userMessage: string) {
  const words = (t: string) =>
    normalizeText(t)
      .toLowerCase()
      .match(/[a-z0-9’']{3,}/g) ?? [];
  const available = new Set([...words(find), ...words(userMessage)]);
  return words(replace).every((w) => available.has(w));
}

const firstWords = (text: string, n = 2) => normalizeText(text).toLowerCase().split(" ").slice(0, n).join(" ");

function recordChange(state: TurnState, before: string, after: string) {
  const summary = summarizeChanges(before, after);
  state.changes.push(summary.event);
  state.highlights.push(...summary.added);
  return summary;
}

const MAX_FEEDBACK = 12;

// Used when the model leaves out revise_document's scope. Quoted text or a named part
// ("the headline", "this paragraph") means a targeted change; anything else is whole-document.
function inferScope(instructions: string): "whole" | "part" {
  return /["“”']|\b(line|sentence|headline|heading|title|paragraph|section|bullet|cta|button|intro|opening|closing)\b/i.test(
    instructions,
  )
    ? "part"
    : "whole";
}

// Decisions the user already made on this document, passed to every rewrite.
async function standingGuidance(doc: Document): Promise<StandingGuidance> {
  const history = await revisionHistory(doc.id);
  return {
    feedback: history
      .filter((h) => h.kind === "revise" && h.instructions)
      .map((h) => h.instructions!)
      .slice(-MAX_FEEDBACK),
    keep: history
      .filter((h) => h.kind === "edit" && h.replace?.trim() && findSpan(doc.content, h.replace).ok)
      .map((h) => h.replace!.trim()),
    removed: history.filter((h) => h.kind === "edit" && h.find && !h.replace?.trim()).map((h) => h.find!.trim()),
  };
}

// Long messages are truncated in the chat history the discussion model sees;
// the full text reaches the writer as source material instead.
const HISTORY_MAX_CHARS = 1500;

function truncateForHistory(text: string) {
  return text.length > HISTORY_MAX_CHARS
    ? `${text.slice(0, HISTORY_MAX_CHARS)}\n[…truncated here; the full text is passed to the writer]`
    : text;
}

function buildTools(state: TurnState, thread: { doc: Document; userMessage: string; history: ChatMessage[] }) {
  // Everything the user pasted or linked in this thread (see src/lib/sources.ts).
  const sourceMaterial = thread.doc.sourceMaterial;

  const searchDocs = tool(
    async ({ query }) => {
      const results = await searchDocuments(query);
      if (results.length === 0)
        return "No matching documents. Tell the user nothing matched; do not write new content.";
      // Small models tend to ask "should I open it?" — with a single match, just open it.
      if (results.length === 1) {
        state.documentId = results[0].id;
        return `One match: "${results[0].title}" (id ${results[0].id}). It is now open for the user.`;
      }
      return JSON.stringify(results);
    },
    {
      name: "search_documents",
      description:
        "Search the user's saved documents by keyword or topic. Returns id, title, type, and last updated date.",
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
      const req = {
        ...rest,
        keywords: keywords
          ?.split(",")
          .map((k) => k.trim())
          .filter(Boolean),
      };
      // Writer drafts; the editor reviews and fixes before anything is saved or shown.
      const request = { ...req, sourceMaterial };
      const content = await editDraft(await writeContent(request), { request, guidance: NO_GUIDANCE });
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
        brief: z
          .string()
          .describe("Complete brief: product/offer, goal, key points, constraints, and relevant context"),
        audience: z.string().optional(),
        tone: z.string().optional(),
        // A comma-separated string rather than an array: small local models often send a string anyway.
        keywords: z.string().optional().describe("Comma-separated keywords"),
      }),
    },
  );

  const reviseDoc = tool(
    async ({ id, instructions, scope }) => {
      if (state.changedThisTurn) return ALREADY_CHANGED;
      const current = await getDocument(id);
      if (!current) return NOT_FOUND(id);
      state.revisedThisTurn = true;
      // The editor owns revisions: it rewrites, then reviews its own work like any draft.
      const withUserWords = `${instructions}\nThe user's own words: "${thread.userMessage}"`;
      const content = await reviseAndEdit(current.content, withUserWords, scope ?? inferScope(instructions), {
        request: { contentType: current.contentType, brief: current.brief, sourceMaterial: current.sourceMaterial },
        guidance: await standingGuidance(current),
      });
      await reviseDocument(id, { content }, { kind: "revise", instructions });
      state.documentId = id;
      state.changedThisTurn = true;
      const summary = recordChange(state, current.content, content);
      return summary.changed
        ? `Revised "${current.title}". Actual changes (already shown to the user):\n${summary.event}`
        : "The writer returned the document unchanged. Tell the user nothing changed and ask them to rephrase.";
    },
    {
      name: "revise_document",
      description: "Have the specialist writer revise an existing document according to instructions.",
      schema: z.object({
        id: z.string(),
        instructions: z.string().describe("Specific changes the user wants"),
        scope: z
          .enum(["whole", "part"])
          .optional()
          .describe('"whole" for tone, length, or focus across the document; "part" for one section or line'),
      }),
    },
  );

  const editText = tool(
    async ({ find, replace }) => {
      // New text must come from the user. The router once "reworded" lines itself through
      // this tool; its lines were weaker and got saved as the user's own words.
      if (!isUsersWording(find, replace, thread.userMessage)) {
        return "That new text isn't in the user's message. Use edit_text only with the user's exact words. To reword or improve text, call reword_text and let the editor write it.";
      }
      const current = await getDocument(thread.doc.id);
      if (!current) return NOT_FOUND(thread.doc.id);
      const result = applyEdit(current.content, find, replace);
      if (!result.ok) {
        state.failedEdits++;
        if (state.failedEdits >= 2) return "Stop calling tools. Ask the user to paste the exact text they mean.";
        return result.reason === "ambiguous"
          ? `That text appears ${result.count} times in the document, so it's unclear which one to change. Don't retry; ask the user which one they mean (e.g. the first or second), or to quote more of the surrounding text.`
          : "That exact text isn't in the document. If the user described the change rather than quoting text, use revise_document; otherwise ask them to paste the exact text.";
      }
      const instructions = replace.trim() ? `Replace "${find}" with "${replace}"` : `Remove "${find}"`;
      await reviseDocument(current.id, { content: result.content }, { kind: "edit", instructions, find, replace });
      thread.doc = { ...current, content: result.content };
      state.documentId = current.id;
      state.changedThisTurn = true;
      recordChange(state, current.content, result.content);
      return "Done. The user already sees the exact change. Reply in one short sentence; only call edit_text again if this same message asked for another exact change.";
    },
    {
      name: "edit_text",
      description:
        "Exact edit on this conversation's document: replace the quoted text, or remove it with an empty replace. Instant; changes nothing else.",
      schema: z.object({
        find: z.string().min(1).describe("The exact text to change, as the user quoted it"),
        replace: z.string().describe('The new text, or "" to remove it'),
      }),
    },
  );

  const rewordTextTool = tool(
    async ({ find, keep, drop, direction }) => {
      if (state.revisedThisTurn) return ALREADY_CHANGED;
      const current = await getDocument(thread.doc.id);
      if (!current) return NOT_FOUND(thread.doc.id);
      const found = resolveTarget(current.content, find, thread.userMessage, thread.history);
      if (!found.ok) {
        state.failedEdits++;
        if (state.failedEdits >= 2) return "Stop calling tools. Ask the user to paste the exact line they mean.";
        return found.reason === "ambiguous"
          ? `That text appears ${found.count} times. Don't retry; ask the user which one they mean.`
          : "That text isn't in the document. Copy the line exactly from the document or from the most recent change, or ask the user which line they mean.";
      }
      const { start, end } = found.span;
      const line = current.content.slice(start, end);
      const lineStart = current.content.lastIndexOf("\n", start - 1) + 1;
      const lineEnd = current.content.indexOf("\n", end);
      const neighbours = (text: string) =>
        text
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
      const surroundings = {
        before: neighbours(current.content.slice(0, lineStart)).at(-1) ?? "",
        after: lineEnd === -1 ? "" : (neighbours(current.content.slice(lineEnd)).at(0) ?? ""),
      };
      // Earlier versions of this line (same opening words) that the user moved away from.
      const avoid = recentChanges(thread.history)
        .flatMap((c) => c.removed)
        .filter((r) => firstWords(r) === firstWords(line))
        .slice(-6);
      const split = (text?: string) =>
        (text ?? "")
          .split("|")
          .map((t) => t.trim().replace(/^["“']|["”']$/g, ""))
          .filter(Boolean);

      const result = await rewordText(
        line,
        surroundings,
        { keep: split(keep), drop: split(drop), direction, userWords: thread.userMessage, avoid },
        {
          request: { contentType: current.contentType, brief: current.brief, sourceMaterial: current.sourceMaterial },
          guidance: await standingGuidance(current),
        },
      );
      if (!result.ok) {
        state.failedEdits++;
        return `${result.reason} Nothing was changed. Ask the user one short question about what to keep or change.`;
      }
      const content = current.content.slice(0, start) + result.best + current.content.slice(end);
      const instructions = [
        `Reword "${line}"`,
        keep &&
          `keeping ${split(keep)
            .map((k) => `"${k}"`)
            .join(", ")}`,
        drop &&
          `leaving out ${split(drop)
            .map((d) => `"${d}"`)
            .join(", ")}`,
        `aim: ${direction}`,
      ]
        .filter(Boolean)
        .join("; ");
      await reviseDocument(current.id, { content }, { kind: "revise", instructions });
      thread.doc = { ...current, content };
      state.documentId = current.id;
      state.changedThisTurn = true;
      if (result.alternatives.length) state.options.push({ current: result.best, options: result.alternatives });
      recordChange(state, current.content, content);
      return `Done. The line now reads: "${result.best}". The user sees it and other options to pick from. Reply in one short sentence.`;
    },
    {
      name: "reword_text",
      description:
        "Have the editor reword one line or sentence (it writes the new wording and offers alternatives). Use when the user wants text reworded or improved rather than giving exact new words.",
      schema: z.object({
        find: z.string().min(1).describe("The exact current text of the line to reword"),
        keep: z.string().optional().describe('Phrases to keep word for word, separated by "|"'),
        drop: z.string().optional().describe('Phrases to remove, separated by "|"'),
        direction: z.string().describe("What the new wording should convey, in the user's words"),
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

  return [searchDocs, listRecent, openDoc, createContent, reviseDoc, editText, rewordTextTool, renameDoc];
}

export async function runDiscussionTurn(input: {
  message: string;
  history: ChatMessage[];
  // The document this conversation belongs to, with any new sources already attached.
  threadDoc: Document;
  // Notes about this turn for the model, e.g. that a Google Doc was read or couldn't be.
  notes: string[];
}) {
  const state: TurnState = {
    documentId: null,
    changes: [],
    highlights: [],
    changedThisTurn: false,
    revisedThisTurn: false,
    failedEdits: 0,
    options: [],
  };
  const { threadDoc } = input;

  // Attached to the latest message rather than the system prompt: small models
  // follow context next to the request much more reliably.
  const notes = [
    isBlank(threadDoc)
      ? `[This conversation's document is empty (id ${threadDoc.id}). Only write into it if the user asks you to write something now.]`
      : `[Open document: "${threadDoc.title}" (id ${threadDoc.id}, type ${threadDoc.contentType})]`,
    ...lastChangeNote(input.history),
    ...input.notes,
  ];
  const currentMessage = `${input.message}\n\n${notes.join("\n")}`;

  const tools = buildTools(state, { doc: threadDoc, userMessage: input.message, history: input.history });
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
  return {
    reply,
    documentId: state.documentId,
    changes: state.changes,
    highlights: state.highlights,
    options: state.options,
  };
}

// Follow-ups ("this bullet is getting closer") almost always refer to the line just changed.
function lastChangeNote(history: ChatMessage[]) {
  const last = recentChanges(history).at(-1);
  if (!last || last.added.length !== 1) return [];
  const from = last.removed.length === 1 ? ` (it replaced "${last.removed[0]}")` : "";
  return [
    `[Most recent change: the line now reads "${last.added[0]}"${from}. "This", "it", or "the bullet" most likely means this line.]`,
  ];
}

// Which text a reword is about. Decided in code, because the model picked wrong in testing:
// it targeted "We listen. <real change vibes>" (not in the document) instead of the quoted
// line above it, and reworded the last-changed line when the user had quoted another one.
// Order: text the user quoted or pasted that exists in the document, then the model's
// choice, then the line from the most recent change.
function resolveTarget(content: string, find: string, userMessage: string, history: ChatMessage[]) {
  const quoted = [
    ...[...userMessage.matchAll(/["“]([^"“”]{8,})["”]/g)].map((m) => m[1]),
    ...userMessage.split("\n").filter((l) => l.trim().length >= 12 && !/<[^>]+>/.test(l)),
  ]
    .map((q) => q.trim())
    .filter((q) => findSpan(content, q).ok);
  const modelChoice = findSpan(content, find);
  const overlaps = (q: string) => {
    const a = normalizeText(q).toLowerCase();
    const b = normalizeText(find).toLowerCase();
    return a.includes(b) || b.includes(a);
  };
  // The model's choice stands if it's one of the user's quotes (or nothing was quoted).
  if (modelChoice.ok && (quoted.length === 0 || quoted.some(overlaps))) return modelChoice;
  if (quoted.length) {
    // Prefer a whole quoted line over a fragment of it.
    const best = quoted.sort((a, b) => b.length - a.length)[0];
    return findSpan(content, best);
  }
  if (modelChoice.ok) return modelChoice;
  const last = recentChanges(history).at(-1);
  if (last?.added.length === 1) {
    const recent = findSpan(content, last.added[0]);
    if (recent.ok) return recent;
  }
  return modelChoice;
}
