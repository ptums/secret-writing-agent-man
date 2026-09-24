import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { applyEdit, normalizeText } from "@/lib/textEdit";
import { LITERAL_HEADINGS, readSourceRules, runChecks, unsupportedSpecifics, type Finding } from "./editorChecks";
import { editorModel } from "./models";
import { describeRequest, stripFence, type WriteRequest } from "./writer";

// The editor agent. Every first draft and every revision passes through it before the
// user sees anything. It reviews against EDITOR_CRITERIA (plus the mechanical checks in
// ./editorChecks.ts), fixes what fails with exact replacements, and re-reviews. Its notes
// are never shown to the user: the final document is what passes review.

export const EDITOR_CRITERIA = `A piece passes only if all of these hold:

1. Facts. Every price, number, date, day, time, duration, feature, result, and claim is supported by the brief or source material. Goals, targets, and success metrics are not stated as results. Features listed as out of scope or future are not mentioned as existing. No invented testimonials, statistics, customers, or process details.
2. Voice. Logical and poetic. Short sentences in plain, common words, below a 10th grade reading level. No filler or hype ("unlock", "elevate", "leverage", "game-changer", "made with love", "in today's fast-paced world"). Doesn't prescribe a feeling to the reader unless the brief asks for it.
3. Request. Delivers what was asked, in the requested format and tone, for the right audience. Follows the user's earlier feedback. Keeps the user's own lines word for word, and doesn't bring back text they removed.
4. Clean. Only the deliverable: no preamble, notes to the user, or section labels (like "Hero" or "Features") used as headings.`;

const REVIEW_PROMPT = `You are a meticulous copy editor. You don't rewrite pieces; you find specific problems and give exact fixes.

${EDITOR_CRITERIA}

For each problem, return:
- quote: the exact text from the piece, copied character for character (one sentence or line)
- problem: what's wrong, briefly
- replacement: the corrected text for that quote, in the same voice and plain Markdown (never HTML), or "" to delete it. Never add a number, price, day, or duration that isn't in the brief or source; when one is needed, use a bracketed placeholder like [delivery day].

Only flag real problems against the criteria. Don't restyle text that already passes, and don't remove headings (renaming a vague one is fine).

Never flag or change the user's own lines. Return an empty list if the piece passes.`;

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
    const issues = await review(content, ctx, findings);
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

  let revised = await rewrite(prompt(currentContent, { source: scope === "part" }), 0.4);
  if (unchanged(revised)) {
    revised = await rewrite(
      prompt(currentContent, { extra: "Your previous attempt returned the document unchanged. Apply the change." }),
      0.7,
    );
  }
  if (unchanged(revised) && scope === "whole") {
    const bySection = await rewriteBySection(currentContent, instructions);
    if (!isMalformed(bySection, currentContent)) revised = bySection;
  }
  if (unchanged(revised)) return currentContent; // reported upstream as "no changes"
  return editDraft(revised, { ...ctx, instructions });
}

const headingCount = (text: string) => (text.match(/^#{1,6}\s/gm) ?? []).length;

function isMalformed(revised: string, original: string) {
  return headingCount(revised) > headingCount(original) + 1 || revised.length > original.length * 1.8;
}

// Last resort for whole-document changes: smaller pieces echo far less (5/6 sections
// changed where whole-document attempts had echoed).
async function rewriteBySection(content: string, instructions: string) {
  const sections = content.split(/\n(?=#{1,6}\s)/);
  const rewritten = [];
  for (const section of sections) {
    const response = await editorModel({ temperature: 0.5 }).invoke([
      new HumanMessage(
        `This is one section of a longer piece:\n<<<\n${section}\n>>>\n\nRewrite this section: ${instructions} Keep its heading, facts, and meaning. Return only the rewritten section in Markdown.`,
      ),
    ]);
    const out = stripFence(response.text);
    rewritten.push(out && headingCount(out) <= headingCount(section) ? out : section);
  }
  return rewritten.join("\n\n");
}
