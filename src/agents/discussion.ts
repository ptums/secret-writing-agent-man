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
import { quotedPreferences } from "@/lib/intent";
import type { LineOptions } from "@/lib/options";
import { applyEdit, findSpan, normalizeText } from "@/lib/textEdit";
import { discussionModel } from "./models";
import { textToolCallMiddleware } from "./textToolCalls";
import { draftWithReview, reviseAndEdit, reviseSection, rewordText, type StandingGuidance } from "./editor";
import { newDuplicateSentences } from "./editorChecks";
import { formatBrief, summarizeConversation } from "./handoff";

const SYSTEM_PROMPT = `You are the account lead at a small writing studio. You are the only one who talks with the user. Two specialists do the writing, and they never see this conversation:
- the writer drafts new pieces (create_content)
- the editor changes existing text (reword_text, revise_document)
They know only what your tool calls tell them, so every handoff must be complete on its own. You never write copy yourself, not even one line.

# Handing off new writing: create_content
- Call it only when the user asks you to write, draft, or create something. When they're just chatting or sharing ideas, reply briefly and naturally without a tool.
- "request" is one explicit instruction in plain words: what to write, about what, and for whom, plus anything the user asked to include or avoid. Example: "Write an essay about how carb overloading can impact your health."
- Write the request as an instruction to the writer. Refer to the user as "the user", never "I" or "my": "how I balance my carbs" made the writer produce a first-person piece.
- A summary of this conversation is attached for the writer automatically. Don't retell the chat in the request; make the request itself unambiguous.
- If something essential is missing (what it's for, who it's for), ask one short question first. Otherwise fill reasonable gaps and hand off right away.
- Documents the user pastes or links (PRDs, user stories, notes, Google Docs) are saved as source material and reach the writer word for word. Don't copy them into the request.
- If the user shares a document without saying what to write, confirm you have it and ask what they want made from it.
- If a note says a Google Doc couldn't be read, tell the user why and don't write anything from it.
- If this conversation's document is empty, create_content writes into it. Otherwise it makes a new document.

# Handing off changes to the open document
Choose one tool per change:
- edit_text: the user gives the exact new text ("replace X with Y", "change X to Y", "drop X", "add Y after X"). The new text must be their words, copied from their message. To remove, use an empty "replace". To add a line, find the text it goes after and replace it with that text plus the new line.
- reword_text: the user wants a line or sentence reworded or improved without giving the exact new words: "reword this", "suggest another", "I don't like the rest", "keep X", or a part marked with <angle brackets>. Put the phrases they want kept in "keep" and the ones they want gone in "drop", copied from their message. Put what the new wording should convey, in their words, in "direction".
- revise_document: broad changes to the whole document (tone, length, focus), or changes to one section's structure: a new heading, moving a line, merging repeated lines. For one section, set "target" to text quoted from that section, and only that section changes. "instructions" is one explicit instruction, like a request.
Feedback like "getting closer", "not quite", or "I like X but…/I don't like the rest" asks for another change, not approval: call reword_text again. Praise on its own ("I like it", "feels like us", "looks good") is not a request: thank them and change nothing.
"This", "it", "this bullet", or "this line" usually means the line from the most recent change (see the note under the message). If you can't tell which text they mean, ask one short question.
Never create a new document for an edit.

# Questions
If the user asks a question ("why is…", "what does…", "is this…"), answer it in one or two sentences using the document text under their message, and offer to fix what they're asking about. Don't change the document until they ask.

# Other tools
- "Rename…", "call it…", or "change the title…" means rename_document, never create_content.
- To find or show past work ("find", "show me", "open", "where is"), call search_documents first. If several match, list their titles or open the clear best match with open_document. Never guess an id, and never write new content when the user asked to find something.

# Rules
- Do only what the latest message asks.
- Never say you did something unless a tool did it.
- After a tool creates, changes, or opens a document, reply in one short sentence. The user already sees the document and the exact changes; don't describe or repeat them.
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
  // Set when a change tool failed, so the reply can't claim success.
  failure: string | null;
};

const SECTION_CHANGE =
  /\b(sub ?-?title|this section|that section|the section|move (it|this|that)|merge|combine|restructure|reorder)\b/i;

const NOT_A_CHANGE =
  "The user didn't ask for a change in this message. Don't change the document; reply to what they said.";

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

// Writing is only handed off when the user's message asks for it. In testing, "I try not to
// eat too many carbs in one day" (after the agent offered to write) produced a 1,186-word post.
const WRITE_VERBS =
  /\b(write|draft|create|compose|make|produce|generate|put together|turn (this|it) into|come up with|redo|rewrite)\b/i;
const FORMATS =
  /\b(essay|article|blog|post|email|newsletter|landing page|homepage|website|copy|ad|ads|caption|captions|tagline|headline|brief|script|bio|page|story|piece|announcement|press release|outline)\b/i;
const YES = /^\s*(yes|yeah|yep|sure|ok(ay)?|please( do)?|go (for it|ahead)|do it|sounds good|let'?s do it)\b/i;

export function asksForWriting(message: string, history: ChatMessage[]) {
  if (WRITE_VERBS.test(message) && FORMATS.test(message)) return true;
  if (/\b(write|draft)\b/i.test(message)) return true;
  // "Yes" right after the agent offered to write something.
  const lastReply = [...history].reverse().find((m) => m.role === "assistant")?.content ?? "";
  return YES.test(message) && /\b(write|draft|create)\b/i.test(lastReply);
}

// Rewrites and rewordings need a change request. "I really like how the hero reads now"
// produced a rewrite of the hero in testing.
const CHANGE_WORDS =
  /\b(make|change|reword|rewrite|rephrase|revise|redo|shorten|lengthen|expand|trim|tighten|cut|drop|remove|delete|add|replace|swap|fix|tweak|improve|adjust|update|simplify|soften|punch(y|ier)?|warmer|cooler|shorter|longer|more|less|different|another|instead|try|suggest|keep|rework|polish|edit)\b/i;
const DISLIKE =
  /\b(don'?t like|do not like|not (a fan|great|quite|right)|dislike|hate|getting closer|feels off|weird|awkward|wrong|too (long|short|much|many|formal|casual|wordy|generic|salesy|stiff|vague|busy|dense|cheesy|corporate))\b/i;

export function asksForChange(message: string) {
  return CHANGE_WORDS.test(message) || DISLIKE.test(message) || /<[^>]+>/.test(message);
}

// After a rewrite, puts back the user's recent line-level decisions if an older version of
// the line reappeared. In testing, "make the page warmer" restored two lines the user had
// just changed. A line the rewrite changed into something new is left alone, and so is a
// line the user's current message mentions (they may be asking to change it back).
async function restoreDecisions(content: string, documentId: string, userMessage: string) {
  const decisions = (await revisionHistory(documentId)).filter((h) => h.find?.trim() && h.replace?.trim());
  const words = (t: string) =>
    new Set(
      normalizeText(t)
        .toLowerCase()
        .match(/[a-z0-9’']+/g) ?? [],
    );
  const similarity = (a: string, b: string) => {
    const [wa, wb] = [words(a), words(b)];
    return [...wa].filter((w) => wb.has(w)).length / Math.max(wa.size, wb.size, 1);
  };
  let result = content;
  for (const d of decisions) {
    const mentioned = normalizeText(userMessage).toLowerCase().includes(normalizeText(d.find!).toLowerCase());
    if (mentioned || findSpan(result, d.replace!).ok) continue;
    const exact = applyEdit(result, d.find!, d.replace!);
    if (exact.ok) {
      result = exact.content;
      continue;
    }
    // A cut-down or reworded old version ("We listen. What’s your real problem?"): the line
    // that starts the same way and is closer to the old wording than to the user's.
    const lines = result.split("\n");
    const i = lines.findIndex((line) => {
      const bare = line.replace(/^\s*(?:[-*+•]|\d+[.)])\s*/, "");
      return (
        firstWords(bare) === firstWords(d.find!) &&
        similarity(bare, d.find!) >= 0.5 &&
        similarity(bare, d.find!) > similarity(bare, d.replace!)
      );
    });
    if (i !== -1) {
      const marker = lines[i].match(/^\s*(?:[-*+•]|\d+[.)])\s*/)?.[0] ?? "";
      lines[i] = marker + d.replace!;
      result = lines.join("\n");
    }
  }
  return result;
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
      if (!asksForWriting(thread.userMessage, thread.history)) {
        return "The user didn't ask for anything to be written in this message. Don't write; reply to what they said. You may ask if they'd like something written.";
      }
      const req = {
        ...rest,
        keywords: keywords
          ?.split(",")
          .map((k) => k.trim())
          .filter(Boolean),
      };
      // The handoff: the chat agent's explicit request plus a summary of the actual chat.
      // Stored together as the brief, so the editor sees both on every later revision.
      const brief = formatBrief(req.request, await summarizeConversation(thread.history, thread.userMessage));
      console.info("[handoff]", JSON.stringify({ brief }));
      // Writer drafts; the editor reviews and sends it back until it passes (see draftWithReview).
      const request = {
        contentType: req.contentType,
        brief,
        audience: req.audience,
        tone: req.tone,
        keywords: req.keywords,
        sourceMaterial,
      };
      const content = await draftWithReview(request);
      const fields = { title: req.title, content, contentType: req.contentType, brief, sourceMaterial };

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
        request: z
          .string()
          .describe(
            'One explicit instruction: what to write, about what, for whom, and anything to include or avoid. E.g. "Write an essay about how carb overloading can impact your health."',
          ),
        audience: z.string().optional(),
        tone: z.string().optional(),
        // A comma-separated string rather than an array: small local models often send a string anyway.
        keywords: z.string().optional().describe("Comma-separated keywords"),
      }),
    },
  );

  const reviseDoc = tool(
    async ({ id, instructions, scope, target }) => {
      if (state.changedThisTurn) return ALREADY_CHANGED;
      if (!asksForChange(thread.userMessage)) return NOT_A_CHANGE;
      const current = await getDocument(id);
      if (!current) return NOT_FOUND(id);
      state.revisedThisTurn = true;
      // The editor owns revisions: it rewrites, then reviews its own work like any draft.
      // The explicit instruction plus the user's own words. No chat summary here: it quoted
      // earlier versions of lines, and a rewrite restored them over the user's later edits.
      const withUserWords = `${instructions}\nThe user's own words: "${thread.userMessage}"`;
      // One section: resolved from the user's quotes first (the model once targeted the
      // wrong line), then rewritten on its own and spliced back.
      const section =
        (scope ?? inferScope(instructions)) === "part"
          ? resolveTarget(current.content, target ?? "", thread.userMessage, thread.history)
          : null;
      if (section?.ok) {
        const next = await reviseSection(current.content, section.span, withUserWords);
        if (!next) {
          state.failure =
            "I couldn't make that change cleanly, so nothing in the document changed. Could you say it another way?";
          return "The editor couldn't make that change cleanly. Nothing changed. Ask the user to say it another way.";
        }
        await reviseDocument(id, { content: next }, { kind: "revise", instructions });
        state.documentId = id;
        state.changedThisTurn = true;
        recordChange(state, current.content, next);
        return "Done. The user sees the exact change. Reply in one short sentence.";
      }
      const rewritten = await reviseAndEdit(current.content, withUserWords, scope ?? inferScope(instructions), {
        request: { contentType: current.contentType, brief: current.brief, sourceMaterial: current.sourceMaterial },
        guidance: await standingGuidance(current),
      });
      const content = await restoreDecisions(rewritten, id, thread.userMessage);
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
        target: z.string().optional().describe("For one section: text quoted from that section"),
      }),
    },
  );

  const editText = tool(
    async ({ find, replace }) => {
      // New text must come from the user. The router once "reworded" lines itself through
      // this tool; its lines were weaker and got saved as the user's own words.
      if (!asksForChange(thread.userMessage)) return NOT_A_CHANGE;
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
      // "Why is this duplicated?" once led the router to copy the duplicated sentence into
      // another line; an edit may not create duplicate text.
      if (newDuplicateSentences(current.content, result.content).length) {
        return "That edit would copy text that's already in the document. Don't make it; ask the user what they want changed.";
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
      if (!asksForChange(thread.userMessage)) return NOT_A_CHANGE;
      // "New title for this section and make the title the subtitle" is a section change;
      // rewording the heading alone left the duplicate in place.
      if (SECTION_CHANGE.test(thread.userMessage)) {
        return 'This is a change to a section\'s structure. Call revise_document with scope "part" and "target" set to text quoted from that section.';
      }
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
      // What the user said to keep or drop, read from their own wording, wins over the
      // model's extraction (which got it backwards in testing).
      const said = quotedPreferences(thread.userMessage);
      const same = (a: string, b: string) => normalizeText(a).toLowerCase() === normalizeText(b).toLowerCase();
      // When the user named phrases to keep, those are the whole list: the model once added
      // their entire pasted line as a "keep", which left nothing to reword.
      const keepList = said.keep.length ? said.keep : split(keep);
      const dropList = [...said.drop, ...split(drop).filter((d) => !said.keep.some((k) => same(k, d)))];
      console.info("[reword]", JSON.stringify({ line, keep: keepList, drop: dropList, direction }));

      const result = await rewordText(
        line,
        surroundings,
        { keep: keepList, drop: dropList, direction, userWords: thread.userMessage, avoid },
        {
          request: { contentType: current.contentType, brief: current.brief, sourceMaterial: current.sourceMaterial },
          guidance: await standingGuidance(current),
        },
      );
      if (!result.ok) {
        state.failedEdits++;
        state.failure =
          "I couldn't find wording that fits what you asked, so nothing changed. What should I keep or change?";
        return `${result.reason} Nothing was changed. Ask the user one short question about what to keep or change.`;
      }
      const content = current.content.slice(0, start) + result.best + current.content.slice(end);
      const instructions = [
        `Reword "${line}"`,
        keepList.length && `keeping ${keepList.map((k) => `"${k}"`).join(", ")}`,
        dropList.length && `leaving out ${dropList.map((d) => `"${d}"`).join(", ")}`,
        `aim: ${direction}`,
      ]
        .filter(Boolean)
        .join("; ");
      // find/replace recorded so a later rewrite can't silently bring the old line back.
      await reviseDocument(current.id, { content }, { kind: "revise", instructions, find: line, replace: result.best });
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
    failure: null,
  };
  const { threadDoc } = input;

  // Attached to the latest message rather than the system prompt: small models
  // follow context next to the request much more reliably.
  const notes = [
    isBlank(threadDoc)
      ? `[This conversation's document is empty (id ${threadDoc.id}). Only write into it if the user asks you to write something now.]`
      : `[Open document: "${threadDoc.title}" (id ${threadDoc.id}, type ${threadDoc.contentType})]`,
    ...lastChangeNote(input.history, threadDoc.content, input.message),
    ...questionNote(threadDoc.content, input.message),
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
  let reply = result.messages.at(-1)?.text?.trim() || "Done.";
  // A tool failed and nothing changed, but the reply claims it did: the router did exactly this
  // ("The document has been updated with a new title and subtitle") in testing.
  const claimsChange = /\b(updated|revised|changed|reworded|rewritten|done|added|removed|replaced)\b/i;
  if (state.failure && !state.changedThisTurn && claimsChange.test(reply)) reply = state.failure;
  return {
    reply,
    documentId: state.documentId,
    changes: state.changes,
    highlights: state.highlights,
    options: state.options,
  };
}

// Follow-ups ("this bullet is getting closer") almost always refer to the line just changed.
function lastChangeNote(history: ChatMessage[], content: string, message: string) {
  // When the user quotes text from the document, that's what they mean: the hint pointed
  // the router at the last-changed line instead, and it edited the wrong one.
  const quotesDocument = [
    ...[...message.matchAll(/["“]([^"“”]{12,})["”]/g)].map((m) => m[1]),
    ...message.split("\n").filter((l) => l.trim().length >= 20),
  ].some((q) => findSpan(content, q.trim()).ok);
  const last = recentChanges(history).at(-1);
  if (quotesDocument || !last || last.added.length !== 1) return [];
  const from = last.removed.length === 1 ? ` (it replaced "${last.removed[0]}")` : "";
  return [
    `[Most recent change: the line now reads "${last.added[0]}"${from}. "This", "it", or "the bullet" most likely means this line.]`,
  ];
}

const QUESTION_DOC_CHARS = 6000;

// A question about the document needs its text to be answered ("Why is this duplicated?").
function questionNote(content: string, message: string) {
  const isQuestion = /\?\s*$|^\s*(why|what|how|is|are|does|do|can|where|which)\b/im.test(message);
  if (!isQuestion || !content.trim()) return [];
  const text = content.length > QUESTION_DOC_CHARS ? `${content.slice(0, QUESTION_DOC_CHARS)}\n[…]` : content;
  return [`[The document's current text, for answering the question:\n${text}]`];
}

// A quoted fragment ("drop 'to your practice…'") means rework its whole line, not just the
// fragment: rewording only the fragment produced "…real change 2. We plan it together." in
// testing. Long paragraphs keep the fragment's span.
const MAX_LINE_CHARS = 240;

function toWholeLine(content: string, span: { start: number; end: number }) {
  const lineStart = content.lastIndexOf("\n", span.start - 1) + 1;
  const nl = content.indexOf("\n", span.end);
  const lineEnd = nl === -1 ? content.length : nl;
  const raw = content.slice(lineStart, lineEnd);
  if (raw.length > MAX_LINE_CHARS) return span;
  // Leave list markers, heading hashes, and trailing spaces outside the span.
  const marker = raw.match(/^\s*(?:[-*+•]\s+|\d+[.)]\s+|#{1,6}\s+|>\s?)?/)?.[0].length ?? 0;
  return { start: lineStart + marker, end: lineStart + raw.trimEnd().length };
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
  const found = findSpan(content, find);
  const modelChoice = found.ok ? { ...found, span: toWholeLine(content, found.span) } : found;
  const overlaps = (q: string) => {
    const a = normalizeText(q).toLowerCase();
    const b = normalizeText(find).toLowerCase();
    return a.includes(b) || b.includes(a);
  };
  // The model's choice stands if it's one of the user's quotes (or nothing was quoted).
  if (modelChoice.ok && (quoted.length === 0 || quoted.some(overlaps))) return modelChoice;
  if (quoted.length) {
    // Prefer a whole quoted line over a fragment of it.
    const best = findSpan(content, quoted.sort((a, b) => b.length - a.length)[0]);
    return best.ok ? { ...best, span: toWholeLine(content, best.span) } : best;
  }
  if (modelChoice.ok) return modelChoice;
  const last = recentChanges(history).at(-1);
  if (last?.added.length === 1) {
    const recent = findSpan(content, last.added[0]);
    if (recent.ok) return { ...recent, span: toWholeLine(content, recent.span) };
  }
  return modelChoice;
}
