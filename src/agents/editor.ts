import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { applyEdit, findSpan, normalizeText, resolvePhrase } from "@/lib/textEdit";
import {
  BANNED_PHRASES,
  LITERAL_HEADINGS,
  MAX_SENTENCE_WORDS,
  readSourceRules,
  runChecks,
  sentences,
  unsupportedSpecifics,
  type Finding,
} from "./editorChecks";
import { editorModel } from "./models";
import { describeRequest, redraftContent, stripFence, writeContent, type WriteRequest } from "./writer";

// The editor agent. Every first draft and every revision passes through it before the
// user sees anything. It reviews against EDITOR_CRITERIA (plus the mechanical checks in
// ./editorChecks.ts), fixes what fails with exact replacements, and re-reviews. Its notes
// are never shown to the user: the final document is what passes review.

export const EDITOR_CRITERIA = `A piece passes only if all of these hold:

1. Facts. Claims about the user's business, product, or offer (prices, numbers, dates, days, durations, features, results, customers, testimonials, process details) are supported by the brief or source material. Goals, targets, and success metrics are not stated as results. Features listed as out of scope or future are not mentioned as existing. General knowledge (how the body, a market, or a technology works) is fine when it's widely accepted, but no invented statistics, studies, or quotes.
2. Voice. Logical and poetic. Short sentences in plain, common words, below a 10th grade reading level. No filler or hype ("unlock", "elevate", "leverage", "game-changer", "made with love", "in today's fast-paced world"). Doesn't prescribe a feeling to the reader unless the brief asks for it.
3. Request. Delivers what was asked, in the requested format and tone, for the right audience. Follows the user's earlier feedback. Keeps the user's own lines word for word, and doesn't bring back text they removed.
4. Clean. Only the deliverable: no preamble, notes to the user, or section labels (like "Hero" or "Features") used as headings.`;

// Reviews a rewrite of an existing document (see reviseAndEdit). New drafts are reviewed by
// draftWithReview instead, which sends failing drafts back to the writer.
const REVIEW_PROMPT = `You are a meticulous copy editor. You don't rewrite pieces; you find specific problems and give exact fixes.

${EDITOR_CRITERIA}

For each problem, return:
- quote: the exact text from the piece, copied character for character (one sentence or line)
- problem: what's wrong, briefly
- replacement: the corrected text for that quote, in the same voice and plain Markdown (never HTML), or "" to delete it. Never add a number, price, day, or duration that isn't in the brief or source; when one is needed, use a bracketed placeholder like [delivery day].

Only flag real problems against the criteria. Don't restyle text that already passes, and don't remove headings (renaming a vague one is fine). Prefer fixing a sentence to deleting it; never delete a whole paragraph or section.

Never flag or change the user's own lines. Return an empty list if the piece passes.`;

// ---- Reviewing new drafts ----------------------------------------------------------
//
// The writer drafts; the editor scores how well the draft fulfills the request and checks it
// against EDITOR_CRITERIA (plus the code checks). A draft passes only with high accuracy and
// nothing flagged; otherwise it goes back to the writer with specific instructions, and the
// new draft is reviewed again. Nothing here is shown to the user: they see the draft that
// passed (or the best one, if none did).

export const PASS_ACCURACY = 8;
const MAX_DRAFTS = 3;

const DRAFT_REVIEW_PROMPT = `You are the editor at a writing studio. The account lead sends the writer a request (and a summary of the conversation with the user); the writer sends you a draft. You decide whether the draft is good enough to show the user.

Judge two things.

1. Accuracy: how well the draft fulfills the request. List the requirements the request sets, 3 to 8 of them: what to write and about what, the format, the audience, anything to include or avoid, and using what the conversation context says about the user. Mark each one met or not met, strictly. Only count requirements the request or context actually states.
2. The criteria below. Label every problem with the criterion it breaks: Facts, Voice, Request, or Clean.

${EDITOR_CRITERIA}

Facts problems are serious: they send the draft back to the writer. Whether the draft does what was asked is judged by the requirements above, so Request, Voice, and Clean problems are minor: note them, but they don't block a pass.
A draft passes if at least ${PASS_ACCURACY * 10}% of the requirements are met and there are no Facts problems.

Return:
- requirements: each requirement and whether the draft meets it
- problems: each one with the exact quote from the draft, its criterion, and what's wrong
- instructions: if the draft doesn't pass, specific instructions for the writer's next draft. Refer to exact passages, say what to change and how, and say what to keep. Empty if it passes.`;

const DraftReview = z.object({
  requirements: z.array(z.object({ requirement: z.string(), met: z.boolean() })),
  problems: z.array(
    z.object({ quote: z.string(), criterion: z.enum(["Facts", "Voice", "Request", "Clean"]), problem: z.string() }),
  ),
  instructions: z.string(),
});

type DraftVerdict = {
  draft: string;
  accuracy: number;
  serious: string[];
  minor: string[];
  notes: string;
  passed: boolean;
};

// Tiered: only unmet requirements, the model's Facts problems, and serious code checks send a
// draft back. With every flag blocking, no draft passed in testing (an 8B reviewer always
// finds a nitpick; 6–12 minutes per piece). The model's Request/Clean labels were nitpicks
// too ("not formatted as a button"), and both are covered better elsewhere: the requirements
// checklist for the request, the code checks for structure.
// A model "Facts" flag only blocks when the quote contains something checkable: a number,
// price, percentage, or a quoted testimonial. Elsewhere it flagged general knowledge in a
// health essay ("carbs raise blood sugar") and "two loaves" vs "2 loaves" as fact problems.
const checkable = (quote: string) => /\d|[$%]|["“][^"”]{8,}["”]/.test(quote);

export async function reviewDraft(draft: string, ctx: EditorContext): Promise<DraftVerdict> {
  // The code checks are flags too: they catch what the model reviewer misses.
  const findings = runChecks(draft, checkContext(ctx));
  const review = await editorModel()
    .withStructuredOutput(DraftReview)
    .invoke([
      new SystemMessage(DRAFT_REVIEW_PROMPT),
      new HumanMessage(`The request:\n${describeRequest(ctx.request)}\n\nThe draft:\n<<<\n${draft}\n>>>`),
    ]);
  const describe = (quote: string | undefined, problem: string) => (quote ? `"${quote}": ${problem}` : problem);
  const serious = [
    ...review.problems
      .filter((p) => p.criterion === "Facts" && checkable(p.quote))
      .map((p) => describe(p.quote, `${p.problem} (Facts)`)),
    ...findings.filter((f) => f.severity === "serious").map((f) => describe(f.quote, f.problem)),
  ];
  const minor = [
    ...review.problems
      .filter((p) => p.criterion !== "Facts" || !checkable(p.quote))
      .map((p) => describe(p.quote, p.problem)),
    ...findings.filter((f) => f.severity === "style").map((f) => describe(f.quote, f.problem)),
  ];
  // Accuracy is the share of the request's requirements met: a 1–10 gut score from the model
  // came back 9–10 for every draft in testing, so it couldn't tell drafts apart (this scores
  // a matching draft 10/10 and an off-topic one 0/10).
  if (process.env.DEBUG_EDITOR) console.info(`[editor] serious:\n${serious.join("\n")}`);
  const met = review.requirements.filter((q) => q.met).length;
  const accuracy = review.requirements.length ? Math.round((10 * met) / review.requirements.length) : 10;
  const unmet = review.requirements.filter((q) => !q.met).map((q) => q.requirement);
  const list = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
  const notes = [
    unmet.length && `Requirements the draft doesn't meet yet:\n${list(unmet)}`,
    serious.length && `Must fix:\n${list(serious)}`,
    review.instructions && `Instructions: ${review.instructions}`,
    minor.length && `Also improve if you can:\n${list(minor)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { draft, accuracy, serious, minor, notes, passed: accuracy >= PASS_ACCURACY && !serious.length };
}

// Writer drafts → editor reviews → writer redrafts with the editor's notes, until a draft
// passes or MAX_DRAFTS is reached; then the best draft wins.
export async function draftWithReview(request: WriteRequest) {
  const ctx: EditorContext = { request, guidance: NO_GUIDANCE };
  const verdicts: DraftVerdict[] = [];
  let draft = await writeContent(request);
  for (let n = 1; n <= MAX_DRAFTS; n++) {
    const verdict = await reviewDraft(draft, ctx);
    verdicts.push(verdict);
    console.info(
      `[editor] draft ${n}: accuracy ${verdict.accuracy}/10, ${verdict.serious.length} serious / ${verdict.minor.length} minor → ${verdict.passed ? "pass" : n < MAX_DRAFTS ? "back to the writer" : "out of drafts"}`,
    );
    if (verdict.passed || n === MAX_DRAFTS) break;
    draft = await redraftContent(request, verdict.notes);
  }
  // Best = a passing draft if any; else most accurate, then fewest serious, then fewest minor.
  const rank = (v: DraftVerdict) => [v.passed ? 1 : 0, v.accuracy, -v.serious.length, -v.minor.length];
  const better = (a: DraftVerdict, b: DraftVerdict) => {
    const [ra, rb] = [rank(a), rank(b)];
    const i = ra.findIndex((x, k) => x !== rb[k]);
    return i === -1 ? b : ra[i] > rb[i] ? a : b; // ties go to the later draft
  };
  const best = verdicts.reduce(better);
  const checks = checkContext(ctx);
  return removeOutOfScope(confirmUnsupported(best.draft, checks), checks).replace(/^(#{1,6})(?=[^\s#])/gm, "$1 ");
}

// Safety net after the last draft: a sentence mentioning something the source lists as out of
// scope doesn't ship ("Android is coming." survived three drafts in testing), and neither do
// leaked section labels used as headings.
function removeOutOfScope(content: string, checks: ReturnType<typeof checkContext>) {
  // Section labels used as headings ("# Hero", "## Final CTA") carry no content; drop them.
  let result = content
    .split("\n")
    .filter((line) => !LITERAL_HEADINGS.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  for (const f of runChecks(content, checks)) {
    if (!f.quote || !/is out of scope in the source/.test(f.problem)) continue;
    const removed = applyEdit(result, f.quote, "");
    if (removed.ok) result = removed.content;
  }
  return result;
}

// What the user has already decided about this document, so later work doesn't undo it.
export type StandingGuidance = {
  feedback: string[]; // earlier revision instructions
  keep: string[]; // text the user wrote or approved via exact edits
  removed: string[]; // text the user deliberately removed
};

export const NO_GUIDANCE: StandingGuidance = { feedback: [], keep: [], removed: [] };

export type EditorContext = {
  request: WriteRequest;
  guidance: StandingGuidance;
  // The change the user just asked for, when reviewing a revision.
  instructions?: string;
};

const MAX_ROUNDS = 2;
// A review that wants dozens of changes is nitpicking; take the first ones.
const MAX_FIXES_PER_ROUND = 12;
// A round that empties a section or cuts this share of the words is discarded: in testing,
// one round deleted 42 sentences of an essay and left bare headings.
const MAX_ROUND_CUT = 0.2;

const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;

// A heading followed directly by another heading (or the end) that had text in `before`.
function emptiedSection(before: string, after: string) {
  const empty = (t: string) =>
    [...t.matchAll(/^(#{1,6}\s.+)\n+(?=#{1,6}\s|$(?![\s\S]))/gm)].map((m) => normalizeText(m[1]));
  const wasEmpty = new Set(empty(before));
  return empty(after).some((h) => !wasEmpty.has(h));
}

const Review = z.object({
  issues: z.array(z.object({ quote: z.string(), problem: z.string(), replacement: z.string() })),
});

function describeGuidance(g: StandingGuidance) {
  const section = (title: string, items: string[]) =>
    items.length ? `${title}\n${items.map((i) => `- ${i}`).join("\n")}` : null;
  return [
    section("Earlier feedback on this document (still applies):", g.feedback),
    section(
      "Text the user wrote themselves (keep word for word):",
      g.keep.map((t) => `"${t}"`),
    ),
    section(
      "Text the user removed (don't bring it back, or anything like it):",
      g.removed.map((t) => `"${t}"`),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function checkContext(ctx: EditorContext) {
  const { request, guidance, instructions } = ctx;
  return {
    allowedText: [request.brief, request.sourceMaterial, instructions, ...guidance.feedback, ...guidance.keep]
      .filter(Boolean)
      .join("\n"),
    keep: guidance.keep,
    removed: guidance.removed,
    ...readSourceRules(request.sourceMaterial),
  };
}

async function review(content: string, ctx: EditorContext, findings: Finding[]) {
  const prompt = [
    `What was asked for:\n${describeRequest(ctx.request)}`,
    describeGuidance(ctx.guidance),
    ctx.instructions && `The user's latest request: ${ctx.instructions}`,
    findings.length &&
      `Automated checks found these problems; fix every one that points at a quote:\n${findings
        .map((f) => `- ${f.quote ? `"${f.quote}": ` : ""}${f.problem}`)
        .join("\n")}`,
    `Piece to review:\n<<<\n${content}\n>>>`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const result = await editorModel()
    .withStructuredOutput(Review)
    .invoke([new SystemMessage(REVIEW_PROMPT), new HumanMessage(prompt)]);
  return result.issues;
}

// Review → fix → re-review, until the piece passes or MAX_ROUNDS is reached.
export async function editDraft(draft: string, ctx: EditorContext) {
  const checks = checkContext(ctx);
  const keep = ctx.guidance.keep.map((k) => normalizeText(k).toLowerCase());
  const touchesUsersOwn = (quote: string) => {
    const q = normalizeText(quote).toLowerCase();
    return keep.some((k) => k.includes(q) || q.includes(k));
  };

  let content = draft;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const findings = runChecks(content, checks);
    // Round 1 is the full review. Later rounds only run to clear what the code checks
    // still flag: a second open-ended review mostly restyled copy that already passed
    // (and deleted a correct feature line in testing).
    if (round > 1 && findings.length === 0) break;
    const issues = (await review(content, ctx, findings)).slice(0, MAX_FIXES_PER_ROUND);
    const roundStart = content;
    let applied = 0;
    for (const issue of issues) {
      if (normalizeText(issue.quote) === normalizeText(issue.replacement)) continue; // whitespace-only "fix"
      if (touchesUsersOwn(issue.quote) || rejectFix(content, issue, checks.allowedText)) continue;
      // Match heading text without its "## " (from either side) so the document's own
      // heading prefix stays in place; otherwise "# Hero" → "New headline" loses the heading.
      const unheading = (t: string) => t.replace(/^#{1,6}\s*/, "");
      const result = applyEdit(content, unheading(issue.quote), unheading(issue.replacement));
      if (result.ok) {
        content = result.content;
        applied++;
      }
    }
    if (wordCount(content) < wordCount(roundStart) * (1 - MAX_ROUND_CUT) || emptiedSection(roundStart, content)) {
      console.info(`[editor] round ${round}: discarded (cut too much)`);
      content = roundStart;
      break;
    }
    console.info(
      `[editor] round ${round}: ${findings.length} check findings, ${issues.length} issues, ${applied} fixed`,
    );
    if (applied === 0) break; // nothing it can act on; another round won't help
  }
  // "#Heading" (no space) renders as plain text.
  return confirmUnsupported(content, checks).replace(/^(#{1,6})(?=[^\s#])/gm, "$1 ");
}

// The editor model's fixes are checked in code before they're applied. In testing it
// turned Markdown headings into HTML, deleted ordinary headings like "How It Works",
// and replaced an invented "$50" with an invented "$400/month".
function rejectFix(content: string, issue: { quote: string; replacement: string }, allowedText: string) {
  if (/<\/?[a-z][^>]*>/i.test(issue.replacement)) return true;
  if (unsupportedSpecifics(issue.replacement, allowedText).length) return true;
  const quote = normalizeText(issue.quote).toLowerCase();
  const heading = content
    .split("\n")
    .find((line) => /^#{1,6}\s/.test(line) && normalizeText(line).toLowerCase() === quote);
  // A heading may be renamed, but only deleted if it's a leaked section label ("Hero").
  return Boolean(heading && !issue.replacement.trim() && !LITERAL_HEADINGS.test(heading.trim()));
}

// Last resort: an unsupported specific, or a PRD goal stated as a result, that survived
// review becomes a visible "[confirm: …]" placeholder, so it never ships as plain fact.
function confirmUnsupported(content: string, checks: ReturnType<typeof checkContext>) {
  let result = content;
  for (const f of runChecks(content, checks)) {
    const token = f.problem.match(/^"(.+?)" (?:isn't in the brief or source material|is a goal in the source)/)?.[1];
    if (!token || !f.quote) continue;
    const fixed = applyEdit(result, f.quote, f.quote.replace(token, `[confirm: ${token}]`));
    if (fixed.ok) result = fixed.content;
  }
  return result;
}

// A revision the user asked for: the editor rewrites, then reviews it like any draft.
//
// qwen3:8b often returns the document unchanged ("echo") when asked to rewrite it.
// Measured causes: a system prompt with the house style (8/8 echoed; the text already
// matches it, so it reads as done) and a long source in the prompt (4/4). So rewrites use
// a plain prompt with the document first and the instruction last, send the source only for
// targeted changes, retry once, and finally rewrite section by section.
export async function reviseAndEdit(
  currentContent: string,
  instructions: string,
  // "whole" = tone/length/focus across the document; "part" = one section or line.
  scope: "whole" | "part",
  ctx: EditorContext,
) {
  // "Keep every other sentence verbatim" also makes whole-document rewrites echo,
  // so that rule only applies to targeted changes.
  const how =
    scope === "whole"
      ? "Rework it throughout so the change is clear. Keep its structure, facts, and the user's own lines."
      : "Change only the part this refers to; keep every other sentence exactly as written.";
  const guidance = describeGuidance(ctx.guidance);
  const prompt = (text: string, { source = false, extra = "" } = {}) =>
    [
      source && ctx.request.sourceMaterial && `Facts you may draw on:\n<<<\n${ctx.request.sourceMaterial}\n>>>`,
      `Current document:\n<<<\n${text}\n>>>`,
      guidance,
      `Revise the document above: ${instructions} ${how}`,
      extra,
      "Return only the complete revised document in Markdown, without the <<< >>> markers.",
    ]
      .filter(Boolean)
      .join("\n\n");

  const rewrite = async (p: string, temperature: number) => {
    const out = stripFence((await editorModel({ temperature }).invoke([new HumanMessage(p)])).text);
    // A rewrite that repeats sections (seen in testing: 10 headings from 5) is treated as a
    // failed attempt, like an echo.
    return isMalformed(out, currentContent) ? currentContent : out;
  };
  const unchanged = (text: string) => text.trim() === currentContent.trim();

  // Whole-document changes go section by section: in one pass, qwen3:8b echoed, restored
  // old versions of edited lines, and copied one list item's text into the next.
  let revised = currentContent;
  if (scope === "whole") {
    const bySection = await rewriteBySection(currentContent, instructions, ctx.guidance.keep);
    if (!isMalformed(bySection, currentContent)) revised = bySection;
  } else {
    revised = await rewrite(prompt(currentContent, { source: true }), 0.4);
    if (unchanged(revised)) {
      revised = await rewrite(
        prompt(currentContent, { extra: "Your previous attempt returned the document unchanged. Apply the change." }),
        0.7,
      );
    }
  }
  if (unchanged(revised)) return currentContent; // reported upstream as "no changes"
  return editDraft(revised, { ...ctx, instructions });
}

const headingCount = (text: string) => (text.match(/^#{1,6}\s/gm) ?? []).length;

// Lines (normalized) that appear more than once.
function duplicateLines(text: string) {
  const seen = new Map<string, number>();
  for (const line of text.split("\n")) {
    const n = normalizeText(line.replace(/^\s*(?:[-*+•]|\d+[.)]|#{1,6})\s*/, "")).toLowerCase();
    if (n.length > 20) seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, count]) => count > 1).map(([line]) => line));
}

// Rewrites that repeat sections (10 headings from 5), balloon, or copy one line's text into
// another ("We build. A clear, actionable roadmap…" from step 2) are failed attempts.
function isMalformed(revised: string, original: string) {
  const before = duplicateLines(original);
  const newDuplicates = [...duplicateLines(revised)].some((line) => !before.has(line));
  return headingCount(revised) > headingCount(original) + 1 || revised.length > original.length * 1.8 || newDuplicates;
}

// Last resort for whole-document changes: smaller pieces echo far less (5/6 sections
// changed where whole-document attempts had echoed).
async function rewriteBySection(content: string, instructions: string, keep: string[]) {
  const sections = content.split(/\n(?=#{1,6}\s)/);
  const rewritten = [];
  for (const section of sections) {
    // The user's own lines in this section stay word for word.
    const own = keep.filter((k) => findSpan(section, k).ok);
    const response = await editorModel({ temperature: 0.5 }).invoke([
      new HumanMessage(
        [
          `This is one section of a longer piece:\n<<<\n${section}\n>>>`,
          `Rewrite this section: ${instructions}`,
          "Keep its heading, facts, meaning, and list structure. Each line must stay distinct: don't copy one item's words into another.",
          own.length && `Keep these lines word for word: ${own.map((o) => `"${o}"`).join("; ")}`,
          "Return only the rewritten section in Markdown.",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    ]);
    const out = stripFence(response.text);
    const ok = out && headingCount(out) <= headingCount(section) && !isMalformed(out, section);
    rewritten.push(ok ? out : section);
  }
  return rewritten.join("\n\n");
}

// ---- Rewording one line -------------------------------------------------------------
//
// "Reword this bullet", "keep X, I don't like the rest", "We listen. <real change vibes>".
// The editor writes several options for just that line; code checks each against what the
// user asked for, applies the best, and the rest are offered in the chat to swap in.

const wordsIn = (t: string) =>
  normalizeText(t)
    .toLowerCase()
    .match(/[a-z0-9’']+/g) ?? [];
const escapeRegExp = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type RewordSpec = {
  keep: string[]; // phrases to keep word for word (as the user typed them; typos allowed)
  drop: string[]; // phrases that must go
  direction: string; // what the new wording should convey, in the user's words
  userWords: string; // the user's whole message, verbatim
  avoid: string[]; // earlier versions of this line the user already moved away from
};

const OPTIONS = 5;
const Options = z.object({ options: z.array(z.string()) });

const VOICE = EDITOR_CRITERIA.split("\n")
  .find((l) => l.startsWith("2. Voice"))
  ?.replace("2. Voice. ", "");

const REWORD_PROMPT = `You are a copy editor rewording one line of a larger piece. Write ${OPTIONS} distinct options for the line that do what the user asked. Change the wording the user wants changed; don't only add words to the old line. Keep what the line is (its step in a list, its subject, its job on the page) unless the user asks to change that. Voice: ${VOICE}
Each option is the complete new line as plain text: no quotes, labels, or brackets.`;

const FILL_PROMPT = `You are a copy editor finishing one line of a larger piece. Part of the line is fixed and the user wants to keep it; you write only the missing part, marked ___. Write ${OPTIONS} distinct options for the missing part that do what the user asked. An option may be empty if the fixed part already works as a whole line. Keep what the line is (its step in a list, its subject, its job on the page). Voice: ${VOICE}
Each option is only the text that replaces ___, as plain text: no quotes, labels, or brackets.`;

// When the kept phrases sit at the start and/or end of the line, the model only writes
// the middle. qwen3:8b echoed the whole line or copied the user's notes when asked to
// rewrite it "keeping X"; filling one blank it does well, and the kept text can't drift.
function template(line: string, keep: string[]) {
  const spans = keep
    .map((k) => findSpan(line, k))
    .flatMap((f) => (f.ok ? [f.span] : []))
    .sort((a, b) => a.start - b.start);
  if (!spans.length) return null;
  const gap = (a: number, b: number) => /^[\s.,;:!?—–-]*$/.test(line.slice(a, b));
  let prefixEnd = 0;
  let i = 0;
  while (i < spans.length && gap(prefixEnd, spans[i].start)) prefixEnd = spans[i++].end;
  let suffixStart = line.length;
  let j = spans.length - 1;
  while (j >= i && gap(spans[j].end, suffixStart)) suffixStart = spans[j--].start;
  if (j >= i) return null; // a kept phrase sits in the middle: use whole-line mode
  const prefix = line.slice(0, prefixEnd).trimEnd();
  const suffix = line.slice(suffixStart).trimStart();
  return { prefix, suffix, removed: line.slice(prefixEnd, suffixStart).trim() };
}

export function assemble(t: { prefix: string; suffix: string }, fill: string) {
  let middle = fill.trim().replace(/^___\s*|\s*___$/g, "");
  // The model sometimes writes the whole line instead of just the blank.
  const lead = t.prefix && findSpan(middle, t.prefix);
  if (lead && lead.ok && lead.span.start === 0) middle = middle.slice(lead.span.end).trim();
  const tail = t.suffix && findSpan(middle, t.suffix);
  if (tail && tail.ok && tail.span.end === middle.length) middle = middle.slice(0, tail.span.start).trim();
  // After a finished sentence ("We listen."), the fill starts a new one: drop a dangling
  // "and"/"but"/"so" and capitalize ("We listen. and let's…" came back in testing).
  if (/[.!?]$/.test(t.prefix) && middle) {
    middle = middle.replace(/^(and|but|so|or)\s+/i, "");
    middle = middle.charAt(0).toUpperCase() + middle.slice(1);
  }
  let out = [t.prefix, middle, t.suffix].filter(Boolean).join(" ");
  if (!t.suffix && !/[.!?]$/.test(out)) out += ".";
  return out.replace(/\s+([.,;:!?])/g, "$1");
}

export async function rewordText(
  line: string,
  surroundings: { before: string; after: string },
  spec: RewordSpec,
  ctx: EditorContext,
): Promise<{ ok: true; best: string; alternatives: string[] } | { ok: false; reason: string }> {
  // Resolve loosely-typed phrases to the line's actual wording; a keep phrase that isn't in
  // the line but is in the user's message (new words they want) is kept as typed.
  // Keep/drop phrases refer to existing text, so they're matched loosely (typos) against the
  // line, then against its earlier versions. An unmatched keep phrase is only used as new
  // wording if the user asked to add or include words; otherwise a typo like "let's bring
  // reach" would be pasted into the copy. Phrases the model invented (not in the user's
  // message) are ignored: in testing it passed phrases from a neighbouring bullet.
  const fromUser = (p: string) => normalizeText(spec.userWords).toLowerCase().includes(normalizeText(p).toLowerCase());
  const asksToAdd = /\b(add|include|use the words?|mention|work in|put in)\b/i.test(spec.userWords);
  const resolveKeep = (p: string) => {
    const inLine = resolvePhrase(line, p);
    if (inLine) return inLine;
    for (const earlier of spec.avoid) if (resolvePhrase(earlier, p)) return resolvePhrase(earlier, p)!;
    return fromUser(p) && asksToAdd ? p.trim() : "";
  };
  // The quoted target line itself isn't a "keep" phrase: keeping all of it leaves nothing
  // to reword, and the model could only append ("We plan it with you. We craft with you.").
  const isWholeLine = (p: string) =>
    normalizeText(p).toLowerCase().length >= normalizeText(line).toLowerCase().length * 0.8;
  const keep = [...new Set(spec.keep.map(resolveKeep).filter(Boolean))].filter((k) => !isWholeLine(k));
  // Keep phrases that match nothing are likely typos; options mustn't copy them either.
  const unclear = spec.keep.filter((p) => !resolveKeep(p));
  const drop = [...new Set(spec.drop.map((d) => resolvePhrase(line, d) ?? "").filter(Boolean))];
  const allowed = [checkContext(ctx).allowedText, line, spec.userWords].join("\n");
  const has = (text: string, phrase: string) =>
    normalizeText(text).toLowerCase().includes(normalizeText(phrase).toLowerCase());
  const avoid = [line, ...spec.avoid].map((a) => normalizeText(a).toLowerCase());
  // "<real change vibes>" describes the new wording; it isn't the wording. The model gets it
  // as a plain instruction, and options that copy it are rejected.
  const directions = [...spec.userWords.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim()).filter((d) => d.length > 3);
  const userWords = spec.userWords.replace(/<([^>]+)>/g, "(new wording that conveys: $1)");
  // With keep phrases given, "the rest" is what the user wants changed.
  const contentWords = (t: string) => wordsIn(t).filter((w) => w.length >= 4);
  const rest = contentWords(
    keep.reduce((t, k) => t.replace(new RegExp(escapeRegExp(normalizeText(k)), "i"), " "), normalizeText(line)),
  );
  // Only dropping ("drop X and make the rest work"): the rest of the line is the fixed part,
  // and the model only smooths the gap or ending.
  const remainder = drop
    .reduce((t, d) => t.replace(d, " "), line)
    .replace(/\s{2,}/g, " ")
    .trim();
  const implicitKeep =
    !keep.length && drop.length && remainder && remainder !== line ? [remainder.replace(/[\s—–,;:-]+$/, "")] : [];
  const fill = template(line, keep.length ? keep : implicitKeep);
  // Parallel list items ("We listen / We plan / We build"): when the neighbours share the
  // first word but not the second, the first two words name the step and must stay.
  const lead = (t: string) => wordsIn(t.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, "")).slice(0, 2);
  const [w1, w2] = lead(line);
  const neighbours = [surroundings.before, surroundings.after].map(lead).filter((n) => n.length === 2);
  const stepName =
    w1 && w2 && neighbours.length && neighbours.every(([n1, n2]) => n1 === w1 && n2 !== w2) ? `${w1} ${w2}` : null;

  const problemsWith = (option: string) => {
    const problems: string[] = [];
    for (const k of keep) {
      if (!has(option, k)) problems.push(`must keep "${k}"`);
      else if (normalizeText(option).toLowerCase().split(normalizeText(k).toLowerCase()).length > 2)
        problems.push(`repeats "${k}"`);
    }
    for (const d of drop) if (has(option, d)) problems.push(`must not contain "${d}"`);
    if (avoid.includes(normalizeText(option).toLowerCase()))
      problems.push("repeats a version the user already rejected");
    for (const d of directions) if (has(option, d)) problems.push("copies the user's note instead of writing copy");
    // Matched on the phrase's last two words too: "we bring reach" slipped past a whole-phrase check.
    for (const u of unclear) {
      const tail = wordsIn(u).slice(-2).join(" ");
      if (has(option, u) || (tail.includes(" ") && wordsIn(option).join(" ").includes(tail))) {
        problems.push(`copies the unclear phrase "${u}"`);
      }
    }
    if (/\b(I want|I'd like|vibes?)\b/i.test(option) && !/\b(I want|I'd like|vibes?)\b/i.test(line)) {
      problems.push("uses the user's phrasing instead of copy");
    }
    if (keep.length && rest.length >= 2) {
      const optionWords = new Set(contentWords(option));
      if (rest.filter((w) => optionWords.has(w)).length / rest.length > 0.5) problems.push("the rest wasn't reworked");
    }
    if (/<\/?[a-z][^>]*>|[<>_]{1,3}/i.test(option)) problems.push("contains markup or a blank");
    if (/^\s*(?:[-*+•]|\d+[.)])\s/.test(option) || /\s\d+[.)]\s+[A-Z]/.test(option))
      problems.push("contains a list number");
    for (const n of [surroundings.before, surroundings.after].filter((x) => x.length > 8)) {
      const bare = (t: string) => normalizeText(t.replace(/^\s*(?:[-*+•]|\d+[.)]|#{1,6})\s*/, "")).toLowerCase();
      if (bare(option).includes(bare(n)) || bare(n).includes(bare(option))) problems.push("copies a neighbouring line");
    }
    if (stepName && lead(option).join(" ") !== stepName)
      problems.push(`must start with "${stepName}", the step it names`);
    if (option.includes("\n") && !line.includes("\n")) problems.push("must be a single line");
    if (sentences(option).some((s) => s.split(/\s+/).length > MAX_SENTENCE_WORDS))
      problems.push("a sentence is too long");
    const lower = option.toLowerCase().replace(/’/g, "'");
    const banned = BANNED_PHRASES.find((b) => lower.includes(b));
    if (banned) problems.push(`uses filler "${banned}"`);
    const unsupported = unsupportedSpecifics(option, allowed);
    if (unsupported.length) problems.push(`adds unsupported ${unsupported.join(", ")}`);
    return problems;
  };

  const request = (extra: string) =>
    [
      `The piece: ${ctx.request.contentType}. ${ctx.request.brief}`,
      surroundings.before && `Line before: ${surroundings.before}`,
      fill
        ? `The line: ${[fill.prefix, "___", fill.suffix].filter(Boolean).join(" ")}\nIt currently reads: ${line}`
        : `The line to reword: ${line}`,
      surroundings.after && `Line after: ${surroundings.after}`,
      `The user asked: ${userWords}`,
      `What the new wording should convey: ${spec.direction}`,
      !fill && keep.length && `Keep word for word: ${keep.map((k) => `"${k}"`).join(", ")}`,
      drop.length && `Leave out: ${drop.map((d) => `"${d}"`).join(", ")}`,
      spec.avoid.length && `Versions the user already moved away from: ${spec.avoid.map((a) => `"${a}"`).join("; ")}`,
      extra,
    ]
      .filter(Boolean)
      .join("\n");

  const valid: string[] = [];
  let feedback = "";
  for (const temperature of [0.8, 1.0, 1.1]) {
    const { options } = await editorModel({ temperature })
      .withStructuredOutput(Options)
      .invoke([new SystemMessage(fill ? FILL_PROMPT : REWORD_PROMPT), new HumanMessage(request(feedback))]);
    const reasons = new Set<string>();
    for (const raw of options) {
      const text = raw.trim().replace(/^["“]|["”]$/g, "");
      const option = fill ? assemble(fill, text) : text;
      const problems = problemsWith(option);
      problems.forEach((p) => reasons.add(p));
      if (!problems.length && !valid.some((v) => normalizeText(v) === normalizeText(option))) valid.push(option);
    }
    console.info(`[editor] reword (${fill ? "fill" : "line"}): ${options.length} options, ${valid.length} valid`);
    if (valid.length >= 2) break;
    // Reasons only, not the rejected options: quoting them back made the model repeat them.
    feedback = reasons.size ? `Avoid these problems from the last attempt: ${[...reasons].join("; ")}.` : "";
  }
  if (!valid.length) {
    return {
      ok: false,
      reason: `No option met the request (keep ${keep.join(", ") || "nothing"}; leave out ${drop.join(", ") || "nothing"}).`,
    };
  }
  // Prefer options that don't bring back the dropped phrase's words in another form
  // ("drop 'to your practice and patients'" → not "…for patients, making care better").
  const droppedWords = new Set(drop.flatMap(contentWords));
  const reuse = (o: string) => contentWords(o).filter((w) => droppedWords.has(w)).length;
  const ranked = [...valid].sort((a, b) => reuse(a) - reuse(b));
  return { ok: true, best: ranked[0], alternatives: ranked.slice(1, 3) };
}
