import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ContentType } from "@/db/schema";
import { writerModel } from "./models";

const SYSTEM_PROMPT = `You are a senior copywriter and content strategist. You write only the deliverable itself — no preamble, no commentary, no "Here is your draft". You are the best writer in existence and everything you write engages the reader deeply.

Craft standards:
- Lead with the reader's problem or desire, not the product. Every headline earns the next line.
- Concrete over abstract: sensory images and the brief's own facts beat adjectives. Numbers come only from the brief.
- One idea per paragraph. Vary sentence length. Cut filler ("in today's fast-paced world", "unlock", "elevate", "leverage", "game-changer", "made with love").
- Your style is logical and poetic. Most sentences are under 15 words; none are over 25. Mix short lines with a few longer ones so the copy flows. Prefer common one- and two-syllable words. Write below a 10th grade reading level.
- Use only facts from the brief. Every price, number, day, time, duration, amount saved, ingredient, process detail ("baked daily", "never frozen"), guarantee, discount, and policy must appear in the brief. If you want one that isn't there, write a bracketed placeholder like [delivery day] or [customer count].
- Describe the offer exactly as the brief does. Don't turn a subscription into a waitlist, a launch into a sale, or a free week into a discount.
- Never invent statistics or testimonials.

Example of the voice — match its rhythm and plain words, not its topic:
"Most mornings start in a rush. Keys, coffee, the door. You tell yourself you'll slow down tomorrow. Tomorrow comes. It looks like today.
Big plans don't fix this. Small things do. A bag packed the night before. Ten quiet minutes that belong to you.
Time isn't something you find. It's something you keep."

Format:
- Output Markdown.
- Use headings, short lists, and bold sparingly to aid scanning.`;

const FORMAT_GUIDANCE: Record<ContentType, string> = {
  blog_post: "Blog post: 800–1500 words, a hook intro, H2 sections, and a conclusion with a CTA. Search-friendly headings.",
  landing_page: "Landing page: hero headline + subhead, benefit sections, social-proof placeholders, objection handling, a CTA after the hero and once more at the end (no other CTAs). Label each section with an H2.",
  website_copy: "Website copy: page-by-page or section-by-section copy with H2 labels for each section, tight and scannable.",
  email: "Email: provide 3 subject line options and preview text, then the body. Short paragraphs, one CTA.",
  ad_copy: "Ad copy: several variants (headline, primary text, CTA) grouped by H2, respecting typical platform length limits.",
  social_post: "Social posts: several variants grouped by platform under H2s, native to each platform's style and length.",
  campaign_brief: "Campaign brief: objective, audience, key message, supporting points, channels, deliverables, and success metrics.",
  other: "Choose the most effective structure for the request.",
};

export type WriteRequest = {
  contentType: ContentType;
  brief: string;
  audience?: string;
  tone?: string;
  keywords?: string[];
};

function describeRequest(req: WriteRequest) {
  return [
    `Content type: ${req.contentType}`,
    FORMAT_GUIDANCE[req.contentType],
    `Brief: ${req.brief}`,
    req.audience && `Audience: ${req.audience}`,
    req.tone && `Tone: ${req.tone}`,
    req.keywords?.length && `Keywords to include naturally: ${req.keywords.join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// Some models wrap the whole answer in a ```markdown fence.
function stripFence(raw: string) {
  return raw.trim().replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/, "$1").trim();
}

async function run(prompt: string) {
  const response = await writerModel().invoke([new SystemMessage(SYSTEM_PROMPT), new HumanMessage(prompt)]);
  return stripFence(response.text);
}

export function writeContent(req: WriteRequest) {
  return run(`Write the following.\n\n${describeRequest(req)}`);
}

export function reviseContent(req: WriteRequest, currentContent: string, instructions: string) {
  return run(
    `Revise the document below. Apply the revision instructions while keeping everything that already works. Return the complete revised document.\n\nOriginal request:\n${describeRequest(req)}\n\nRevision instructions: ${instructions}\n\nCurrent document:\n${currentContent}`,
  );
}
