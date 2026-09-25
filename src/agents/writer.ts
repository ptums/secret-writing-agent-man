import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ContentType } from "@/db/schema";
import { writerModel } from "./models";

// The house style. The editor rewrites with this same prompt, so revisions keep the voice.
export const SYSTEM_PROMPT = `You are a senior copywriter and content strategist. You write only the deliverable itself — no preamble, no commentary, no "Here is your draft". You are the best writer in existence and everything you write engages the reader deeply.

Craft standards:
- Lead with the reader's problem or desire, not the product. Every headline earns the next line.
- Concrete over abstract: sensory images and the brief's own facts beat adjectives. Numbers come only from the brief.
- One idea per paragraph. Vary sentence length. Cut filler ("in today's fast-paced world", "unlock", "elevate", "leverage", "game-changer", "made with love").
- Your style is logical and poetic. Most sentences are under 15 words; none are over 25. Mix short lines with a few longer ones so the copy flows. Prefer common one- and two-syllable words. Write below a 10th grade reading level.
- Use only facts from the brief. Every price, number, day, time, duration, amount saved, ingredient, process detail ("baked daily", "never frozen"), guarantee, discount, and policy must appear in the brief. If you want one that isn't there, write a bracketed placeholder like [delivery day] or [customer count].
- Describe the offer exactly as the brief does. Don't turn a subscription into a waitlist, a launch into a sale, or a free week into a discount.
- Never invent statistics or testimonials.

Working from source material (PRDs, user stories, notes):
- It is the only source of facts. Use its specifics — features, numbers, prices, limits, timings — instead of generic claims.
- Goals, targets, and success metrics are plans, not results. "Cut no-shows by 50%" is a goal; never state it as something the product already does.
- Never mention features listed as out of scope, future, or not at launch as if they exist.
- Turn the problem and user stories into the reader's own words: they are the best hooks.
- Follow any brand or voice notes in it.

Example of the voice — match its rhythm and plain words, not its topic:
"Most mornings start in a rush. Keys, coffee, the door. You tell yourself you'll slow down tomorrow. Tomorrow comes. It looks like today.
Big plans don't fix this. Small things do. A bag packed the night before. Ten quiet minutes that belong to you.
Time isn't something you find. It's something you keep."

Format:
- Output Markdown.
- Use headings, short lists, and bold sparingly to aid scanning.`;

const FORMAT_GUIDANCE: Record<ContentType, string> = {
  blog_post:
    "Blog post: 800–1500 words, a hook intro, H2 sections, and a conclusion with a CTA. Search-friendly headings.",
  landing_page:
    "Landing page: open with a headline, a one-line subhead, and a call to action; then benefit sections, social-proof placeholders, and objections answered; close with the call to action once more (no other CTAs). Give each section an H2 that is a real headline about its content.",
  website_copy:
    "Website copy for a marketing homepage, in this order, each section under an H2 that is a real headline about its content: an opening headline with a one-line subhead and the main call to action; the problem, in the reader's words; how it works, in 3 short steps; the features, written as benefits and grouped; pricing (if given); 3–5 real objections, answered; a closing call to action.",
  email: "Email: provide 3 subject line options and preview text, then the body. Short paragraphs, one CTA.",
  ad_copy:
    "Ad copy: several variants (headline, primary text, CTA) grouped by H2, respecting typical platform length limits.",
  social_post:
    "Social posts: several variants grouped by platform under H2s, native to each platform's style and length.",
  campaign_brief:
    "Campaign brief: objective, audience, key message, supporting points, channels, deliverables, and success metrics.",
  other: "Choose the most effective structure for the request.",
};

export type WriteRequest = {
  contentType: ContentType;
  brief: string;
  audience?: string;
  tone?: string;
  keywords?: string[];
  sourceMaterial?: string | null;
};

export function describeRequest(req: WriteRequest) {
  return [
    `Content type: ${req.contentType}`,
    FORMAT_GUIDANCE[req.contentType],
    // Handoffs arrive as "Request: …\n\nConversation context: …" (see ./handoff.ts).
    req.brief.startsWith("Request:") ? req.brief : `Brief: ${req.brief}`,
    // Without this, an essay opened with "You've shared that you enjoy bagels…".
    req.brief.includes("Conversation context:") &&
      "Use the conversation context to shape the piece. Don't mention the conversation or repeat the user's words back to them.",
    req.audience && `Audience: ${req.audience}`,
    req.tone && `Tone: ${req.tone}`,
    req.keywords?.length && `Keywords to include naturally: ${req.keywords.join(", ")}`,
    req.sourceMaterial && `Source material from the user (the only source of facts):\n<<<\n${req.sourceMaterial}\n>>>`,
  ]
    .filter(Boolean)
    .join("\n");
}

// Some models wrap the whole answer in a ```markdown fence.
export function stripFence(raw: string) {
  return raw
    .trim()
    .replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/, "$1")
    .replace(/^<<<\n?|\n?>>>$/g, "") // the markers the editor wraps documents in
    .trim();
}

async function run(prompt: string, temperature?: number) {
  const response = await writerModel({ temperature }).invoke([
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(prompt),
  ]);
  return stripFence(response.text);
}

// Drafts only: the editor (./editor.ts) reviews every draft, sends it back with notes until it
// passes, and handles all revisions of existing documents.
export function writeContent(req: WriteRequest) {
  return run(`Write the following.\n\n${describeRequest(req)}`);
}

// A new draft after the editor sent the last one back. The notes quote the passages that
// failed; the earlier draft itself isn't included, because with the house style as the
// system prompt, qwen3:8b tends to hand an existing document back unchanged.
export function redraftContent(req: WriteRequest, editorNotes: string) {
  return run(
    `Write the following.\n\n${describeRequest(req)}\n\nThe editor sent back your previous draft. Write a new draft that fixes every point below and keeps what they said worked.\n${editorNotes}`,
  );
}
